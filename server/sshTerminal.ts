// SSH 终端：WS /ws/ssh-terminal?target=&termId=&cols=&rows=&from=（远程主机）。
//
// 定位刻意收窄（与产品概念的分界）：远程主机不是被管理对象——无 OSC 深链、无活动扫描
// （无输出提醒）、不进批量操作/hosts/mysandbox status。文件面板是刻意保留的例外（四足
// 鼎立的第四足）：/api/ssh/:name/*（sshFiles.ts，通道经 sshChannel.ts 的宿主 ssh），
// 终端本体之外只补文件浏览/编辑这一件事。除本机外，终端区的其他主机条目来自这里的
// targets CRUD（存 sidecar state.json，UI 可增删，不动用户手改的 config.yaml）。
//
// 会话语义与宿主终端（hostTerminal.ts）同构，差别只在会话本体搬到了**远端**：
//   - 远端 tmux 用专用 socket `-L mysandbox-ssh`（不碰远端用户自己的 tmux server），
//     会话名 mysandbox-ssh-<termId>；
//   - 会话在远端 tmux server 里，本地断开/刷新/mysandbox 重启一律纯 detach、无限期
//     保留（远端 server 自管生命周期，无本地 cgroup 归属问题，也不需要 systemd-run）；
//   - PTY 链：script(1)（本机，与宿主终端同款）→ ssh client → 远端 tmux attach。
//     resize：stty 改本机 ssh client 的 pts → ssh 收 SIGWINCH 转发远端，同构成立；
//   - 凭据全走宿主 ssh（keys / agent / ~/.ssh/config 别名含跳板），零新增存储。
//     后台命令（建会话/扫描）带 BatchMode=yes 快败——密码/口令认证的目标后台失败
//     不挡连接：attach 命令用 `new-session -A` 兜底，在终端里交互应答（输密码）
//     也能建出会话，只是那条路径来不及注入 tmux 设置（可接受降级，下连即修复——
//     重建走标准链）。
//
// 注入面：host/user/port 只收无 shell 元字符的白名单字符集（见 SSH_HOST_RE），
// 会话名经 TERMID_RE 校验，attach 命令串其余全为常量——script -c 单串无注入面。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ChildProcess } from 'node:child_process';
import { TERMID_RE, LIST_FMT, type TermSessionView } from './terminal.js';
import { badRequest, conflict, notFound } from './errors.js';
import { addSshTarget, deleteSshTarget, getSshTargets, type SshTarget } from './state.js';
import { children, childTty, applyTtySize, detectEnv } from './hostTerminal.js';

const execFileAsync = promisify(execFile);

// 远端专用 tmux socket 名与会话前缀（远端 ls 里全是 mysandbox-*，一眼可辨归属）。
export const SSH_SOCKET = 'mysandbox-ssh';
const SSH_SESSION_PREFIX = 'mysandbox-ssh-';

// 目标名校验（标识 + 显示名；进 WS query 与 state key）。导出：sshFiles.ts 的
// requireTarget 同一防线（文件端点的 :name 同源校验）。
export const SSH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
// 目的地字符集白名单：无空白与 shell 元字符（host 串会进 script -c 命令串，这是
// 注入面的总闸）。覆盖 host / user@host / IPv6 [::1] 形态；ssh config 的别名同理。
const SSH_HOST_RE = /^[A-Za-z0-9._@%+\-[\]:]{1,255}$/;
const SSH_USER_RE = /^[A-Za-z0-9._-]{1,64}$/;

// resize 尾沿防抖（同 hostTerminal）。
const RESIZE_DEBOUNCE_MS = 120;

// 后台命令（建会话/扫描/kill + 文件层 sshChannel）：BatchMode 快败（密码认证的目标
// 不吊死到超时）。导出：sshChannel.ts（文件层通道）同用。
// 交互 attach 不带 BatchMode——密码/口令/首次 host key 确认都要能在终端里应答。
// ⚠️ attach 必须显式 -t：ssh 带远端命令时**不会**因本机 stdin 是 tty 就自动申请
// 远端 pty（实测：script 给了本机 pty，远端 tmux client 仍报 "open terminal failed:
// not a terminal"）——-t 强制远端 pty 分配，本机侧的 pty 由 script 提供。
export const SSH_BG_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];
const SSH_TTY_OPTS = ['-t', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3'];

// 目的地串：user 优先拼 user@host；host 本身含 @（用户直接写了 user@host）则原样。
function sshDest(t: SshTarget): string {
  return t.user && !t.host.includes('@') ? `${t.user}@${t.host}` : t.host;
}

// tmux target 的远端 shell 引号包裹：ssh 把 argv 以空格拼成命令串交给**远端登录 shell**
// 解析，`=名字` 在 zsh 里触发 =word 展开（=命令路径查找 → "not found"，本地
// hostTerminal 靠 SHELL=/bin/sh 压掉的坑在远端原样复现）——必须单引号裹住。
// 值域是 TERMID_RE/常量，无引号注入面。
function shq(target: string): string {
  return `'${target}'`;
}

// ssh 命令参数（不含程序名本身——execFile('ssh', argv) 另给；之前重复带了导致远端
// 主机名变成字面量 "ssh" 被 DNS 解析到 fake-ip，实测踩坑）。port 有值才传 -p。
// 导出：sshFiles.ts / sshChannel.ts（文件层通道）同用。
export function sshArgv(t: SshTarget, opts: string[], cmd: string[]): string[] {
  return [...opts, ...(t.port ? ['-p', String(t.port)] : []), sshDest(t), ...cmd];
}

// 跑一条后台 ssh 命令（远端 tmux 前缀已包好）。失败不抛：调用方按语义降级，
// err 带首行 stderr 供日志定位（连接拒绝/认证失败/无 tmux 各不相同）。
async function sshRun(
  t: SshTarget,
  cmd: string[],
  timeoutMs = 12_000,
): Promise<{ ok: boolean; stdout: string; err?: string }> {
  try {
    const { stdout } = await execFileAsync('ssh', sshArgv(t, SSH_BG_OPTS, cmd), { timeout: timeoutMs });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, stdout: '', err: (err.stderr || err.message || '').split('\n')[0]?.slice(0, 200) };
  }
}

function tmuxArgs(args: string[]): string[] {
  return ['tmux', '-L', SSH_SOCKET, ...args];
}

export function sshSessionName(termId: string): string {
  return `${SSH_SESSION_PREFIX}${termId}`;
}

// 会话/服务端 tmux 设置链（\; 串成一次 ssh 往返；argv 里的引号由远端 shell 剥离，
// 语义与 hostTerminal 逐项对齐——逐项依据见那边注释）：
//   - history-limit 在 new-session 之前（首个会话即 5 万行）；
//   - -e 注入色深需 tmux ≥3.2，老远端整链失败时由调用方退回无 -e 版本重试；
//   - set-titles-string 的 #T 必须单引号包裹：裸 # 在远端 shell 里开头即注释，
//     会把后面的参数全部吞掉。
function createChain(session: string, cols: number, rows: number, cwd: string, withEnv: boolean): string[] {
  return tmuxArgs([
    'start-server', '\\;',
    'set', '-g', 'history-limit', '50000', '\\;',
    'new-session', '-d',
    ...(withEnv ? ['-e', 'COLORTERM=truecolor', '-e', 'CLAUDE_CODE_TMUX_TRUECOLOR=1'] : []),
    '-s', session, '-x', String(cols), '-y', String(rows),
    ...(cwd ? ['-c', cwd] : []),
    '\\;',
    'set', '-g', 'mouse', 'off', '\\;',
    'set', '-sg', 'escape-time', '10', '\\;',
    'set', '-g', 'terminal-overrides', '"xterm*:smcup@:rmcup@"', '\\;',
    'set', '-as', 'terminal-overrides', '",xterm*:Ms=\\E]52;%p1%s;%p2%s\\007"', '\\;',
    'set', '-g', 'set-clipboard', 'on', '\\;',
    'set', '-t', shq(`${session}:`), 'set-titles', 'on', '\\;',
    'set', '-t', shq(`${session}:`), 'set-titles-string', "'#T'", '\\;',
    'set', '-t', shq(`${session}:`), 'status', 'off',
  ]);
}

// 每个会话的活连接数（多窗口同 termId，语义同 hostTerminal）。进程重启即清零：
// 仅影响 wantKill 时机的判定，会话本体在远端不受影响。
const activeCount = new Map<string, number>();

async function killSession(target: SshTarget, session: string): Promise<void> {
  activeCount.delete(session);
  await sshRun(target, tmuxArgs(['kill-session', '-t', shq(`${session}`)]));
}

// —— 会话发现 / 结束（/api/terminal-sessions 的 ssh 段，routes.ts 组合）——
// 逐目标并行扫描（allSettled 降级为 0 会话）；不可达/密码认证（BatchMode 拒绝）的
// 目标在对话框里不出现，不拖垮整体。格式串与解析同 hostTerminal 的两行格式。
export async function listSshSessions(): Promise<TermSessionView[]> {
  const targets = await getSshTargets();
  const settled = await Promise.allSettled(
    targets.map(async (t): Promise<TermSessionView[]> => {
      // -F 格式串含换行与 |（LIST_FMT 两行格式）：必须引号裹住过远端 shell，
      // 否则被拆成多条命令（实测 sessions 扫描恒空、| 变管道）。
      const r = await sshRun(t, tmuxArgs(['list-sessions', '-F', shq(LIST_FMT)]), 10_000);
      if (!r.ok) return [];
      const rows: TermSessionView[] = [];
      const re = /^mysandbox-ssh-([A-Za-z0-9_-]{4,64})\|/;
      const lines = r.stdout.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        const [att, created, ...path] = lines[i].slice(m[0].length).split('|');
        const next = lines[i + 1];
        const title = next && !re.exec(next) ? next : undefined;
        if (title !== undefined) i++;
        rows.push({
          kind: 'ssh',
          containerId: t.name,
          termId: m[1],
          attached: Number(att) || 0,
          created: (Number(created) || 0) * 1000,
          cwd: path.join('|') || undefined,
          title: title || undefined,
        });
      }
      return rows;
    }),
  );
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

export async function killSshSession(name: string, termId: string): Promise<void> {
  if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
  const target = (await getSshTargets()).find((t) => t.name === name);
  if (!target) throw notFound('ssh target not found');
  await killSession(target, sshSessionName(termId));
}

// —— ~/.ssh/config 候选（只读解析，供前端「从 ssh config 导入」列表）——
// 不做 include/Match 展开（候选列表够用即可，导入仍可手改）；通配/取反模式跳过。
export interface SshConfigHost {
  name: string;
  host?: string;
  user?: string;
  port?: number;
}

export async function sshConfigCandidates(): Promise<SshConfigHost[]> {
  let text: string;
  try {
    text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8');
  } catch {
    return []; // 没有 ssh config：空候选，不影响手动添加
  }
  const out = new Map<string, SshConfigHost>();
  let cur: SshConfigHost | null = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+?)(?:\s+|=)(.*)$/.exec(line); // keyword value 与 keyword=value 两种形态
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'host') {
      cur = null;
      for (const pat of val.split(/\s+/)) {
        if (/[*!?]/.test(pat)) continue;
        if (!out.has(pat)) out.set(pat, { name: pat });
        cur = out.get(pat)!;
      }
    } else if (cur) {
      if (key === 'hostname' && !cur.host) cur.host = val;
      else if (key === 'user' && !cur.user) cur.user = val;
      else if (key === 'port' && !cur.port) {
        const p = Number(val);
        if (Number.isInteger(p) && p > 0 && p < 65536) cur.port = p;
      }
    }
  }
  return [...out.values()];
}

export async function registerSshTerminal(app: FastifyInstance): Promise<void> {
  const log = app.log;

  // —— 目标 CRUD（存 state.json sidecar；UI 增删，config.yaml 不掺和）——
  app.get('/api/ssh/targets', async () => ({ targets: await getSshTargets() }));

  app.post('/api/ssh/targets', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    const host = String(b.host ?? '').trim();
    const user = b.user === undefined || b.user === null || b.user === '' ? undefined : String(b.user).trim();
    const port = b.port === undefined || b.port === null || b.port === '' ? undefined : Number(b.port);
    if (!SSH_NAME_RE.test(name)) throw badRequest('目标名需以字母或数字开头，可含 . _ -，最长 63 字符');
    if (!SSH_HOST_RE.test(host)) throw badRequest('目的地含非法字符（只允许字母数字与 . _ @ % + - [ ] :）');
    if (user !== undefined && !SSH_USER_RE.test(user)) throw badRequest('用户名含非法字符');
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw badRequest('端口需为 1-65535 的整数');
    const t = await addSshTarget({ name, host, user, port, createdAt: new Date().toISOString() });
    if (!t) throw conflict(`SSH 目标 ${name} 已存在`);
    return { ok: true, target: t };
  });

  app.delete('/api/ssh/targets/:name', async (req) => {
    const { name } = req.params as { name: string };
    if (!SSH_NAME_RE.test(name)) throw badRequest('invalid target name');
    if (!(await deleteSshTarget(name))) throw notFound('ssh target not found');
    return { ok: true };
  });

  app.get('/api/ssh/config-hosts', async () => ({ hosts: await sshConfigCandidates() }));

  // —— WS 终端（结构与 hostTerminal 的 ttyHandler 同构，差异见各注释）——
  app.get('/ws/ssh-terminal', { websocket: true }, async (socket, req) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const cols = Math.min(500, Math.max(1, Number(q.cols) || 80));
    const rows = Math.min(500, Math.max(1, Number(q.rows) || 24));
    const termId = q.termId;
    // from = 分屏来源 pane 的 termId（同目标上的会话）：新会话 cwd 继承源 pane 当前目录。
    const from = q.from && TERMID_RE.test(q.from) ? q.from : '';
    if (!termId || !TERMID_RE.test(termId)) {
      socket.close(1008, 'missing or invalid termId');
      return;
    }
    const tname = (q.target || '').trim();
    if (!SSH_NAME_RE.test(tname)) {
      socket.close(1008, 'missing or invalid target');
      return;
    }
    const target = (await getSshTargets()).find((t) => t.name === tname);
    if (!target) {
      socket.close(1008, 'unknown ssh target');
      return;
    }
    if (process.platform !== 'linux') {
      socket.close(1008, 'ssh terminal is linux-only');
      return;
    }

    try {
      const env = await detectEnv();
      if (env === 'none') {
        socket.send(Buffer.from('\x1b[31m>> 宿主缺少 script(1)，无法提供 PTY\x1b[0m\r\n'));
        socket.close(1011, 'script(1) not available');
        return;
      }

      const session = sshSessionName(termId);

      // 分屏 cwd 继承：源 pane 当前目录（远端 tmux 跟踪值）。源会话已死/查询失败
      // 静默落远端 home（不传 -c 即远端默认）。
      let cwd = '';
      if (from) {
        const r = await sshRun(
          target,
          tmuxArgs(['list-panes', '-t', shq(`${sshSessionName(from)}:`), '-F', shq('#{pane_active} #{pane_current_path}')]),
          10_000,
        );
        const src = r.stdout
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('1 '))
          ?.slice(2) ?? '';
        if (r.ok && src.startsWith('/')) cwd = src;
      }

      // 建会话 + 注设置（后台 best-effort）：密码认证/无 tmux/老版本等失败一律不挡
      // 连接——attach 用 new-session -A 兜底建（交互应答密码后可建出无设置的会话，
      // 见文件头降级说明）。-e 失败退回无 -e 重试（远端 tmux <3.2 不支持）。
      const alive = (await sshRun(target, tmuxArgs(['has-session', '-t', shq(`${session}`)]), 10_000)).ok;
      if (!alive) {
        let created = await sshRun(target, createChain(session, cols, rows, cwd, true), 20_000);
        if (!created.ok) {
          created = await sshRun(target, createChain(session, cols, rows, cwd, false), 20_000);
        }
        if (!created.ok) {
          log.warn({ target: target.name, err: created.err }, 'ssh terminal: remote session create failed (falling back to attach -A)');
        }
      }

      // 历史回填（attach 前 capture，控制帧先发；与 hostTerminal 同款，前端写 scrollback）。
      // 会话刚经 -A 兜底创建时无历史可回，失败静默。
      try {
        const cap = await sshRun(
          target,
          tmuxArgs(['capture-pane', '-p', '-J', '-t', shq(`${session}:`), '-S', '-10000', '-E', '-1']),
          15_000,
        );
        const text = cap.stdout.trim();
        if (cap.ok && text) {
          socket.send(JSON.stringify({ type: 'history', text }));
        }
      } catch {
        /* 无历史可回填 */
      }
      // tab 标题恢复（重连/刷新后 pane title 不随 attach 重发）。
      try {
        const t = await sshRun(
          target,
          tmuxArgs(['list-panes', '-t', shq(`${session}:`), '-F', shq('#{pane_active} #{pane_title}')]),
          15_000,
        );
        const title = t.stdout
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('1 '))
          ?.slice(2)
          .trim() ?? '';
        if (t.ok && title) {
          socket.send(JSON.stringify({ type: 'title', text: title }));
        }
      } catch {
        /* 静默 */
      }

      // ---- 派生 script（包 ssh attach），提前挂监听（terminal.ts 的教训：不丢帧）----
      let child: ChildProcess | null = null;
      let ownTty: string | null = null;
      let pendingResize: { cols: number; rows: number } | null = null;
      let lastSize = '';
      let resizeTimer: NodeJS.Timeout | null = null;
      let wantKill = false;
      let closed = false;

      activeCount.set(session, (activeCount.get(session) ?? 0) + 1);

      // 统一收尾（幂等）。socket 先断 → 杀 script（SIGTERM，500ms 未退 SIGKILL）；
      // script 先退（ssh 断/远端会话被杀/远端 shell 退出）→ 以 1000 关 socket。
      // 非 kill 断开 = 纯 detach，远端会话无限期保留（真 tmux 语义）。
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
          if (wantKill) void killSession(target, session);
        }
      };

      socket.on('message', (data: unknown, isBinary?: boolean) => {
        if (isBinary === false || typeof data === 'string') {
          // 文本帧=控制 JSON；心跳空文本帧靠 parse 失败分支静默消化。
          try {
            const text = typeof data === 'string' ? data : (data as Buffer).toString();
            const m = JSON.parse(text) as { type: string; cols?: number; rows?: number };
            if (m.type === 'resize') {
              const size = { cols: m.cols ?? 80, rows: m.rows ?? 24 };
              pendingResize = size;
              if (`${size.cols}x${size.rows}` === lastSize) return;
              if (resizeTimer) clearTimeout(resizeTimer);
              resizeTimer = setTimeout(() => {
                resizeTimer = null;
                // 只有自己的 pts：ssh client 是 SIGWINCH 的源头，转发远端由 ssh 自己做
                // （与宿主终端的 clientTtys 全量遍历不同——这里每个连接一个独立 pts）。
                if (!ownTty) {
                  lastSize = ''; // pts 还没探到：留着 pendingResize 给初始轮询落盘
                  return;
                }
                lastSize = `${size.cols}x${size.rows}`;
                void applyTtySize(ownTty, size.cols, size.rows);
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

      // script 提供 PTY（同 hostTerminal：-f 防缓冲、SHELL 压 /bin/sh 防 zsh =word 展开）。
      // 命令串 = 常量 + 白名单字符集的目的地 + TERMID_RE 校验的会话名，无注入面。
      // attach 用 new-session -A：会话在则 attach，不在则兜底创建（后台建失败的场景）。
      const sshCmd = [
        'ssh',
        ...SSH_TTY_OPTS,
        ...(target.port ? ['-p', String(target.port)] : []),
        sshDest(target),
        'tmux',
        '-L',
        SSH_SOCKET,
        'new-session',
        '-A',
        '-s',
        session,
      ].join(' ');
      child = spawn('script', ['-q', '-f', '-e', '-c', sshCmd, '/dev/null'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不注入 MYSANDBOX_WEB：远端没有容器内 mysandbox CLI，OSC 7677 链路不存在。
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', CLAUDE_CODE_TMUX_TRUECOLOR: '1', SHELL: '/bin/sh' },
      });
      children.add(child);
      child.stdin?.on('error', () => { /* noop */ });
      child.stdout?.on('error', () => { /* noop */ });
      child.stderr?.on('error', () => { /* noop */ });

      child.stdout?.on('data', (d: Buffer) => {
        if (socket.readyState === 1) socket.send(d);
      });
      child.stderr?.on('data', (d: Buffer) => {
        // ssh 的连接错误/host key 确认/密码提示多走 stderr：必须透传（同宿主终端）。
        if (socket.readyState === 1) socket.send(d);
      });
      child.on('exit', () => {
        children.delete(child!);
        try { socket.close(1000); } catch { /* noop */ }
        cleanup();
      });
      child.on('error', (e) => {
        log.warn({ err: e, target: target.name }, 'ssh terminal script spawn failed');
        try { socket.close(1011, 'script spawn failed'); } catch { /* noop */ }
        cleanup();
      });

      // 初始尺寸：pts 出现即 stty（SIGWINCH 先行），shrink-then-grow 同款预防。
      // 每 50ms 轮询（script 起 pts 很快，ssh 握手不影响——pts 在本机）。
      for (let i = 0; i < 10; i++) {
        const tty = await childTty(child.pid!);
        if (tty) {
          ownTty = tty;
          const init = pendingResize ?? { cols, rows };
          await applyTtySize(tty, init.cols, init.rows);
          lastSize = `${init.cols}x${init.rows}`;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch {
      try { socket.close(1011, 'terminal error'); } catch { /* noop */ }
    }
  });
}
