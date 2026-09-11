// docker 服务层：配套服务（数据库等）的预设、编排与路由。
//
// 形态（v2，compose 底账）：一服务 = <CONFIG_DIR>/compose/<名>/compose.yaml（唯一配置
// 真相，见 serviceCompose.ts）+ 固定 IP（mysandbox-lan 上 ipv4_address）+ 命名卷
// mysandbox-svc-<name>；不发布端口到宿主——与 LXC 容器同语义（固定 IP 直连、无 NAT），
// LXC 容器里 `psql -h <服务名>` 的通路靠 hosts 注入（hosts-sync 组合 listServiceEndpoints）。
// 创建 = 生成首版文件 + compose up；改配置 = 编辑文件 + up（面板配置页或终端，等价）；
// 删除 = compose down（+ 删卷 + 删目录）。旧版 update/rebuild 任务链随声明式底账退役——
// 「追新镜像」= 改 image 版本 + 应用，「本地 build 迭代」= 构建并应用（up -d --build）。
// 管理边界结构性隔离：判定集 = label（mysandbox.managed-by + mysandbox.kind=service）
// ∪ 收编 meta（adoptedServiceNames——外部容器无 label，收编走 sidecar，见 adoptService）。
// 未收编的外部容器（dener-* 等）永远不进列表、操作只会 404。
//
// docker 原语在 docker.ts（CLI 客户端），compose 文件层在 serviceCompose.ts；这里只有
// 业务编排。对标 base.ts 的「路由薄 + 实现厚」。
import type { FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import type { NetworkInfo } from './docker.js';
import { badRequest, conflict, notFound } from './errors.js';
import { applyServicesBlock } from './hosts-sync.js';
import { log } from './logger.js';
import { parseProcNetListeners, probeHtmlPort } from './portprobe.js';
import {
  MANAGED_LABEL,
  KIND_LABEL,
  serviceVolumeName,
  dockerStatus,
  inspectNetwork,
  listServiceContainers,
  serviceNameExists,
  containerIpamIp,
  containerPid,
  inspectServiceSnapshot,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  containerLogs,
  containerNetIp,
  listImages,
  listExternalContainers,
  registryMirrors,
  rowLabels,
  createNetwork,
  connectServiceNetwork,
  disconnectServiceNetwork,
  ensureVolume,
  removeVolume,
  subscribeServiceEvents,
  containerComposeHash,
  containerPublishedPorts,
  inspectContainerShape,
  inspectImageDefaults,
  listComposeProjectContainers,
  type DockerContainerRow,
} from './docker.js';
import {
  adoptedServiceNames,
  adoptedContainerNames,
  stackMetaOfContainer,
  getAllServiceMeta,
  getServiceMeta,
  setServiceMeta,
  deleteServiceMeta,
  type ServiceMeta,
  type StackServiceRef,
} from './state.js';
import {
  buildComposeYaml,
  composeDir,
  composeDown,
  composeFileExists,
  composeFileHash,
  composeFileOf,
  composeStackRestart,
  composeStackStart,
  composeStackStop,
  composeUp,
  isManagedComposeProject,
  listComposeDirServices,
  readComposeProject,
  readComposeService,
  readComposeYaml,
  removeComposeDir,
  writeCompose,
  type ComposeServiceDef,
  type ParsedProjectService,
} from './serviceCompose.js';
import {
  reservedServiceIps,
  tryReserveJobName,
  releaseJobName,
  reserveJobIp,
  releaseJobIp,
  startServiceJob,
  listServiceJobs,
  getServiceJob,
  cancelServiceJob,
  type JobCtx,
  type ServicePlan,
} from './jobs.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

// 收编容器名：docker 名语义的收窄版（外部容器名改不了，收编时校验、过不了明确拒绝）。
// 比 NAME_RE 宽出的 `_` 是 compose 命名惯例；不含 `.`（vhost 域名分隔符吃不下）、
// 不含大写（浏览器发 Host 头会小写化，大写名在 vhost 门面匹配不上）。
const ADOPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// —— 预设表（代码即配置；新预设就是加一行） ——
export interface ServicePreset {
  key: string;
  label: string;
  image: string;
  description: string;
  volumePath: string | null; // null = 不建数据卷
  ports: number[]; // 仅供展示（不发布端口，容器内连服务名）
  fixedEnv: Record<string, string>;
  userEnv: { key: string; label: string; required?: boolean; secret?: boolean }[];
  command?: string[];
  hint: string; // 容器内怎么连（展示给用户）
}

export const SERVICE_PRESETS: ServicePreset[] = [
  {
    key: 'postgres',
    label: 'PostgreSQL',
    image: 'postgres:17',
    description: 'PostgreSQL 17，默认库 app / 用户 mysandbox',
    volumePath: '/var/lib/postgresql/data',
    ports: [5432],
    fixedEnv: { POSTGRES_DB: 'app', POSTGRES_USER: 'mysandbox' },
    userEnv: [
      { key: 'POSTGRES_PASSWORD', label: '密码（POSTGRES_PASSWORD）', required: true, secret: true },
    ],
    hint: '容器内：psql -h <服务名> -U mysandbox -d app',
  },
  {
    key: 'redis',
    label: 'Redis',
    image: 'redis:7-alpine',
    description: 'Redis 7，AOF 持久化',
    volumePath: '/data',
    ports: [6379],
    fixedEnv: {},
    userEnv: [],
    command: ['redis-server', '--appendonly', 'yes'],
    hint: '容器内：redis-cli -h <服务名>',
  },
  {
    key: 'mysql',
    label: 'MySQL',
    image: 'mysql:8',
    description: 'MySQL 8，默认库 app',
    volumePath: '/var/lib/mysql',
    ports: [3306],
    fixedEnv: { MYSQL_DATABASE: 'app' },
    userEnv: [
      { key: 'MYSQL_ROOT_PASSWORD', label: 'root 密码（MYSQL_ROOT_PASSWORD）', required: true, secret: true },
      { key: 'MYSQL_USER', label: '业务用户名（可选，MYSQL_USER）' },
      { key: 'MYSQL_PASSWORD', label: '业务用户密码（随 MYSQL_USER，可选）', secret: true },
    ],
    hint: '容器内：mysql -h <服务名> -u root -p',
  },
];

export function findPreset(key: string): ServicePreset | undefined {
  return SERVICE_PRESETS.find((p) => p.key === key);
}

// 现成连接命令：从 preset + env 拼出可直接运行的命令。主机名用服务名（容器内 hosts
// 注入可解析；宿主直连换 IP——前端「连接信息」对话框有提示）。拼装所需 env 缺一个
// 都不出（meta 缺失时宁可没有，不出半截命令误导）。
function composeConnect(presetKey: string, name: string, env: Record<string, string>, ports: number[]): string[] {
  const port = ports[0];
  switch (presetKey) {
    case 'postgres': {
      const u = env.POSTGRES_USER;
      const db = env.POSTGRES_DB;
      const pw = env.POSTGRES_PASSWORD;
      return u && db && pw ? [`psql "host=${name} port=${port ?? 5432} user=${u} dbname=${db} password=${pw}"`] : [];
    }
    case 'redis':
      return [`redis-cli -h ${name}${port ? ` -p ${port}` : ''}`];
    case 'mysql': {
      const pw = env.MYSQL_ROOT_PASSWORD;
      return pw ? [`mysql -h ${name}${port ? ` -P ${port}` : ''} -u root --password="${pw}"`] : [];
    }
    default:
      return [];
  }
}

// —— 视图 ——
// env 全量回值（含密码）：token = 宿主完整权限，鉴权边界已在 token 上收住，
// UI 需要直接展示连接凭据（compose.yaml 落盘 0600 不变）。
export interface ServiceView {
  name: string;
  preset: string;
  image: string;
  ip: string | null;
  state: string;
  status: string;
  running: boolean;
  volume: string | null;
  ports: number[];
  envKeys: string[];
  env: Record<string, string>; // 全量 env（含密码值），供 UI 展示/复制（真相在 compose 文件）
  connect: string[]; // 预设感知的现成连接命令（容器内服务名口径）
  displayName?: string; // 显示名（侧栏卡片/终端 tab），不动容器真名
  description?: string;
  createdAt?: string;
  command?: string[];
  metaMissing?: boolean; // label 在但 sidecar 缺（state.json 被清过）
  adopted?: boolean; // 收编的外部容器（无 label，凭证在 sidecar）——前端区分卡片与操作边界
  hasCompose?: boolean; // compose 底账在（可改配置可应用）；managed 而无文件 = 旧版创建，前端出迁移入口
  container?: string; // 实际容器名（目录注册表服务 compose 项目名 ≠ 容器名时用于 docker 操作）
  // —— 多容器项目（1 目录 = 1 项目 = N 服务；adopted 栈同理）——
  stackServices?: StackServiceView[]; // 项目全部成员（>1 时卡片锚在入口，其余折叠在抽屉）
  stackFile?: string | null; // adopted 栈的原 compose 文件（配置页只读展示）
  externalStack?: boolean; // adopted 栈：file 在原处，配置只读、启停 compose 驱动、删除 409
  stackProject?: string; // 「加入列表」升格卡片的所属项目
}

export interface StackServiceView {
  name: string; // compose service key
  container: string; // 容器名（docker 操作锚点）
  state: string;
  running: boolean;
  entry: boolean;
  listed: boolean; // 已加入列表（独立卡片）
}

export interface ServicesStatus {
  enabled: boolean;
  reachable: boolean;
  version?: string;
  error?: string;
  network: {
    name: string;
    bridgeOk: boolean; // docker 网络存在即 true（LXC 已用独立网桥，桥一致性检查退役）
    subnet: string | null;
    detail?: string; // 网络不存在等异常时的人话说明
  };
  pool: { from: string; to: string; reserved: string[]; assigned: string[]; free: string[] };
  // daemon 的 registry-mirrors（docker info）。undefined = 探测失败省略；[] = 直连
  // Docker Hub，网络受限环境下拉取常超时——前端据此给 amber 提示。
  registryMirrors?: string[];
}

export interface CreateServiceInput {
  name: string;
  preset: string; // 'postgres' | 'redis' | 'mysql' | 'custom'
  image?: string; // custom 必填
  volumePath?: string; // custom 可选：数据卷挂载路径（留空不建卷）；预设由 preset 表定
  env?: Record<string, string>; // 预设的 userEnv 值 / custom 的全量 env
  command?: string; // custom 可选，空格分词（无 shell）
  ip?: string; // 手动指定；缺省自动分配
  description?: string;
}

// —— 编排 ——

function rowName(names: string): string {
  return names.split(',')[0].replace(/^\//, '');
}

// 服务在项目内的容器名：container_name 钉了用之；否则 compose 默认命名
// <project>-<service>-1（rsuffix 数字可能 >1，用 ps 的 project+service label 精确命中）。
function containerOfService(
  rowByService: Map<string, DockerContainerRow>,
  dirName: string,
  svc: { key: string; containerName?: string },
): { container: string; row: DockerContainerRow | null } {
  const row = rowByService.get(svc.key) ?? null;
  const container = svc.containerName ?? row?.Names.split(',')[0].replace(/^\//, '') ?? `${dirName}-${svc.key}-1`;
  return { container, row };
}

// 入口服务选择：meta 里用户指认的优先；否则带发布端口的服务；再否则第一个。
function pickEntryIndex(
  services: ParsedProjectService[],
  meta: ServiceMeta | undefined,
  refByContainer: Map<string, StackServiceRef>,
): number {
  const flagged = meta?.stack?.services.findIndex((s) => s.entry) ?? -1;
  if (flagged >= 0) {
    const idx = services.findIndex((s) => s.key === meta!.stack!.services[flagged].name);
    if (idx >= 0) return idx;
  }
  const withPorts = services.findIndex((s) => s.ports.length > 0);
  if (withPorts >= 0) return withPorts;
  void refByContainer;
  return 0;
}

export async function listServices(cfg: Config): Promise<{ items: ServiceView[]; status: ServicesStatus }> {
  const status = await servicesStatus(cfg);
  if (!status.reachable) return { items: [], status };
  const meta = await getAllServiceMeta();
  const rows = await listServiceContainers(adoptedContainerNames(meta));
  // 目录注册表：compose/<名>/ 本身就是服务清单（agent/用户直接放文件 + up）。
  // 行 → 目录名的映射走 com.docker.compose.project（agent 文件的容器名是
  // <project>-<service>-1 形状，project 才等于目录名）。
  const dirNames = new Set(await listComposeDirServices());
  for (const prow of await listComposeProjectContainers([...dirNames])) {
    if (!rows.some((r) => rowName(r.Names) === rowName(prow.Names))) rows.push(prow);
  }
  const items: ServiceView[] = [];
  const coveredRows = new Set<DockerContainerRow>();

  // —— 目录项目（1 目录 = 1 项目 = N 服务；N=1 是特例，行为与旧版一致）——
  for (const dirName of dirNames) {
    const project = await readComposeProject(dirName);
    const dirMeta = meta[dirName];
    if (!project) {
      // 坏文件/空文件：按单服务旧形态出卡（absent），不炸列表
      items.push({
        name: dirName,
        preset: 'custom',
        image: '',
        ip: null,
        state: 'absent',
        status: 'compose.yaml 解析失败',
        running: false,
        volume: null,
        ports: [],
        envKeys: [],
        env: {},
        connect: [],
        metaMissing: false,
        hasCompose: true,
      });
      continue;
    }
    // 项目成员行：project label 命中，按 compose service label 分桶
    const rowByService = new Map<string, DockerContainerRow>();
    for (const row of rows) {
      const labels = rowLabels(row);
      if (labels['com.docker.compose.project'] === dirName) {
        rowByService.set(labels['com.docker.compose.service'] ?? '', row);
        coveredRows.add(row);
      }
    }
    const refByContainer = new Map<string, StackServiceRef>(
      (dirMeta?.stack?.services ?? []).map((s) => [s.container, s]),
    );
    const services = project.services;
    if (services.length <= 1) {
      // —— 单服务（N=1 特例，与旧版行为一致）——
      const svc = services[0];
      const { container, row } = containerOfService(rowByService, dirName, svc);
      const ip = svc.ip ?? (row ? (await containerIpamIp(container)) ?? null : null);
      items.push({
        name: dirName,
        container: container !== dirName ? container : undefined,
        preset: 'custom',
        image: svc.image ?? row?.Image ?? '',
        ip,
        state: row?.State ?? 'absent',
        status: row?.Status ?? '未创建（docker compose up 启动）',
        running: row?.State === 'running',
        volume: svc.volumes[0] ?? null,
        ports: [],
        envKeys: Object.keys(svc.env),
        env: svc.env,
        connect: [],
        createdAt: row?.CreatedAt,
        command: svc.command,
        metaMissing: !dirMeta && !!row,
        hasCompose: true,
      });
      continue;
    }
    // —— 多服务项目：一张卡锚在入口服务，其余折叠在抽屉（listed 的升格成独立卡）——
    const entryIdx = pickEntryIndex(services, dirMeta, refByContainer);
    const stackServices: StackServiceView[] = [];
    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      const { container, row } = containerOfService(rowByService, dirName, svc);
      const ref = refByContainer.get(container);
      stackServices.push({
        name: svc.key,
        container,
        state: row?.State ?? 'absent',
        running: row?.State === 'running',
        entry: i === entryIdx,
        listed: ref?.listed === true,
      });
    }
    const entrySvc = services[entryIdx];
    const entryView = stackServices[entryIdx];
    items.push({
      name: dirName,
      container: entryView.container,
      preset: 'custom',
      image: entrySvc.image ?? '',
      ip: entrySvc.ip ?? null,
      state: entryView.state,
      status: entryView.running ? entryView.state : `项目 · ${services.length} 个服务（入口 ${entrySvc.key}）`,
      running: entryView.running,
      volume: entrySvc.volumes[0] ?? null,
      ports: entrySvc.ports,
      envKeys: Object.keys(entrySvc.env),
      env: entrySvc.env,
      connect: [],
      createdAt: rowByService.get(entrySvc.key)?.CreatedAt,
      command: entrySvc.command,
      metaMissing: !dirMeta,
      hasCompose: true,
      stackServices,
    });
    // listed 成员升格为独立卡片（name = 容器名，唯一且可直接操作）
    for (let i = 0; i < services.length; i++) {
      if (i === entryIdx) continue;
      const s = stackServices[i];
      if (!s.listed) continue;
      const svc = services[i];
      const row = rowByService.get(svc.key) ?? null;
      items.push({
        name: s.container,
        preset: 'custom',
        image: svc.image ?? row?.Image ?? '',
        ip: svc.ip ?? (row ? (await containerIpamIp(s.container)) ?? null : null),
        state: s.state,
        status: s.state === 'absent' ? '未创建（docker compose up 启动）' : (row?.Status ?? ''),
        running: s.running,
        volume: svc.volumes[0] ?? null,
        ports: svc.ports,
        envKeys: Object.keys(svc.env),
        env: svc.env,
        connect: [],
        createdAt: row?.CreatedAt,
        command: svc.command,
        metaMissing: false,
        hasCompose: true,
        stackProject: dirName,
        stackServices,
      });
    }
  }

  // —— adopted 栈（meta 以项目名为 key，成员容器逐一锚定）——
  for (const [key, m] of Object.entries(meta)) {
    if (!m.adopted || !m.stack) continue;
    const rowByContainer = new Map<string, DockerContainerRow>();
    for (const row of rows) {
      const n = rowName(row.Names);
      if (m.stack.services.some((s) => s.container === n)) {
        rowByContainer.set(n, row);
        coveredRows.add(row);
      }
    }
    const entryRef = m.stack.services.find((s) => s.entry) ?? m.stack.services[0];
    const stackServices: StackServiceView[] = m.stack.services.map((s) => {
      const row = rowByContainer.get(s.container);
      return {
        name: s.name,
        container: s.container,
        state: row?.State ?? 'absent',
        running: row?.State === 'running',
        entry: s.entry === true || s.container === entryRef.container,
        listed: s.listed === true,
      };
    });
    const entryState = stackServices.find((s) => s.entry) ?? stackServices[0];
    items.push({
      name: key,
      container: entryRef.container,
      preset: m.preset,
      image: m.image,
      ip: entryRef.ip ?? null,
      state: entryState.state,
      status: entryState.running ? entryState.state : `栈 · ${m.stack.services.length} 个服务（入口 ${entryRef.name}）`,
      running: entryState.running,
      volume: null,
      ports: [],
      envKeys: [],
      env: {},
      connect: [],
      displayName: m.displayName,
      description: m.description,
      createdAt: m.createdAt,
      metaMissing: false,
      adopted: true,
      hasCompose: false,
      stackServices,
      stackFile: m.stack.file,
      externalStack: true,
    });
    // listed 成员升格
    for (const s of stackServices) {
      if (s.entry || !s.listed) continue;
      const row = rowByContainer.get(s.container);
      items.push({
        name: s.container,
        preset: m.preset,
        image: row?.Image ?? '',
        ip: m.stack.services.find((x) => x.container === s.container)?.ip ?? null,
        state: s.state,
        status: row?.Status ?? '',
        running: s.running,
        volume: null,
        ports: [],
        envKeys: [],
        env: {},
        connect: [],
        displayName: s.name,
        createdAt: m.createdAt,
        metaMissing: false,
        adopted: true,
        hasCompose: false,
        stackProject: key,
        stackServices,
        stackFile: m.stack.file,
        externalStack: true,
      });
    }
  }

  // —— 剩余行（label 管理的旧形态 ∪ 非栈收编）——
  for (const row of rows) {
    if (coveredRows.has(row)) continue;
    const name = rowName(row.Names);
    const m = meta[name];
    const presetKey = m?.preset ?? rowLabels(row)['mysandbox.service-preset'] ?? 'custom';
    // 收编容器可能挂着多个网络（compose 网 + 我们的）：IP 必须取 mysandbox-lan 上的——
    // containerIpamIp 遍历全网络可能先命中 compose 网的静态 IP。
    const ip = m?.adopted
      ? (await containerNetIp(name, cfg.services.network)) ?? m?.ip ?? null
      : (await containerIpamIp(name)) ?? m?.ip ?? null;
    // compose 底账：managed 服务读文件（配置真相）；读不到/没有文件回退 meta（旧版服务）。
    // 坏文件 readComposeService 返回 null——env 降级 meta，列表不炸。
    const comp = m?.adopted ? null : await readComposeService(name);
    const envVals = comp ? comp.env : m?.env ?? {};
    items.push({
      name,
      preset: presetKey,
      image: comp?.image ?? m?.image ?? row.Image,
      ip: comp?.ip ?? ip,
      state: row.State,
      status: row.Status,
      running: row.State === 'running',
      volume: comp?.volume ?? m?.volume ?? null,
      ports: m?.ports ?? [],
      envKeys: Object.keys(envVals),
      env: envVals,
      connect: m ? composeConnect(presetKey, name, envVals, m.ports ?? []) : [],
      displayName: m?.displayName,
      description: m?.description,
      createdAt: m?.createdAt ?? row.CreatedAt,
      command: comp?.command ?? m?.command,
      metaMissing: !m,
      adopted: !!m?.adopted,
      hasCompose: !m?.adopted && (await composeFileExists(name)),
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, status };
}

// registry-mirrors 的 60s TTL 缓存：值只在 daemon.json 改动并重启 docker 后才变，
// 而 servicesStatus 被 15s 轮询——没必要每次都 spawn docker info（快，但省着点）。
let mirrorsCache: { at: number; val: string[] | null } | null = null;
async function cachedRegistryMirrors(): Promise<string[] | null> {
  if (mirrorsCache && Date.now() - mirrorsCache.at < 60_000) return mirrorsCache.val;
  const val = await registryMirrors();
  mirrorsCache = { at: Date.now(), val };
  return val;
}

export async function servicesStatus(cfg: Config): Promise<ServicesStatus> {
  const docker = await dockerStatus();
  // 网络自持：mysandbox-lan 属于服务层基础设施，缺失（被 prune / 手工删）就按服务池网段
  // 重建——面板每 3–15s 轮询一次 status，自愈周期即一个轮询间隔。创建失败（daemon 瞬时
  // 忙等）不炸 status——降级为 detail 提示，下一轮轮询自然重试。
  let net: NetworkInfo | null = null;
  let ensureError: string | null = null;
  if (docker.reachable) {
    try {
      net = await ensureServiceNetwork(cfg);
    } catch (e) {
      ensureError = (e as Error).message;
      log.warn({ err: ensureError }, 'ensureServiceNetwork failed');
    }
  }
  const poolView = await servicePoolView(cfg);
  const status: ServicesStatus = {
    enabled: cfg.services.enabled,
    reachable: docker.reachable,
    version: docker.version,
    error: docker.error,
    network: { name: cfg.services.network, bridgeOk: !!net, subnet: net?.subnet ?? null },
    pool: poolView,
  };
  if (ensureError) {
    status.network.detail = `服务网络自动创建失败：${ensureError}`;
    return status;
  }
  if (!net) return status;
  status.registryMirrors = (await cachedRegistryMirrors()) ?? undefined;
  // 子网体检：网络存在但子网与服务池隐含的 /24 不符（如被手工重建到 docker 默认池）
  // ——LXC 与服务网段经宿主路由互通，子网漂移会断跨桥连通，值得一句人话提示。
  const expected = `${poolView.from.split('.').slice(0, 3).join('.')}.0/24`;
  if (net.subnet && net.subnet !== expected) {
    status.network.detail =
      `网络 "${net.name}" 子网 ${net.subnet} 与服务池隐含的 ${expected} 不符——` +
      '跨桥到 LXC 的互通可能失效（重建网络或改 services.ipPool）';
  }
  return status;
}

// 服务网络自持：存在即返回；缺失则按服务池隐含的 /24 建出来（网关 = 前缀.1），并钉桥
// 设备名 br-<网络名首段>（mysandbox-lan → br-mysandbox：Linux 网卡名 ≤15 字符，网络名
// 全量进 br- 前缀会超长；-lan 等语义后缀不进桥名）。br- 前缀保持在 DOCKER-USER 的
// br+ 通配范围内（mysandbox-docker-interop.service）。
export async function ensureServiceNetwork(cfg: Config): Promise<NetworkInfo | null> {
  const existing = await inspectNetwork(cfg.services.network);
  if (existing) return existing;
  const prefix = cfg.services.ipPool.from.split('.').slice(0, 3).join('.');
  const bridge = `br-${cfg.services.network.split('-')[0]}`;
  await createNetwork(cfg.services.network, `${prefix}.0/24`, `${prefix}.1`, bridge);
  log.info({ network: cfg.services.network, subnet: `${prefix}.0/24`, bridge }, 'service network auto-created');
  return inspectNetwork(cfg.services.network);
}

// 服务池视图：占用 = 网络 running 端点（10.88.0.x 全体，含非服务容器）∪ state.services
// 登记 IP ∪ reserved ∪ 进行中任务预占的 IP（jobs.ts）。与 network.ts 的容器池互不相交
// （服务在 .200+，容器在 10.88.10.x）。
async function servicePoolView(
  cfg: Config,
): Promise<ServicesStatus['pool']> {
  const { from, to, reserved } = cfg.services.ipPool;
  const used = new Set<string>(reserved);
  const net = await inspectNetwork(cfg.services.network);
  if (net) {
    const prefix = from.split('.').slice(0, 3).join('.');
    for (const e of net.endpoints) {
      if (e.ip.startsWith(`${prefix}.`)) used.add(e.ip);
    }
  }
  for (const m of Object.values(await getAllServiceMeta())) {
    used.add(m.ip);
    // 栈成员的静态 IP 也是占用（停机成员不进 network 端点）
    if (m.stack) for (const s of m.stack.services) if (s.ip) used.add(s.ip);
  }
  // 底账文件里的静态 IP 也是占用（停机/未创建的目录服务不进 network 端点，
  // meta 可能为空——agent 自放文件的服务根本没 meta）。
  for (const dirName of await listComposeDirServices()) {
    const parsed = await readComposeService(dirName);
    if (parsed?.ip) used.add(parsed.ip);
  }
  for (const ip of reservedServiceIps()) used.add(ip);
  const assigned: string[] = [];
  const free: string[] = [];
  const pFrom = Number(from.split('.')[3]);
  const pTo = Number(to.split('.')[3]);
  for (let i = pFrom; i <= pTo; i++) {
    const ip = `${from.split('.').slice(0, 3).join('.')}.${i}`;
    (used.has(ip) ? assigned : free).push(ip);
  }
  return { from, to, reserved, assigned, free };
}

// 分配静态 IP。三源并集判定占用（网络端点只含 running——停机服务的 IP 靠 state.services 保住，
// 否则会被二次分配，start 时 docker 报 Address already in use）。
export async function allocateServiceIp(cfg: Config, manual?: string): Promise<string> {
  const { from, to, reserved } = cfg.services.ipPool;
  const prefix = from.split('.').slice(0, 3).join('.');
  const inPool = (ip: string): boolean => {
    const segs = ip.split('.');
    if (segs.length !== 4) return false;
    const n = Number(segs[3]);
    return segs.slice(0, 3).join('.') === prefix && n >= Number(from.split('.')[3]) && n <= Number(to.split('.')[3]);
  };
  if (manual) {
    if (!inPool(manual)) {
      throw badRequest(`IP ${manual} 不在服务池 ${from}–${to} 内`);
    }
    if (reserved.includes(manual)) throw conflict(`IP ${manual} is reserved`);
    const pool = await servicePoolView(cfg);
    if (pool.assigned.includes(manual)) throw conflict(`IP ${manual} already in use`);
    return manual;
  }
  const pool = await servicePoolView(cfg);
  const free = pool.free;
  if (free.length === 0) throw conflict('service IP pool exhausted');
  return free[0];
}

// 创建的「计划」：prepareServiceCreate 的产物、runServiceCreate 的输入。
// env 含密码——只进执行链（ServiceView 本就回全量 env，见上），但绝不进 job 记录/
// 视图（jobs.ts 的 ServicePlan 只搬 name/image/ip）。
export interface CreateServicePlan {
  name: string;
  preset: ServicePreset | null;
  image: string;
  env: Record<string, string>;
  command: string[] | undefined;
  ip: string;
  volume: { source: string; target: string } | null;
  description?: string;
}

// 创建段一（快，路由同步跑）：全部输入校验 + 查重 + IP 分配。失败抛 HttpError →
// 路由回 4xx，对话框内联显示；通过则拿 plan 进后台任务。
// 注意 IP 已由路由层预占（tryReserveJobName/reserveJobIp 在前），这里分配时
// servicePoolView 已把预占并进占用集，不会撞进行中任务。
export async function prepareServiceCreate(cfg: Config, input: CreateServiceInput): Promise<CreateServicePlan> {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw badRequest('服务名 2–31 位，小写字母/数字/连字符，字母或数字开头');
  }
  if (!cfg.services.enabled) throw badRequest('services 层未启用（config services.enabled）');

  // 网络自持：第一个服务创建前把网络建好（缺失才建，幂等）。
  await ensureServiceNetwork(cfg);

  const preset = input.preset === 'custom' ? null : findPreset(input.preset);
  if (!preset && input.preset !== 'custom') throw badRequest(`未知预设 "${input.preset}"`);

  const image = (preset?.image ?? input.image ?? '').trim();
  if (!image) throw badRequest('custom 服务必须提供镜像名');

  // 数据卷：预设由 preset 表定；custom 可选给挂载路径（留空 = 不建卷，数据在容器可写层）。
  const volumePath = preset?.volumePath ?? (input.preset === 'custom' ? input.volumePath?.trim() || null : null);
  if (volumePath && !volumePath.startsWith('/')) {
    throw badRequest('数据卷挂载路径须为绝对路径（如 /data）');
  }

  // env：预设 = fixedEnv + 用户填的 userEnv（required 校验）；custom = 用户全量给。
  const env: Record<string, string> = {};
  const command: string[] | undefined = preset?.command ?? (input.command?.trim() ? input.command.trim().split(/\s+/) : undefined);
  if (preset) {
    Object.assign(env, preset.fixedEnv);
    for (const u of preset.userEnv) {
      const v = input.env?.[u.key];
      if (u.required && !v?.trim()) throw badRequest(`缺少必填项：${u.label}`);
      if (v?.trim()) env[u.key] = v.trim();
    }
  } else {
    for (const [k, v] of Object.entries(input.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw badRequest(`非法环境变量名 "${k}"`);
      env[k] = String(v);
    }
  }

  if (await serviceNameExists(name)) throw conflict(`docker 里已有同名容器 "${name}"`);
  const ip = await allocateServiceIp(cfg, input.ip?.trim() || undefined);

  return {
    name,
    preset: preset ?? null,
    image,
    env,
    command,
    ip,
    volume: volumePath ? { source: serviceVolumeName(name), target: volumePath } : null,
    description: input.description,
  };
}

// —— 编排共用：def（compose 服务定义）拼装 ——
// 创建走 plan，迁移走 meta+快照——两条路最终都落成同一份 compose 文件形状。

function defFromPlan(plan: CreateServicePlan, network: string): ComposeServiceDef {
  return {
    name: plan.name,
    image: plan.image,
    env: plan.env,
    command: plan.command,
    volumes: plan.volume ? [plan.volume] : [],
    ip: plan.ip,
    network,
    labels: {
      [MANAGED_LABEL]: 'mysandbox',
      [KIND_LABEL]: 'service',
      'mysandbox.service-preset': plan.preset?.key ?? 'custom',
      'mysandbox.created-at': new Date().toISOString(),
    },
  };
}

// 旧版（docker create）服务迁移用：meta 是 env/command/volume/ip 的记录，快照补
// labels（preset/created-at 在容器身上）与卷挂载点（meta 只记卷名）。meta 缺失无法
// 复刻形状——调用方挡（migrateService 路由 + requireService 已保证 meta 在）。
function defFromMeta(m: ServiceMeta, name: string, network: string, snap: { labels: Record<string, string>; volumeTarget: string | null } | null): ComposeServiceDef {
  const volume = m.volume && snap?.volumeTarget ? { source: m.volume, target: snap.volumeTarget } : null;
  const labels = { ...(snap?.labels ?? {}) };
  // 我们的身份 label 以 meta/常量为准写死（快照里万一被改过也纠正回来）；compose 自己
  // 的 com.docker.compose.* label 不带进文件——up 时 compose 会按自己的语义重打。
  labels[MANAGED_LABEL] = 'mysandbox';
  labels[KIND_LABEL] = 'service';
  for (const k of Object.keys(labels)) if (k.startsWith('com.docker.compose.')) delete labels[k];
  return {
    name,
    image: m.image,
    env: m.env,
    command: m.command,
    volumes: volume ? [volume] : [],
    ip: m.ip,
    network,
    labels,
  };
}

// 接管式收编：从外部裸容器的 inspect 复刻「操作者加的形状」。env 减镜像默认值、
// entrypoint/command 只在与镜像默认不同才写（写了一样语义但文件变噪声）、原自定义
// 网络原样 external 保留（tl-db 的 tl-test 断了 tl-app 就瞎了）、host 网络模式原样
// network_mode: host（没有服务网络 IP 一说）。
function defFromShape(
  name: string,
  shape: NonNullable<Awaited<ReturnType<typeof inspectContainerShape>>>,
  img: Awaited<ReturnType<typeof inspectImageDefaults>>,
  cfg: Config,
  ip: string | null,
): ComposeServiceDef {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(shape.env)) {
    if (img?.env[k] !== v) env[k] = v;
  }
  const eq = (a: string[] | undefined, b: string[] | undefined): boolean => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const hostMode = shape.networkMode === 'host';
  const extras = hostMode
    ? []
    : shape.networks
        .filter((n) => n.name !== 'bridge' && n.name !== cfg.services.network && n.name !== 'none')
        .map((n) => ({
          name: n.name,
          ipv4: n.ipv4 ?? undefined,
          aliases: n.aliases.filter((a) => a !== name) ?? undefined,
        }));
  return {
    name,
    image: shape.image,
    env,
    entrypoint: eq(shape.entrypoint, img?.entrypoint) || !shape.entrypoint.length ? undefined : shape.entrypoint,
    command: eq(shape.cmd, img?.cmd) || !shape.cmd.length ? undefined : shape.cmd,
    volumes: shape.volumes.map((v) => ({
      source: v.type === 'bind' ? (v.source ?? '') : (v.name ?? ''),
      target: v.destination,
    })).filter((v) => v.source),
    ip: ip ?? '',
    network: cfg.services.network,
    labels: {
      [MANAGED_LABEL]: 'mysandbox',
      [KIND_LABEL]: 'service',
      'mysandbox.service-preset': 'adopted',
      'mysandbox.created-at': new Date().toISOString(),
    },
    restart: shape.restart && shape.restart !== 'no' ? shape.restart : undefined,
    user: shape.user && shape.user !== img?.user ? shape.user : undefined,
    workingDir: shape.workingDir && shape.workingDir !== img?.workingDir ? shape.workingDir : undefined,
    ports: shape.ports.length ? shape.ports : undefined,
    healthcheck: shape.healthcheck ?? undefined,
    extraNetworks: extras.length ? extras : undefined,
    networkMode: hostMode ? 'host' : undefined,
  };
}

// 创建段二（慢，后台 job 跑）：生成 compose 文件 → 预建 external 卷 → compose up →
// 落盘 meta → 追平 hosts。取消全程有效（SIGKILL compose CLI，半途状态由再次 up 收敛）。
export async function runServiceCreate(cfg: Config, plan: CreateServicePlan, ctx: JobCtx): Promise<ServiceView> {
  const { name, ip, volume } = plan;
  const def = defFromPlan(plan, cfg.services.network);

  // prepare 之后网络可能又被删（prune 等）——job 起步再兜一次底。
  await ensureServiceNetwork(cfg);

  ctx.status(`写入 compose 配置（${def.image}）`);
  await writeCompose(name, buildComposeYaml(def));

  if (volume) {
    // external 卷必须在 up 前存在（文件里 external: true，compose 不会代建）。
    ctx.status(`创建数据卷 ${volume.source}`);
    await ensureVolume(volume.source);
  }

  ctx.setCancellable(true);
  ctx.status(`compose up（${ip}）`);
  await composeUp(name, { onLine: (l) => ctx.log(l), signal: ctx.signal, hardTimeoutMs: cfg.services.pullTimeoutMs });
  ctx.setCancellable(false);

  const meta: ServiceMeta = {
    preset: plan.preset?.key ?? 'custom',
    image: plan.image,
    env: plan.env,
    command: plan.command,
    volume: volume?.source ?? null,
    ip,
    ports: plan.preset?.ports ?? [],
    description: plan.description,
    createdAt: new Date().toISOString(),
  };
  await setServiceMeta(name, meta);

  // 服务起来了 → 追平所有运行中 LXC 容器的 hosts（hash-skip，无变化近零成本）。
  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`服务 ${name} 就绪（${ip}）`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? viewFallback(name, meta, ip, true);
}

// listServices 没找到（极端竞态）时的兜底视图：用 meta 拼一个，不让任务死在收尾。
function viewFallback(name: string, m: ServiceMeta, ip: string, running: boolean): ServiceView {
  return {
    name,
    preset: m.preset,
    image: m.image,
    ip,
    state: running ? 'running' : 'exited',
    status: 'updated',
    running,
    volume: m.volume,
    ports: m.ports ?? [],
    envKeys: Object.keys(m.env),
    env: m.env,
    connect: composeConnect(m.preset, name, m.env, m.ports ?? []),
    description: m.description,
    createdAt: m.createdAt,
    command: m.command,
    hasCompose: true,
  };
}

// —— 应用（配置页保存）：文件已由路由层校验并写盘，这里只做收敛 ——
// up -d 幂等：配置没变 = 无事发生；变了 = 只重建受影响的容器。带 build 时顺带重建
// 本地镜像（自研服务迭代循环 = 改代码 → 构建并应用）。收尾按文件回写 meta.ip
// （用户改过 ipv4_address 时池记账要跟上）。
export async function runServiceApply(cfg: Config, name: string, build: boolean, ctx: JobCtx): Promise<ServiceView> {
  ctx.setCancellable(true);
  ctx.status(build ? '构建并应用（compose up -d --build）' : '应用配置（compose up -d）');
  await composeUp(name, { build, onLine: (l) => ctx.log(l), signal: ctx.signal, hardTimeoutMs: cfg.services.pullTimeoutMs });
  ctx.setCancellable(false);

  const comp = await readComposeService(name);
  const m = await getServiceMeta(name);
  if (m && comp?.ip && comp.ip !== m.ip) {
    await setServiceMeta(name, { ...m, ip: comp.ip });
  }

  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`配置已应用：${name}`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? (m ? viewFallback(name, m, comp?.ip ?? m.ip, true) : (throwNotFound(name)));
}

// 极端竞态兜底（meta 也在瞬间消失）：让任务以 404 形状失败而不是编译期撒谎。
function throwNotFound(name: string): never {
  throw notFound(`service "${name}" not found`);
}

// —— 迁移（旧版 docker create 服务 → compose 底账）——
// 从 meta + 快照复刻形状生成文件 → rm 旧容器（compose 与既有裸容器同名冲突）→
// up。数据在命名卷里无损；无卷的 custom 服务 = 可写层会换新容器——风险提示在前端
// 入口（requestServiceMigrate）。rm 之后失败不自动回滚：声明式底账下再点一次迁移/
// 应用，compose 幂等收敛到同一形状（与旧 update/rebuild 同契约）。
export async function runServiceMigrate(cfg: Config, name: string, ctx: JobCtx): Promise<ServiceView> {
  const m = await getServiceMeta(name);
  if (!m) throw conflict(`缺少 "${name}" 的登记元数据（state.json），无法迁移——删除后重新创建即可`);
  const snap = await inspectServiceSnapshot(name);
  if (!snap) throw notFound(`service "${name}" not found`);
  const ip = (await containerIpamIp(name)) ?? m.ip;

  ctx.status('生成 compose 配置（按现容器形状复刻）');
  await writeCompose(name, buildComposeYaml(defFromMeta({ ...m, ip }, name, cfg.services.network, snap)));

  ctx.setCancellable(true);
  ctx.status(`compose up（${ip}）`);
  // 同名冲突挡路：旧容器是 docker create 的裸容器，compose up 接管不了它，先移除
  // （数据在卷里；文件已生成，失败后重试幂等收敛）。
  await removeContainer(name);
  try {
    await composeUp(name, { onLine: (l) => ctx.log(l), signal: ctx.signal, hardTimeoutMs: cfg.services.pullTimeoutMs });
  } catch (e) {
    throw new Error(
      `迁移失败（旧容器已被移除，数据卷无损；文件已生成——再点一次「迁移」或「应用」即按 compose 幂等收敛）：` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  ctx.setCancellable(false);

  await setServiceMeta(name, { ...m, ip });
  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`已迁移到 compose 底账：${name}（${ip}）`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? viewFallback(name, { ...m, ip }, ip, true);
}

// —— 接管式收编（后台 job）：写底账 → rm 裸容器 → compose up ——
// 与 migrate 同构（rm 后失败不回滚，再点一次收敛）；差别只在 def 来源是 inspect 复刻
// 而非我们的 meta，且收编 meta 写成「自有服务」形状（adopted 清位——从此按 label +
// 底账双凭证管理，删除/改配置全解锁）。
export async function runServiceAdopt(cfg: Config, name: string, def: ComposeServiceDef, ctx: JobCtx): Promise<ServiceView> {
  ctx.status(`复刻启动方式 → ${composeFileOf(name)}`);
  await writeCompose(name, buildComposeYaml(def));

  ctx.setCancellable(true);
  ctx.status('移除裸容器，由 compose 接管');
  await removeContainer(name); // compose 接管不了同名裸容器；数据在卷里
  try {
    await composeUp(name, { onLine: (l) => ctx.log(l), signal: ctx.signal, hardTimeoutMs: cfg.services.pullTimeoutMs });
  } catch (e) {
    throw new Error(
      `接管失败（原容器已移除；底账已生成——再点一次「应用」即按 compose 幂等收敛）：` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  ctx.setCancellable(false);

  const named = def.volumes.filter((v) => !v.source.startsWith('/'));
  const meta: ServiceMeta = {
    preset: 'adopted',
    image: def.image,
    env: def.env,
    command: def.command,
    volume: named[0]?.source ?? null,
    ip: def.networkMode ? '' : def.ip,
    ports: (def.ports ?? []).map((p) => p.container),
    description: '接管式收编（启动方式复刻自原容器）',
    createdAt: new Date().toISOString(),
  };
  await setServiceMeta(name, meta);

  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`已接管进 compose 底账：${name}`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? viewFallback(name, meta, meta.ip || def.ip, true);
}

// 路由层已确保 name 在 label 过滤集里（requireService）。
export async function deleteService(
  cfg: Config,
  name: string,
  opts: { deleteData?: boolean; confirmName?: string } = {},
): Promise<{ ok: true; dataRemoved: boolean; name: string }> {
  const m = await getServiceMeta(name);
  // 删数据 = 删卷 = 数据丢失，语义对齐 LXC 容器的 confirmName 确认。
  if (opts.deleteData) {
    if (opts.confirmName !== name) {
      throw conflict(`删除数据需输入服务名确认（${name}）`);
    }
  }
  // 容器移除走 compose down（底账在时）——compose 管的容器由 compose 摘除才干净；
  // 文件坏/缺失回退裸 rm（down 解析失败不能挡删除）。external 网络/卷 compose 不会动。
  if (await composeFileExists(name)) {
    try {
      await composeDown(name);
    } catch (e) {
      log.warn({ err: String(e), name }, 'compose down failed — fallback to docker rm');
      await removeContainer(name);
    }
  } else {
    await removeContainer(name);
  }
  let dataRemoved = false;
  if (opts.deleteData) {
    // 卷清单以底账为准（项目文件可能是多服务多卷），meta.volume 兜底旧形态。meta 里
    // volume 为 null 表示该服务没有数据卷（custom 可无卷）——不能兜底硬造卷名，
    // 否则对无卷服务删除会报 no such volume（实测踩到）。
    const project = await readComposeProject(name);
    const volumes = project
      ? [...new Set(project.services.flatMap((s) => s.volumes))].filter((v) => !v.startsWith('/'))
      : m?.volume
        ? [m.volume]
        : [];
    for (const volume of volumes) {
      await removeVolume(volume); // 卷被别的容器占用等失败原样抛，不假装成功
      dataRemoved = true;
    }
  }
  // 底账随服务走：目录一并移除（服务没了文件留着只会变成误导性孤儿）。
  await removeComposeDir(name).catch((e) => log.warn({ err: String(e), name }, 'compose dir cleanup failed'));
  await deleteServiceMeta(name);
  // hosts 里的服务行要消失：追平一次（hash-skip）。
  try {
    await applyServicesBlock(cfg);
  } catch (e) {
    log.warn({ err: String(e) }, 'hosts re-apply after service delete failed');
  }
  log.info({ name, dataRemoved }, 'docker service deleted');
  return { ok: true, dataRemoved, name };
}

// —— 配置底账（服务抽屉「配置」页的后端面） ——
export interface ServiceConfigView {
  name: string;
  path: string; // compose.yaml 绝对路径（终端手改的入口指引）
  yaml: string | null; // null = 无文件（旧版创建 → 前端出迁移入口；收编容器被路由挡）
  hasBuild: boolean; // 文件带 build: ——前端给「构建并应用」
  hash: string | null; // 当前文件的 compose hash（config --hash，按首个/入口服务）
  appliedHash: string | null; // 容器 label 里最后一次 up 的 hash
  drift: boolean; // hash 与 appliedHash 不一致 = 改了没应用
  readonly?: boolean; // adopted 栈：文件在原处（别人的底账），只读展示不提供编辑/应用
}

export async function getServiceConfig(cfg: Config, name: string): Promise<ServiceConfigView> {
  const t = await resolveTarget(name);
  // adopted 栈：底账在原编排方——只读展示原文件，不提供编辑/应用（双真相是红线）
  if (t.externalStack && t.stack) {
    const yaml = t.stack.file ? await readFile(t.stack.file, 'utf8').catch(() => null) : null;
    return {
      name,
      path: t.stack.file ?? '',
      yaml,
      hasBuild: false,
      hash: null,
      appliedHash: null,
      drift: false,
      readonly: true,
    };
  }
  const m = await getServiceMeta(name);
  if (m?.adopted && !m.stack) throw conflict('收编容器没有 compose 底账（生命周期归它自己的编排方管）');
  if (t.project) name = t.project; // 升格卡片 → 项目文件
  const yaml = await readComposeYaml(name);
  if (!yaml) {
    return { name, path: composeFilePath(name), yaml: null, hasBuild: false, hash: null, appliedHash: null, drift: false };
  }
  // 多服务项目：hash 逐服务比对（任一成员不一致即 drift；容器缺席 = 未应用）。
  // spawn 有成本——config 页是懒加载场景，N 个服务的量级可接受。
  const project = await readComposeProject(name);
  const keys = project?.services.map((s) => s.key) ?? [];
  const file = composeFileOf(name);
  const anchor = keys[0] ?? name;
  void anchor;
  const [hash, appliedHash] = await Promise.all([composeFileHash(name), containerComposeHash(t.container)]);
  // 多服务项目的漂移以入口容器 hash 代表（成员 hash 同源于同一次 up，入口一致基本
  // 全员一致）；绝对精确可后续按需逐服务 `config --hash` 比对（每服务一次 spawn）。
  const drift = hash != null && hash !== appliedHash;
  return {
    name,
    path: file,
    yaml,
    hasBuild: project?.services.some((s) => s.build) ?? false,
    hash,
    appliedHash,
    drift,
  };
}

function composeFilePath(name: string): string {
  return composeFileOf(name);
}

// —— 收编外部容器 ——
// docker 不能给既有容器补 label，收编 = sidecar 登记（adopted meta）+ 接入服务网络。
// 不动容器本体：不重建、不改 env、不断原网络（compose 栈原样活着），只给它一条
// mysandbox-lan 上的静态 IP——LXC 容器按名字可达（hosts 注入），面板获得全套管理。
export interface AdoptableRow {
  name: string;
  image: string;
  state: string;
  status: string;
  networks: string;
  onServiceNetwork: boolean; // 已在服务网络（compose external 等手工挂过）——adopt 复用现 IP
  compose: boolean; // compose 栈容器（带 project label）——只读收编，不做接管
  ip: string | null;
}

// compose 栈（多容器项目）的收编候选：一行一个项目。
export interface AdoptableStack {
  project: string;
  file: string | null; // 原 compose 文件（从容器 label 拿——docker 替我们记好了）
  containers: { name: string; state: string }[];
  running: number;
}

// 收编候选：宿主上非 mysandbox 管理的容器（无 label），排除已收编。
// 裸容器逐个一行；compose 容器按 project 聚合成栈一行。running 优先（Exited 试验
// 残留是头号噪声）。
export async function listAdoptables(cfg: Config): Promise<{ items: AdoptableRow[]; stacks: AdoptableStack[] }> {
  const all = await getAllServiceMeta();
  const adopted = new Set([...adoptedServiceNames(all), ...adoptedContainerNames(all)]);
  // 目录注册表项目的成员不是收编候选（已经是服务了——project 命中即排除）
  const dirSet = new Set(await listComposeDirServices());
  const rows = (await listExternalContainers()).filter(
    (r) => !(dirSet.has(rowLabels(r)['com.docker.compose.project'] ?? '') || adopted.has(rowName(r.Names))),
  );
  const net = await inspectNetwork(cfg.services.network);
  const onNet = new Map(net?.endpoints.map((e) => [e.name, e.ip]));
  const items: AdoptableRow[] = [];
  const stackMap = new Map<string, AdoptableStack>();
  for (const row of rows) {
    const name = rowName(row.Names);
    if (adopted.has(name)) continue;
    const labels = rowLabels(row);
    const project = labels['com.docker.compose.project'];
    if (project) {
      let st = stackMap.get(project);
      if (!st) {
        st = {
          project,
          file: labels['com.docker.compose.project.config_files'] ?? null,
          containers: [],
          running: 0,
        };
        stackMap.set(project, st);
      }
      st.containers.push({ name, state: row.State });
      if (row.State === 'running') st.running++;
      continue;
    }
    items.push({
      name,
      image: row.Image,
      state: row.State,
      status: row.Status,
      networks: row.Networks,
      onServiceNetwork: onNet.has(name),
      compose: false,
      ip: onNet.get(name) ?? null,
    });
  }
  const rank = (s: string): number => (s === 'running' ? 0 : 1);
  items.sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name));
  const stacks = [...stackMap.values()].sort(
    (a, b) => rank(a.containers[0]?.state ?? '') - rank(b.containers[0]?.state ?? '') || a.project.localeCompare(b.project),
  );
  return { items, stacks };
}

// 收编动作。名字校验在路由层（ADOPT_NAME_RE）。
// 两种形态：裸容器（无 compose label）+ takeover = **接管式收编**——inspect 复刻启动
// 方式生成 compose 底账 → rm 裸容器 → compose up，文件进 compose 目录从此可查可改
// （重建中断一次、可写层数据丢失的风险由前端确认）；compose 栈容器（带 compose
// project label）只允许只读收编——底账在原编排方，复制过来就是双真相。
export async function adoptService(cfg: Config, name: string, opts: { takeover?: boolean } = {}): Promise<ServiceView> {
  await ensureServiceNetwork(cfg);
  // 已受管（label 命中）不是收编对象；已收编的也不能重复收编（会覆盖用户改过的
  // displayName 等元数据）。与进行中任务撞名也要挡——任务预占的容器还没建出来，
  // ps 查不到。试占名兜底，finally 释放。
  const prev = await getServiceMeta(name);
  if (prev?.adopted) throw conflict(`"${name}" 已收编`);
  const managed = await listServiceContainers();
  if (managed.some((r) => rowName(r.Names) === name)) throw conflict(`"${name}" 已是受管服务`);
  if (!tryReserveJobName(name)) throw conflict(`同名任务「${name}」进行中`);
  // 注意任务名预占的释放纪律：takeover 路径把释放交给 jobs.ts run() 的 finally（job
  // 是异步的，这里 finally 释放会架空互斥）；只读路径是同步动作，路径尾部自己释放。
  let releaseHere = true;
  try {
    const externals = await listExternalContainers();
    let row = externals.find((r) => rowName(r.Names) === name);
    if (!row) row = externals.find((r) => rowLabels(r)['com.docker.compose.project'] === name);
    if (!row) throw notFound(`docker 容器 "${name}" 不存在（或已受管）`);
    const composeProject = rowLabels(row)['com.docker.compose.project'];

    // —— compose 栈（多容器项目）→ 栈级只读收编：全量纳管、单入口展示 ——
    if (composeProject) {
      if (opts.takeover) {
        throw conflict(`"${composeProject}" 是 compose 栈——底账在原编排方，只做只读收编（栈级），不做接管`);
      }
      const members = externals.filter((r) => rowLabels(r)['com.docker.compose.project'] === composeProject);
      return await adoptStack(cfg, composeProject, members);
    }

    // —— 接管式：生成底账 → rm 裸容器 → compose up（后台 job，进度/取消走任务面）——
    if (opts.takeover) {
      const shape = await inspectContainerShape(name);
      if (!shape) throw notFound(`docker 容器 "${name}" 不存在（或已受管）`);
      const img = await inspectImageDefaults(shape.image);
      // 服务网络 IP：已在网复用现 IP，否则分配（host 网络模式没有 IP 一说）
      const net = await inspectNetwork(cfg.services.network);
      let ip: string | null = net?.endpoints.find((e) => e.name === name)?.ip ?? null;
      if (!ip && shape.networkMode !== 'host') {
        ip = await allocateServiceIp(cfg);
      }
      const def = defFromShape(name, shape, img, cfg, ip);
      if (!def.networkMode) {
        await ensureServiceNetwork(cfg); // 分配过 IP 就必须保证网络在（inspect 与 up 之间可能被删）
      }
      // 释放纪律切换点：此后失败由 jobs.ts 的 finally 释放，路由侧不再插手
      releaseHere = false;
      const job = startServiceJob({ name, image: shape.image, ip: ip ?? '', kind: 'adopt' }, (ctx) =>
        runServiceAdopt(cfg, name, def, ctx),
      );
      // jobId 一并回（前端任务横幅按 id 挂进度）；视图先行（容器在重建中，状态以轮询为准）
      return {
        name,
        preset: 'adopted',
        image: shape.image,
        ip,
        state: row.State,
        status: row.Status,
        running: row.State === 'running',
        volume: null,
        ports: [],
        envKeys: [],
        env: {},
        connect: [],
        adopted: false,
        hasCompose: true,
        description: '接管式收编（启动方式已复刻进 compose 底账）',
        createdAt: new Date().toISOString(),
        jobId: job.id,
      } as ServiceView & { jobId: string };
    }

    // —— 只读收编：sidecar 登记 + 接入服务网络，本体不动 ——
    const net = await inspectNetwork(cfg.services.network);
    let ip = net?.endpoints.find((e) => e.name === name)?.ip ?? null;
    if (!ip) {
      ip = await allocateServiceIp(cfg);
      await connectServiceNetwork(name, cfg.services.network, ip);
    }

    const meta: ServiceMeta = {
      preset: 'adopted',
      image: row.Image,
      env: {},
      volume: null,
      ip,
      ports: [],
      adopted: true,
      description: '外部容器收编（原配置不动）',
      createdAt: new Date().toISOString(),
    };
    await setServiceMeta(name, meta);

    // hosts 尾块追平；失败不回滚收编——下次事件/轮询自然补上。
    try {
      await applyServicesBlock(cfg);
    } catch (e) {
      log.warn({ err: String(e), name }, 'hosts re-apply after adopt failed');
    }
    log.info({ name, ip, image: row.Image }, 'docker container adopted');

    return {
      name,
      preset: meta.preset,
      image: row.Image,
      ip,
      state: row.State,
      status: row.Status,
      running: row.State === 'running',
      volume: null,
      ports: [],
      envKeys: [],
      env: {},
      connect: [],
      adopted: true,
      description: meta.description,
      createdAt: meta.createdAt,
    };
  } finally {
    if (releaseHere) releaseJobName(name);
  }
}

// 栈级只读收编：项目全体成员接入服务网络（已在网复用现 IP）+ 项目 meta（原文件
// 路径从 compose label 拿——docker 早就记好了）+ 入口锚定（有发布端口的容器）。
// 不碰容器本体、不碰原文件——管理不拥有。
async function adoptStack(cfg: Config, project: string, members: DockerContainerRow[]): Promise<ServiceView> {
  await ensureServiceNetwork(cfg);
  const net = await inspectNetwork(cfg.services.network);
  const first = members[0];
  const file = rowLabels(first)['com.docker.compose.project.config_files'] ?? null;
  const workdir = rowLabels(first)['com.docker.compose.project.working_dir'] ?? null;
  const services: StackServiceRef[] = [];
  for (const r of members) {
    const cname = rowName(r.Names);
    const svcKey = rowLabels(r)['com.docker.compose.service'] ?? cname;
    let ip = net?.endpoints.find((e) => e.name === cname)?.ip ?? null;
    if (!ip) {
      ip = await allocateServiceIp(cfg);
      await connectServiceNetwork(cname, cfg.services.network, ip);
    }
    services.push({ name: svcKey, container: cname, ip });
  }
  // 入口锚定：有发布端口的容器优先（对外入口）；没有就第一个
  for (const s of services) {
    if ((await containerPublishedPorts(s.container)).length > 0) s.entry = true;
  }
  if (!services.some((s) => s.entry)) services[0].entry = true;

  const meta: ServiceMeta = {
    preset: 'adopted',
    image: first.Image,
    env: {},
    volume: null,
    ip: '',
    ports: [],
    adopted: true,
    description: `compose 栈收编（${services.length} 个服务，原底账不动）`,
    createdAt: new Date().toISOString(),
    stack: { file, workdir, services },
  };
  await setServiceMeta(project, meta);
  try {
    await applyServicesBlock(cfg);
  } catch (e) {
    log.warn({ err: String(e), name: project }, 'hosts re-apply after stack adopt failed');
  }
  log.info({ project, members: services.length }, 'compose stack adopted');
  return (await listServices(cfg)).items.find((x) => x.name === project) ?? {
    name: project,
    preset: 'adopted',
    image: first.Image,
    ip: null,
    state: first.State,
    status: first.Status,
    running: first.State === 'running',
    volume: null,
    ports: [],
    envKeys: [],
    env: {},
    connect: [],
    adopted: true,
    description: meta.description,
    createdAt: meta.createdAt,
  };
}

// 取消收编：摘网络（还原）+ 清 meta + 追平 hosts。容器本体不动。栈 = 全体成员一起
// 摘（meta 以项目名为 key；name 传项目名或任一成员容器名都行）。
export async function unadoptService(cfg: Config, name: string): Promise<void> {
  const all = await getAllServiceMeta();
  const hit = all[name]?.adopted ? { key: name, meta: all[name] } : stackMetaOfContainer(all, name);
  if (!hit?.meta.adopted) throw conflict(`"${name}" 不是收编容器——删除请走 DELETE /api/services/${name}`);
  const members = hit.meta.stack?.services ?? [{ name: hit.key, container: hit.key }];
  for (const s of members) {
    try {
      await disconnectServiceNetwork(s.container, cfg.services.network);
    } catch (e) {
      // 摘不掉不拦取消收编（容器可能已被外部删掉；hosts 反正要追平）
      log.warn({ err: String(e), name: s.container }, 'unadopt: network disconnect failed (ignored)');
    }
  }
  await deleteServiceMeta(hit.key);
  try {
    await applyServicesBlock(cfg);
  } catch (e) {
    log.warn({ err: String(e) }, 'hosts re-apply after unadopt failed');
  }
  log.info({ name: hit.key }, 'docker service unadopted');
}

// —— 路由 ——

// :name 的统一前置：名字合法 + label 集 ∪ 收编集里存在——未收编的外部容器结构性 404。
// 容器没了但 meta 还在（外部 docker rm / 上次删除中途失败）→ 顺手清孤儿 meta 再 404，
// 不然 state.json 里会积累指向不存在容器的条目。
// ⚠️ 「ps 列表里没有」≠「真没了」：ps 失败被吞成空列表（daemon 忙碌/重启的瞬时故障，
// 见 listServiceContainers），更新/重建任务还有 rm→create 的真窗口——盲删会把瞬时故障
// 变成不可逆的 meta 丢失（2026-09-10 myapikey 事故）。所以：任务占用期一律不删；其余
// 情形单容器直查二次确认——在（ps 瞬时失败）照常放行，确认无才清，查询失败 409 拒判。
async function requireService(name: string): Promise<void> {
  // 目录注册表服务（agent 自放的 compose 文件）可能带 `_`（compose 惯例），放宽到收编名规格。
  if (!NAME_RE.test(name) && !ADOPT_NAME_RE.test(name)) {
    throw badRequest('invalid service name');
  }
  // 底账存在即服务（目录是注册表）；项目 meta（adopted 栈以项目名为 key）与栈成员
  // 容器名（「加入列表」升格卡片）同样合法。容器在不在由具体操作自己面对——compose
  // 对缺席容器幂等；孤儿 meta 清理已退役（栈时代没有可保护的 rm→create 窗口）。
  if (await composeFileExists(name)) return;
  const all = await getAllServiceMeta();
  if (all[name] || stackMetaOfContainer(all, name)) return;
  // 无 meta 无文件：label 管理的旧形态——ps 确认存在（daemon 瞬时故障会被吞成空列表，
  // 这里宁可 404 也不误伤）
  const rows = await listServiceContainers(adoptedContainerNames(all));
  if (rows.some((r) => rowName(r.Names) === name)) return;
  throw notFound(`service "${name}" not found`);
}

// 服务名 → 实际容器名：目录注册表服务 compose 项目名 ≠ container_name 时（agent 自放
// 文件用 compose 默认命名 <project>-<service>-1），docker 直操作要对准容器真名。
// 我们生成的文件 container_name 恒 = 服务名，此 helper 是零成本的直读。
async function resolveContainerName(name: string): Promise<string> {
  const parsed = await readComposeService(name);
  return parsed?.containerName ?? name;
}

// 多容器项目的 meta（懒创建 + 从文件补水）：目录项目补 compose/<名>/ 的形状，adopted
// 栈的 meta 已带 stack（file 指原文件）——只补新增服务。保留用户已勾的 listed/entry。
async function ensureProjectStackMeta(name: string): Promise<ServiceMeta> {
  const prev = await getServiceMeta(name);
  let services: StackServiceRef[];
  let file: string | null;
  let workdir: string | null;
  if (prev?.stack) {
    // adopted 栈：形状以 meta 为准（file 在原处，ps 反查可能不在）
    file = prev.stack.file;
    workdir = prev.stack.workdir ?? null;
    services = prev.stack.services;
  } else {
    const project = await readComposeProject(name);
    if (!project) throw conflict(`"${name}" 的 compose 文件解析失败，无法管理项目成员`);
    file = composeFileOf(name);
    workdir = composeDir(name);
    services = project.services.map((s) => ({
      name: s.key,
      container: s.containerName ?? `${name}-${s.key}-1`,
      ip: s.ip,
    }));
  }
  const base: ServiceMeta = prev ?? {
    preset: 'custom',
    image: '',
    env: {},
    volume: null,
    ip: '',
    createdAt: new Date().toISOString(),
  };
  // 文件里新增的服务补水进清单（保留既有 ref 的用户标记）
  const merged = services.map((s) => {
    const p = prev?.stack?.services.find((x) => x.name === s.name);
    return { ...s, entry: p?.entry, listed: p?.listed };
  });
  const next: ServiceMeta = { ...base, stack: { file, workdir, services: merged } };
  await setServiceMeta(name, next);
  return next;
}

// 操作目标解析：API 的 :name 可能是 项目名（目录项目 / adopted 栈）或 栈成员容器名
// （「加入列表」的升格卡片）。返回 docker 操作锚点 + 项目上下文（外部栈走 compose 驱动）。
interface ServiceTarget {
  container: string; // docker 操作锚点
  project: string | null; // 所属项目（= name 或反查得到）
  stack: ServiceMeta['stack'] | null;
  externalStack: boolean; // true = adopted 栈：启停 compose 驱动（原文件）、配置只读
}

async function resolveTarget(name: string): Promise<ServiceTarget> {
  // 1) 目录项目（含多服务）：入口容器
  if (await composeFileExists(name)) {
    const project = await readComposeProject(name);
    const dirMeta = await getServiceMeta(name);
    let target: ParsedProjectService | undefined;
    if (project) {
      const idx = pickEntryIndex(project.services, dirMeta, new Map());
      target = project.services[idx];
    }
    const container = target?.containerName ?? target?.key ?? (await resolveContainerName(name));
    return { container, project: name, stack: dirMeta?.stack ?? null, externalStack: false };
  }
  // 2) 项目 meta（adopted 栈以项目名为 key）
  const m = await getServiceMeta(name);
  if (m?.stack) {
    const entry = m.stack.services.find((s) => s.entry) ?? m.stack.services[0];
    return { container: entry.container, project: name, stack: m.stack, externalStack: !!m.adopted };
  }
  // 3) 栈成员容器名（升格卡片）
  const all = await getAllServiceMeta();
  const hit = stackMetaOfContainer(all, name);
  if (hit) {
    return { container: name, project: hit.key, stack: hit.meta.stack ?? null, externalStack: !!hit.meta.adopted };
  }
  // 4) 单容器收编 / 旧形态 / 单服务目录
  return { container: await resolveContainerName(name), project: null, stack: null, externalStack: false };
}

export function registerServices(app: FastifyInstance, cfg: Config): void {
  app.get('/api/services', async () => listServices(cfg));

  app.get('/api/services/presets', async () => {
    // 前端建表单用：预设元数据，不含 fixedEnv 的值（无所谓，但保持「不回环境变量值」的一致性）。
    return { presets: SERVICE_PRESETS.map((p) => ({ ...p, fixedEnv: {} })) };
  });

  // 宿主已有镜像（自定义镜像的候选下拉）。<none> 悬空行/纯 digest 行过滤掉——
  // 没法当 ref 用；失败（daemon 挂）降级为空列表，前端选择器整块隐藏不报错。
  app.get('/api/services/images', async () => {
    const rows = await listImages().catch(() => []);
    const images = rows
      .filter((r) => r.Repository && r.Repository !== '<none>' && r.Tag && r.Tag !== '<none>')
      .map((r) => ({
        ref: `${r.Repository}:${r.Tag}`,
        repository: r.Repository,
        tag: r.Tag,
        size: r.Size,
        createdSince: r.CreatedSince,
      }))
      .sort((a, b) => a.ref.localeCompare(b.ref));
    return { images };
  });

  // —— 收编外部容器 ——
  app.get('/api/services/adoptables', async () => {
    if (!cfg.services.enabled) return { items: [], stacks: [], enabled: false };
    const v = await listAdoptables(cfg);
    return { ...v, enabled: true };
  });

  app.post('/api/services/adopt', async (req) => {
    const body = (req.body as { name?: unknown; takeover?: unknown } | null) || {};
    const name = String(body.name ?? '').trim();
    if (!ADOPT_NAME_RE.test(name)) {
      throw badRequest('容器名须为 1–63 位小写字母/数字/连字符/下划线（含 . 或大写的外部容器暂不支持收编）');
    }
    if (!cfg.services.enabled) throw badRequest('services 层未启用（config services.enabled）');
    // takeover = 接管式收编：裸容器（无 compose label）复刻启动方式进底账并重建；
    // compose 栈容器只能只读收编（服务内部按 label 挡，409 给人话）。
    return adoptService(cfg, name, { takeover: body.takeover === true });
  });

  // 创建：快校验 + 预占通过即返回 jobId，写 compose 文件 + up 在后台 job 跑（jobs.ts）。
  // 校验失败（重名/池尽/缺必填）照旧抛 HttpError → 4xx，对话框内联显示。
  // ⚠️ 同步预占名再进 await：serviceNameExists 查不到「还没建容器」的进行中任务，
  // 不锁名的话两个同名任务会双双通过查重、后一个死在 compose up（Node 单线程，
  // 同步段无竞态）。IP 预占同理；两条的释放兜在 jobs.ts run() 的 finally。
  app.post('/api/services', async (req) => {
    const input = (req.body as CreateServiceInput | null) || ({} as CreateServiceInput);
    const name = String(input.name ?? '').trim().toLowerCase();
    if (!NAME_RE.test(name)) throw badRequest('服务名 2–31 位，小写字母/数字/连字符，字母或数字开头');
    if (!tryReserveJobName(name)) throw conflict(`同名任务「${name}」进行中`);
    let ip: string | null = null;
    try {
      const plan = await prepareServiceCreate(cfg, { ...input, name });
      ip = plan.ip;
      reserveJobIp(ip);
      const job = startServiceJob(plan satisfies ServicePlan, (ctx) => runServiceCreate(cfg, plan, ctx));
      return { jobId: job.id };
    } catch (e) {
      releaseJobName(name);
      if (ip) releaseJobIp(ip);
      throw e;
    }
  });

  // 任务列表：tail=0 不带日志（侧栏轮询的极小 payload），>0 带最近 N 行（面板预览）。
  app.get('/api/services/jobs', async (req) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const tail = Math.min(Math.max(Number(q.tail) || 0, 0), 200);
    return { jobs: listServiceJobs(tail) };
  });

  app.get<{ Params: { id: string } }>('/api/services/jobs/:id', async (req) => {
    const r = getServiceJob(req.params.id);
    if (!r) throw notFound(`job "${req.params.id}" not found`);
    return r;
  });

  app.post<{ Params: { id: string } }>('/api/services/jobs/:id/cancel', async (req) => {
    cancelServiceJob(req.params.id); // 不在 pull 阶段时抛 conflict(409)，人话见 jobs.ts
    return { ok: true };
  });

  // —— 元数据（显示名）—— 与容器 PATCH /meta 同款：改 sidecar 易变数据，不动容器对象。
  // setServiceMeta 是整对象覆盖，先读旧值再合并；清空显示名传 undefined 即删键。
  app.patch<{ Params: { name: string } }>('/api/services/:name/meta', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const body = (req.body as { displayName?: unknown } | null) || {};
    const patch: Partial<ServiceMeta> = {};
    if (typeof body.displayName === 'string') patch.displayName = body.displayName.trim() || undefined;
    if (!('displayName' in patch) && body.displayName !== undefined) throw badRequest('displayName must be a string');
    const prev = await getServiceMeta(name);
    if (!prev) throw notFound(`service "${name}" meta missing`);
    await setServiceMeta(name, { ...prev, ...patch });
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/start', async (req) => {
    await requireService(req.params.name);
    const t = await resolveTarget(req.params.name);
    if (t.stack) await composeStackStart(stackFileOf(t), t.stack.workdir ?? null);
    else await startContainer(t.container);
    await applyServicesBlock(cfg);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/stop', async (req) => {
    await requireService(req.params.name);
    const t = await resolveTarget(req.params.name);
    if (t.stack) await composeStackStop(stackFileOf(t), t.stack.workdir ?? null);
    else await stopContainer(t.container);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/restart', async (req) => {
    await requireService(req.params.name);
    const t = await resolveTarget(req.params.name);
    if (t.stack) await composeStackRestart(stackFileOf(t), t.stack.workdir ?? null);
    else await restartContainer(t.container);
    await applyServicesBlock(cfg);
    return { ok: true };
  });

  // 栈的 compose 驱动启停用原文件（adopted 栈）；目录项目就是我们目录里的文件。
  function stackFileOf(t: ServiceTarget): string {
    if (t.stack?.file) return t.stack.file;
    if (t.project) return composeFileOf(t.project);
    throw conflict('该服务没有 compose 文件可供驱动（裸收编容器请用容器级启停）');
  }

  // —— 「加入列表」/「设为入口」（多容器项目的展示策展）——
  // listed = 升格为独立卡片；entry = 卡片锚点换人。meta 懒创建并从文件补水（目录项目
  // 默认无 meta；补水保留用户已勾的 listed/entry，文件新增服务自动进清单）。
  app.post<{ Params: { name: string } }>('/api/services/:name/stack', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const body = (req.body as { service?: unknown; listed?: unknown; entry?: unknown } | null) || {};
    const svc = String(body.service ?? '');
    if (!svc) throw badRequest('缺少 service');
    const m = await ensureProjectStackMeta(name);
    const ref = m.stack?.services.find((s) => s.name === svc);
    if (!ref) throw notFound(`项目 "${name}" 里没有服务 "${svc}"`);
    if (body.entry === true) {
      for (const s of m.stack!.services) s.entry = s.name === svc;
    }
    if (typeof body.listed === 'boolean') ref.listed = body.listed;
    await setServiceMeta(name, m);
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/api/services/:name', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const am = await getServiceMeta(name);
    if (am?.adopted) {
      throw conflict(`"${name}" 是收编的外部容器，不能删除——请用「取消收编」（POST /api/services/${name}/unadopt）`);
    }
    if (am?.stack) {
      throw conflict(`"${name}" 是多容器项目——删除请直接删 compose 目录（或先删文件再等列表刷新）`);
    }
    const body = (req.body as { deleteData?: boolean; confirmName?: string } | null) || {};
    return deleteService(cfg, name, { deleteData: !!body.deleteData, confirmName: body.confirmName });
  });

  // 取消收编：还原网络接入 + 清 meta，容器本体不动（与删除的分界，见 unadoptService）。
  app.post<{ Params: { name: string } }>('/api/services/:name/unadopt', async (req) => {
    const name = req.params.name;
    await requireService(name);
    await unadoptService(cfg, name);
    return { ok: true, name };
  });

  app.get<{ Params: { name: string } }>('/api/services/:name/logs', async (req) => {
    await requireService(req.params.name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const tail = Math.min(Math.max(Number(q.tail) || 200, 1), 2000);
    // 栈成员可指定 service 看单容器日志；缺省 = 入口/目标容器
    const t = await resolveTarget(req.params.name);
    let container = t.container;
    if (q.service && t.stack) {
      const ref = t.stack.services.find((s) => s.name === q.service);
      if (ref) container = ref.container;
    }
    return { logs: await containerLogs(container, tail) };
  });

  // —— 服务内监听端口（应用端口直达，对齐 /api/containers/:id/listen）——
  // 不走 docker exec：镜像里未必有 shell/awk（distroless 等）。docker inspect 拿容器
  // 主进程的宿主 PID，宿主侧直读 /proc/<pid>/net/tcp{,6}——/proc/<pid>/net 反映该进程
  // 的网络命名空间，正是容器内的监听表；文件全局可读、零镜像依赖。回环监听（含
  // docker 内嵌 DNS 127.0.0.11 的随机端口）在 parseProcNetListeners 里剔除。
  // web 实测同容器路径：宿主直连服务 IP 发最小 HTTP 请求。
  app.get<{ Params: { name: string } }>('/api/services/:name/listen', async (req): Promise<{ ports: number[]; web: number[] }> => {
    const name = req.params.name;
    await requireService(name);
    const t = await resolveTarget(name);
    const cname = t.container;
    const pid = await containerPid(cname);
    if (!pid) throw conflict('service not running');
    const texts = await Promise.allSettled([
      readFile(`/proc/${pid}/net/tcp`, 'utf8'),
      readFile(`/proc/${pid}/net/tcp6`, 'utf8'), // ipv6 关闭的系统没有该文件，缺席即跳过
    ]);
    const ports = [...new Set(texts.flatMap((t) => (t.status === 'fulfilled' ? parseProcNetListeners(t.value) : [])))].sort(
      (a, b) => a - b,
    );
    if (!ports.length) return { ports, web: [] };
    // 收编容器的探测 IP 必须在 mysandbox-lan 上（可能与 compose 网并存，见 listServices）。
    const am = await getServiceMeta(name);
    const ip = am?.adopted
      ? await containerNetIp(cname, cfg.services.network)
      : (await containerIpamIp(cname)) ?? null;
    if (!ip) return { ports, web: [] };
    const marks = await Promise.all(ports.map((p) => probeHtmlPort(ip, p)));
    const web = ports.filter((_, i) => marks[i]);
    return { ports, web };
  });

  // —— 配置底账视图（服务抽屉「配置」页）——
  app.get<{ Params: { name: string } }>('/api/services/:name/config', async (req) => {
    await requireService(req.params.name);
    return getServiceConfig(cfg, req.params.name);
  });

  // —— 应用（配置页保存 = 写文件 + compose up）：校验/写盘在路由同步段（坏文件
  // 4xx 内联回显，绝不落盘），up 在后台 job（可取消，输出进任务日志）。写盘后 job
  // 失败也无碍——文件是真相，修好再点一次应用即收敛。
  app.post<{ Params: { name: string } }>('/api/services/:name/apply', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const m = await getServiceMeta(name);
    if (m?.adopted) throw conflict('收编容器没有 compose 底账（生命周期归它自己的编排方管）');
    const body = (req.body as { yaml?: unknown; build?: unknown } | null) || {};
    if (typeof body.yaml !== 'string' || !body.yaml.trim()) throw badRequest('缺少 yaml 内容');
    // 校验不通过 → 400 内联回显（文件不落盘）；compose 的人话报错前端直接展示。
    try {
      await writeCompose(name, body.yaml);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
    if (!tryReserveJobName(name)) throw conflict(`「${name}」已有任务进行中`);
    try {
      const job = startServiceJob({ name, image: '', ip: '', kind: 'apply' }, (ctx) =>
        runServiceApply(cfg, name, body.build === true, ctx),
      );
      return { jobId: job.id };
    } catch (e) {
      releaseJobName(name);
      throw e;
    }
  });

  // —— 迁移（旧版 docker create 服务 → compose 底账）：无文件的自建服务唯一入口。
  // 与旧 rebuild 同风险面（rm 后按原形状重建，数据在卷里无损），前端入口对无卷
  // custom 给可行动警告。job 视图的 image/ip 填 meta 现值（纯展示）。
  app.post<{ Params: { name: string } }>('/api/services/:name/migrate', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const m = await getServiceMeta(name);
    if (!m) throw conflict(`缺少 "${name}" 的登记元数据（state.json），无法迁移——删除后重新创建即可`);
    if (m.adopted) throw conflict(`"${name}" 是收编的外部容器，没有 compose 底账可迁移`);
    if (await composeFileExists(name)) throw conflict(`"${name}" 已有 compose 底账，无需迁移（改配置请用「应用」）`);
    if (!tryReserveJobName(name)) throw conflict(`「${name}」已有任务进行中`);
    const ip = (await containerIpamIp(name)) ?? m.ip;
    reserveJobIp(ip);
    try {
      const job = startServiceJob({ name, image: m.image, ip, kind: 'migrate' }, (ctx) =>
        runServiceMigrate(cfg, name, ctx),
      );
      return { jobId: job.id };
    } catch (e) {
      releaseJobName(name);
      releaseJobIp(ip);
      throw e;
    }
  });
}

// —— 服务事件 → hosts 追平 ——
// 服务容器 start/die/destroy（含 mysandbox 之外的手工 docker stop/restart）都会改变
// hosts 里的服务行。订阅不带 label 过滤（收编容器也要进来）：受管事件直接扫描，非受管
// 事件拿收编名集一挡——外部容器 churning 只是一次 state 内存读，不触发扫描。
// 2s trailing debounce 合并 crash-loop 的 die→start 风暴；断流（docker daemon 重启会杀掉
// events 子进程）指数退避重连 + 重连后全量补刷一次。骨架照抄 hosts-sync 的 startHostsEventSync。
export function startServicesEventSync(cfg: Config): void {
  if (!cfg.services.enabled) return;
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeServiceEvents((ev) => {
          if (!ev.managed) {
            void getServiceMeta(ev.name)
              .then((m) => {
                if (!m?.adopted) {
                  // 目录注册表服务（agent 自放 compose 文件）：容器无我们的 label，
                  // 靠 compose project label 命中目录名判定——启停同样要追平 hosts。
                  if (ev.composeProject) void isManagedComposeProject(ev.composeProject).then((hit) => hit && scheduleSweep(cfg));
                  return;
                }
                scheduleSweep(cfg);
                if (ev.action === 'start') void healAdopted(cfg, ev.name);
                if (ev.action === 'destroy') scheduleAdoptedOrphanCheck(cfg, ev.name);
              })
              .catch(() => {});
            return;
          }
          scheduleSweep(cfg);
        });
        delay = 1_000;
        log.info({ network: cfg.services.network }, 'services event sync: subscribed');
        scheduleSweep(cfg); // 重连补刷
        await sub.closed;
      } catch (e) {
        log.warn({ err: String(e), retryMs: delay }, 'services event sync: subscribe failed');
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}

// 收编容器被外部重建（compose down/up：同名新容器、不带我们的网络接入）→ start 事件
// 自动重连，self-heal。栈成员：ip 记账在项目 meta 的 stack.services 里。meta.ip 已被
// 占（重建窗口期 docker IPAM 不认我们的记账，可能被别家动态拿走）就重新分配并回写。
async function healAdopted(cfg: Config, name: string): Promise<void> {
  try {
    const all = await getAllServiceMeta();
    const hit = all[name]?.adopted ? { key: name, meta: all[name] } : stackMetaOfContainer(all, name);
    if (!hit?.meta.adopted) return;
    await ensureServiceNetwork(cfg);
    const net = await inspectNetwork(cfg.services.network);
    if (net?.endpoints.some((e) => e.name === name)) return; // 已在网，无需要
    const ref = hit.meta.stack?.services.find((s) => s.container === name);
    let ip: string;
    if (ref?.ip) ip = ref.ip;
    else if (!hit.meta.stack) ip = hit.meta.ip;
    else ip = '';
    try {
      await connectServiceNetwork(name, cfg.services.network, ip || undefined);
    } catch {
      ip = await allocateServiceIp(cfg); // 旧 IP 在记账里算占用，allocate 天然避开
      await connectServiceNetwork(name, cfg.services.network, ip);
    }
    if (hit.meta.stack && ref) {
      if (ip !== ref.ip) {
        ref.ip = ip;
        await setServiceMeta(hit.key, hit.meta);
      }
    } else if (ip !== hit.meta.ip) {
      await setServiceMeta(hit.key, { ...hit.meta, ip });
    }
    log.info({ name, ip }, 'adopted container re-connected to service network');
    scheduleSweep(cfg);
  } catch (e) {
    log.warn({ err: String(e), name }, 'adopted container heal failed');
  }
}

// 收编容器被外部 destroy：meta 先留着——compose force-recreate 是 destroy→create→start，
// 立刻清会弄丢自愈。延迟确认容器真没了（没有同名重建）才清 meta + 追平。栈：全体成员
// 都没了才清项目 meta（个别成员重建是常规操作）。
const orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleAdoptedOrphanCheck(cfg: Config, name: string): void {
  const prev = orphanTimers.get(name);
  if (prev) clearTimeout(prev);
  orphanTimers.set(
    name,
    setTimeout(() => {
      orphanTimers.delete(name);
      void (async () => {
        const all = await getAllServiceMeta();
        const hit = all[name]?.adopted ? { key: name, meta: all[name] } : stackMetaOfContainer(all, name);
        if (!hit?.meta.adopted) return;
        const members = hit.meta.stack?.services.map((s) => s.container) ?? [hit.key];
        // 传成员名集：无 label 的同名重建容器也要能看到（否则误判「没了」清掉 meta）
        const rows = await listServiceContainers(members);
        if (rows.some((r) => members.includes(rowName(r.Names)))) return; // 有成员活着/重建了
        await deleteServiceMeta(hit.key);
        log.info({ name: hit.key }, 'adopted container gone — meta cleaned');
        scheduleSweep(cfg);
      })().catch((e) => log.warn({ err: String(e), name }, 'adopted orphan check failed'));
    }, 60_000),
  );
}

let sweepTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSweep(cfg: Config): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void applyServicesBlock(cfg).catch((e) => {
      log.warn({ err: String(e) }, 'services event hosts re-apply failed');
    });
  }, 2_000);
}
