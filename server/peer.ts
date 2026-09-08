// peer API：容器间命令互通的转发枢纽（「宿主 ↔ 系统容器 ↔ 应用容器」的命令面）。
//
// 原理：lxc-attach / docker exec 只有宿主能调——任何跨容器 exec 最终都过宿主，而
// mysandbox 服务端就住在宿主上，三侧通道现成（LXC 走 engine execRun、应用容器走
// docker exec、宿主直接 spawn）。这里把命令面暴露给容器内部：一个绑在网关 IP
// （<ipPool 前缀>.1，宿主在 mysandbox0 桥上的副 IP）的迷你 HTTP 服务，容器里
// `mysandbox exec <目标> -- 命令`（seed 的 peer-exec.mjs）打过来，宿主代为执行回 JSON。
// 不走 SSH：应用容器（postgres 等）没有 sshd，密钥分发又是一份要同步的状态。
//
// 形态照抄 server/dockerApi.ts：绑死网桥 IP（LAN 无路由可达）、EADDRNOTAVAIL 退避
// （boot 时序：system 的 mysandbox-net 晚于 user service）、随 mysandbox 进程存活、
// 失败非致命（peer 缺席只影响容器间 exec，别把服务拖下水）。
//
// 安全：
//   - 独立 peerToken（config 首启生成、0600），**不是主 token**——主 token = 控制台
//     全量 API；peer 端点只有 targets/exec 两个。诚实说：D1 uid 直通下「exec 进任一
//     容器 ≈ leon 用户」，泄露的边际风险不大，收窄只是保持安全故事干净。
//   - ufw INPUT 只放 LXC 网段 → 本端口（firewall.ts 按 cfg.peer 推导；config 变更后
//     sudo systemctl restart mysandbox-firewall）。services 网段的应用容器只是被执行
//     目标、不需要调别人，不给。
//   - 每次 exec 记审计日志（单 token 不区分调用方，记 target/cmd/cwd/结果）。
//   - 宿主目标（host）= 直接 spawn 为 mysandbox 进程用户（leon）。
//
// 容器侧客户端：seedContainerCli 写进每个容器 home 的 ~/.config/mysandbox/peer.json
// （url+token，宿主每次启动扫描/建容器时刷新，server-owned 覆盖写）+ peer-exec.mjs。
// 宿主 CLI（mysandbox exec / targets）直接走本模块函数，不经 HTTP、不需要服务在跑。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { gatewayOf } from './network.js';
import { log } from './logger.js';
import { listManaged, inspectContainer, execRun } from './engine/index.js';
import { listServiceContainers } from './docker.js';

const execFileAsync = promisify(execFile);

// 默认 60s：取信息类命令足够；claude -p 这类长任务调用方自己带 --timeout。
export const PEER_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
// 服务端硬顶：防 runaway 把 mysandbox 进程占住（HTTP 响应会等满这个时长）。
export const PEER_EXEC_MAX_TIMEOUT_MS = 600_000;
// 请求体上限：exec 请求就是 target+argv，KB 级。
const MAX_BODY_BYTES = 256 * 1024;

// —— 目标执行 ——
// 目标语法：'host' | 'c:<容器名>' | 's:<服务名>' | 裸名（先 LXC 容器后服务，撞名用前缀消歧）。
export interface PeerExecRequest {
  target: string;
  cmd: string[];
  cwd?: string;
  timeoutMs?: number;
  // LXC 侧生效（execRun 的 User，'root'/'dev'/'1000:1000'，parseUser 吃名字混数字）；
  // 服务侧映射 docker exec -u；宿主侧忽略（进程用户就是 leon）。
  user?: string;
}

export interface PeerExecResult {
  ok: boolean; // 前置通过且 exitCode === 0
  exitCode: number; // -1 = 未找到/未运行/超时（与 batch.ts 的约定一致）
  stdout: string;
  stderr: string;
  error?: string; // 前置失败原因（ok=false 且 exitCode=-1 时通常有）
}

function failed(error: string): PeerExecResult {
  return { ok: false, exitCode: -1, stdout: '', stderr: '', error };
}

// LXC 系统容器：execRun（lxc-attach）。running 检查与 batch.runOne 同口径。
async function execLxc(cfg: Config, name: string, req: PeerExecRequest, timeoutMs: number): Promise<PeerExecResult> {
  let info;
  try {
    info = await inspectContainer(cfg, name);
  } catch (e) {
    const err = e as { statusCode?: number; message?: string };
    if (err?.statusCode === 404) return failed(`container not found: ${name}`);
    return failed(err?.message ?? String(e));
  }
  if (!info.running) return failed(`container not running (${info.stateStatus})`);
  const r = await execRun(cfg, name, {
    Cmd: req.cmd,
    Tty: false,
    timeoutMs,
    ...(req.user ? { User: req.user } : {}),
    ...(req.cwd ? { WorkingDir: req.cwd } : {}),
  });
  return { ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

// docker 应用容器：docker exec（管理边界靠 label——listServiceContainers 自带过滤，
// 外部容器结构性进不来，同名也 404）。argv 直传不经 shell；cwd 走 -w。
async function execService(name: string, req: PeerExecRequest, timeoutMs: number): Promise<PeerExecResult> {
  const rows = await listServiceContainers();
  const row = rows.find((r) => r.Names.split(',')[0].replace(/^\//, '') === name);
  if (!row) return failed(`service not found: ${name}`);
  if (row.State !== 'running') return failed(`service not running (${row.Status})`);
  const args = ['exec'];
  if (req.cwd) args.push('-w', req.cwd);
  if (req.user) args.push('-u', req.user);
  args.push(name, ...req.cmd);
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
    if (err.killed) {
      return { ok: false, exitCode: -1, stdout: String(err.stdout ?? ''), stderr: `${String(err.stderr ?? '')}\n[mysandbox: timeout]`, error: 'timeout' };
    }
    return { ok: false, exitCode: typeof err.code === 'number' ? err.code : 1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? err.message ?? '') };
  }
}

// 宿主：直接 spawn（argv 不经 shell）。stdin 关闭——peer exec 是一次性命令，无交互。
function execHost(req: PeerExecRequest, timeoutMs: number): Promise<PeerExecResult> {
  return new Promise((resolve) => {
    const child = spawn(req.cmd[0], req.cmd.slice(1), {
      ...(req.cwd ? { cwd: req.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (timedOut) {
        stderr += `${stderr ? '\n' : ''}[mysandbox: timeout]`;
        exitCode = -1;
      }
      resolve({ ok: exitCode === 0 && !timedOut, exitCode, stdout, stderr });
    };
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      stderr += `${stderr ? '\n' : ''}${e instanceof Error ? e.message : String(e)}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

// 目标解析 + 分发 + 审计日志。HTTP 端点与宿主 CLI 共用这一个入口。
// audit=false（宿主 CLI 直调）：降为 debug——日志走 stdout，CLI 的结果要进管道，
// 不掺 JSON 行；审计价值本就在容器来源的调用上（宿主侧有 shell history）。
export async function execOnTarget(
  cfg: Config,
  req: PeerExecRequest,
  opts: { audit?: boolean } = {},
): Promise<PeerExecResult> {
  const t0 = Date.now();
  const timeoutMs = Math.min(Math.max(req.timeoutMs ?? PEER_EXEC_DEFAULT_TIMEOUT_MS, 1_000), PEER_EXEC_MAX_TIMEOUT_MS);
  let res: PeerExecResult;
  if (!Array.isArray(req.cmd) || req.cmd.length === 0 || typeof req.cmd[0] !== 'string' || req.cmd[0] === '') {
    res = failed('cmd 不能为空');
  } else if (req.target === 'host') {
    res = await execHost(req, timeoutMs);
  } else if (req.target.startsWith('c:')) {
    res = await execLxc(cfg, req.target.slice(2), req, timeoutMs);
  } else if (req.target.startsWith('s:')) {
    res = await execService(req.target.slice(2), req, timeoutMs);
  } else {
    // 裸名：先 LXC 后服务，都没命中给消歧提示。
    const lxcRes = await execLxc(cfg, req.target, req, timeoutMs);
    if (lxcRes.error?.startsWith('container not found')) {
      const svcRes = await execService(req.target, req, timeoutMs);
      if (svcRes.error?.startsWith('service not found')) {
        res = failed(`target not found: ${req.target}（目标写法：host | c:<容器名> | s:<服务名>）`);
      } else {
        res = svcRes;
      }
    } else {
      res = lxcRes;
    }
  }
  const audit = { target: req.target, cmd: req.cmd, cwd: req.cwd, user: req.user, ms: Date.now() - t0, ok: res.ok, exitCode: res.exitCode };
  if (opts.audit === false) log.debug(audit, 'peer exec');
  else log.info(audit, 'peer exec');
  return res;
}

// —— targets 列表（mysandbox targets / GET /targets）——
export interface PeerTargets {
  host: { name: string };
  containers: { name: string; ip: string | null; running: boolean }[];
  services: { name: string; running: boolean; image: string }[];
}

export async function listTargets(cfg: Config): Promise<PeerTargets> {
  const [containers, services] = await Promise.all([
    listManaged(cfg).catch(() => []), // 引擎不可达：列不出容器但不拖垮整体
    listServiceContainers(),
  ]);
  return {
    host: { name: 'host' },
    containers: containers.map((c) => ({ name: c.name, ip: c.ip ?? null, running: c.state === 'running' })),
    services: services.map((s) => ({
      name: s.Names.split(',')[0].replace(/^\//, ''),
      running: s.State === 'running',
      image: s.Image,
    })),
  };
}

// —— 容器种子信息（container-cli.ts 的 peer.json 内容）——
export interface PeerSeedInfo {
  url: string; // 容器内可达的 peer API 地址（网关 IP = 宿主在桥上的副 IP）
  token: string;
}

export function peerSeedInfo(cfg: Config): PeerSeedInfo | undefined {
  if (!cfg.peer?.enabled || !cfg.peerToken) return undefined;
  return { url: `http://${gatewayOf(cfg)}:${cfg.peer.port}`, token: cfg.peerToken };
}

// —— HTTP 服务（容器侧调用方）——

function authed(cfg: Config, req: IncomingMessage): boolean {
  const got = req.headers['x-peer-token'];
  const want = cfg.peerToken ?? '';
  if (typeof got !== 'string' || want === '') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// 路径归一：/exec、/peer/exec 都认（人手 curl 也顺手）。
function normalizePath(url: string | undefined): string {
  const p = (url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
  return p.startsWith('/peer') ? p.slice(5) || '/' : p;
}

async function handle(cfg: Config, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = normalizePath(req.url);
  if (!authed(cfg, req)) {
    log.warn({ ip: req.socket.remoteAddress, path }, 'peer api: unauthorized');
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (req.method === 'GET' && path === '/targets') {
    sendJson(res, 200, await listTargets(cfg));
    return;
  }
  if (req.method === 'POST' && path === '/exec') {
    let parsed: PeerExecRequest;
    try {
      parsed = JSON.parse(await readBody(req)) as PeerExecRequest;
    } catch (e) {
      sendJson(res, 400, { error: `bad request: ${e instanceof Error ? e.message : e}` });
      return;
    }
    if (typeof parsed.target !== 'string' || parsed.target === '') {
      sendJson(res, 400, { error: 'target required（host | c:<名> | s:<名>）' });
      return;
    }
    // exec 级失败走 200 + ok:false（调用方按结构化结果处理），只有协议错误才用 4xx/5xx。
    sendJson(res, 200, await execOnTarget(cfg, parsed));
    return;
  }
  sendJson(res, 404, { error: 'not found（routes: GET /targets, POST /exec）' });
}

// 每次尝试新建一个 server：listen 失败（EADDRNOTAVAIL 等）后复用同一实例再 listen 的
// 状态机容易留脏状态，重建最省心（失败的 listen 不占端口，旧实例无 fd 泄漏）。
function bind(cfg: Config, bindIp: string): void {
  let attempt = 0;
  const listen = () => {
    const server = createServer((req, res) => {
      handle(cfg, req, res).catch((e) => {
        log.warn({ err: String(e) }, 'peer api: handler failed');
        try { sendJson(res, 500, { error: String(e instanceof Error ? e.message : e) }); } catch { /* 已回包 */ }
      });
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRNOTAVAIL' && attempt < 15) {
        // 网关 IP 还没挂上（boot 时序：system 的 mysandbox-net 晚于 user service）。
        attempt += 1;
        const waitMs = Math.min(1000 * attempt, 5_000);
        // 前两次 warn（正常宿主上应很快起来），之后降 debug：非 LXC 宿主上跑 mysandbox
        // 会一路重试到底，别刷 warn。
        const logFn = attempt <= 2 ? log.warn : log.debug;
        logFn({ bindIp, port: cfg.peer.port, attempt, retryMs: waitMs }, 'peer api: gateway IP not up yet, retrying');
        setTimeout(listen, waitMs).unref();
        return;
      }
      // EADDRINUSE（起了两个 mysandbox）/ EACCES 等一律放弃：非致命。
      log.warn({ bindIp, port: cfg.peer.port, err: e.message }, 'peer api: not listening (containers lose cross-target exec)');
    });
    server.on('listening', () => {
      log.info({ bindIp, port: cfg.peer.port }, 'peer api: listening');
    });
    server.listen(cfg.peer.port, bindIp);
  };
  listen();
}

// cli.ts 启动装配点（与 startDockerApiBridge 同排）。永不抛、不阻塞 listen。
export function startPeerApi(cfg: Config): void {
  if (!cfg.peer?.enabled) return;
  bind(cfg, gatewayOf(cfg));
}

// —— 宿主一次性子命令（进程内直调，不需要服务在跑）——

export async function runExecCommand(argv: string[], config: Config): Promise<void> {
  const usage = () =>
    process.stderr.write(
      '用法: mysandbox exec [--cwd <dir>] [--timeout <sec>] [--user <u>] <目标> -- <命令...>\n' +
        '目标: host | c:<容器名> | s:<服务名> | <容器名>（mysandbox targets 可列出）\n',
    );
  const req: PeerExecRequest = { target: '', cmd: [] };
  const cmd: string[] = [];
  let timeoutSec = 0;
  let onlyCmd = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (onlyCmd) {
      cmd.push(a);
    } else if (a === '--') {
      onlyCmd = true;
    } else if (a === '--cwd') {
      req.cwd = argv[++i];
    } else if (a === '--timeout') {
      timeoutSec = Number(argv[++i]);
    } else if (a === '--user') {
      req.user = argv[++i];
    } else if (a === '-h' || a === '--help') {
      usage();
      return;
    } else if (a.startsWith('--')) {
      process.stderr.write(`>> 未知选项: ${a}\n`);
      usage();
      process.exitCode = 2;
      return;
    } else if (!req.target) {
      req.target = a;
    } else {
      cmd.push(a);
    }
  }
  req.cmd = cmd;
  if (!req.target || cmd.length === 0) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (timeoutSec > 0) req.timeoutMs = timeoutSec * 1000;
  const r = await execOnTarget(config, req, { audit: false });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) process.stderr.write(`>> mysandbox: ${r.error}\n`);
  process.exitCode = r.exitCode === -1 ? 1 : r.exitCode;
}

export async function runTargetsCommand(config: Config): Promise<void> {
  const t = await listTargets(config);
  process.stdout.write('host\n');
  for (const c of t.containers) {
    process.stdout.write(`c:${c.name}  ${c.ip ?? '-'}${c.running ? '' : '  (已停止)'}\n`);
  }
  for (const s of t.services) {
    process.stdout.write(`s:${s.name}  ${s.image}${s.running ? '' : '  (已停止)'}\n`);
  }
}
