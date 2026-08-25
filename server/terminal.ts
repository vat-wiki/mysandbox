// 网页终端：WS /ws/terminal?id=&token=&shell=&cols=&rows=&termId=
//
// 每个终端 tab 一个 tmux 会话：ms-<容器短id>-<termId>（termId 浏览器生成 UUID、随 tab 存 localStorage）。
// 一个容器可开多个终端、各自独立 shell。关闭与刷新的区分靠「是否收到 kill 帧」：
//   - 点 ✕ 关闭：前端发 {type:'kill'} -> 后端 tmux kill-session，shell 真死。
//   - 刷新/掉线：不发 kill -> 会话保留，宽限期（60s）内重连同 termId 即复活旧 shell（含历史/进程）；
//     超时未重连才 kill-session（清掉关浏览器/崩溃/导航离开的遗弃会话）。
// 多窗口同 termId 时用 activeCount 计活连接：关一个只 detach、等最后一个走才按上述杀/挂宽限，不误伤。
//
// 握 PTY master 的是容器内独立 tmux server 守护进程，与浏览器、与 mysandbox 进程解耦。
//
// tmux 不在镜像里时：首次开终端用 root apt 装一次并缓存（tmuxReady），装失败则退回普通一次性 shell
// （刷新即丢，但至少能用）。镜像里内置 tmux 后这一步只是一次 ~毫秒级 command -v 检查。
//
// 传输：lxc-attach Tty 单流。控制帧（resize/kill）走文本帧 JSON，stdin 走二进制。
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import type { Config } from './config.js';
import { execRun, execStream as execStreamRaw, inspectContainer } from './engine/index.js';

// 控制帧：resize 调 PTY 尺寸、kill 杀整条会话（真关）。
interface ControlMsg {
  type: 'resize' | 'kill';
  cols?: number;
  rows?: number;
}

// termId 仅用于拼会话名，限制字符集/长度防注入。浏览器用 UUID，也接受短随机串。
// files.ts 的 cwd 查询也用它校验 termId，故导出。
export const TERMID_RE = /^[A-Za-z0-9_-]{4,64}$/;

// tmux 会话名：ms-<容器短id>-<termId>。terminal.ts 与 files.ts 共用，杜绝两处拼接漂移。
export function sessionName(id: string, termId: string): string {
  return `ms-${id.slice(0, 8)}-${termId}`;
}
// 遗弃会话宽限期：WS 断开且非 kill 时挂这个定时器，期内重连取消、超时 kill-session。
const GRACE_MS = 60_000;

// 容器 id -> 已确认装好 tmux。命中即跳过探测/安装，重连零额外开销。
const tmuxReady = new Set<string>();

// 当前 mysandbox 进程认领的「活连接」pidfile。reapOrphanClients 据此区分活连接与孤儿：
// 服务重启后此 Set 为空，首次连某容器时把该容器所有 pidfile 当孤儿清掉（重启前旧 WS 的
// cleanup 闭包随进程而死、killExecClient 没机会跑 -> 容器侧 tmux 客户端孤儿化、卡在 stale
// 80x24 永不退）。正常断连由 cleanup 里的 killExecClient 即时清，本 Set 只用于收割漏网之鱼。
const activePidfiles = new Set<string>();

// 每个会话当前挂着的 WS 连接数（多窗口同 termId 时 >1）。决定断开时是否动会话：
// >1 -> 还有别的窗口在用，只 detach 本连接；==0（最后一个走）-> 按 wantKill 决定即杀或挂宽限。
const activeCount = new Map<string, number>();
// 遗弃会话的宽限定时器：sessionName -> timeout。重连时 cancelGrace，到期 killSession。
const graceTimers = new Map<string, NodeJS.Timeout>();

// 快速探测容器里有没有 tmux（不安装）。命中缓存或 command -v 成功即返回 true。
async function hasTmux(cfg: Config, id: string): Promise<boolean> {
  if (tmuxReady.has(id)) return true;
  const r = await execRun(cfg, id, {
    Cmd: ['sh', '-c', 'command -v tmux >/dev/null 2>&1'],
    User: 'root',
    Tty: false,
    timeoutMs: 8_000,
  });
  if (r.exitCode === 0) tmuxReady.add(id);
  return r.exitCode === 0;
}

// 首次安装 tmux（root）。镜像/容器里 apt lists 已存在，故只 install、不做 update--
// 实测约 30–60s；做 update 会再拉一遍索引、常超 60s。装失败返回 false（调用方退回普通 shell）。
async function installTmux(
  cfg: Config,
  id: string,
  log: FastifyInstance['log'],
): Promise<boolean> {
  const r = await execRun(cfg, id, {
    Cmd: ['sh', '-c', 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends tmux'],
    User: 'root',
    Tty: false,
    timeoutMs: 120_000,
  });
  if (r.exitCode === 0) {
    tmuxReady.add(id);
    return true;
  }
  log.warn(
    { id, exitCode: r.exitCode, stderr: r.stderr.slice(0, 200) },
    'tmux install failed; fallback to plain shell',
  );
  return false;
}

// 杀掉本次连接在容器内起的 tmux 客户端进程（见下面 cleanup 的注释）。
// 为什么用 pidfile 而非子进程 pid：detach 后拿不到，
// （实测），拿不到容器内 PID。改成让 sh 自己把 $$（=容器内 PID，exec tmux 后同 PID）写进
// 唯一 pidfile，关闭时读出来按 comm 校验后 kill。每个 WS 连接一个唯一 pidfile，并发 tab 不打架。
// comm 校验：tmux 客户端进程 /proc/<pid>/comm 是 "tmux: client"（server 是 "tmux: server"），
// 前缀匹配 "tmux: client" 才杀--防 PID 复用误杀、绝不误杀 tmux server。
// 注意：只杀 attach 客户端进程，不动 tmux 会话本身--会话（server+shell）继续活，供刷新重连。
async function killExecClient(cfg: Config, id: string, pidfile: string): Promise<void> {
  try {
    await execRun(cfg, id, {
      Cmd: ['sh', '-c', 'f="$1"; p=$(cat "$f" 2>/dev/null); [ -z "$p" ] && exit 0; c=$(cat /proc/$p/comm 2>/dev/null); case "$c" in "tmux: client"*) kill -9 $p 2>/dev/null;; esac; rm -f "$f"', 'sh', pidfile],
      User: 'root',
      Tty: false,
      timeoutMs: 5_000,
    });
  } catch {
    /* 容器/exec 已没了就忽略 */
  }
}

// 杀整条 tmux 会话（server 收到后结束该会话的 shell + 所有 pane + detach 所有 client）。
// 幂等：会话已不在则 tmux 报错、exitCode!=0，调用方忽略。同步清掉该会话的宽限定时器与计数。
async function killSession(cfg: Config, id: string, session: string): Promise<void> {
  cancelGrace(session);
  activeCount.delete(session);
  try {
    await execRun(cfg, id, {
      Cmd: ['tmux', 'kill-session', '-t', session],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 5_000,
    });
  } catch {
    /* 会话/容器已没了就忽略 */
  }
}

// 挂宽限定时器：WS 断开且非显式 kill 时调用。到期再核 activeCount 仍为 0 才真杀
// （防「挂定时器后又有新连接」的竞态--新连接来时已 cancelGrace 并 activeCount++）。
function armGrace(cfg: Config, id: string, session: string): void {
  cancelGrace(session); // 已有定时器则先清，重置计时
  const t = setTimeout(() => {
    graceTimers.delete(session);
    if ((activeCount.get(session) ?? 0) === 0) {
      void killSession(cfg, id, session);
    }
  }, GRACE_MS);
  graceTimers.set(session, t);
}
function cancelGrace(session: string): void {
  const t = graceTimers.get(session);
  if (t) {
    clearTimeout(t);
    graceTimers.delete(session);
  }
}

// 收割孤儿 tmux 客户端 + 旧式单会话。服务重启 / 异常断连时，旧 WS 的 cleanup 闭包随进程而死、
// killExecClient 没机会执行 -> 容器侧 tmux 客户端被孤儿化（ppid=0、拿着 stale 80x24 的 pty 永不退出）
// 持续泄漏。每次新连某容器时先跑一遍：
//   1) 读该容器所有 pidfile，凡不在 activePidfiles（=本进程认领的活连接）里的，
//      按 comm="tmux: client" 校验后 kill -9 + 删 pidfile（只杀 attach 进程，不动会话）；
//   2) 旧式单会话 ms-<短id>（无 termId 后缀，升级前的模型）若存在且无 attached client -> kill-session。
//      升级后浏览器改连 ms-<短id>-<termId>，旧会话必为孤儿；有 client 时不动（防误伤升级中在用的）。
async function reapOrphanClients(cfg: Config, id: string): Promise<void> {
  const short = id.slice(0, 8);
  // 1) 列出该容器所有 pidfile + 对应 pid（一条 exec，少往返）。
  const list = await execRun(cfg, id, {
    Cmd: [
      'sh', '-c',
      `for f in /tmp/.ms-term-${short}-*.pid; do [ -f "$f" ] || continue; printf '%s %s\\n' "$f" "$(cat "$f" 2>/dev/null)"; done`,
    ],
    User: 'root',
    Tty: false,
    timeoutMs: 5_000,
  });
  const orphans: string[] = [];
  for (const line of list.stdout.split('\n')) {
    if (!line.trim()) continue;
    const [pf, pid] = line.split(' ');
    if (!pf || !pid) continue;
    if (activePidfiles.has(pf)) continue; // 本进程活连接，跳过
    orphans.push(pf, pid);
  }
  if (orphans.length) {
    // 批量杀+删：成对传 (pidfile pid)，comm 校验后 kill -9、删 pidfile。
    // ⚠️ 只杀「pidfile 落盘超过 2 个宽限期」的：别的 mysandbox 实例（同容器双端口跑两个服务、
    // 或滚动重启窗口内）的活连接不在本进程 activePidfiles 里，但它们的 pidfile 是刚写的——
    // 按 mtime 放过，避免把人家正在用的 attach 客户端误杀（误杀会连带 60s 宽限后丢会话）。
    await execRun(cfg, id, {
      Cmd: [
        'sh', '-c',
        'while [ $# -gt 0 ]; do f="$1"; p="$2"; shift 2; old=$(find "$f" -mmin +2 2>/dev/null); [ -z "$old" ] && continue; c=$(cat /proc/$p/comm 2>/dev/null); case "$c" in "tmux: client"*) kill -9 $p 2>/dev/null;; esac; rm -f "$f"; done',
        'sh', ...orphans,
      ],
      User: 'root',
      Tty: false,
      timeoutMs: 5_000,
    });
  }
  // 2) 迁移旧式单会话 ms-<短id>：无 attached client 才杀。
  //    ⚠️ 必须 `=$s` 精确匹配：tmux 的 -t 默认按「前缀」匹配（实测 `ms-<短id>` 会匹配到
  //    `ms-<短id>-<termId>`），不写 = 的话本函数会把刷新重连场景下、等宽限的当前会话误杀——
  //    时序：刷新 → cleanup 杀旧 attach 客户端 → 重连时本函数跑：has-session(前缀)命中、
  //    list-clients=0（客户端刚被杀）→ kill-session → 会话死 → 重连只得 new-session 全新 shell，
  //    表现为「刷新后终端历史/任务全丢」。
  await execRun(cfg, id, {
    Cmd: [
      'sh', '-c',
      `s="ms-${short}"; tmux has-session -t "=$s" 2>/dev/null || exit 0; n=$(tmux list-clients -t "=$s" 2>/dev/null | wc -l); [ "$n" -eq 0 ] && tmux kill-session -t "=$s" 2>/dev/null || true`,
    ],
    User: '1000:1000',
    Tty: false,
    timeoutMs: 5_000,
  });
}

export async function registerTerminal(app: FastifyInstance, cfg: Config): Promise<void> {
  const log = app.log;
  app.get('/ws/terminal', { websocket: true }, async (socket, req) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const id = q.id;
    const shell = q.shell || cfg.ui.defaultShell;
    const cols = Number(q.cols) || 80;
    const rows = Number(q.rows) || 24;
    const termId = q.termId;
    if (!id) {
      socket.close(1008, 'missing container id');
      return;
    }
    if (!termId || !TERMID_RE.test(termId)) {
      socket.close(1008, 'missing or invalid termId');
      return;
    }

    try {
      // useTmux 在下面的 await 串里才确定；cleanup（早断连时）经由此引用读取，
      // 未确定时按 false 收尾：不杀 pidfile、不动会话计数（此刻也确实还没认领成 tmux 路径）。
      const useTmuxRef = { v: false };
      const session = sessionName(id, termId);
      const pidfile = `/tmp/.ms-term-${id.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}.pid`;
      // 认领：把本次连接的 pidfile 登记为「活」，reaper 据此跳过它（绝不误杀本 tab / 其它 tab）。
      activePidfiles.add(pidfile);
      // 重连复活：取消该会话的宽限定时器（若有），活连接计数 +1。多窗口同 termId 时计数 >1。
      cancelGrace(session);
      activeCount.set(session, (activeCount.get(session) ?? 0) + 1);

      // ---- 提前挂事件监听（必须在下面的 inspect/tmux/reap/exec 一串 await 之前）----
      // 客户端 onopen 一到就认为「能发帧了」，而那串 await 实测要几百 ms。期间到达的帧若无人
      // 接收会被 ws 静默丢弃：resize 帧丢了 -> tmux 会话停在 URL 里的陈旧尺寸（分屏场景表现为
      // claude 输出被截一半多，拖窗触发新 resize 才恢复）；close 丢了 -> 认领计数泄漏。
      // 故监听器先行，exec 产物用可变引用 late-bind；流未就绪前 stdin 丢弃、resize 只留最新一帧，
      // 由流就绪后的初始 resize 统一落盘（后到即最新，URL 快照反而是陈旧值）。
      let execStream: Duplex | null = null;
      let resizeExec: ((cols: number, rows: number) => void) | null = null;
      let pendingResize: { cols: number; rows: number } | null = null;
      let lastSize = ''; // 最近一次已落盘的 resize 尺寸（幂等跳过用）
      let wantKill = false; // 收到过 kill 帧（点 ✕）：断开时即杀会话而非挂宽限
      let closed = false;

      // 统一收尾（幂等）。断连时序：杀 attach 客户端进程（保留会话，供刷新重连）→ 释放 pidfile 认领
      // → 最后一个连接走时按 wantKill 决定即杀/挂宽限。exec 串未跑完就断连时 killExecClient 照发
      // （容器里 sh 可能还没写 pidfile，脚本 cat 不到就退出，无害），不会因早断而漏收尾。
      const cleanup = () => {
        if (closed) return;
        closed = true;
        try {
          execStream?.destroy();
        } catch {
          /* noop */
        }
        // 杀本次连接的 attach 客户端进程（保留会话本身，供刷新重连/别的窗口继续用）。
        // 故用 pidfile：sh 起来时已把 $$ 写进 pidfile，
        // 这里读出来按 comm="tmux: client" 校验后 kill -9。comm 校验防 PID 复用误杀、绝不误杀 server。
        if (useTmuxRef.v) killExecClient(cfg, id, pidfile);
        activePidfiles.delete(pidfile); // 释放认领，允许后续 reaper 回收（若 killExecClient 没杀成）
        // 会话级收尾：只在最后一个连接走时才决定会话生死（多窗口下别的连接还活着就只 detach）。
        // 计数一律扣（与 try 顶部的 +1 对应；exec 串没跑完就断连也得扣，否则计数泄漏）。
        const n = (activeCount.get(session) ?? 1) - 1;
        if (n > 0) {
          activeCount.set(session, n);
        } else if (useTmuxRef.v) {
          // 最后一个连接断了：显式 kill -> 即杀（killSession 内部会 delete 计数）；
          // 否则挂宽限（刷新/掉线留 60s 供重连，超时才杀）。挂宽限必须把计数清 0，
          // 否则下次重连 get 到旧值 1、+1 变 2（实际只 1 个连接），多窗口判定会错。
          if (wantKill) {
            void killSession(cfg, id, session);
          } else {
            activeCount.set(session, 0);
            armGrace(cfg, id, session);
          }
        } else {
          // 非 tmux 路径（或 useTmux 未确定的早断连）：无会话可收尾，计数清 0 即可。
          activeCount.set(session, 0);
        }
      };

      // 浏览器 -> 容器：文本帧=控制(resize/kill)，二进制=stdin
      // 注意：ws v8 起文本帧的 data 也是 Buffer（非 string），不能靠 typeof 判断帧类型--
      // 否则控制 JSON 会被误当 stdin 写进 PTY，终端里就出现 {"type":"resize",...} 回显。
      // 用回调第二个参数 isBinary（来自帧 opcode）判断才可靠。
      socket.on('message', (data: unknown, isBinary?: boolean) => {
        if (isBinary === false || typeof data === 'string') {
          try {
            const text = typeof data === 'string' ? data : (data as Buffer).toString();
            const m = JSON.parse(text) as ControlMsg;
            if (m.type === 'resize') {
              const size = { cols: m.cols ?? 80, rows: m.rows ?? 24 };
              // 尺寸不变跳过：前端 15s 心跳帧也带 resize 对账 payload（防丢帧后尺寸永陈旧），
              // 无条件转 resize 就是每 15s 一次无谓的 lxc-attach 调用。
              if (`${size.cols}x${size.rows}` === lastSize) return;
              lastSize = `${size.cols}x${size.rows}`;
              if (resizeExec) resizeExec(size.cols, size.rows);
              else pendingResize = size; // exec 未就绪：只留最新一帧
            } else if (m.type === 'kill') {
              // 点 ✕ 关闭：标记后关 socket，cleanup 见 wantKill=true 会即杀会话
              // （最后一个连接时）或只 detach（别的窗口还活着时），不会挂宽限。
              wantKill = true;
              try { socket.close(1000); } catch { /* noop */ }
            }
          } catch {
            /* ignore bad control frame */
          }
          return;
        }
        execStream?.write(data as Buffer);
      });
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      const info = await inspectContainer(cfg, id);
      if (!info.running) {
        socket.close(1008, 'container not running');
        return;
      }

      // tmux 可用 -> 走持久会话（new-session -A：有则 attach、无则建）；不可用 -> 退回一次性 shell。
      let useTmux = await hasTmux(cfg, id);
      useTmuxRef.v = useTmux;
      if (!useTmux) {
        // 首次安装提示：发二进制帧（客户端只渲染二进制、忽略文本帧），告诉用户正在装、稍等。
        try {
          socket.send(
            Buffer.from(
              '\x1b[2m>> 首次使用：正在容器内安装 tmux（约 30–60s，仅一次）…\x1b[0m\r\n',
            ),
          );
        } catch {
          /* socket 已关就忽略 */
        }
        useTmux = await installTmux(cfg, id, log);
        useTmuxRef.v = useTmux;
      }
      // 先收割孤儿 tmux 客户端 + 旧式单会话：清掉上次服务重启/异常断连残留的僵尸。
      // 必须在生成新 pidfile 之前跑--此时容器里还没有本次连接的 pidfile，reap 只会碰到旧孤儿。
      if (useTmux) await reapOrphanClients(cfg, id);
      // tmux 持久会话。一次 attach、用 sh -c 串四步（无额外往返）：
      //   0) echo $$ > pidfile：sh 把自己的 PID（容器内 PID，exec tmux 后同 PID）写进唯一 pidfile，
      //      关闭时 killExecClient 据此找到并杀掉对应 tmux 客户端（exec.inspect().Pid 恒为 0，用不了）；
      //   1) has-session || new-session -d：有会话则复用、没有则 detached 新建（server+shell 起来但不 attach）；
      //   2) set -g mouse off + terminal-overrides smcup@:rmcup@：tmux 仅做会话守护，交互交给 xterm.js。
      //      mouse off：选择/复制交给 xterm.js（tmux 不劫持鼠标）。
      //      禁 smcup/rmcup：让 tmux 客户端 attach 时【不进 alt screen】。否则 tmux 发 ?1049h 进 alt buffer，
      //      xterm 在 alt buffer 下 hasScrollback=false，会把滚轮转成 ↑/↓ 方向键发给 shell（=翻命令历史，
      //      而非滚 scrollback）并隐藏滚动条--这正是「滚轮切命令、无滚动条」的根因。禁后 tmux 在 normal screen
      //      绘制，滚轮走 xterm scrollback、有滚动条（与 VSCode 集成终端一致）。实测：无反复 2J 重绘、不污染
      //      scrollback、status bar 正常。每次 attach 都重设，扛得住 tmux server 重启；
      //      set-environment -g MYSANDBOX_WEB 1 + set -s allow-passthrough on：给容器内 mysandbox
      //      命令铺路——前者标记 web 环境（exec 的 Env 到不了 tmux server 起的 shell，故挂 server
      //      全局环境，脚本用 show-environment -g 运行时探测）；后者放行 DCS passthrough，否则
      //      tmux 吞掉脚本打的 OSC 7677（tmux 只转发认识的 OSC）。
      //   3) exec tmux attach：替换进程为 attach 客户端。
      //   $1=会话名 ms-<短id>-<termId>、$2=shell、$3=pidfile。注意：set 必须在 attach 之前 detached 跑--attach 后
      //   客户端接管 tty，命令行里 ';' 接的后续 tmux 命令不再执行（实测 attach 路径下 set 不生效）。
      const cmd = useTmux
        ? [
            'sh', '-c',
            'echo $$ > "$3"; tmux has-session -t "$1" 2>/dev/null || tmux new-session -d -s "$1" "$2"; tmux set -g mouse off 2>/dev/null; tmux set -g terminal-overrides "xterm*:smcup@:rmcup@" 2>/dev/null; tmux set-environment -g MYSANDBOX_WEB 1 2>/dev/null; tmux set -s allow-passthrough on 2>/dev/null; exec tmux attach -t "$1"',
            'sh', session, shell, pidfile,
          ]
        : [shell];

      const exec = await execStreamRaw(cfg, id, {
        Cmd: cmd,
        User: '1000:1000',
        WorkingDir: '/home/dev',
        Env: ['TERM=xterm-256color', 'MYSANDBOX_WEB=1'],
      });
      const stream = exec.stream;
      execStream = stream;
      // resize 就绪后接到 exec 上；此后到达的 resize 帧即时生效。
      resizeExec = (cols, rows) => {
        exec.resize(cols, rows).catch(() => {});
      };

      // 初始尺寸（来自 query）：握手期间若已有更晚到达的 resize 帧（pendingResize），以它为准。
      // tmux 据此 resize 窗口，普通 shell 据此 resize PTY。
      const init = pendingResize ?? { cols, rows };
      lastSize = `${init.cols}x${init.rows}`;
      try {
        await exec.resize(init.cols, init.rows);
      } catch {
        /* 容器偶发忽略 resize */
      }

      // 容器 -> 浏览器：单流（Tty）。tmux attach 时这里先收到整屏重绘，所以历史输出可见。
      stream.on('data', (d: Buffer) => {
        if (socket.readyState === 1 /* OPEN */) socket.send(d);
      });
      stream.on('end', () => {
        try {
          socket.close(1000);
        } catch {
          /* noop */
        }
      });
      stream.on('error', cleanup);
    } catch {
      try {
        socket.close(1011, 'terminal error');
      } catch {
        /* noop */
      }
    }
  });
}
