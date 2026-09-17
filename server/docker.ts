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
// 管理边界（结构性，不靠约定）：受管服务 = label mysandbox.kind=service + mysandbox.managed-by。
// docker 不能给既有容器后补 label，收编的外部容器（无 label）走 sidecar（state.json
// services.adopted）纳管——所以列表/事件等过滤点都要**双源**：label 集 ∪ 调用方传入的
// 收编名集（extraNames，由 state 的 adopted meta 得出）。未收编的外部容器（dener-* 等）
// 依然永远不进列表、对它们的服务操作只会 404。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcess } from 'node:child_process';
import type { Config } from './config.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// label 方案（与被删的 docker 引擎同款 managed-by，加 kind 区分服务）。
export const MANAGED_LABEL = 'mysandbox.managed-by'; // 值恒 'mysandbox'
export const KIND_LABEL = 'mysandbox.kind'; // 值恒 'service'

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
  // ⚠️ docker ps 的 {{json .}} 里这是逗号拼接串（"k=v,k2=v2"）不是对象——读具体
  // label 一律走 rowLabels()（实测踩过：当对象用恒 undefined，受管判定全部失效）。
  Labels: string;
  Networks: string;
}

function rowName(row: DockerContainerRow): string {
  return row.Names.split(',')[0].replace(/^\//, '');
}

// Labels 拼接串 → 对象。值里的逗号 docker 不转义（拼接格式固有损失），自家 label
// 无逗号，够用；容器 inspect（dockerJson）里的 Labels 才是真对象（如 328 行）。
export function rowLabels(row: Pick<DockerContainerRow, 'Labels'>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof row.Labels !== 'string') return out;
  for (const pair of row.Labels.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

// ⚠️ network inspect 只列 running 端点：停机服务的静态 IP 不在这里——占用判定必须
// 并上 state.services 里登记的 IP（见 services.ts allocateServiceIp）。
//
// 双源（见文件头「管理边界」）：label 命中的受管服务 ∪ extraNames 里无 label 的收编
// 容器（精确名匹配，extraNames 来自 state 的 adopted meta）。一次无过滤 `ps -a` 在 JS
// 分区——宿主容器量级（几十）下比 N 条 `--filter name=` 便宜，且 name 过滤是子串匹配
// 不能直接用。
export async function listServiceContainers(extraNames: string[] = []): Promise<DockerContainerRow[]> {
  try {
    const rows = await dockerJsonLines<DockerContainerRow>(['ps', '-a']);
    const extra = new Set(extraNames);
    return rows.filter((r) => {
      const labels = rowLabels(r);
      const managed = labels[MANAGED_LABEL] === 'mysandbox' && labels[KIND_LABEL] === 'service';
      return managed || (extra.has(rowName(r)) && labels[MANAGED_LABEL] !== 'mysandbox');
    });
  } catch (e) {
    log.warn({ err: String(e) }, 'docker ps failed');
    return [];
  }
}

// 非 mysandbox 管理的容器全集（收编候选列表用）。已收编的也在（无 label 无法区分），
// 由业务层对着 state 的 adopted meta 排除。
export async function listExternalContainers(): Promise<DockerContainerRow[]> {
  try {
    const rows = await dockerJsonLines<DockerContainerRow>(['ps', '-a']);
    return rows.filter((r) => rowLabels(r)[MANAGED_LABEL] !== 'mysandbox');
  } catch (e) {
    log.warn({ err: String(e) }, 'docker ps failed');
    return [];
  }
}

// 目录注册表服务的容器行：compose project label ∈ 我们目录名集的容器（agent 自放
// compose 文件起的服务没有我们的 label，靠 project 命中）。业务层拿它和 label 管理的
// 行做并集/去重（我们生成的文件同样带 project label，两端都会命中）。
export async function listComposeProjectContainers(projects: string[]): Promise<DockerContainerRow[]> {
  if (!projects.length) return [];
  try {
    const rows = await dockerJsonLines<DockerContainerRow>(['ps', '-a']);
    const set = new Set(projects);
    return rows.filter((r) => set.has(rowLabels(r)['com.docker.compose.project'] ?? ''));
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

// 把既有容器接入用户网络（收编用）：running 容器热加第二块网卡，停机容器 start 时生效。
// 带 --ip 落静态 IP（进 IPAMConfig，停机也在）；不带则动态分配（只存在于运行时 IPAddress）。
export async function connectServiceNetwork(name: string, network: string, ip?: string): Promise<void> {
  const argv = ['network', 'connect'];
  if (ip) argv.push('--ip', ip);
  argv.push(network, name);
  const r = await dockerExec(argv, 15_000);
  if (!r.ok) throw new Error(`docker network connect failed: ${r.stderr.trim() || 'no output'}`);
}

// 从用户网络摘除（取消收编的还原动作）。失败原样抛——调用方决定是否忽略。
export async function disconnectServiceNetwork(name: string, network: string): Promise<void> {
  const r = await dockerExec(['network', 'disconnect', network, name], 15_000);
  if (!r.ok) throw new Error(`docker network disconnect failed: ${r.stderr.trim() || 'no output'}`);
}

// 容器在某网络上的 IP：静态优先（IPAMConfig，停机也在），运行时 IPAddress 兜底
// （network connect 不带 --ip 的动态分配不在 IPAMConfig 里）。
export async function containerNetIp(name: string, network: string): Promise<string | null> {
  try {
    const raw = await dockerJson<{
      NetworkSettings?: {
        Networks?: Record<string, { IPAMConfig?: { IPv4Address?: string }; IPAddress?: string }>;
      };
    }>(['container', 'inspect', name]);
    const n = raw.NetworkSettings?.Networks?.[network];
    return n?.IPAMConfig?.IPv4Address ?? n?.IPAddress ?? null;
  } catch {
    return null;
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

// 容器发布的容器侧端口（PortBindings 的 key：'80/tcp' → 80）。栈收编时选「入口容器」
// 用（有发布的那个是对外入口）。
export async function containerPublishedPorts(name: string): Promise<number[]> {
  const r = await dockerExec(['container', 'inspect', '--format', '{{json .HostConfig.PortBindings}}', name], 5_000);
  if (!r.ok) return [];
  try {
    const bindings = JSON.parse(r.stdout) as Record<string, unknown> | null;
    if (!bindings) return [];
    return Object.keys(bindings)
      .map((k) => Number(k.split('/')[0]))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

// 迁移前的现场快照：运行态 + labels + 命名卷的容器内挂载点。旧版（docker create）
// 服务迁移到 compose 文件时要从这里复刻形状——env/command 在 meta 里，卷挂载点
// meta 没记（只有卷名），labels（含 preset/created-at）在容器身上，inspect 是权威。
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

// —— 接管式收编的形状复刻原料 ——
// 外部裸容器（无 compose label、docker run 起家）没有底账可抄，inspect 是唯一事实。
// 这里只取「操作者加的形状」：env 要减掉镜像默认值（调用方对 image inspect 做 diff）、
// 端口/卷/网络/健康检查/restart 原样带回。host 网络模式原样报告（compose network_mode: host）。
export interface ContainerShape {
  image: string;
  env: Record<string, string>;
  entrypoint: string[];
  cmd: string[];
  user: string | null;
  workingDir: string | null;
  labels: Record<string, string>;
  restart: string | null; // 'no' | 'always' | 'unless-stopped' | 'on-failure'
  networkMode: string | null; // 'bridge' | 'host' | 'none' | <自定义网络名>
  ports: { host: string; container: number; proto: string }[];
  networks: { name: string; ipv4: string | null; aliases: string[] }[];
  volumes: { type: string; name: string | null; source: string | null; destination: string }[];
  healthcheck: { test: string[]; interval?: string; timeout?: string; retries?: number; startPeriod?: string } | null;
}

type ShapeRaw = {
  Config?: {
    Image?: string;
    Env?: string[];
    Entrypoint?: string[] | null;
    Cmd?: string[] | null;
    User?: string | null;
    WorkingDir?: string | null;
    Labels?: Record<string, string>;
    Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number; StartPeriod?: number } | null;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string };
    NetworkMode?: string;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null>;
    Binds?: string[] | null;
  };
  NetworkSettings?: { Networks?: Record<string, { IPAMConfig?: { IPv4Address?: string } | null; Aliases?: string[] | null }> };
  Mounts?: { Type?: string; Name?: string; Source?: string; Destination?: string }[];
};

export async function inspectContainerShape(name: string): Promise<ContainerShape | null> {
  let raw: ShapeRaw | null = null;
  try {
    raw = await dockerJson<ShapeRaw>(['container', 'inspect', name]);
  } catch {
    return null;
  }
  if (!raw?.Config) return null;
  const env: Record<string, string> = {};
  for (const e of raw.Config.Env ?? []) {
    const i = e.indexOf('=');
    if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
  }
  const ports: ContainerShape['ports'] = [];
  for (const [key, binds] of Object.entries(raw.HostConfig?.PortBindings ?? {})) {
    const [cPort, cProto] = key.split('/');
    for (const b of binds ?? []) {
      if (b.HostPort) ports.push({ host: b.HostPort, container: Number(cPort), proto: cProto ?? 'tcp' });
    }
  }
  const networks: ContainerShape['networks'] = [];
  for (const [nname, n] of Object.entries(raw.NetworkSettings?.Networks ?? {})) {
    networks.push({ name: nname, ipv4: n.IPAMConfig?.IPv4Address ?? null, aliases: (n.Aliases ?? []).filter(Boolean) });
  }
  const ns = (s: number | undefined): string | undefined =>
    s == null ? undefined : `${Math.round(s / 1e9)}s`; // Go 纳秒时长 → compose 的 "10s"
  const hc = raw.Config.Healthcheck;
  return {
    image: raw.Config.Image ?? '',
    env,
    entrypoint: raw.Config.Entrypoint ?? [],
    cmd: raw.Config.Cmd ?? [],
    user: raw.Config.User || null,
    workingDir: raw.Config.WorkingDir || null,
    labels: raw.Config.Labels ?? {},
    restart: raw.HostConfig?.RestartPolicy?.Name ?? null,
    networkMode: raw.HostConfig?.NetworkMode ?? null,
    ports,
    networks,
    volumes: (raw.Mounts ?? [])
      .filter((m): m is { Type: string; Name?: string; Source?: string; Destination: string } =>
        (m.Type === 'volume' || m.Type === 'bind') && !!m.Destination)
      .map((m) => ({ type: m.Type, name: m.Name ?? null, source: m.Source ?? null, destination: m.Destination })),
    healthcheck:
      hc && hc.Test?.length
        ? {
            test: hc.Test,
            interval: ns(hc.Interval),
            timeout: ns(hc.Timeout),
            retries: hc.Retries,
            startPeriod: ns(hc.StartPeriod),
          }
        : null,
  };
}

// 镜像默认形状（env/entrypoint/cmd/working_dir/user）：容器形状减镜像默认 = 操作者加的东西。
export interface ImageDefaults {
  env: Record<string, string>;
  entrypoint: string[];
  cmd: string[];
  workingDir: string | null;
  user: string | null;
}

export async function inspectImageDefaults(ref: string): Promise<ImageDefaults | null> {
  try {
    const raw = await dockerJson<{
      Config?: { Env?: string[]; Entrypoint?: string[] | null; Cmd?: string[] | null; WorkingDir?: string | null; User?: string | null };
    }>(['image', 'inspect', ref]);
    if (!raw?.Config) return null;
    const env: Record<string, string> = {};
    for (const e of raw.Config.Env ?? []) {
      const i = e.indexOf('=');
      if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
    }
    return {
      env,
      entrypoint: raw.Config.Entrypoint ?? [],
      cmd: raw.Config.Cmd ?? [],
      workingDir: raw.Config.WorkingDir || null,
      user: raw.Config.User || null,
    };
  } catch {
    return null;
  }
}

// compose 漂移检测的容器侧：最后一次 up 时 compose 按配置算出的 hash（label）。非
// compose 管的容器（旧版 docker create / 收编）label 缺席 = 空串 → 调用方按「未应用/
// 待迁移」理解。与 composeFileHash 同一算法来源，逐字节可比。
export async function containerComposeHash(name: string): Promise<string | null> {
  const r = await dockerExec(
    ['container', 'inspect', '--format', '{{index .Config.Labels "com.docker.compose.config-hash"}}', name],
    5_000,
  );
  if (!r.ok) return null;
  const v = r.stdout.trim();
  return v || null;
}

// 容器是否存在的三态判定：true=在 / false=确认无（no such object）/ null=查询失败不可判定。
// `docker ps -a` 失败会被 listServiceContainers 吞成空列表（daemon 忙碌/重启时的既定降级），
// 但「列表为空」在 requireService 的孤儿 meta 清理语境下不可信——删 meta 前用它单容器
// 直查二次确认，防把瞬时故障当成永久消失（2026-09-10 myapikey meta 事故：宿主 build
// 收尾瞬间 ps 失败，活着的容器被误判孤儿、meta 被清，重建从此 409）。
export async function containerExists(name: string): Promise<boolean | null> {
  const r = await dockerExec(['container', 'inspect', '--format', '{{.Name}}', name], 5_000);
  if (r.ok) return r.stdout.trim().length > 0;
  return /no such/i.test(r.stderr) ? false : null;
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

// 本进程派生的全部 docker events 订阅：node 退出（含 tsx watch 热重启、信号退出——
// hostTerminal 的 signal 处理器 process.exit 时 exit 事件照发）时同步 SIGKILL。不收割
// = 每次重启泄一代订阅孤儿，dockerd 被几百条长连接吊着（实测见 engine/lxc.ts 同款注释）。
const eventChildren = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of eventChildren) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
  }
});

// start/die/destroy：服务起来了/停了/没了，三种都影响 hosts 里的服务行。
// 不带 label 过滤：收编容器（无 label）的事件也要进来。受管与否在回调里给
// （Actor.Attributes 自带容器 label），过滤判定由调用方做——外部容器 churning
// 时调用方拿收编名集一挡就静默返回，不触发扫描。
// closed 在流 end/close/error 任一时 resolve（error 吞掉，调用方退避重连）。
export function subscribeServiceEvents(
  onEvent: (ev: { name: string; action: string; managed: boolean; composeProject?: string }) => void,
): ServiceEventSubscription {
  const child: ChildProcess = spawn('docker', [
    'events',
    '--filter', 'type=container',
    '--filter', 'event=start',
    '--filter', 'event=die',
    '--filter', 'event=destroy',
    '--format', '{{json .}}',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  eventChildren.add(child);
  child.on('close', () => eventChildren.delete(child));

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
          Actor?: { Attributes?: { name?: string; 'mysandbox.managed-by'?: string; 'com.docker.compose.project'?: string } };
        };
        const name = ev.Actor?.Attributes?.name;
        if (ev.Action && name) {
          onEvent({
            name,
            action: ev.Action,
            managed: ev.Actor?.Attributes?.['mysandbox.managed-by'] === 'mysandbox',
            composeProject: ev.Actor?.Attributes?.['com.docker.compose.project'],
          });
        }
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
export async function listServiceEndpoints(
  cfg: Config,
  extraNames: string[] = [],
  composeProjects: string[] = [], // 目录注册表服务的 project 名（agent 自放文件的服务无我们的 label）
): Promise<{ name: string; ip: string }[]> {
  const net = await inspectNetwork(cfg.services.network);
  if (!net) return [];
  const rows = await listServiceContainers(extraNames);
  let renames: Map<string, string> | null = null;
  if (composeProjects.length) {
    const projRows = await listComposeProjectContainers(composeProjects);
    rows.push(...projRows);
    // compose 默认命名的容器（<project>-<service>-1）≠ 服务名：单服务项目的 hosts 行
    // 要用项目名（用户连接的名字）。多服务项目不 rename——成员各用容器名（唯一），
    // 想要短名的在文件里 pin container_name（rename 会把 N 个成员挤成同一个名字）。
    const countByProject = new Map<string, number>();
    for (const r of projRows) {
      const p = rowLabels(r)['com.docker.compose.project'];
      if (p) countByProject.set(p, (countByProject.get(p) ?? 0) + 1);
    }
    for (const r of projRows) {
      const proj = rowLabels(r)['com.docker.compose.project'];
      const cname = rowName(r);
      if (proj && cname !== proj && countByProject.get(proj) === 1) {
        if (!renames) renames = new Map();
        renames.set(cname, proj);
      }
    }
  }
  const running = new Set(rows.filter((r) => r.State === 'running').map(rowName));
  return net.endpoints
    .filter((e) => running.has(e.name))
    .map((e) => ({ name: renames?.get(e.name) ?? e.name, ip: e.ip }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
