// docker CLI 客户端：配套服务层（数据库等）的原语集。
//
// 角色边界：docker 在 mysandbox 里不再是容器引擎（那是 LXC 的活），而是「服务提供方」——
// mysandbox 用它起 postgres/redis 这类配套服务，挂在与 LXC 同一座网桥上供容器固定 IP 直连。
// 所以这个模块**不在 engine/ 里**：Engine 接口是容器生命周期形状（create/exec/terminal），
// 服务是另一种生命周期；「业务层只 import engine/index.js」的约定限于容器引擎。
// docker 本身的编排（预设表/路由/SSE）在 services.ts，这里只有无业务语义的 docker 原语。
//
// 实现约定（对齐 engine/lxc.ts 的 run() 模式）：
//   - 一律 execFile/spawn 数组参数，无 shell——env 值里的特殊字符天然安全。
//   - 机器可读输出统一 `--format '{{json .}}'`：network inspect 是单对象，ps/volume ls 是
//     逐行 JSON，dockerJson 与 dockerJsonLines 分开，别共用假设。
//   - 失败不抛，返回 ok:false（调用方决定怎么翻译错误）；dockerJson 系列坏输出才抛。
//   - 权限：宿主用户在 docker 组（免 sudo 直连 /var/run/docker.sock）。systemd user service
//     里同样可用——group 成员在 user manager 启动时快照，后加组需 daemon-restart。
//
// 管理边界（结构性，不靠约定）：所有针对「我们的服务」的操作都带 SERVICE_FILTER（label
// mysandbox.kind=service）。宿主上其它 docker 容器（如 dener-*）没有该 label，永远不进列表、
// 对它们的服务操作只会 404。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import type { Config } from './config.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// label 方案（与被删的 docker 引擎同款 managed-by，加 kind 区分服务）。
export const MANAGED_LABEL = 'mysandbox.managed-by'; // 值恒 'mysandbox'
export const KIND_LABEL = 'mysandbox.kind'; // 值恒 'service'
export const SERVICE_FILTER = [
  '--filter', `label=${MANAGED_LABEL}=mysandbox`,
  '--filter', `label=${KIND_LABEL}=service`,
];

export function serviceVolumeName(name: string): string {
  return `mysandbox-svc-${name}`;
}

async function dockerExec(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

// 末尾追加 --format 的单对象 JSON（network inspect 等）。
async function dockerJson<T>(args: string[], timeoutMs?: number): Promise<T> {
  const r = await dockerExec([...args, '--format', '{{json .}}'], timeoutMs);
  if (!r.ok) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim() || 'no output'}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`docker ${args[0]} returned unparseable output`);
  }
}

// 逐行 JSON（ps / volume ls / events 流之外的批量查询）。
async function dockerJsonLines<T>(args: string[], timeoutMs?: number): Promise<T[]> {
  const r = await dockerExec([...args, '--format', '{{json .}}'], timeoutMs);
  if (!r.ok) throw new Error(`docker ${args[0]} failed: ${r.stderr.trim() || 'no output'}`);
  const out: T[] = [];
  for (const line of r.stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      // 坏行丢弃
    }
  }
  return out;
}

// —— 探活：/api/health 也走这里，必须快败，绝不能把 health 拖死 ——
export async function dockerStatus(): Promise<{ reachable: boolean; version?: string; error?: string }> {
  const r = await dockerExec(['version', '--format', '{{.Server.Version}}'], 1_500);
  if (!r.ok) {
    return { reachable: false, error: r.stderr.trim().split('\n')[0] || 'docker unreachable' };
  }
  return { reachable: true, version: r.stdout.trim() };
}

// —— 网络 ——

// 创建用户网络（bridge，指定子网/网关，钉桥设备名 + managed-by label——mysandbox 自有资产）。
// 调用方保证幂等（先 inspectNetwork，缺失才建）。桥名以 br- 开头是有意的：DOCKER-USER
// 放行用 br+ 通配，钉名不得掉出通配范围；桥名由调用方按「br-<网络名首段>」推导
// （Linux 网卡名 ≤15 字符，网络名带 -lan 后缀会超长）。
export async function createNetwork(
  name: string,
  subnet: string,
  gateway: string,
  bridge: string,
): Promise<void> {
  const r = await dockerExec(
    [
      'network', 'create', '--driver', 'bridge',
      '--subnet', subnet, '--gateway', gateway,
      '--label', `${MANAGED_LABEL}=mysandbox`,
      '--opt', `com.docker.network.bridge.name=${bridge}`,
      name,
    ],
    15_000,
  );
  if (!r.ok) throw new Error(`docker network create failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

export interface NetworkInfo {
  name: string;
  id: string;
  subnet: string | null;
  gateway: string | null;
  // docker 用户网络桥设备名：mysandbox 建的网络钉名 br-<网络名首段>（mysandbox-lan →
  // br-mysandbox，见 services.ts ensureServiceNetwork）；外部网络则是 br-<网络id前12位>。
  // 此字段用于状态展示与排障（桥一致性检查已随 LXC 独立网桥退役）。
  bridge: string | null;
  endpoints: { name: string; ip: string }[];
}

interface RawNetwork {
  Name?: string;
  Id?: string;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
  Containers?: Record<string, { Name?: string; IPv4Address?: string }>;
}

export async function inspectNetwork(name: string): Promise<NetworkInfo | null> {
  let raw: RawNetwork | null = null;
  try {
    raw = await dockerJson<RawNetwork>(['network', 'inspect', name]);
  } catch {
    return null;
  }
  const ipam = raw.IPAM?.Config?.[0];
  const endpoints = Object.values(raw.Containers || {})
    .map((c) => ({ name: c.Name ?? '', ip: (c.IPv4Address ?? '').split('/')[0] }))
    .filter((e) => e.name && e.ip);
  return {
    name: raw.Name ?? name,
    id: raw.Id ?? '',
    subnet: ipam?.Subnet ?? null,
    gateway: ipam?.Gateway ?? null,
    bridge: raw.Id ? `br-${raw.Id.slice(0, 12)}` : null,
    endpoints,
  };
}

// —— 容器（服务）——
export interface DockerContainerRow {
  ID: string;
  Names: string; // --format 下是逗号拼接字符串，取第一段
  Image: string;
  State: string; // running / exited / restarting…
  Status: string; // 人话状态（Up 2 hours / Restarting (1) 3s ago…）
  CreatedAt: string;
  Labels: Record<string, string>;
  Networks: string;
}

function rowName(row: DockerContainerRow): string {
  return row.Names.split(',')[0].replace(/^\//, '');
}

// ⚠️ network inspect 只列 running 端点：停机服务的静态 IP 不在这里——占用判定必须
// 并上 state.services 里登记的 IP（见 services.ts allocateServiceIp）。
export async function listServiceContainers(): Promise<DockerContainerRow[]> {
  try {
    return await dockerJsonLines<DockerContainerRow>(['ps', '-a', ...SERVICE_FILTER]);
  } catch (e) {
    log.warn({ err: String(e) }, 'docker ps failed');
    return [];
  }
}

export async function serviceNameExists(name: string): Promise<boolean> {
  // 全量查重（含 dener-* 等外部容器）：docker 容器名全局唯一，撞名 create 会失败，
  // 与其让 create 报晦涩错误不如前置给 409。
  const rows = await dockerJsonLines<{ Names: string }>(['ps', '-a']);
  return rows.some((r) => r.Names.split(',')[0].replace(/^\//, '') === name);
}

export interface CreateServiceArgs {
  name: string;
  image: string;
  ip: string;
  network: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  volume?: { source: string; target: string } | null;
  command?: string[];
}

export async function createServiceContainer(args: CreateServiceArgs): Promise<void> {
  const argv = [
    'create',
    '--name', args.name,
    '--hostname', args.name,
    '--network', args.network,
    '--ip', args.ip,
    '--restart', 'unless-stopped',
  ];
  for (const [k, v] of Object.entries(args.labels)) argv.push('--label', `${k}=${v}`);
  if (args.volume) argv.push('--mount', `source=${args.volume.source},target=${args.volume.target}`);
  for (const [k, v] of Object.entries(args.env)) argv.push('--env', `${k}=${v}`);
  argv.push(args.image);
  if (args.command?.length) argv.push(...args.command);
  const r = await dockerExec(argv, 60_000);
  if (!r.ok) {
    throw new Error(`docker create failed: ${r.stderr.trim() || 'no output'}`);
  }
}

// 停机容器的静态 IP（IPAMConfig 是 create 时的期望值，停机也在）。
export async function containerIpamIp(name: string): Promise<string | null> {
  try {
    const raw = await dockerJson<{
      NetworkSettings?: { Networks?: Record<string, { IPAMConfig?: { IPv4Address?: string } }> };
    }>(['container', 'inspect', name]);
    for (const n of Object.values(raw.NetworkSettings?.Networks ?? {})) {
      if (n.IPAMConfig?.IPv4Address) return n.IPAMConfig.IPv4Address;
    }
  } catch {
    return null;
  }
  return null;
}

// 容器主进程的宿主 PID（非运行/查不到 = null）。服务监听端口扫描用：宿主侧
// /proc/<pid>/net/tcp 就是该进程网络命名空间（= 容器）的监听表，免 docker exec
// 的镜像内依赖（distroless 等无 shell/awk 的镜像也适用），见 services.ts listen 路由。
export async function containerPid(name: string): Promise<number | null> {
  const r = await dockerExec(['container', 'inspect', '--format', '{{.State.Pid}}', name], 5_000);
  if (!r.ok) return null;
  const pid = Number(r.stdout.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// 镜像的本地 ID（sha256:…；查不到 = null）。服务更新用它判断 pull 前后镜像是否变化
// ——变了才值得重建容器，没变就是「已是最新」。
export async function imageId(ref: string): Promise<string | null> {
  const r = await dockerExec(['image', 'inspect', '--format', '{{.Id}}', ref], 5_000);
  if (!r.ok) return null;
  const id = r.stdout.trim();
  return id || null;
}

// 重建前的现场快照：运行态 + labels + 命名卷的容器内挂载点。更新（拉新镜像后按原
// 形状重建容器）要复刻创建时的全部形状——env/command 在 meta 里，卷挂载点 meta 没记
// （只有卷名），labels（含 preset/created-at）也在容器身上，inspect 是权威。
export interface ServiceSnapshot {
  running: boolean;
  labels: Record<string, string>;
  volumeTarget: string | null; // 命名卷的容器内挂载路径（无卷 = null）
}

export async function inspectServiceSnapshot(name: string): Promise<ServiceSnapshot | null> {
  try {
    const raw = await dockerJson<{
      State?: { Running?: boolean };
      Config?: { Labels?: Record<string, string> };
      Mounts?: { Type?: string; Name?: string; Destination?: string }[];
    }>(['container', 'inspect', name]);
    const vol = (raw.Mounts ?? []).find((m) => m.Type === 'volume' && m.Name);
    return {
      running: raw.State?.Running === true,
      labels: raw.Config?.Labels ?? {},
      volumeTarget: vol?.Destination ?? null,
    };
  } catch {
    return null;
  }
}

export async function startContainer(name: string): Promise<void> {
  const r = await dockerExec(['start', name], 60_000);
  if (!r.ok) throw new Error(`docker start failed: ${r.stderr.trim() || 'no output'}`);
}

export async function stopContainer(name: string, t = 5): Promise<void> {
  const r = await dockerExec(['stop', '-t', String(t), name], 60_000);
  if (!r.ok) throw new Error(`docker stop failed: ${r.stderr.trim() || 'no output'}`);
}

export async function restartContainer(name: string, t = 5): Promise<void> {
  const r = await dockerExec(['restart', '-t', String(t), name], 90_000);
  if (!r.ok) throw new Error(`docker restart failed: ${r.stderr.trim() || 'no output'}`);
}

export async function removeContainer(name: string): Promise<void> {
  const r = await dockerExec(['rm', '-f', name], 60_000);
  if (!r.ok) throw new Error(`docker rm failed: ${r.stderr.trim() || 'no output'}`);
}

// logs 的 stdout/stderr 都要收：不少镜像（mysql 8 实测）把常规输出走 stderr。
export async function containerLogs(name: string, tail = 200): Promise<string> {
  const r = await dockerExec(['logs', '--tail', String(tail), name], 15_000);
  if (!r.ok) throw new Error(`docker logs failed: ${r.stderr.trim() || 'no output'}`);
  return `${r.stdout}${r.stderr}`;
}

// —— 镜像 ——
export interface DockerImageRow {
  Repository: string;
  Tag: string;
  Size: string; // 人话大小（"431MB"）
  CreatedSince: string; // 人话时间（"2 days ago"）
}

// 本地镜像全集（同一 image ID 多 tag 自然多行；<none> 悬空行由业务层按需过滤）。
export async function listImages(): Promise<DockerImageRow[]> {
  return dockerJsonLines<DockerImageRow>(['images']);
}

// 镜像是否已在本地（按引用名查，tag 或 digest 均可）。
export async function imageExistsLocal(image: string): Promise<boolean> {
  const r = await dockerExec(['image', 'inspect', image], 5_000);
  return r.ok;
}

// daemon 的全局 registry-mirrors（daemon.json 的 registry-mirrors）。拉 docker.io 走它；
// 为空 = 直连，国内网络/代理环境下常超时（本机实测：daemon.json 无 mirrors 且宿主在
// fake-ip 网络下时 auth.docker.io 直接 EOF）。返回 null = 探测失败（调用方省略字段，不猜）。
// 注意不走 dockerJson——它会在末尾追加自己的 --format，与参数里的冲突。只看 Mirrors，
// 别解析 IndexConfigs（私有 insecure registry 在那，与 docker.io 拉取无关）。
export async function registryMirrors(): Promise<string[] | null> {
  const r = await dockerExec(['info', '--format', '{{json .RegistryConfig}}'], 3_000);
  if (!r.ok) return null;
  try {
    const c = JSON.parse(r.stdout) as { Mirrors?: unknown };
    return Array.isArray(c.Mirrors) ? (c.Mirrors as string[]) : [];
  } catch {
    return null;
  }
}

export interface PullOpts {
  timeoutMs?: number; // 硬超时（默认 30min）：到点 SIGKILL——兜底防呆，正常该先被 idle 看门狗拦下
  idleMs?: number; // 无输出看门狗（默认 5min）：TLS 握手卡死的 pull 完全静默，等硬超时纯属干等
  signal?: AbortSignal; // 取消：SIGKILL 子进程，以带 canceled 标记的错误 reject
}

// docker pull 的流式进度。无 TTY 下 docker CLI 输出 JSON 行，逐行解析后聚合：
//   - {status} 无 id/progress（Pulling from / Digest / Status / Verifying Checksum…）→ 立即透传
//   - {id, progressDetail} → 层进度聚合，每 2s flush 一行摘要（原始每层 ~500ms 一条
//     带 [===>] 进度条的行，直接透传全是垃圾）
//   - {error} → 记为致命错误
// JSON.parse 失败的行原样透传（防 CLI 混入非 JSON 输出）。
// 镜像已在本地时调用方跳过（imageExistsLocal 判定）：pull 对本地已有的 tag 也会去
// registry 校验 manifest——离线/网络受限环境下白白失败（实测 docker 29）。
export async function pullImageStream(image: string, onLine: (line: string) => void, opts: PullOpts = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const idleMs = opts.idleMs ?? 5 * 60_000;
  await new Promise<void>((resolveP, rejectP) => {
    const child = spawn('docker', ['pull', image], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let done = false; // close 只处理一次（超时/取消先 kill，close 跟着触发）
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let killReason: 'timeout' | 'idle' | 'cancel' | null = null;

    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      fn();
    };

    // —— 层进度聚合 ——
    const layers = new Map<string, { current: number; total: number }>();
    let lastSummary = '';
    const flushSummary = (): void => {
      let cur = 0;
      let total = 0;
      for (const l of layers.values()) {
        if (l.total > 0) {
          cur += l.current;
          total += l.total;
        }
      }
      if (total === 0) return;
      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)}MB`;
      const pct = Math.floor((cur / total) * 100);
      const s = `层进度：${layers.size} 层 · ${mb(cur)}/${mb(total)}（${pct}%）`;
      if (s !== lastSummary) {
        // 数字没变（卡住）就不重复刷行——停滞靠 idle 看门狗报，不靠刷屏
        lastSummary = s;
        onLine(s);
      }
    };
    const summaryTimer = setInterval(flushSummary, 2_000);

    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killReason = 'idle';
        child.kill('SIGKILL');
      }, idleMs);
    };
    hardTimer = setTimeout(() => {
      killReason = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    armIdle();

    interface PullEvent {
      status?: string;
      id?: string;
      progress?: string; // 带进度条的层事件（[===> ] 12.3MB/43.2MB）——聚合，不透传
      progressDetail?: { current?: number; total?: number };
      error?: string;
      errorDetail?: { message?: string };
    }
    const feed = (buf: Buffer): void => {
      armIdle(); // 任何输出都算「活着」
      for (const rawLine of buf.toString('utf8').split('\n')) {
        const s = rawLine.trim();
        if (!s) continue;
        let ev: PullEvent;
        try {
          ev = JSON.parse(s) as PullEvent;
        } catch {
          onLine(s); // 非 JSON 输出原样透传
          continue;
        }
        if (ev.error || ev.errorDetail?.message) {
          err += `${ev.error ?? ev.errorDetail?.message}\n`;
          continue;
        }
        if (ev.id && ev.progressDetail) {
          layers.set(ev.id, {
            current: ev.progressDetail.current ?? 0,
            total: ev.progressDetail.total ?? 0,
          });
          continue;
        }
        if (ev.status && !ev.progress) onLine(ev.status);
      }
    };

    child.stdout?.on('data', feed);
    child.stderr?.on('data', (b: Buffer) => {
      feed(b);
      err += b.toString('utf8');
    });
    child.on('error', (e) => {
      clearInterval(summaryTimer);
      finish(() => rejectP(e));
    });
    child.on('close', (code) => {
      clearInterval(summaryTimer);
      if (code === 0) {
        flushSummary(); // 收尾刷最后一行（层全部完成后）
        finish(resolveP);
        return;
      }
      finish(() => {
        if (killReason === 'cancel' || opts.signal?.aborted) {
          rejectP(Object.assign(new Error(`已取消拉取 ${image}`), { canceled: true }));
        } else if (killReason === 'timeout') {
          rejectP(new Error(`拉取超时（${Math.round(timeoutMs / 60_000)} 分钟）——镜像 ${image}`));
        } else if (killReason === 'idle') {
          rejectP(new Error(`拉取停滞（${Math.round(idleMs / 60_000)} 分钟无输出）——网络受限或 registry 不可达，镜像 ${image}`));
        } else {
          rejectP(new Error(err.trim().split('\n').pop() || `docker pull exited ${code}`));
        }
      });
    });
    if (opts.signal) {
      opts.signal.addEventListener(
        'abort',
        () => {
          killReason = 'cancel';
          child.kill('SIGKILL');
        },
        { once: true },
      );
    }
  });
}

// —— 卷 ——

export async function volumeExists(volume: string): Promise<boolean> {
  try {
    return (await listManagedVolumes()).some((v) => v.name === volume);
  } catch {
    return false;
  }
}

// 带 mysandbox label 的全部卷（status 总览扫描用；label 见 ensureVolume）。
export async function listManagedVolumes(): Promise<{ name: string }[]> {
  return dockerJsonLines<{ Name: string }>([
    'volume', 'ls', '--filter', `label=${MANAGED_LABEL}=mysandbox`,
  ]).then((rows) => rows.map((r) => ({ name: r.Name })));
}

export async function ensureVolume(volume: string): Promise<void> {
  if (await volumeExists(volume)) return;
  const r = await dockerExec([
    'volume', 'create', '--label', `${MANAGED_LABEL}=mysandbox`, volume,
  ]);
  if (!r.ok) throw new Error(`docker volume create failed: ${r.stderr.trim() || 'no output'}`);
}

export async function removeVolume(volume: string): Promise<void> {
  const r = await dockerExec(['volume', 'rm', volume], 30_000);
  if (!r.ok) throw new Error(`docker volume rm failed: ${r.stderr.trim() || 'no output'}`);
}

// —— 事件订阅（服务 hosts 追平用） ——

export interface ServiceEventSubscription {
  close(): void;
  closed: Promise<void>;
}

// start/die/destroy：服务起来了/停了/没了，三种都影响 hosts 里的服务行。
// closed 在流 end/close/error 任一时 resolve（error 吞掉，调用方退避重连）。
export function subscribeServiceEvents(
  onEvent: (ev: { name: string; action: string }) => void,
): ServiceEventSubscription {
  const child: ChildProcess = spawn('docker', [
    'events',
    '--filter', 'type=container',
    '--filter', 'event=start',
    '--filter', 'event=die',
    '--filter', 'event=destroy',
    ...SERVICE_FILTER,
    '--format', '{{json .}}',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  child.on('exit', () => resolveClosed());
  child.on('error', () => resolveClosed());

  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as {
          Action?: string;
          Actor?: { Attributes?: { name?: string } };
        };
        const name = ev.Actor?.Attributes?.name;
        if (ev.Action && name) onEvent({ name, action: ev.Action });
      } catch {
        // 坏行丢弃
      }
    }
  });

  return {
    close() {
      try {
        child.kill('SIGTERM');
      } catch {
        /* noop */
      }
    },
    closed,
  };
}

// —— hosts 注入素材 ——
// running 的服务容器 → [{name, ip}]。这是 hosts 块的唯一事实源（applyHostsToContainers /
// lifecycle 初始 hosts 都经它）。docker 不可达返回 []：hosts 路径永不因 docker 挂掉而 500，
// 等价于「没有服务」，容器里旧的服务行下次 docker 恢复后被追平。
export async function listServiceEndpoints(cfg: Config): Promise<{ name: string; ip: string }[]> {
  const net = await inspectNetwork(cfg.services.network);
  if (!net) return [];
  const rows = await listServiceContainers();
  const running = new Set(rows.filter((r) => r.State === 'running').map(rowName));
  return net.endpoints
    .filter((e) => running.has(e.name))
    .map((e) => ({ name: e.name, ip: e.ip }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
