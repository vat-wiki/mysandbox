// LXC 引擎实现：与 docker 引擎同接口（见 types.ts），底层是 lxc-* CLI + 容器 config 纯文本。
//
// 「容器 = 一台开机的机器」是这层的核心语义差异：LXC 容器跑真 systemd（PID 1），
// 起停就是开关机，没有 docker 的 Cmd/Entrypoint/镜像即真相那套概念。
//
// ## 运行环境硬约束（PoC 实测，改这个文件前必读）
//
// LXC 命令必须在**已委派 cgroup 的 systemd user manager 环境**里跑。裸 shell（SSH session）
// 落在 root 属主的 `session-<n>.scope`，`lxc-start` 报 `cgroup.threads is not writable`
// → 容器秒退 255；`lxc-attach` 报 `cgroup_attach_move_into_leaf: Permission denied`。
// 因此 **mysandbox 必须以 systemd user service 形态运行**（`systemctl --user` + linger），
// 落在已委派的 `user@1000.service` 下。实测结论：
//   - 本进程直接 spawn `lxc-attach`（子进程继承本进程 cgroup）→ 直接可用，无需任何包装；
//   - `lxc-start` 不能直接 spawn：容器进程会挂在本服务的 cgroup 下，mysandbox 一重启就
//     被 systemd 连带清杀。必须 `systemd-run --user --unit=mysandbox-<name>` 把容器放进
//     **自己的**瞬态单元（见 startContainer 注释）。
//   - 由此 `lxc.cgroup.dir` 不需要配、`/sys/fs/cgroup/lxc` 也不需要 sudo 预建——容器 cgroup
//     自然落在 `user@1000.service/app.slice/mysandbox-<name>.service/lxc.payload.<name>`。
//
// ## PTY
//
// LXC 无 docker exec 的 hijack 流。终端复用 hostTerminal.ts 的方案：`script(1)` 提供 PTY
// 包住 `lxc-attach`，resize 走子进程 pts 上的 `stty -F`（详见 execStream 注释）。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Config } from '../config.js';
import { xdgDataHome } from '../config.js';
import { getAllMeta, type ContainerMeta } from '../state.js';
import { notFound } from '../errors.js';
import type {
  Engine,
  EngineEvent,
  ContainerInfo,
  ContainerView,
  ExecOpts,
  ExecResult,
  ExecStream,
} from './types.js';

const execFileAsync = promisify(execFile);

// 受管理标记（D5：LXC 没有 label，用 config 里的纯文本键；可 diff、可手改）。
// lxc.environment 是唯一「随容器走、启动时注入、不被 LXC 校验拒绝」的自定义键。
export const MANAGED_KEY = 'MYSANDBOX_MANAGED';
const MANAGED_LINE = `lxc.environment = ${MANAGED_KEY}=true`;

// 容器根目录（unprivileged LXC 默认 lxcpath）。rootfs 在 <lxcpath>/<name>/rootfs（D4：home 在 rootfs 内）。
export function lxcPath(): string {
  return join(xdgDataHome(), 'lxc');
}
export function containerDir(name: string): string {
  return join(lxcPath(), name);
}
export function configPath(name: string): string {
  return join(containerDir(name), 'config');
}
// 容器内 /home/dev 在宿主侧的真实路径（D1 uid 直通 → 属主就是 leon，files.ts 可直读）。
export function containerHomePath(name: string): string {
  return join(containerDir(name), 'rootfs', 'home', 'dev');
}

// LXC 里「id」就是容器名（无 docker 的 64 位 hex id）。engine 接口的 id 参数一律当名字用。
// 名字校验挡住 shell 元字符与路径穿越——所有 lxc-* 调用都用 execFile/spawn 数组参数（无 shell），
// 这里再挡一层是为了不让脏名字进 config 路径拼接。
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
function assertName(id: string): string {
  if (!NAME_RE.test(id)) throw notFound(`invalid container name "${id}"`);
  return id;
}

// 跑一条外部命令（lxc-* 为主，resolveBridge 也用它问一次 docker）。
// 不加 systemd-run 包装：本进程已在 user manager 环境里（见文件头注释），子进程继承 cgroup 即可。
// 失败不抛，返回 ok:false 由调用方按语义处理（lxc CLI 大量用非零退出表达「没这个容器」/
// 「没在跑」这类正常状态）。
async function run(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(args[0], args.slice(1), {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

// —— Engine.status：LXC 可用性 ——
// 没有 daemon 可连（这正是选裸 LXC 的理由之一），「可达」= CLI 在 + user manager 环境对。
// 后者是最常见的部署错误（mysandbox 没作为 systemd user service 跑），必须在这里报出来，
// 否则用户只会看到「建容器成功但秒退」这种难查的表象。
async function status(_cfg: Config) {
  const v = await run(['lxc-start', '--version'], 5_000);
  if (!v.ok) {
    return { reachable: false, error: 'lxc CLI not found (apt install lxc uidmap lxcfs)' };
  }
  const version = v.stdout.trim();
  if (!process.env.XDG_RUNTIME_DIR) {
    return {
      reachable: false,
      version,
      error:
        'no systemd user manager environment (XDG_RUNTIME_DIR unset). mysandbox must run as a systemd user service: `systemctl --user`',
    };
  }
  return { reachable: true, version };
}

// —— config 读写：LXC 的「元数据」就是这个纯文本文件 ——
export async function readConfig(name: string): Promise<string | null> {
  const p = configPath(assertName(name));
  if (!existsSync(p)) return null;
  return readFile(p, 'utf8');
}

// 取 config 里某个键的值（最后一次出现的为准，与 LXC 自身的后覆盖前语义一致）。
export function configValue(content: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    found = line.slice(eq + 1).trim();
  }
  return found;
}

// 受管理判定（D5）：config 里有 MANAGED_KEY 标记。
function isManagedConfig(content: string): boolean {
  return configValue(content, 'lxc.environment') === `${MANAGED_KEY}=true`
    || content.includes(MANAGED_LINE);
}

// 往 config 追加受管理标记（adopt 外部容器用；幂等）。
export async function markManaged(name: string): Promise<void> {
  const content = await readConfig(name);
  if (content == null) throw notFound(`container ${name} not found`);
  if (isManagedConfig(content)) return;
  const sep = content.endsWith('\n') ? '' : '\n';
  await writeFile(configPath(name), `${content}${sep}${MANAGED_LINE}\n`);
}

// —— 状态查询 ——
// lxc-info -n X 的输出是 `Key:<空白>Value` 行。一次调用取全（state/pid/ip），避免多次 fork。
async function infoLines(name: string): Promise<Record<string, string> | null> {
  const r = await run(['lxc-info', '-n', assertName(name)], 10_000);
  if (!r.ok) return null;
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && !out[k]) out[k] = v; // 首次出现为准（TX/RX bytes 那几行带前导空格，key 不冲突）
  }
  return out;
}

// 全部已定义容器名（含停止的）。-1 = 一行一个，比 -f 的列对齐输出好解析。
async function listNames(): Promise<string[]> {
  const r = await run(['lxc-ls', '-1'], 10_000);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// LXC 的 STOPPED/RUNNING/FROZEN → 对齐 docker 的 state 字符串，让 web 侧无需分引擎判断。
function mapState(lxcState: string): { state: string; running: boolean } {
  const s = (lxcState || '').toUpperCase();
  if (s === 'RUNNING') return { state: 'running', running: true };
  if (s === 'FROZEN') return { state: 'paused', running: false };
  if (s === 'STARTING') return { state: 'restarting', running: false };
  if (s === 'STOPPING') return { state: 'exited', running: false };
  return { state: 'exited', running: false };
}

// 列出受管理容器：config 有标记 或 挂在配置的网桥上（对齐 docker 引擎「在网络上或有 label」）。
async function listManaged(cfg: Config): Promise<ContainerView[]> {
  const names = await listNames();
  const meta = await getAllMeta();
  const bridge = await resolveBridge(cfg);
  const views: ContainerView[] = [];
  for (const name of names) {
    const content = await readConfig(name);
    if (content == null) continue;
    const managed = isManagedConfig(content);
    const link = configValue(content, 'lxc.net.0.link');
    const onNet = !!bridge && link === bridge;
    if (!managed && !onNet) continue;

    const info = await infoLines(name);
    const { state, running } = mapState(info?.State ?? 'STOPPED');
    // IP：跑起来的读 lxc-info（真实态）；停的读 config 静态配置（LXC 的 IP 是配出来的，
    // 不像 docker IPAM 要等运行才知道——停机容器也能显示它的固定 IP，UI 体验更好）。
    const ip = running
      ? info?.IP || null
      : (configValue(content, 'lxc.net.0.ipv4.address') || '').split('/')[0] || null;
    const m: ContainerMeta | undefined = meta[name];
    views.push({
      id: name, // LXC 无独立 id，名字即 id
      name,
      displayName: m?.displayName,
      status: running ? 'Up' : 'Stopped',
      state,
      image: 'lxc', // LXC 无镜像概念（D3：模板容器克隆而来）；模板来源记在 sidecar source
      ip,
      networks: link ? [cfg.network] : [],
      managed,
      adopted: !!m?.managed,
      description: m?.description,
      tags: m?.tags,
      source: m?.source,
      labels: {}, // LXC 无 label
      ports: [], // LXC 直连固定 IP，无 NAT 端口映射（D2）
      created: createdAtMs(m),
      command: '/sbin/init', // 真 init，不是 sleep infinity
    });
  }
  views.sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (a.state !== 'running' && b.state === 'running') return 1;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });
  return views;
}

function createdAtMs(m: ContainerMeta | undefined): number {
  if (!m?.createdAt) return 0;
  const t = Date.parse(m.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

// 配置的网络名 → 宿主网桥名（D2：复用 docker 的 dev-lan = br-<netid 前 12 位>）。
// LXC config 里存的是网桥设备名，而 cfg.network 是 docker 网络名，需要一次映射。
// 缓存：网桥名在 docker 网络生命周期内不变，每次列表都查 docker 太浪费。
let bridgeCache: { network: string; bridge: string | null } | null = null;
export async function resolveBridge(cfg: Config): Promise<string | null> {
  if (bridgeCache && bridgeCache.network === cfg.network) return bridgeCache.bridge;
  let bridge: string | null = null;
  // 网桥名可直接给（cfg.network 本身就是 br-*/自建桥名）——先认这种。
  if (/^br-|^br\d|bridge$/.test(cfg.network) && existsSync(`/sys/class/net/${cfg.network}`)) {
    bridge = cfg.network;
  } else {
    // 否则问 docker 要 docker 网络对应的桥（迁移期两引擎共享同一座桥）。
    const r = await run(
      ['docker', 'network', 'inspect', cfg.network, '--format', '{{.Id}}'],
      5_000,
    );
    if (r.ok) {
      const id = r.stdout.trim();
      if (id) {
        const candidate = `br-${id.slice(0, 12)}`;
        if (existsSync(`/sys/class/net/${candidate}`)) bridge = candidate;
      }
    }
  }
  bridgeCache = { network: cfg.network, bridge };
  return bridge;
}

// —— inspect 归一 ——
async function inspect(cfg: Config, id: string): Promise<ContainerInfo> {
  const name = assertName(id);
  const content = await readConfig(name);
  if (content == null) throw notFound(`container ${name} not found`);
  const info = await infoLines(name);
  const { state, running } = mapState(info?.State ?? 'STOPPED');
  const link = configValue(content, 'lxc.net.0.link');
  const bridge = await resolveBridge(cfg);
  return {
    id: name,
    name,
    running,
    stateStatus: state,
    managed: isManagedConfig(content),
    networks: link && link === bridge ? [cfg.network] : link ? [link] : [],
    ports: [],
  };
}

// —— 生命周期 ——
// 启动：必须放进**独立的** systemd user 瞬态单元（见文件头）。`-F`（前台）+ 单元常驻，
// 这样容器 cgroup 挂在 mysandbox-<name>.service 而非 mysandbox 自己的服务下——
// mysandbox 重启/升级不会连带杀掉所有容器（实测直接 spawn 会被清杀）。
// --collect：单元退出后自动回收，不留 failed 残骸。
async function startContainer(_cfg: Config, id: string): Promise<void> {
  const name = assertName(id);
  const r = await run(
    [
      'systemd-run', '--user', `--unit=${unitName(name)}`, '--collect',
      '--property=KillMode=mixed', // 停机时先 TERM 主进程（lxc-start 会优雅停容器），再收尾
      'lxc-start', '-n', name, '-F',
    ],
    20_000,
  );
  if (!r.ok) throw new Error(`lxc-start failed: ${r.stderr.trim() || 'unknown error'}`);
  // systemd-run 立刻返回（单元后台跑），等 RUNNING 才算启动成功——否则调用方拿到 ok
  // 但容器还没起来（PID 1 起 systemd 要几秒），后续 exec 全失败。
  await waitState(name, 'RUNNING', 30_000);
}

export function unitName(name: string): string {
  return `mysandbox-${name}.service`;
}

// 轮询等状态（LXC 无事件等待原语；lxc-wait 存在但对 unprivileged + 瞬态单元路径不稳）。
async function waitState(name: string, want: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await infoLines(name);
    if ((info?.State ?? 'STOPPED').toUpperCase() === want) return;
    if (Date.now() > deadline) {
      throw new Error(`container ${name} did not reach ${want} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// 停止：lxc-stop 给容器 init 发关机信号（真关机，不是 docker 的 SIGTERM 给 PID 1 应用）。
// -t 是宽限秒数，超时后强杀。
async function stopContainer(_cfg: Config, id: string, t = 5): Promise<void> {
  const name = assertName(id);
  const r = await run(['lxc-stop', '-n', name, '-t', String(t)], (t + 20) * 1000);
  // 已经停了：lxc-stop 报错但语义上是成功（对齐 docker stop 已停容器的幂等）。
  if (!r.ok) {
    const info = await infoLines(name);
    if ((info?.State ?? 'STOPPED').toUpperCase() !== 'STOPPED') {
      throw new Error(`lxc-stop failed: ${r.stderr.trim() || 'unknown error'}`);
    }
  }
  // 瞬态单元通常随 lxc-start 退出自行回收（--collect）；残留就显式停，防单元名占用下次启动。
  await run(['systemctl', '--user', 'stop', unitName(name)], 10_000);
}

async function restartContainer(cfg: Config, id: string, t = 5): Promise<void> {
  await stopContainer(cfg, id, t);
  await startContainer(cfg, id);
}

// 重命名：LXC 无 rename 原语。lxc-copy -R 是「移动」（改名不复制数据），但要求容器已停。
async function renameContainer(_cfg: Config, id: string, newName: string): Promise<void> {
  const name = assertName(id);
  assertName(newName);
  const info = await infoLines(name);
  if ((info?.State ?? 'STOPPED').toUpperCase() !== 'STOPPED') {
    throw new Error('container must be stopped before rename (LXC has no live rename)');
  }
  const r = await run(['lxc-copy', '-n', name, '-N', newName, '-R'], 60_000);
  if (!r.ok) throw new Error(`rename failed: ${r.stderr.trim() || 'unknown error'}`);
  // uts.name（容器 hostname）跟着改，否则新名字容器里 hostname 还是旧的。
  const content = await readConfig(newName);
  if (content != null) {
    const next = content.replace(/^lxc\.uts\.name\s*=.*$/m, `lxc.uts.name = ${newName}`);
    if (next !== content) await writeFile(configPath(newName), next);
  }
}

// 删除：先停再 lxc-destroy（连 rootfs 一起删——D4 下 home 在 rootfs 内，
// 所以「删数据」与「删容器」在 LXC 里是同一件事，lifecycle 层的 deleteData 语义要相应调整）。
async function removeContainer(cfg: Config, id: string, opts: { force?: boolean } = {}): Promise<void> {
  const name = assertName(id);
  if (opts.force ?? true) {
    try {
      await stopContainer(cfg, name, 5);
    } catch {
      /* 已停或停不下来，交给 destroy -f */
    }
  }
  const r = await run(['lxc-destroy', '-n', name, '-f'], 120_000);
  if (!r.ok && existsSync(containerDir(name))) {
    throw new Error(`lxc-destroy failed: ${r.stderr.trim() || 'unknown error'}`);
  }
}

// —— exec ——
// lxc-attach 直接 spawn（本进程已在 user manager 环境，子进程继承 cgroup）。
// --clear-env：不把 mysandbox 服务的环境泄进容器（对齐 docker exec 的干净环境语义）；
// 需要的变量用 -v 显式带。-u/-g 走容器内 uid（默认 1000 dev，同 docker 引擎的 User 默认）。
function attachArgs(name: string, opts: ExecOpts): string[] {
  const { uid, gid } = parseUser(opts.User);
  const args = ['lxc-attach', '-n', name, '--clear-env', '-u', String(uid), '-g', String(gid)];
  const env = [
    `HOME=${uid === 0 ? '/root' : '/home/dev'}`,
    'PATH=/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(opts.Env ?? []),
  ];
  for (const e of env) args.push('-v', e);
  args.push('--');
  // WorkingDir：lxc-attach 无 --cwd，用 sh -c 'cd X && exec "$@"' 包一层。
  // exec "$@" 保证信号/退出码直达目标命令（不多一层 sh 吞掉）。
  const cwd = opts.WorkingDir || (uid === 0 ? '/root' : '/home/dev');
  args.push('/bin/sh', '-c', `cd ${shq(cwd)} 2>/dev/null || cd /; exec "$@"`, 'sh', ...opts.Cmd);
  return args;
}

// docker 的 "1000:1000" 形式 → uid/gid。LXC 要分开给 -u/-g。
function parseUser(user: string | undefined): { uid: number; gid: number } {
  if (!user) return { uid: 1000, gid: 1000 };
  const [u, g] = user.split(':');
  const uid = Number(u);
  const gid = g == null ? uid : Number(g);
  return {
    uid: Number.isFinite(uid) ? uid : 1000,
    gid: Number.isFinite(gid) ? gid : 1000,
  };
}

// 单引号 shell 转义（只用于上面那句 cd，路径来自 WorkingDir 配置）。
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// 跑命令收结果。docker 引擎靠 hijack 流 + demux；这里 spawn 天然分离 stdout/stderr，更简单。
// 超时语义与 docker 引擎逐字对齐（stderr 追加 [mysandbox: timeout]、exitCode -1），
// 因为 batch.ts/files.ts 依赖这个约定。
async function execRun(_cfg: Config, id: string, opts: ExecOpts): Promise<ExecResult> {
  return runAttach(assertName(id), opts, null);
}

// stdin 版：喂完 input 后半关闭（对 `cat > file` 即 EOF）。用途同 docker 引擎的 execFeed：
// 写大文件绕开 argv 128KB 上限。
async function execFeed(
  _cfg: Config,
  id: string,
  opts: ExecOpts,
  input: Buffer,
): Promise<ExecResult> {
  return runAttach(assertName(id), opts, input);
}

function runAttach(name: string, opts: ExecOpts, input: Buffer | null): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = attachArgs(name, opts);
    const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, opts.timeoutMs)
      : null;
    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        stderr += stderr ? '\n[mysandbox: timeout]' : '[mysandbox: timeout]';
        exitCode = -1;
      }
      resolve({ exitCode, stdout, stderr });
    };
    // 三流都挂 error：容器没跑/attach 失败时写 stdin 会 EPIPE，不吞会崩整个 mysandbox
    // （与 hostTerminal.ts 同款教训）。
    child.stdin?.on('error', () => { /* noop */ });
    child.stdout?.on('error', () => { /* noop */ });
    child.stderr?.on('error', () => { /* noop */ });
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      stderr += (stderr ? '\n' : '') + (e instanceof Error ? e.message : String(e));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    if (input) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

// —— PTY 流（terminal.ts 的底座）——
// LXC 无 docker exec hijack。复用 hostTerminal.ts 的 script(1) 方案：
//   script -q -f -e -c '<cmd>' /dev/null 给命令开一个真 pty；
//   resize 走子进程的 pts 上 `stty -F <pts> cols N rows M`（tmux 3.4 refresh-client 不支持 -x/-y）。
// stdin/stdout 用 PassThrough 拼成 Duplex，对上层伪装成 docker 的 Tty 单流（stderr 合入 stdout）。
async function execStream(_cfg: Config, id: string, opts: ExecOpts): Promise<ExecStream> {
  const name = assertName(id);
  // script 的 -c 收单个字符串命令，所以 attach 参数要拼成 shell 串。所有片段单引号转义，
  // Cmd 来自 terminal.ts 的常量 + 正则校验过的会话名，无注入面（但转义照做，防将来传入变脏）。
  const cmd = attachArgs(name, opts).map(shq).join(' ');
  const child = spawn('script', ['-q', '-f', '-e', '-c', cmd, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // SHELL 压成 /bin/sh：script 用 $SHELL 跑 -c 串，用户登录 zsh 会做 =word 展开
    // （hostTerminal.ts 实测踩过：tmux attach -t =h-xxx 被 zsh 当命令路径查找）。
    env: { ...process.env, TERM: 'xterm-256color', SHELL: '/bin/sh' },
  });
  children.add(child);
  child.stdin?.on('error', () => { /* noop */ });
  child.stdout?.on('error', () => { /* noop */ });
  child.stderr?.on('error', () => { /* noop */ });

  // 双向壳：write → script stdin；script stdout+stderr → push 出去（Tty 单流语义，
  // 对上层伪装成 docker exec 的 hijack 流）。destroy() 由 Duplex 的 _destroy 转成杀进程。
  const duplex = new Duplex({
    read() { /* push 由下面的 stdout/stderr 监听驱动 */ },
    write(chunk, _enc, cb) {
      try { child.stdin?.write(chunk); } catch { /* script 已死 */ }
      cb();
    },
    destroy(err, cb) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      // SIGTERM 后 script 要 ~2s 才真退（同 hostTerminal.ts 的观察）；兜一发 KILL。
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 500).unref();
      cb(err);
    },
  });
  // destroy 触发的 'error' 不吞会崩进程（同 docker 引擎 execStream 的教训）。
  duplex.on('error', () => { /* noop */ });
  child.stdout?.on('data', (d: Buffer) => duplex.push(d));
  child.stderr?.on('data', (d: Buffer) => duplex.push(d));
  child.on('exit', () => {
    children.delete(child);
    duplex.push(null); // EOF → 上层 stream.on('end') 关 socket
  });

  return {
    stream: duplex,
    resize: async (cols, rows) => {
      const pts = await childTty(child.pid!);
      if (pts) await applyTtySize(pts, cols, rows);
    },
  };
}

// 本进程派生的 script 子进程：node 退出（含 tsx watch 热重启）时同步 SIGKILL，
// 否则遗留 script 拿着 pts 挂在容器里（=幽灵 attach，卡 stale 尺寸）。同 hostTerminal.ts。
const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
  }
});

// script 子进程的 pts。script 自己的 controlling tty 继承自 node（无 tty），
// 它为命令开的 pts 挂在**子进程**身上，所以查 --ppid。同 hostTerminal.ts 的 childTty。
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

async function applyTtySize(pts: string, cols: number, rows: number): Promise<void> {
  try {
    await execFileAsync('stty', ['-F', pts, 'cols', String(cols), 'rows', String(rows)], {
      timeout: 2_000,
    });
  } catch { /* pts 可能刚随退出消失 */ }
}

// —— 网络 ——
// 已占 IP：LXC 的 IP 是 config 里配死的（D2 静态分配），所以扫全部容器 config 就是权威源——
// 比 docker 的「问网络要 IPAM 表」更直接，且停机容器的 IP 也算占用（不会被重新分配）。
async function assignedIps(_cfg: Config): Promise<Set<string>> {
  const set = new Set<string>();
  for (const name of await listNames()) {
    const content = await readConfig(name);
    if (content == null) continue;
    const addr = configValue(content, 'lxc.net.0.ipv4.address');
    if (addr) {
      const ip = addr.split('/')[0].trim();
      if (ip) set.add(ip);
    }
  }
  return set;
}

// —— 事件 ——
// LXC 有 lxc-monitor，但它按 lxcpath 监听、输出是行文本状态迁移。hosts-sync 只关心
// 「容器起来了，去刷 /etc/hosts」，所以订阅 RUNNING 迁移即可。
// 注意 lxc-monitor 是常驻前台进程，用 spawn 而非 execFile。
async function subscribeEvents(
  _cfg: Config,
  onEvent: (ev: EngineEvent) => void,
): Promise<{ close(): void }> {
  const child = spawn('lxc-monitor', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('error', () => { /* noop */ });
  child.stderr?.on('error', () => { /* noop */ });
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      // 形如：'ms-dev' changed state to [RUNNING]
      const m = /^'([^']+)' changed state to \[RUNNING\]/.exec(line);
      if (m) onEvent({ containerId: m[1], action: 'start' });
    }
  });
  return {
    close() {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    },
  };
}

export const lxcEngine: Engine = {
  name: 'lxc',
  status,
  listManaged,
  inspect,
  start: startContainer,
  stop: stopContainer,
  restart: restartContainer,
  rename: renameContainer,
  remove: removeContainer,
  execRun,
  execFeed,
  execStream,
  assignedIps,
  subscribeEvents,
};
