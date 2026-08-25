// 宿主终端：WS /ws/host-terminal?token=&shell=&cols=&rows=&termId=（无容器 id）。
//
// 与 terminal.ts（容器终端）同协议、同语义（60s 宽限、kill 帧、activeCount 多窗口），
// 但 PTY 由本进程在宿主侧管理，不走 lxc-attach：
//   - 宿主 tmux 用专用 socket `-L mysandbox-host`（不碰用户自己的 tmux server），会话名 h-<termId>；
//   - `script(1)` 给 `tmux attach` 提供 PTY（node 无内置 pty，不引 native 依赖）；script 进程
//     退出 = detach，会话保留——刷新重连同 termId 即复活（对齐容器终端）；
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
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { ChildProcess } from 'node:child_process';
import { TERMID_RE } from './terminal.js';
import { notFound, badRequest } from './errors.js';

const execFileAsync = promisify(execFile);

// 宿主专用 tmux socket 名（-L）。与用户自己的 tmux server 完全隔离。
export const HOST_SOCKET = 'mysandbox-host';

// 宿主会话名：h-<termId>。与容器侧 ms-<短id>-<termId> 区分。
export function hostSessionName(termId: string): string {
  return `h-${termId}`;
}

// 遗弃会话宽限期（对齐容器终端 GRACE_MS）。
const GRACE_MS = 60_000;
// resize 尾沿防抖：拖窗时前端每帧发 resize，不防抖 = 每秒几十个 stty 进程。
const RESIZE_DEBOUNCE_MS = 120;

// 每个会话的活连接数（多窗口同 termId）与宽限定时器，语义同 terminal.ts。
const activeCount = new Map<string, number>();
const graceTimers = new Map<string, NodeJS.Timeout>();

// 本进程派生的全部 script 子进程：node 退出（含 tsx watch 热重启）时同步 SIGKILL，
// 否则遗留 script 进程拿着 pts 挂在 tmux server 上（=幽灵 attach 客户端，卡 stale 80x24）。
const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
  }
});

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

// 当前会话的客户端 pts 列表（`=` 前缀精确匹配，防 tmux 前缀匹配串到别的 termId）。
async function clientTtys(session: string): Promise<string[]> {
  const r = await hostTmux(['list-clients', '-t', `=${session}`, '-F', '#{client_tty}']);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/dev/'));
}

async function killSession(session: string): Promise<void> {
  cancelGrace(session);
  activeCount.delete(session);
  await hostTmux(['kill-session', '-t', `=${session}`]);
}

function armGrace(session: string): void {
  cancelGrace(session);
  const t = setTimeout(() => {
    graceTimers.delete(session);
    // 二次校验用 tmux 而非进程内 activeCount：同用户多实例共用 host socket 时，
    // 别的实例可能还挂着 client（tmux 是跨实例真相源）。
    void clientTtys(session).then((ttys) => {
      if (ttys.length === 0 && (activeCount.get(session) ?? 0) === 0) {
        return killSession(session);
      }
    });
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

// 启动清扫：node 重启导致旧连接的宽限定时器随进程而死，无 client 的遗留会话永不回收。
// 不直接杀——重启后 60s 内刷新重连应复活（与容器终端语义一致）：重挂宽限即可。
// tmux server 随最后一个会话结束自动退出，无 daemon 泄漏。
async function reapHostSessions(): Promise<void> {
  const r = await hostTmux(['list-sessions', '-F', '#{session_name}']);
  if (!r.ok) return;
  for (const name of r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const ttys = await clientTtys(name);
    if (ttys.length === 0) armGrace(name);
  }
}

// 周期清扫（每 60s）：孤儿 script（别的 node 实例留下的、被 SIGKILL 的）死亡后 client 消失，
// 但没有任何进程给这个会话挂宽限——启动清扫只在启动时跑一次盖不住这种延迟孤儿（实测踩过：
// 旧进程留下的孤儿 script 在新进程起来后才死，会话永挂）。armGrace 幂等且到期二次校验
// clientTtys——活跃会话（用户 60s 内又连上）不会被误杀；有 client 的会话这里根本不碰。
function startReapLoop(): void {
  const t = setInterval(() => {
    void reapHostSessions();
  }, 60_000);
  t.unref(); // 不阻止进程退出
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

export async function registerHostTerminal(app: FastifyInstance, cfg: Config): Promise<void> {
  const log = app.log;
  void reapHostSessions();
  startReapLoop();

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
        cancelGrace(session);
        activeCount.set(session, (activeCount.get(session) ?? 0) + 1);
        const has = await hostTmux(['has-session', '-t', `=${session}`]);
        if (!has.ok) {
          // 新建 detached 会话（-A 语义手写：有则直接 attach 走下面）。尺寸用 URL 值，
          // attach 后 client 会按自身 pts 尺寸再调——初始 stty 已提前落盘，值一致。
          await hostTmux(['new-session', '-d', '-s', session, '-x', String(cols), '-y', String(rows), '-c', cwd]);
          // 与容器终端同组的全局设置，必须在 attach 之前 detached 跑（attach 后客户端接管 tty）。
          await hostTmux(['set', '-g', 'mouse', 'off']);
          await hostTmux(['set', '-g', 'terminal-overrides', 'xterm*:smcup@:rmcup@']);
          await hostTmux(['set-environment', '-g', 'MYSANDBOX_WEB', '1']);
          await hostTmux(['set', '-s', 'allow-passthrough', 'on']);
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
      // script 先退（用户 C-b d detach / 会话被杀 / shell exit）→ 视为 detach，走宽限分支。
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
        } else if (useTmux) {
          activeCount.set(session, 0);
          if (wantKill) void killSession(session);
          else armGrace(session);
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
        // 展开，把 attach 目标 "=h-xxx" 当命令路径查找（zsh:1: h-xxx not found）——实测踩坑。
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
        // script 先退 = detach（C-b d / 会话被杀 / shell exit）：以 1000 关 socket，走宽限收尾。
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
