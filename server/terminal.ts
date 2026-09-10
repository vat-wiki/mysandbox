// 网页终端：WS /ws/terminal?id=&token=&shell=&cols=&rows=&termId=
//
// 每个终端 tab 一个 tmux 会话：mysandbox-<容器短id>-<termId>（termId 浏览器生成 UUID、随 tab 存 localStorage）。
// 一个容器可开多个终端、各自独立 shell。会话生命周期是**真 tmux 语义**（与宿主终端
// hostTerminal.ts 一致）：只有显式 kill（前端 ✕）或 shell 自己退出才终结；断线、关浏览器、
// 服务重启一概保留，无任何定时清理——「只要服务还在，用户开的会话就活着」。
// 多窗口同 termId 时用 activeCount 计活连接：关一个只 detach、最后一个走也只 detach，不误伤。
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

// tmux 会话名：mysandbox-<容器短id>-<termId>。terminal.ts 与 files.ts 共用，杜绝两处拼接漂移。
// 前缀统一用 mysandbox（与 docker label、systemd 单元、socket 等全部标志一致）；
// 历史前缀 ms- 的活会话由 attach 脚本自动 rename 迁移（见 OLD_SESSION_PREFIX）。
export function sessionName(id: string, termId: string): string {
  return `mysandbox-${id.slice(0, 8)}-${termId}`;
}
// 旧版会话名前缀（统一命名前用 ms-）。attach 时探测到旧名会话就 rename 成新名——
// 否则升级后浏览器按旧 termId 重连会静默新建会话，用户的现场丢失。
const OLD_SESSION_PREFIX = 'ms-';
// pidfile 模式（新旧两代都收，reaper 才能清掉升级前的旧孤儿）。
const PIDFILE_PREFIX = 'mysandbox-term-';
const OLD_PIDFILE_PREFIX = '.ms-term-';
// 孤儿 pidfile 的最小年龄：别的 mysandbox 实例（同容器双端口跑两个服务、滚动重启窗口内）
// 的活连接不在本进程 activePidfiles 里，但 pidfile 是刚写的——按 mtime 放过，避免误杀
// 人家正在用的 attach 客户端（误杀会让 attach 断成纯 detach，多窗口下观感异常）。
const ORPHAN_MIN_AGE_MIN = 2;

// 容器 id -> 已确认装好 tmux。命中即跳过探测/安装，重连零额外开销。
const tmuxReady = new Set<string>();

// 当前 mysandbox 进程认领的「活连接」pidfile。reapOrphanClients 据此区分活连接与孤儿：
// 服务重启后此 Set 为空，首次连某容器时把该容器所有 pidfile 当孤儿清掉（重启前旧 WS 的
// cleanup 闭包随进程而死、killExecClient 没机会跑 -> 容器侧 tmux 客户端孤儿化、卡在 stale
// 80x24 永不退）。正常断连由 cleanup 里的 killExecClient 即时清，本 Set 只用于收割漏网之鱼。
const activePidfiles = new Set<string>();

// 每个会话当前挂着的 WS 连接数（多窗口同 termId 时 >1）。决定断开时是否动会话：
// >1 -> 还有别的窗口在用，只 detach 本连接；==0（最后一个走）-> 按 wantKill 决定即杀或纯 detach。
const activeCount = new Map<string, number>();

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
// 幂等：会话已不在则 tmux 报错、exitCode!=0，调用方忽略。同步清掉该会话的计数。
// `=` 精确名匹配（reapOrphanClients 的教训）：tmux 的 -t 默认前缀/通配匹配。
async function killSession(cfg: Config, id: string, session: string): Promise<void> {
  activeCount.delete(session);
  try {
    await execRun(cfg, id, {
      Cmd: ['tmux', 'kill-session', '-t', `=${session}`],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 5_000,
    });
  } catch {
    /* 会话/容器已没了就忽略 */
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
  // 1) 列出该容器所有 pidfile（新旧两代模式）+ 对应 pid（一条 exec，少往返）。
  const list = await execRun(cfg, id, {
    Cmd: [
      'sh', '-c',
      `for f in /tmp/${PIDFILE_PREFIX}${short}-*.pid /tmp/${OLD_PIDFILE_PREFIX}${short}-*.pid; do [ -f "$f" ] || continue; printf '%s %s\\n' "$f" "$(cat "$f" 2>/dev/null)"; done`,
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
    // ⚠️ 只杀 pidfile 落盘超过 ORPHAN_MIN_AGE_MIN 分钟的（理由见常量注释）。
    await execRun(cfg, id, {
      Cmd: [
        'sh', '-c',
        `while [ $# -gt 0 ]; do f="$1"; p="$2"; shift 2; old=$(find "$f" -mmin +${ORPHAN_MIN_AGE_MIN} 2>/dev/null); [ -z "$old" ] && continue; c=$(cat /proc/$p/comm 2>/dev/null); case "$c" in "tmux: client"*) kill -9 $p 2>/dev/null;; esac; rm -f "$f"; done`,
        'sh', ...orphans,
      ],
      User: 'root',
      Tty: false,
      timeoutMs: 5_000,
    });
  }
  // 2) 迁移旧式单会话 ms-<短id>（无 termId 后缀，更早的模型）：无 attached client 才杀。
  //    ⚠️ 必须 `=$s` 精确匹配：tmux 的 -t 默认按「前缀」匹配（实测 `ms-<短id>` 会匹配到
  //    会话名 `mysandbox-<短id>-<termId>` 之外的旧式名），不写 = 的话本函数会把断线后的
  //    当前会话误杀——时序：刷新 → cleanup 杀旧 attach 客户端 → 重连时本函数跑：has-session(前缀)命中、
  //    list-clients=0（客户端刚被杀）→ kill-session → 会话死 → 重连只得 new-session 全新 shell，
  //    表现为「刷新后终端历史/任务全丢」。
  await execRun(cfg, id, {
    Cmd: [
      'sh', '-c',
      `s="${OLD_SESSION_PREFIX}${short}"; tmux has-session -t "=$s" 2>/dev/null || exit 0; n=$(tmux list-clients -t "=$s" 2>/dev/null | wc -l); [ "$n" -eq 0 ] && tmux kill-session -t "=$s" 2>/dev/null || true`,
    ],
    User: '1000:1000',
    Tty: false,
    timeoutMs: 5_000,
  });
}

// —— 会话发现（/api/terminal-sessions，routes.ts 组合宿主侧）——
// web 的 tab 列表只存浏览器 localStorage，换个浏览器/窗口就「找不到」——但会话本体
// （容器内 tmux）还活着。这里对单个容器做一次只读扫描（不安装 tmux——没有就 0 会话），
// 列出 mysandbox 管理的会话：新前缀 mysandbox-<短id>-<termId> + 旧前缀 ms-…（统一命名
// 迁移前的活会话要等连接时才 rename，这里原样识别，前端接入走正常连接即自动迁移）。
// cwd 取会话活跃 pane 的当前目录，给会话对话框当「这是哪个终端」的识别信息。
export interface TermSessionView {
  kind: 'host' | 'container' | 'service';
  containerId?: string; // kind=container 时为容器 id；kind=service 时为服务名（web 侧用它解析显示名/颜色）
  termId: string;
  attached: number; // 正在 attach 的客户端数（>0 = 有窗口正在用）
  created: number; // epoch ms
  cwd?: string;
  title?: string; // pane 动态标题（shell 钩子的命令行/空闲路径、CC·opencode 任务标题）
}

// 行格式：每会话**两行**——主行 `name|attached|created|path`（| 分隔：路径可含空格；
// 路径本身也可能含 |（文件名 a|b 合法），所以拆前 3 段后剩余整体回拼）+ 第二行 pane
// title。title 不并用 | 分隔的原因：title 来自命令行（preexec 标题含管道符 | 很常见）
// 与 TUI 应用标题，加段必有歧义；控制字符（\x1f 试过）会被 tmux format 转义成 \037
// 字面串也切不开。换行分块最稳（title 含换行的情形实际不存在：钩子已剔、tmux pane
// title 不含换行），解析按「主行命中 re、其后一行即 title」消费。
export const LIST_FMT = '#{session_name}|#{session_attached}|#{session_created}|#{pane_current_path}\n#{pane_title}';

export async function listContainerSessions(cfg: Config, id: string): Promise<TermSessionView[]> {
  const short = id.slice(0, 8);
  // 会话名按本容器短 id 前缀匹配（容器名可能来自 adopt，转义防正则元字符）
  const re = new RegExp(
    `^(?:mysandbox|ms)-${short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([A-Za-z0-9_-]{4,64})\\|`,
  );
  let out = '';
  try {
    const r = await execRun(cfg, id, {
      Cmd: ['sh', '-c', `tmux list-sessions -F "${LIST_FMT}" 2>/dev/null || true`],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 8_000,
    });
    out = r.stdout;
  } catch {
    return []; // 容器刚停/exec 失败：按 0 会话
  }
  const rows: TermSessionView[] = [];
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const [att, created, ...path] = lines[i].slice(m[0].length).split('|');
    // title 行 = 主行的下一行（不命中主行 re 即消费；缺失/为空 → 无 title）。
    const next = lines[i + 1];
    const title = next && !re.exec(next) ? next : undefined;
    if (title !== undefined) i++;
    rows.push({
      kind: 'container',
      containerId: id,
      termId: m[1],
      attached: Number(att) || 0,
      created: (Number(created) || 0) * 1000,
      cwd: path.join('|') || undefined,
      title: title || undefined,
    });
  }
  return rows;
}

// 会话对话框的「结束会话」：真杀（幂等，会话已不在则报错忽略）。= 前缀精确匹配——
// tmux 的 -t 默认按前缀/通配匹配（见 reapOrphanClients 注释的教训），裸名字有误伤邻会话面。
// activeCount 同步清，别让本进程的多窗口计数泄漏。
export async function killContainerSession(cfg: Config, id: string, termId: string): Promise<void> {
  const session = sessionName(id, termId);
  activeCount.delete(session);
  try {
    await execRun(cfg, id, {
      Cmd: ['tmux', 'kill-session', '-t', `=${session}`],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 5_000,
    });
  } catch {
    /* 会话/容器已没了就忽略 */
  }
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
    // from = 分屏来源 pane 的 termId（前端仅分屏时传）：新会话首次创建时继承源 pane 的
    // 当前目录（tmux 跟踪前台进程 cwd，#{pane_current_path} 即权威值）。普通连接不带，
    // 落默认 /home/dev。TERMID_RE 校验防注入（进 tmux target 与会话名拼接）。
    const from = q.from && TERMID_RE.test(q.from) ? q.from : '';
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
      const oldSession = `${OLD_SESSION_PREFIX}${id.slice(0, 8)}-${termId}`;
      const pidfile = `/tmp/${PIDFILE_PREFIX}${id.slice(0, 8)}-${Math.random().toString(36).slice(2, 10)}.pid`;
      // 认领：把本次连接的 pidfile 登记为「活」，reaper 据此跳过它（绝不误杀本 tab / 其它 tab）。
      activePidfiles.add(pidfile);
      // 活连接计数 +1。多窗口同 termId 时计数 >1。
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
      let wantKill = false; // 收到过 kill 帧（点 ✕）：断开时即杀会话而非纯 detach
      let closed = false;

      // 统一收尾（幂等）。断连时序：杀 attach 客户端进程（保留会话）→ 释放 pidfile 认领
      // → 最后一个连接走时按 wantKill 决定即杀或纯 detach（真 tmux 语义：非显式 kill 不清会话，
      // 见文件头）。exec 串未跑完就断连时 killExecClient 照发（容器里 sh 可能还没写 pidfile，
      // 脚本 cat 不到就退出，无害），不会因早断而漏收尾。
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
        // 计数一律扣（与上面的 +1 对应；exec 串没跑完就断连也得扣，否则计数泄漏）。
        const n = (activeCount.get(session) ?? 1) - 1;
        if (n > 0) {
          activeCount.set(session, n);
        } else if (useTmuxRef.v && wantKill) {
          // 最后一个连接断了且是显式 kill：即杀（killSession 内部会 delete 计数）。
          void killSession(cfg, id, session);
        } else {
          // 纯 detach（刷新/掉线/非最后连接）：会话保留，计数清 0——
          // 否则下次重连 get 到旧值 1、+1 变 2（实际只 1 个连接），多窗口判定会错。
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
              // （最后一个连接时）或只 detach（别的窗口还活着时）。
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
      // 分屏（from 参数）：新会话若需要新建，cwd 继承源 pane 的当前目录。tmux 跟踪 pane
      // 前台进程的 cwd（opencode 运行中 = 其启动目录；shell 待机 = zsh 当前目录），
      // #{pane_current_path} 即权威值。只在 from 存在时多这一次 exec（普通连接零开销）；
      // 源会话已死/查询失败一律静默落默认 /home/dev。list-panes 而非 display-message：
      // 后者对无 attach client 上下文的会话返回空串（files.ts 同款结论）；target 带
      // 「=会话名:」（capture-pane 的教训：3.4 按会话+窗口精确解析，纯名字有歧义面）。
      let splitCwd = '';
      if (useTmux && from) {
        try {
          const r = await execRun(cfg, id, {
            Cmd: [
              'sh', '-c',
              'tmux list-panes -t "=$1:" -F "#{pane_active} #{pane_current_path}" 2>/dev/null | sed -n "s/^1 //p"',
              'sh', sessionName(id, from),
            ],
            User: '1000:1000',
            Tty: false,
            timeoutMs: 8_000,
          });
          const cwd = r.stdout.trim();
          if (cwd.startsWith('/')) splitCwd = cwd;
        } catch {
          /* 源会话不在/容器抖动：落默认 home */
        }
      }
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
//      set-environment -g LANG C.UTF-8：tmux server 是守护进程、全局环境在首次启动时冻结
//     （update-environment 默认不含 LANG），之后 exec 带的 LANG 传不进已运行的 server——
//     修复前起的 server 其新 pane 仍会落在 C locale（提示符 » 显示成 _、编辑残留幽灵字符，
//     见 engine/lxc.ts attachArgs 的 locale 注释），每次 attach 钉一次补漏。
//      new-session -e COLORTERM=truecolor：claude 等 TUI 按 COLORTERM 判色深（truecolor
//     vs 256 色，后者配色被吸附到 256 色板、明显发淡），而 web 链路外层 xterm.js 本就支持
//     真彩。不能靠 exec Env 直传（update-environment 不含 COLORTERM，进不了已运行 server
//     的 pane），也不能照抄 set-environment -g（它在本脚本里排在 new-session 之后，新建
//     会话的首个 pane 已按旧全局环境快照落 env、恰好漏掉）——-e 落在 session env 上，
//     首 pane 起就有，会话内所有 pane/窗口全继承。Env 数组里的同名值是给非 tmux 兜底
//     shell 和「server 首启继承」用的。
  //      set -as terminal-overrides Ms + set -g set-clipboard on：打通 OSC 52（剪贴板）转发。
  //     TUI 应用（opencode 等）在容器内没有 X/Wayland，xclip/wl-copy 全失败，唯一的复制通道
  //     是「请终端代写剪贴板」的 OSC 52——但 tmux 默认不转发它（terminfo 无 Ms 能力时直接
  //     丢弃），应用还照样提示「已复制」（发序列是火后不管的）。Ms override 让 tmux 相信
  //     外层终端支持剪贴板；set-clipboard 必须 on（external 只转发 tmux 自己的 buffer 操作、
  //     忽略 pane 内应用发的序列——实测对照过）；前端 Terminal.vue 的 registerOscHandler(52)
  //     接住转发来的序列写 navigator.clipboard，三方接通。
  //      set -g history-limit 50000：pane 历史默认仅 2000 行，长输出（claude -h 等）很快被
  //     截断；前端 scrollback 10000，历史上限给足余量（回填见下方 capture）。
  //      set -sg escape-time 10：默认 500ms——tmux 收到裸 ESC 后等这么久判断「是 ESC 键
  //     还是序列开头」，按 ESC 打断 opencode/vim 要迟 0.5s 才生效、快速连按还会在等待
  //     窗口内互相吞并，表现为「ESC 没反应」（实测容器 server 恒为默认 500，代码从未设过）。
  //     web 链路上 xterm.js 每次按键独立成帧、序列字节原子到达，10ms 合并窗口绰绰有余
  //     且人不可感。
  //      set -t "=$1" set-titles on + set-titles-string '#T'：**tab 标题链路的 tmux 侧**。
  //     pane 内程序发的 OSC 0/2（shell 钩子的执行命令/空闲路径、CC/opencode 的任务标题）
  //     被 tmux 截获存成 pane title（#T），默认 set-titles off 不往外层转发——web 终端
  //     tab 一直显示固定容器名、CC 标题到不了前端的根因在这。转发格式用 #T（实测 tmux
  //     3.4：OSC 0/2 只更新 pane title 不动 window name；omz 的 termsupport 在 TERM=tmux*
  //     分支发的 \ek 序列两者都不改，标题由 zshrc 钩子补发 OSC 2，见 scripts/zshrc）。
  //     session 级选项（不带 -g、-t 指定会话）：不污染用户自己开的 tmux 会话；每次 attach
  //     都设（同上面其他 set 的理由）。⚠️ target 必须 "=$1:"（带冒号）：set-option 的
  //     -t 是 target-pane，无冒号的 =名字 按 window 名解析（会话 window 名是 sh/zsh 等
  //     前台命令，实测报 no such session）；带冒号 = 精确会话 + 当前窗口（capture-pane
  //     教训同源）。
  //      set -t "=$1:" status off：tmux 状态栏自带分钟时钟，整点跳分钟重绘状态栏一格 =
  //     attach 客户端每 60s 必收一帧——「无输出提醒」的静默确认（60s）永远凑不满、
  //     提醒恒不触发（实测 lastNotable 每整 60s 重置）。web 终端有自己的 tab 栏，状态栏
  //     纯噪声；session 级不影响用户自己的会话。hostTerminal.ts 同款。
  //   3) exec tmux attach：替换进程为 attach 客户端。
  //   $1=会话名 mysandbox-<短id>-<termId>、$2=shell、$3=pidfile、$4=旧名会话 ms-<短id>-<termId>、
  //   $5=新会话 cwd（分屏继承源 pane 目录，空则落 /home/dev）。
  //   旧名存在就 rename 成新名（命名统一迁移，幂等）：rename 后立刻退出脚本防串扰，
  //   后续 has-session 命中新名。注意 set 必须在 attach 之前 detached 跑--attach 后
  //   客户端接管 tty，命令行里 ';' 接的后续 tmux 命令不再执行（实测 attach 路径下 set 不生效）。
  const cmd = useTmux
    ? [
        'sh', '-c',
        'echo $$ > "$3"; if tmux has-session -t "=$4" 2>/dev/null; then tmux rename-session -t "=$4" "$1"; fi; tmux has-session -t "$1" 2>/dev/null || tmux new-session -d -e COLORTERM=truecolor -s "$1" -c "${5:-/home/dev}" "$2"; tmux set -g mouse off 2>/dev/null; tmux set -sg escape-time 10 2>/dev/null; tmux set -g terminal-overrides "xterm*:smcup@:rmcup@" 2>/dev/null; tmux set-environment -g MYSANDBOX_WEB 1 2>/dev/null; tmux set-environment -g LANG C.UTF-8 2>/dev/null; tmux set -s allow-passthrough on 2>/dev/null; tmux set -as terminal-overrides ",xterm*:Ms=\\E]52;%p1%s;%p2%s\\007" 2>/dev/null; tmux set -g set-clipboard on 2>/dev/null; tmux set -g history-limit 50000 2>/dev/null; tmux set -t "=$1:" set-titles on 2>/dev/null; tmux set -t "=$1:" set-titles-string "#T" 2>/dev/null; tmux set -t "=$1:" status off 2>/dev/null; exec tmux attach -t "$1"',
        'sh', session, shell, pidfile, oldSession, splitCwd,
      ]
    : [shell];

      // ---- 历史回填 ----
      // tmux attach 只重绘当前可见屏、不回放 pane 历史：刷新页面/重连后 xterm scrollback 从空
      // 开始，连接前产生的长输出「开头看不到、滚轮滚不动」（历史只在 tmux pane 里）。attach
      // 前先 capture-pane 把历史（不含当前屏）作为 {type:'history'} 文本控制帧发过去，前端
      // term.write 进 scrollback；帧先于 attach 流发出（同 socket 保序），重绘落在空视口上。
      // 会话不存在（首连）capture 失败 -> 跳过。旧名会话顺带 rename（attach 脚本同款迁移，
      // 否则 capture 找不到旧名、旧会话永远回填不到）。
      // ⚠️ target 必须是 "=$1:"（带冒号）：tmux 3.4 实测 capture-pane 的 target 按 window 解析，
      // 纯会话名（=name，无冒号）会被当 window 名匹配 -> "can't find pane" 静默失败（has-session
      // 是 session target 所以没事）。带冒号 = 精确会话 + 默认窗口，稳。
      if (useTmux) {
        try {
          const r = await execRun(cfg, id, {
            Cmd: [
              'sh', '-c',
              'if tmux has-session -t "=$2" 2>/dev/null; then tmux rename-session -t "=$2" "$1"; fi; tmux capture-pane -p -J -t "=$1:" -S -10000 -E -1 2>/dev/null',
              'sh', session, oldSession,
            ],
            User: '1000:1000',
            timeoutMs: 10_000,
          });
          const text = r.stdout.trim();
          if (text) {
            socket.send(JSON.stringify({ type: 'history', text }));
          }
        } catch {
          /* 会话不在（首连）：无历史可回填 */
        }
        // —— tab 标题恢复 ——
        // xterm 的 onTitleChange 只在流里出现 OSC 时触发；重连/刷新后 pane title 留在
        // tmux 里不会重发（capture-pane 回填的是可见文本，OSC 已被剥离）。attach 前读
        // pane_title 补发 {type:'title'} 控制帧，前端更新 tab（失败静默 = 首连/会话不在，
        // tab 落默认名）。pane title 来源：shell 钩子与 TUI 应用的 OSC 0/2（见上方 set 串
        // 的 set-titles 注释）。list-panes 而非 display-message：后者对无 attach client
        // 的会话返回空串（files.ts 同款结论）；target 带「=会话名:」（capture-pane 教训）。
        try {
          const r = await execRun(cfg, id, {
            Cmd: [
              'sh', '-c',
              'tmux list-panes -t "=$1:" -F "#{pane_active} #{pane_title}" 2>/dev/null | sed -n "s/^1 //p"',
              'sh', session,
            ],
            User: '1000:1000',
            Tty: false,
            timeoutMs: 8_000,
          });
          const title = r.stdout.trim();
          if (title) {
            socket.send(JSON.stringify({ type: 'title', text: title }));
          }
        } catch {
          /* 会话不在/容器抖动：tab 落默认名 */
        }
      }

      const exec = await execStreamRaw(cfg, id, {
        Cmd: cmd,
        User: '1000:1000',
        WorkingDir: '/home/dev',
        Env: ['TERM=xterm-256color', 'COLORTERM=truecolor', 'MYSANDBOX_WEB=1'],
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
