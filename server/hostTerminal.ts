// 宿主终端：WS /ws/host-terminal?token=&shell=&cols=&rows=&termId=（无容器 id）。
//
// 与 terminal.ts（容器终端）同协议（kill 帧、resize/心跳、多窗口），会话生命周期也是同一套
// **真 tmux 语义**：会话只被显式 kill（前端 ✕）或 shell 自己退出终结；断线、关浏览器、
// 服务重启一概保留，无任何定时清理——「只要服务还在，用户开的会话就活着」，
// PTY 由本进程在宿主侧管理，不走 lxc-attach：
//   - 宿主 tmux 用专用 socket `-L mysandbox-host`（不碰用户自己的 tmux server），会话名 h-<termId>；
//   - tmux server 必须活在 mysandbox.service 的 cgroup **之外**（--scope 瞬态单元，
//     见 HOST_TMUX_UNIT 注释）：服务重启时 systemd 按 KillMode=control-group 清空
//     整个 cgroup，server 留在里面 = 全部会话陪葬——「tmux 与服务解耦」就名存实亡；
//   - `script(1)` 给 `tmux attach` 提供 PTY（node 无内置 pty，不引 native 依赖）；script 进程
//     退出 = detach，会话保留——刷新重连同 termId 即复活；
//   - resize：script 的 pts 上 `stty -F <pts> cols N rows M`（实测 tmux 3.4 的 refresh-client
//     不支持 -x/-y）。初始尺寸在 attach 前就 stty 落盘，防 shrink-then-grow 重排。
//
// 会话 cwd = 宿主 home。
//
// 降级：宿主无 tmux → script 直接跑 shell（一次性，断开即死、无宽限）；无 script → 报错关闭。
// token 本就等价宿主 leon 用户（uid 1000 直通，见 CLAUDE.md 安全模型），宿主终端不扩大
// 权限面，只是把它摆上 UI。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { ChildProcess } from 'node:child_process';
import { TERMID_RE, LIST_FMT, type TermSessionView } from './terminal.js';
import { notFound, badRequest, HttpError } from './errors.js';

const execFileAsync = promisify(execFile);

// 宿主专用 tmux socket 名（-L）。与用户自己的 tmux server 完全隔离。
export const HOST_SOCKET = 'mysandbox-host';

// 宿主 tmux server 的宿主 scope 名：server 若直接从本进程 fork 出来，会落进
// mysandbox.service 的 cgroup，服务重启时被 systemd 连带清杀（KillMode=
// control-group）——全部会话陪葬，「tmux 与服务解耦」名存实亡（与 lxc.ts 给
// lxc-start 套 systemd-run 同因同解）。但注意形态差异：lxc-start 用 -F 前台
// 常驻、跑在 service 单元里没问题；`new-session -d` 的 client 毫秒级退出，
// service 单元随之完成、systemd 清空 cgroup，刚 fork 的 server 陪葬（实测：
// attach 直收 "no sessions"）。所以必须 --scope：不监督进程，client 退出后
// scope 变 abandoned，只要 server 还活着 scope 就保持。--collect 让 scope 随
// 最后进程退出自动回收；server 本身随最后一个会话结束自动退出，无泄漏。
const HOST_TMUX_UNIT = 'mysandbox-host-tmux.scope';

// 宿主会话名：mysandbox-host-<termId>。与容器侧 mysandbox-<短id>-<termId> 同前缀，
// 一眼可辨归属（tmux ls 里全是 mysandbox-*）。历史前缀 h- 的活会话由 hostNewSession
// 自动 rename 迁移（见 OLD_HOST_PREFIX），升级无感。
export function hostSessionName(termId: string): string {
  return `mysandbox-host-${termId}`;
}
// 旧版宿主会话名前缀（统一命名前用 h-）。首连探测到旧名会话就 rename 成新名。
const OLD_HOST_PREFIX = 'h-';

// 会话名见 hostSessionName。无宽限期、无周期清扫（语义见文件头）；activeCount 只用于
// 多窗口计数，最后一个连接断开 = 纯 detach。
// resize 尾沿防抖：拖窗时前端每帧发 resize，不防抖 = 每秒几十个 stty 进程。
const RESIZE_DEBOUNCE_MS = 120;

// 每个会话的活连接数（多窗口同 termId）。
const activeCount = new Map<string, number>();

// 本进程派生的全部 script 子进程：node 退出（含 tsx watch 热重启）时同步 SIGKILL，
// 否则遗留 script 进程拿着 pts 挂在 tmux server 上（=幽灵 attach 客户端，卡 stale 80x24）。
// ⚠️ exit 事件只覆盖「正常跑完/显式 process.exit」；SIGINT/SIGTERM 默认直接终死进程、
// **不触发 exit**（实测踩坑：手动 Ctrl+C 的 dev 实例泄漏了一个 script，之后它在的会话
// 永远 attached=1，会话对话框满屏假「使用中」）。所以信号也挂：收到即同步杀子进程再退出。
const children = new Set<ChildProcess>();
const killChildren = () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
  }
};
process.on('exit', killChildren);
process.on('SIGINT', () => { killChildren(); process.exit(130); });
process.on('SIGTERM', () => { killChildren(); process.exit(143); });

// 环境探测缓存：'tmux' | 'plain' | 'none'（none=连 script 都没有，无 PTY 可给）。
let envCache: 'tmux' | 'plain' | 'none' | null = null;

async function detectEnv(): Promise<'tmux' | 'plain' | 'none'> {
  if (envCache) return envCache;
  const has = async (cmd: string) => {
    try { await execFileAsync('sh', ['-c', `command -v ${cmd}`]); return true; }
    catch { return false; }
  };
  if (!(await has('script'))) envCache = 'none';
  else if (await has('tmux')) envCache = 'tmux';
  else envCache = 'plain';
  return envCache;
}

// 宿主 shell 解析：容器镜像默认 zsh、宿主未必有。逐个 command -v，全没有则 zsh（让 script 报错可见）。
async function resolveHostShell(want: string): Promise<string> {
  for (const s of [want, 'bash', 'sh']) {
    try {
      await execFileAsync('sh', ['-c', `command -v ${s}`]);
      return s;
    } catch { /* 试下一个 */ }
  }
  return want;
}

// 跑一条宿主 tmux 命令（专用 socket）。tmux 报 no server running 等一律按失败返回，
// 调用方按「无会话」处理——宿主 tmux server 只在有会话时存在。
async function hostTmux(
  args: string[],
  timeoutMs = 5_000,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('tmux', ['-L', HOST_SOCKET, ...args], {
      timeout: timeoutMs,
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

// 创建 detached 会话——server 的拉起点。⚠️ 只在 server 尚不存在时走 systemd-run
// --scope（见 HOST_TMUX_UNIT 注释）：scope 已 loaded（server 活着、别的 termId 会话
// 在用）时 systemd-run 必失败（"unit already active"）。server 已活则普通
// new-session 即可，不会重复拉起 server。
// 旧名（h-<termId>）会话若在，先 rename 成新名——统一命名前的活会话迁移，用户无感。
async function hostNewSession(session: string, cols: number, rows: number, cwd: string): Promise<boolean> {
  const alive = await hostTmux(['has-session', '-t', `=${session}`]);
  if (alive.ok) return true; // 会话已在，直接 attach 路径（调用方语义）
  const old = `${OLD_HOST_PREFIX}${session.slice('mysandbox-host-'.length)}`;
  const oldAlive = await hostTmux(['has-session', '-t', `=${old}`]);
  if (oldAlive.ok) {
    await hostTmux(['rename-session', '-t', `=${old}`, session]);
    return true;
  }
  const hasServer = (await hostTmux(['list-sessions', '-F', '#{session_name}'])).ok;
  const argv = ['new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows), '-c', cwd];
  if (hasServer) {
    return (await hostTmux(argv)).ok;
  }
  try {
    await execFileAsync(
      'systemd-run',
      ['--user', '--collect', `--unit=${HOST_TMUX_UNIT}`, '--scope', 'tmux', '-L', HOST_SOCKET, ...argv],
      { timeout: 5_000 },
    );
    return true;
  } catch {
    // scope 已被并发首连拉起（unit already active）：此刻 server 已活，退回普通 new-session。
    return (await hostTmux(argv)).ok;
  }
}

// 当前会话的客户端 pts 列表（`=` 前缀精确匹配，防 tmux 前缀匹配串到别的 termId）。
async function clientTtys(session: string): Promise<string[]> {
  const r = await hostTmux(['list-clients', '-t', `=${session}`, '-F', '#{client_tty}']);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/dev/'));
}

async function killSession(session: string): Promise<void> {
  activeCount.delete(session);
  await hostTmux(['kill-session', '-t', `=${session}`]);
}

// script 子进程的控制终端 pts（`ps -o tty=` 输出 pts/N 或 ?）。拿不到给 stty 落初始尺寸用。
// script 自己的 controlling tty 继承自 node（无 tty），ps -o tty= 查它永远返回 '?'；
// 它为命令开的 pts 挂在**子进程**（sh -c tmux ...）身上。所以查子进程的 tty。
// 子进程起得稍晚，调用方轮询重试。
function childTty(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('ps', ['-o', 'tty=', '--ppid', String(pid)], { timeout: 2_000 }, (err, stdout) => {
      const t = (stdout ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && l !== '?');
      resolvePromise(!err && t ? `/dev/${t}` : null);
    });
  });
}

// stty 改 pts 尺寸（发 SIGWINCH 给 pty 前台进程组，tmux client 随即感知）。
async function applyTtySize(pts: string, cols: number, rows: number): Promise<void> {
  try {
    await execFileAsync('stty', ['-F', pts, 'cols', String(cols), 'rows', String(rows)], {
      timeout: 2_000,
    });
  } catch { /* pts 可能刚随 detach 消失 */ }
}

// —— 会话发现（/api/terminal-sessions，routes.ts 组合容器侧，见 terminal.ts 的说明）——
// 只扫宿主专用 socket（-L mysandbox-host）：用户自己的 tmux server 完全不碰。
// 新名 mysandbox-host-<termId> + 旧名 h-<termId>（统一命名迁移前的活会话，连接时才 rename）。
export async function listHostSessions(): Promise<TermSessionView[]> {
  const r = await hostTmux(['list-sessions', '-F', LIST_FMT]);
  if (!r.ok) return []; // server 不在（无任何会话）等：按 0 会话
  const rows: TermSessionView[] = [];
  const re = /^(?:mysandbox-host|h)-([A-Za-z0-9_-]{4,64})\|/;
  for (const line of r.stdout.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const [att, created, ...path] = line.slice(m[0].length).split('|');
    rows.push({
      kind: 'host',
      termId: m[1],
      attached: Number(att) || 0,
      created: (Number(created) || 0) * 1000,
      cwd: path.join('|') || undefined,
    });
  }
  return rows;
}

// 会话对话框的「结束会话」（宿主侧）。= 精确匹配防 tmux 前缀匹配误伤；activeCount 同步清。
export async function killHostSession(termId: string): Promise<void> {
  const session = hostSessionName(termId);
  activeCount.delete(session);
  await hostTmux(['kill-session', '-t', `=${session}`]);
}

export async function registerHostTerminal(app: FastifyInstance, cfg: Config): Promise<void> {
  const log = app.log;

  // 宿主终端信息条：会话活跃 pane 的 cwd（前端轮询）。list-panes 而非 display-message，
  // 同 files.ts 容器版的原因：后者对无 attach client 上下文的会话返回空串。
  app.get('/api/host-terminal/cwd', async (req): Promise<{ cwd: string }> => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const r = await hostTmux([
      'list-panes', '-t', `=${hostSessionName(termId)}`, '-F', '#{pane_active} #{pane_current_path}',
    ]);
    if (!r.ok) throw notFound('terminal session not found');
    const cwd = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('1 '))
      ?.slice(2) ?? '';
    if (!cwd || !cwd.startsWith('/')) throw notFound('terminal session not found');
    return { cwd };
  });

  // 终端路径链接解析（Ctrl+点击打开）的宿主侧：与 files.ts 容器版 /resolve 一比一
  // （kind 语义、404 条件），前端经 HOST_ID 哨兵自动路由到这里。~ 展开用 homedir()
  // （宿主会话 shell 的 $HOME 与 server 运行用户一致）；归一用 node:path.resolve
  // （与容器侧 readlink -m 的差异是不解析 symlink——stat/readFile 探测与读取本就跟随
  // 链接，无害）。探测错误语义对齐 hostFiles：ENOENT/ENOTDIR=missing，EACCES=403。
  app.get('/api/host-terminal/resolve', async (req): Promise<{ path: string; kind: 'dir' | 'file' | 'missing' }> => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const raw = q.path;
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\n') || raw.length > 4096) {
      throw badRequest('invalid path');
    }
    const r = await hostTmux([
      'list-panes', '-t', `=${hostSessionName(termId)}`, '-F', '#{pane_active} #{pane_current_path}',
    ]);
    if (!r.ok) throw notFound('terminal session not found');
    const cwd = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('1 '))
      ?.slice(2) ?? '';
    if (!cwd || !cwd.startsWith('/')) throw notFound('terminal session not found');
    const home = homedir();
    const base =
      raw === '~' ? home : raw.startsWith('~/') ? home + raw.slice(1) : raw.startsWith('/') ? raw : `${cwd}/${raw}`;
    const p = resolvePath(base);
    let kind: 'dir' | 'file' | 'missing';
    try {
      kind = (await stat(p)).isDirectory() ? 'dir' : 'file';
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') kind = 'missing';
      else throw new HttpError(403, (e as Error).message || 'permission denied', 'forbidden');
    }
    return { path: p, kind };
  });

  app.get('/ws/host-terminal', { websocket: true }, async (socket, req) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const shell = q.shell || cfg.ui.defaultShell;
    const cols = Math.min(500, Math.max(1, Number(q.cols) || 80));
    const rows = Math.min(500, Math.max(1, Number(q.rows) || 24));
    const termId = q.termId;
    if (!termId || !TERMID_RE.test(termId)) {
      socket.close(1008, 'missing or invalid termId');
      return;
    }
    if (process.platform !== 'linux') {
      socket.close(1008, 'host terminal is linux-only');
      return;
    }

    try {
      const env = await detectEnv();
      if (env === 'none') {
        socket.send(Buffer.from('\x1b[31m>> 宿主缺少 script(1)，无法提供 PTY\x1b[0m\r\n'));
        socket.close(1011, 'script(1) not available');
        return;
      }
      const useTmux = env === 'tmux';

      // 会话 cwd = 宿主 home。
      const cwd = homedir();

      const session = hostSessionName(termId);
      if (useTmux) {
        activeCount.set(session, (activeCount.get(session) ?? 0) + 1);
        // 新建 detached 会话（-A 语义手写：有则直接 attach 走下面）。尺寸用 URL 值，
        // attach 后 client 会按自身 pts 尺寸再调——初始 stty 已提前落盘，值一致。
        // server 可能不存在（首连）→ hostNewSession 走 systemd-run 独立单元拉起。
        const created = await hostNewSession(session, cols, rows, cwd);
        if (created) {
          // 与容器终端同组的全局设置，必须在 attach 之前 detached 跑（attach 后客户端接管 tty）。
          await hostTmux(['set', '-g', 'mouse', 'off']);
          await hostTmux(['set', '-g', 'terminal-overrides', 'xterm*:smcup@:rmcup@']);
          await hostTmux(['set-environment', '-g', 'MYSANDBOX_WEB', '1']);
          await hostTmux(['set', '-s', 'allow-passthrough', 'on']);
          // OSC 52（剪贴板）转发打通：Ms override + set-clipboard on（external 不转发 pane
          // 内应用发的序列，实测对照过）。背景见 terminal.ts 的同名注释。
          await hostTmux(['set', '-as', 'terminal-overrides', ',xterm*:Ms=\\E]52;%p1%s;%p2%s\\007']);
          await hostTmux(['set', '-g', 'set-clipboard', 'on']);
        }
      }

      // ---- 派生 script + 提前挂监听（同 terminal.ts 的教训：await 串几百 ms 内到达的帧不能丢）----
      let child: ChildProcess | null = null;
      let pendingResize: { cols: number; rows: number } | null = null;
      let lastSize = '';
      let resizeTimer: NodeJS.Timeout | null = null;
      let wantKill = false;
      let closed = false;

      // 统一收尾（幂等）。socket 先断 → 杀 script（SIGTERM，500ms 未退 SIGKILL）；
      // script 先退（用户 C-b d detach / 会话被杀 / shell exit）→ 以 1000 关 socket。
      // 不做定时清理（见文件头）：非 kill 断开 = 纯 detach，会话无限期保留。
      // 注意 children.delete 只在 child 'exit' 里做（cleanup 不主动删）：script 收 TERM 后要
      // ~2s 才真退，期间若 node 被 kill（重启），500ms 的 SIGKILL 定时器随进程死，只有
      // exit handler 的同步 SIGKILL 能兜住——Set 里必须还留着引用（实测踩过孤儿泄漏）。
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (resizeTimer) clearTimeout(resizeTimer);
        if (child) {
          try { child.kill('SIGTERM'); } catch { /* noop */ }
          const c = child;
          setTimeout(() => {
            try { c.kill('SIGKILL'); } catch { /* noop */ }
          }, 500).unref();
        }
        const n = (activeCount.get(session) ?? 1) - 1;
        if (n > 0) {
          activeCount.set(session, n);
        } else {
          activeCount.set(session, 0);
          if (wantKill && useTmux) void killSession(session);
        }
      };

      socket.on('message', (data: unknown, isBinary?: boolean) => {
        if (isBinary === false || typeof data === 'string') {
          // 文本帧=控制 JSON；前端 15s 心跳发空文本帧，靠 parse 失败分支静默消化。
          try {
            const text = typeof data === 'string' ? data : (data as Buffer).toString();
            const m = JSON.parse(text) as { type: string; cols?: number; rows?: number };
            if (m.type === 'resize') {
              const size = { cols: m.cols ?? 80, rows: m.rows ?? 24 };
              // 记下最新尺寸：初始 pts 轮询（下方）在 attach 前后都可能发生，
              // 期间到达的 resize 帧是唯一真实的尺寸来源（URL 值可能是 xterm 默认 80x24）。
              pendingResize = size;
              // 尾沿防抖 + 尺寸不变跳过：拖窗每帧都发，逐帧 spawn stty 太浪费。
              if (`${size.cols}x${size.rows}` === lastSize) return;
              if (resizeTimer) clearTimeout(resizeTimer);
              resizeTimer = setTimeout(() => {
                resizeTimer = null;
                // 多窗口同 termId 时每个 attach client 的 pts 都要改。
                void clientTtys(session).then((ttys) => {
                  if (ttys.length === 0) {
                    // attach 未完成（会话刚建、script 还没连上）：这帧不丢——
                    // pendingResize 已存，等下方初始轮询拿到 pts 后一并落盘。
                    lastSize = '';
                    return;
                  }
                  lastSize = `${size.cols}x${size.rows}`;
                  for (const pts of ttys) void applyTtySize(pts, size.cols, size.rows);
                });
              }, RESIZE_DEBOUNCE_MS);
            } else if (m.type === 'kill') {
              wantKill = true;
              try { socket.close(1000); } catch { /* noop */ }
            }
          } catch {
            /* ignore bad control frame / heartbeat */
          }
          return;
        }
        try {
          child?.stdin?.write(data as Buffer);
        } catch { /* script 已死 */ }
      });
      socket.on('close', cleanup);
      socket.on('error', cleanup);

      // script 提供 PTY。`-f` 防 script 在非 tty stdout 下缓冲输出；命令内容是常量 +
      // 正则校验过的 termId（TERMID_RE 无 shell 元字符），单字符串 -c 无注入面。
      const cmd = useTmux ? `tmux -L ${HOST_SOCKET} attach -t =${session}` : await resolveHostShell(shell);
      child = spawn('script', ['-q', '-f', '-e', '-c', cmd, '/dev/null'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // SHELL 必须压成 /bin/sh：script 用 $SHELL 跑 -c 命令串，用户登录 zsh 会做 =word
        // 展开，把 attach 目标 "=mysandbox-host-xxx" 当命令路径查找（zsh:1: not found）——实测踩坑。
        env: { ...process.env, TERM: 'xterm-256color', MYSANDBOX_WEB: '1', SHELL: '/bin/sh' },
        cwd: useTmux ? undefined : cwd, // 无 tmux 降级时 shell 直接落在镜像目录
      });
      children.add(child);
      // 三流都挂 error：script 死后前端再发 stdin 会 EPIPE，不吞会崩整个 mysandbox。
      child.stdin?.on('error', () => { /* noop */ });
      child.stdout?.on('error', () => { /* noop */ });
      child.stderr?.on('error', () => { /* noop */ });

      child.stdout?.on('data', (d: Buffer) => {
        if (socket.readyState === 1) socket.send(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (socket.readyState === 1) socket.send(d);
      });
      child.on('exit', () => {
        children.delete(child!);
        // script 先退 = detach（C-b d / 会话被杀 / shell exit）：以 1000 关 socket。
        try { socket.close(1000); } catch { /* noop */ }
        cleanup();
      });
      child.on('error', (e) => {
        log.warn({ err: e }, 'host terminal script spawn failed');
        try { socket.close(1011, 'script spawn failed'); } catch { /* noop */ }
        cleanup();
      });

      // 初始尺寸：script 的 pts 默认 80x24，attach 后会话被缩到 80x24 再等 resize 帧——
      // shrink-then-grow 重排（Terminal.vue 容器侧同款坑）。attach 前轮询拿到 pts 立刻 stty，
      // SIGWINCH 先行，client attach 时读到的就是真实尺寸。每次迭代重读 pendingResize：
      // 轮询期间到达的 resize 帧比 URL 初值更新（URL 可能还是 xterm 默认 80x24）。
      if (useTmux) {
        for (let i = 0; i < 10; i++) {
          const tty = await childTty(child.pid!);
          if (tty) {
            const init = pendingResize ?? { cols, rows };
            await applyTtySize(tty, init.cols, init.rows);
            lastSize = `${init.cols}x${init.rows}`;
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    } catch {
      try { socket.close(1011, 'host terminal error'); } catch { /* noop */ }
    }
  });
}
