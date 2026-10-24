// msmux 目标分发：把静态二进制和派生凭据送到目标，并拉起回连 agent。
//
// 目标语法与 peer exec 对齐，但强制带种类前缀，避免「裸名先猜 LXC 再猜服务」在部署
// 这种写操作上产生歧义：
//   host | c:<LXC 容器名> | s:<docker 服务/项目名> | ssh:<SSH 目标名>
//
// 回连 URL：
//   - host  → ws://127.0.0.1:<listen.port>/ws/mux-agent
//   - c:/s: → ws://<网关 IP>:<mux.agentPort>/ws/mux-agent（经 muxBridge 透传）
//   - ssh:  → 必须显式传 url（远端不在自管网段，猜出来的地址大概率不可达）
//
// 凭据不是主 muxToken，而是按目标派生的 HMAC（muxAgentToken）。目标侧即使被攻破，
// 也只能注册自己的 target，不能冒充 host 或别的容器。
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { CONFIG_DIR, CONFIG_FILE, type Config } from './config.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { execRun, inspectContainer, rootfsPath } from './engine/index.js';
import { muxAgentBridgeIp } from './muxBridge.js';
import { agentForTarget, muxAgentToken } from './muxAgent.js';
import { findServiceTarget } from './serviceMeta.js';
import { getSshTargets } from './state.js';
import { sshExec, sshFeed } from './sshChannel.js';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';

const execFileAsync = promisify(execFile);

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const HOST_DIR = join(homedir(), '.mysandbox', 'mux');
const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user');

type TargetKind = 'host' | 'lxc' | 'service' | 'ssh';

type MuxBackend = 'tmux' | 'msmux';

interface ParsedTarget {
  kind: TargetKind;
  name: string;
  target: string;
}

export interface MuxDeployResult {
  ok: boolean;
  connected: boolean;
  target: string;
  kind: TargetKind;
  url: string;
  binary: { path: string; bytes: number; sha256: string };
  detail: string;
}

function parseTarget(raw: unknown): ParsedTarget {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 128) {
    throw badRequest('target 不能为空（host | c:<容器> | s:<服务> | ssh:<目标>）');
  }
  if (raw === 'host') return { kind: 'host', name: 'host', target: 'host' };
  const m = /^(c|s|ssh):(.+)$/.exec(raw);
  if (!m) throw badRequest(`无法识别的 target：${raw}`);
  const kind = m[1] === 'c' ? 'lxc' : m[1] === 's' ? 'service' : 'ssh';
  const name = m[2];
  if (!NAME_RE.test(name)) throw badRequest(`非法目标名：${name}`);
  return { kind, name, target: raw };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// systemd unit 的 ExecStart 不是 shell；只做引号转义即可覆盖路径/URL 里的空格与引号。
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function commandError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || String(e)).trim().slice(0, 500);
}

async function run(program: string, args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync(program, args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    throw new HttpError(502, `${program} 失败：${commandError(e)}`, 'mux_deploy_failed');
  }
}

async function runIgnored(program: string, args: string[], timeoutMs = 15_000): Promise<void> {
  try {
    await execFileAsync(program, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
  } catch {
    /* 停止旧进程/清理旧 unit 的失败不阻塞重新部署 */
  }
}

/** 找到可部署的静态二进制。顺序：环境变量 → 当前目录 → 源码/产物相对路径。 */
async function resolveBinary(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.MSMUX_BINARY,
    join(process.cwd(), 'mux', 'target', 'x86_64-unknown-linux-musl', 'release', 'msmux'),
    join(here, '..', 'mux', 'target', 'x86_64-unknown-linux-musl', 'release', 'msmux'),
    join(here, '..', '..', 'mux', 'target', 'x86_64-unknown-linux-musl', 'release', 'msmux'),
    join(process.cwd(), 'mux', 'target', 'release', 'msmux'),
    join(here, '..', 'bin', 'msmux'),
    join(here, 'msmux'),
  ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      await access(p, constants.X_OK);
      return p;
    } catch {
      /* 继续找 */
    }
  }
  throw new HttpError(
    503,
    '找不到 msmux 二进制：先运行 npm run build:mux，或用 MSMUX_BINARY 指定路径',
    'mux_binary_missing',
  );
}

function normalizeUrl(cfg: Config, parsed: ParsedTarget, override: unknown): string {
  let raw: string;
  if (typeof override === 'string' && override.trim() !== '') {
    raw = override.trim();
    if (!raw.startsWith('ws://') && !raw.startsWith('wss://')) {
      throw badRequest('url 必须是 ws:// 或 wss:// 地址');
    }
  } else if (parsed.kind === 'host') {
    raw = `ws://127.0.0.1:${cfg.listen.port}/ws/mux-agent`;
  } else if (parsed.kind === 'lxc' || parsed.kind === 'service') {
    raw = `ws://${muxAgentBridgeIp(cfg)}:${cfg.mux.agentPort}/ws/mux-agent`;
  } else {
    throw badRequest('ssh 目标需要显式传 url（远端可达的 ws:// 或 wss:// 控制台地址）');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest(`非法 url：${raw}`);
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') {
    throw badRequest('url 必须是 ws:// 或 wss:// 地址');
  }
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws/mux-agent';
  u.hash = '';
  return u.toString();
}

async function waitForAgent(target: string, timeoutMs = 6_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (agentForTarget(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return Boolean(agentForTarget(target));
}

async function deployHost(
  cfg: Config,
  parsed: ParsedTarget,
  binary: string,
  url: string,
  token: string,
): Promise<string> {
  await mkdir(HOST_DIR, { recursive: true, mode: 0o700 });
  await chmod(HOST_DIR, 0o700);
  const bin = join(HOST_DIR, 'msmux');
  const next = `${bin}.new`;
  await copyFile(binary, next);
  await chmod(next, 0o755);
  await rename(next, bin);

  const tokenFile = join(HOST_DIR, `agent-${createHash('sha256').update(parsed.target).digest('hex').slice(0, 12)}.token`);
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const unit = `msmux-agent-${parsed.target.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
  const logFile = join(HOST_DIR, `${unit}.log`);
  await mkdir(SYSTEMD_USER_DIR, { recursive: true, mode: 0o700 });
  await writeFile(
    join(SYSTEMD_USER_DIR, `${unit}.service`),
    [
      '[Unit]',
      `Description=mysandbox msmux agent (${parsed.target})`,
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${[bin, 'agent', '--url', url, '--token-file', tokenFile, '--target', parsed.target].map(systemdQuote).join(' ')}`,
      'Restart=on-failure',
      'RestartSec=2',
      `StandardOutput=append:${logFile}`,
      `StandardError=append:${logFile}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  // 兼容旧版 transient unit：同名先停/清失败态，再切换到持久 enable 的用户单元。
  await runIgnored('systemctl', ['--user', 'stop', unit]);
  await runIgnored('systemctl', ['--user', 'reset-failed', unit]);
  await run('systemctl', ['--user', 'daemon-reload'], 10_000);
  await run('systemctl', ['--user', 'enable', unit], 10_000);
  await run('systemctl', ['--user', 'restart', unit], 15_000);
  return `宿主 agent 已由持久 systemd 用户单元 ${unit} 托管（日志 ${logFile}）`;
}

async function deployLxc(
  cfg: Config,
  parsed: ParsedTarget,
  binary: string,
  url: string,
  token: string,
): Promise<string> {
  let info;
  try {
    info = await inspectContainer(cfg, parsed.name);
  } catch {
    throw notFound(`容器 ${parsed.name} 不存在`);
  }
  if (!info.running) throw conflict(`容器 ${parsed.name} 未运行（${info.stateStatus}）`);
  const rootfs = rootfsPath(cfg, parsed.name);
  if (!rootfs) throw new HttpError(500, '当前引擎拿不到容器 rootfs 路径', 'mux_deploy_failed');

  const home = join(rootfs, 'home', 'dev');
  const binDir = join(home, '.local', 'bin');
  const stateDir = join(home, '.config', 'msmux');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const bin = join(binDir, 'msmux');
  const next = `${bin}.new`;
  await copyFile(binary, next);
  await chmod(next, 0o755);
  await rename(next, bin);
  const tokenFile = join(stateDir, 'agent.token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  // unit 源文件先落在 dev 可写的 state 目录，再由容器 root 安装到 /etc；rootfs 的
  // /etc 属容器 root，宿主用户直写会 Permission denied。
  const unitSource = join(stateDir, 'msmux-agent.service');
  await writeFile(
    unitSource,
    [
      '[Unit]',
      `Description=mysandbox msmux agent (${parsed.target})`,
      'After=network.target',
      '',
      '[Service]',
      'Type=simple',
      'User=dev',
      'WorkingDirectory=/home/dev',
      'Environment=HOME=/home/dev',
      `ExecStart=${['/home/dev/.local/bin/msmux', 'agent', '--url', url, '--token-file', '/home/dev/.config/msmux/agent.token', '--target', parsed.target].map(systemdQuote).join(' ')}`,
      'Restart=on-failure',
      'RestartSec=2',
      'StandardOutput=append:/home/dev/.config/msmux/agent.log',
      'StandardError=append:/home/dev/.config/msmux/agent.log',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );

  const rootScript = [
    'set -e',
    'p=/home/dev/.config/msmux/agent.pid',
    'if [ -f "$p" ]; then kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi',
    'mkdir -p /etc/systemd/system',
    `cp ${shellQuote(unitSource.replace(rootfs, ''))} /etc/systemd/system/msmux-agent.service`,
    'chmod 644 /etc/systemd/system/msmux-agent.service',
    'systemctl daemon-reload',
    'systemctl enable msmux-agent',
    'systemctl restart msmux-agent',
  ].join('\n');
  const r = await execRun(cfg, parsed.name, {
    Cmd: ['sh', '-c', rootScript],
    User: 'root',
    WorkingDir: '/',
    timeoutMs: 20_000,
  });
  if (r.exitCode !== 0) {
    throw new HttpError(502, `容器内安装 msmux agent 服务失败：${r.stderr.trim() || r.stdout.trim()}`, 'mux_deploy_failed');
  }
  return '容器内 agent 已由 systemd 服务 msmux-agent 托管（容器重启自启）';
}

async function deployService(
  parsed: ParsedTarget,
  binary: string,
  url: string,
  token: string,
): Promise<string> {
  const hit = await findServiceTarget(parsed.name);
  if (!hit) throw notFound(`应用容器/项目 ${parsed.name} 不存在或不在管理边界内`);
  if (hit.running === false) throw conflict(`应用容器 ${hit.container} 未运行`);
  const dir = '/tmp/mysandbox-msmux';
  await run('docker', ['exec', hit.container, 'sh', '-c', `mkdir -p ${dir} && chmod 700 ${dir}`], 15_000);

  const stage = await mkdtemp(join(tmpdir(), 'msmux-deploy-'));
  try {
    const tokenStage = join(stage, 'agent.token');
    await writeFile(tokenStage, `${token}\n`, { mode: 0o600 });
    await run('docker', ['cp', binary, `${hit.container}:${dir}/msmux.new`], 60_000);
    await run('docker', ['cp', tokenStage, `${hit.container}:${dir}/agent.token.new`], 15_000);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  await run(
    'docker',
    ['exec', hit.container, 'sh', '-c',
      `mv ${dir}/msmux.new ${dir}/msmux && chmod 755 ${dir}/msmux && mv ${dir}/agent.token.new ${dir}/agent.token && chmod 600 ${dir}/agent.token`],
    15_000,
  );
  const script = [
    `p=${dir}/agent.pid`,
    'if [ -f "$p" ]; then kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi',
    `nohup ${dir}/msmux agent --url ${shellQuote(url)} --token-file ${dir}/agent.token --target ${shellQuote(parsed.target)} >>${dir}/agent.log 2>&1 </dev/null &`,
    'echo $! > "$p"',
  ].join('\n');
  await run('docker', ['exec', '-d', hit.container, 'sh', '-c', script], 15_000);
  return `应用容器 ${hit.container} 内 agent 已启动（${dir}）`;
}

async function deploySsh(
  parsed: ParsedTarget,
  binary: Buffer,
  url: string,
  token: string,
): Promise<string> {
  const target = (await getSshTargets()).find((t) => t.name === parsed.name);
  if (!target) throw notFound(`SSH 目标 ${parsed.name} 不存在`);
  const prep = await sshExec(
    target,
    ['sh', '-c', 'mkdir -p "$HOME/.local/bin" "$HOME/.config/msmux" && chmod 700 "$HOME/.config/msmux"'],
    15_000,
  );
  if (prep.exitCode !== 0) {
    throw new HttpError(502, `远端目录准备失败：${prep.stderr.trim().slice(0, 300)}`, 'mux_deploy_failed');
  }
  const up = await sshFeed(
    target,
    ['sh', '-c', 'cat > "$HOME/.local/bin/msmux.new"'],
    binary,
    120_000,
  );
  if (up.exitCode !== 0) {
    throw new HttpError(502, `上传 msmux 失败：${up.stderr.trim().slice(0, 300)}`, 'mux_deploy_failed');
  }
  const tok = await sshFeed(
    target,
    ['sh', '-c', 'umask 077; cat > "$HOME/.config/msmux/agent.token.new"'],
    Buffer.from(`${token}\n`),
    15_000,
  );
  if (tok.exitCode !== 0) {
    throw new HttpError(502, `写入远端 agent token 失败：${tok.stderr.trim().slice(0, 300)}`, 'mux_deploy_failed');
  }
  const script = [
    'set -e',
    'mv "$HOME/.local/bin/msmux.new" "$HOME/.local/bin/msmux"',
    'chmod 755 "$HOME/.local/bin/msmux"',
    'mv "$HOME/.config/msmux/agent.token.new" "$HOME/.config/msmux/agent.token"',
    'chmod 600 "$HOME/.config/msmux/agent.token"',
    'p="$HOME/.config/msmux/agent.pid"',
    'if [ -f "$p" ]; then kill "$(cat "$p")" 2>/dev/null || true; rm -f "$p"; fi',
    `nohup "$HOME/.local/bin/msmux" agent --url ${shellQuote(url)} --token-file "$HOME/.config/msmux/agent.token" --target ${shellQuote(parsed.target)} >>"$HOME/.config/msmux/agent.log" 2>&1 </dev/null &`,
    'echo $! > "$p"',
  ].join('\n');
  const launched = await sshExec(target, ['sh', '-c', script], 20_000);
  if (launched.exitCode !== 0) {
    throw new HttpError(502, `远端启动 agent 失败：${launched.stderr.trim().slice(0, 300)}`, 'mux_deploy_failed');
  }
  return '远端 agent 已以 nohup 独立进程启动';
}

export async function deployMuxAgent(
  cfg: Config,
  targetRaw: unknown,
  urlRaw: unknown,
): Promise<MuxDeployResult> {
  const parsed = parseTarget(targetRaw);
  const url = normalizeUrl(cfg, parsed, urlRaw);
  const token = muxAgentToken(cfg, parsed.target);
  if (!token) throw new HttpError(503, 'config 缺少 muxToken', 'mux_token_missing');
  const binaryPath = await resolveBinary();
  const binary = await readFile(binaryPath);
  const sha256 = createHash('sha256').update(binary).digest('hex');

  let detail: string;
  if (parsed.kind === 'host') {
    detail = await deployHost(cfg, parsed, binaryPath, url, token);
  } else if (parsed.kind === 'lxc') {
    detail = await deployLxc(cfg, parsed, binaryPath, url, token);
  } else if (parsed.kind === 'service') {
    detail = await deployService(parsed, binaryPath, url, token);
  } else {
    detail = await deploySsh(parsed, binary, url, token);
  }

  const kind = parsed.kind;
  const connected = await waitForAgent(parsed.target);
  return {
    ok: true,
    connected,
    target: parsed.target,
    kind,
    url,
    binary: { path: binaryPath, bytes: binary.length, sha256 },
    detail,
  };
}

export async function registerMuxDeploy(app: FastifyInstance, cfg: Config): Promise<void> {
  // 服务端默认后端（tmux|msmux，手动选择）：启动参数 --mux / config.yaml 都改这里；
  // 深链/恢复会话等未显式选择的路径按它走，交互入口在菜单里显式二选一。
  app.get('/api/mux/backend', async (req, reply) => {
    if (req.sandboxIdentity?.kind !== 'owner') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'owner only' } });
    }
    return { backend: cfg.mux.backend };
  });

  app.put('/api/mux/backend', async (req, reply) => {
    if (req.sandboxIdentity?.kind !== 'owner') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'owner only' } });
    }
    const body = (req.body ?? {}) as { backend?: unknown };
    const backend = body.backend;
    if (backend !== 'tmux' && backend !== 'msmux') {
      throw badRequest('backend must be tmux or msmux');
    }
    cfg.mux.backend = backend;
    // 服务端默认值落 config.yaml（保留其它键；只改 mux.backend）。前端显式选择的
    // 终端组不进服务端 config，只随浏览器布局持久化。
    const raw = await readFile(CONFIG_FILE, 'utf8');
    const user = (yamlLoad(raw) as Record<string, unknown> | null) || {};
    const mux = (user.mux && typeof user.mux === 'object' ? user.mux : {}) as Record<string, unknown>;
    mux.backend = backend;
    user.mux = mux;
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(CONFIG_FILE, yamlDump(user), { mode: 0o600 });
    await chmod(CONFIG_FILE, 0o600);
    return { backend };
  });

  app.post('/api/mux/deploy', async (req, reply) => {
    if (req.sandboxIdentity?.kind !== 'owner') {
      return reply.code(403).send({ error: { code: 'forbidden', message: 'owner only' } });
    }
    const body = (req.body ?? {}) as { target?: unknown; url?: unknown };
    return deployMuxAgent(cfg, body.target, body.url);
  });
}

// —— CLI：mysandbox mux ——
// 控制台 API 而不是进程内直调：agent 在线状态只存在于正在运行的服务进程里，
// 一次性 CLI 进程看不到回连表，也必须让部署后的 6 秒回连检查发生在服务侧。

const MUX_HELP = `mysandbox mux — 部署/查看 msmux agent

Usage:
  mysandbox mux agents [--json]
      List agents currently connected to the running console.

  mysandbox mux deploy <target> [--url <ws(s)://...>] [--json]
      Upload the static msmux binary and start/reconnect its agent.
      target: host | c:<container> | s:<service> | ssh:<ssh-target>
      --url is required for ssh targets (an address the SSH host can reach).

The console must be running (same HTTP endpoint as the web UI).`;

function consoleBase(cfg: Config): string {
  const host = cfg.listen.host;
  const local = host === '0.0.0.0' || host === '::' || host === 'auto' ? '127.0.0.1' : host;
  return `http://${local.includes(':') ? `[${local}]` : local}:${cfg.listen.port}`;
}

async function consoleApi<T>(
  cfg: Config,
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(consoleBase(cfg) + path, {
      method: init?.method ?? 'GET',
      headers: {
        'x-sandbox-token': cfg.token || '',
        ...(init?.body == null ? {} : { 'content-type': 'application/json' }),
      },
      body: init?.body == null ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init?.timeoutMs ?? 10_000),
    });
  } catch (e) {
    throw new Error(`无法连接 mysandbox 控制台（${consoleBase(cfg)}）：${commandError(e)}`);
  }
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string } })
    | null;
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status} ${path}`);
  return body as T;
}

export async function runMuxCommand(argv: string[], cfg: Config): Promise<void> {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') flags.help = '1';
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      flags[name] = eq >= 0 ? a.slice(eq + 1) : argv[++i] ?? '';
    } else positionals.push(a);
  }

  const sub = positionals[0];
  if (!sub || sub === 'help' || flags.help) {
    process.stdout.write(`${MUX_HELP}\n`);
    return;
  }

  if (sub === 'agents') {
    const r = await consoleApi<{ agents: { target: string; protocol: number | null; channels: number; remote: string; lastSeenAt: number }[] }>(
      cfg,
      '/api/mux/agents',
    );
    if (json) {
      process.stdout.write(`${JSON.stringify(r.agents, null, 2)}\n`);
      return;
    }
    if (!r.agents.length) {
      process.stdout.write('没有在线 msmux agent。\n');
      return;
    }
    for (const a of r.agents) {
      const age = Math.max(0, Math.round((Date.now() - a.lastSeenAt) / 1000));
      process.stdout.write(
        `${a.target.padEnd(32)} protocol=${a.protocol ?? '?'} channels=${a.channels} remote=${a.remote} lastSeen=${age}s ago\n`,
      );
    }
    return;
  }

  if (sub === 'deploy') {
    const target = positionals[1];
    if (!target) throw new Error('缺少 target（host | c:<容器> | s:<服务> | ssh:<目标>）');
    const result = await consoleApi<MuxDeployResult>(cfg, '/api/mux/deploy', {
      method: 'POST',
      body: { target, ...(flags.url ? { url: flags.url } : {}) },
      timeoutMs: 130_000,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.connected ? '✓ 已回连' : '! 已部署但 6 秒内未回连'}\n`);
      process.stdout.write(`  target: ${result.target}\n  url:    ${result.url}\n  detail: ${result.detail}\n`);
      process.stdout.write(`  binary: ${result.binary.path} (${result.binary.bytes} bytes)\n`);
    }
    if (!result.connected) process.exitCode = 1;
    return;
  }

  throw new Error(`unknown mux subcommand "${sub}". Run \`mysandbox mux help\`.`);
}
