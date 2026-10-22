// docker 服务层：配套服务（数据库等）的预设、编排与路由。
//
// 形态（v2，compose 底账）：一服务 = <CONFIG_DIR>/compose/<名>/compose.yaml（唯一配置
// 真相，见 serviceCompose.ts）+ 固定 IP（mysandbox-lan 上 ipv4_address）+ 命名卷
// mysandbox-svc-<name>；不发布端口到宿主——与 LXC 容器同语义（固定 IP 直连、无 NAT），
// LXC 容器里 `psql -h <服务名>` 的通路靠 hosts 注入（hosts-sync 组合 listServiceEndpoints）。
// 创建 = 生成首版文件 + compose up；改配置 = 编辑文件 + up（面板配置页或终端，等价）；
// 删除 = compose down（+ 删卷 + 删目录）。旧版 update/rebuild 任务链随声明式底账退役——
// 「追新镜像」= 改 image 版本 + 应用，「本地 build 迭代」= 构建并应用（up -d --build）。
// 管理边界结构性隔离：判定集 = 目录注册表（compose.yaml 项目 ∪ 外部栈 stub 目录，
// serviceMeta.ts）∪ label（mysandbox.managed-by + mysandbox.kind=service）∪ compose
// project label ∈ 目录名集。未收编的外部容器（dener-* 等）永远不进列表、操作只会 404。
//
// docker 原语在 docker.ts（CLI 客户端），compose 文件层在 serviceCompose.ts，每项目
// 策展（meta.json）在 serviceMeta.ts；这里只有业务编排。对标 base.ts 的「路由薄 + 实现厚」。
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
import { relayServiceState } from './events.js';
import { withPollCache } from './cache.js';
import {
  findServiceTarget,
  isExternalProject,
  externalProjectOfContainer,
  pickExternalEntry,
  readProjectMeta,
  writeProjectMeta,
  type ProjectMemberRef,
  type ProjectMeta,
} from './serviceMeta.js';
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
  listProjectDirs,
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
// 都不出（宁缺毋半截命令误导）。
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
  hasCompose?: boolean; // compose 底账在（可改配置可应用）；false 且非外部栈 = 容器在而无文件（异常形态，仅展示）
  container?: string; // 实际容器名（目录注册表服务 compose 项目名 ≠ 容器名时用于 docker 操作）
  // —— 多容器项目（1 目录 = 1 项目 = N 服务；外部栈同理）——
  stackServices?: StackServiceView[]; // 项目全部成员（>1 时卡片锚在入口，其余折叠在抽屉）
  stackFile?: string | null; // 外部栈的原 compose 文件（配置页只读展示）
  externalStack?: boolean; // 外部栈（只读收编）：file 在原处，配置只读、启停 compose 驱动、删除 409
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

// 入口服务选择：meta.json 里用户指认的优先；否则带发布端口的服务；再否则第一个。
function pickEntryIndex(services: ParsedProjectService[], pm: ProjectMeta | null | undefined): number {
  if (pm?.entry) {
    const idx = services.findIndex((s) => s.key === pm.entry);
    if (idx >= 0) return idx;
  }
  const withPorts = services.findIndex((s) => s.ports.length > 0);
  if (withPorts >= 0) return withPorts;
  return 0;
}

export async function listServices(cfg: Config): Promise<{ items: ServiceView[]; status: ServicesStatus }> {
  const status = await servicesStatus(cfg);
  if (!status.reachable) return { items: [], status };
  // 目录注册表：compose/<名>/ 本身就是服务清单（agent/用户直接放文件 + up；外部栈的
  // 目录里只有 meta.json，同样算）。行 → 目录名的映射走 com.docker.compose.project
  // （agent 文件的容器名是 <project>-<service>-1 形状，project 才等于目录名）。
  const dirNames = new Set(await listProjectDirs());
  // 两源并集去重（我们生成的文件既带 label 也带 project label，两端都会命中）
  const rows: DockerContainerRow[] = [];
  const seenNames = new Set<string>();
  for (const r of [...(await listServiceContainers()), ...(await listComposeProjectContainers([...dirNames]))]) {
    const n = rowName(r.Names);
    if (seenNames.has(n)) continue;
    seenNames.add(n);
    rows.push(r);
  }
  const items: ServiceView[] = [];
  const coveredRows = new Set<DockerContainerRow>();

  // —— 目录项目（1 目录 = 1 项目 = N 服务；N=1 是特例，行为与旧版一致）——
  for (const dirName of dirNames) {
    const pm = await readProjectMeta(dirName);
    // —— 外部栈（只读收编）：meta.json 的成员记账 + ps 现状拼卡片 ——
    if (pm?.external) {
      const members = pm.members ?? [];
      const rowByContainer = new Map<string, DockerContainerRow>();
      for (const row of rows) {
        const n = rowName(row.Names);
        if (members.some((s) => s.container === n)) {
          rowByContainer.set(n, row);
          coveredRows.add(row);
        }
      }
      const entryRef = pickExternalEntry(members);
      const stackServices: StackServiceView[] = members.map((s) => {
        const row = rowByContainer.get(s.container);
        return {
          name: s.name,
          container: s.container,
          state: row?.State ?? 'absent',
          running: row?.State === 'running',
          entry: s.container === entryRef.container,
          listed: s.listed === true,
        };
      });
      const entryState = stackServices.find((s) => s.entry) ?? stackServices[0];
      items.push({
        name: dirName,
        container: entryRef.container,
        preset: pm.preset ?? 'adopted',
        image: pm.image ?? rowByContainer.get(entryRef.container)?.Image ?? '',
        ip: entryRef.ip ?? null,
        state: entryState.state,
        status: entryState.running ? entryState.state : `栈 · ${members.length} 个服务（入口 ${entryRef.name}）`,
        running: entryState.running,
        volume: null,
        ports: [],
        envKeys: [],
        env: {},
        connect: [],
        displayName: pm.displayName,
        description: pm.description,
        createdAt: pm.createdAt,
        hasCompose: false,
        stackServices,
        stackFile: pm.external.file,
        externalStack: true,
      });
      // listed 成员升格为独立卡片（name = 容器名，唯一且可直接操作）
      for (const s of stackServices) {
        if (s.entry || !s.listed) continue;
        const row = rowByContainer.get(s.container);
        items.push({
          name: s.container,
          preset: pm.preset ?? 'adopted',
          image: row?.Image ?? '',
          ip: members.find((x) => x.container === s.container)?.ip ?? null,
          state: s.state,
          status: row?.Status ?? '',
          running: s.running,
          volume: null,
          ports: [],
          envKeys: [],
          env: {},
          connect: [],
          displayName: pm.memberNames?.[s.container] ?? s.name,
          createdAt: pm.createdAt,
          hasCompose: false,
          stackProject: dirName,
          stackServices,
          stackFile: pm.external.file,
          externalStack: true,
        });
      }
      continue;
    }
    const project = await readComposeProject(dirName);
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
        displayName: pm?.displayName,
        description: pm?.description,
        hasCompose: true,
      });
      continue;
    }
    // —— 多服务项目：一张卡锚在入口服务，其余折叠在抽屉（listed 的升格成独立卡）——
    const entryIdx = pickEntryIndex(services, pm);
    const stackServices: StackServiceView[] = [];
    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      const { container, row } = containerOfService(rowByService, dirName, svc);
      stackServices.push({
        name: svc.key,
        container,
        state: row?.State ?? 'absent',
        running: row?.State === 'running',
        entry: i === entryIdx,
        listed: pm?.listed?.includes(svc.key) === true,
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
      displayName: pm?.displayName,
      description: pm?.description,
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
        displayName: pm?.memberNames?.[s.container],
        hasCompose: true,
        stackProject: dirName,
        stackServices,
      });
    }
  }

  // —— 剩余行（label 管理但目录不在的异常形态：旧版创建没来得及迁移 / 删除中途失败）——
  for (const row of rows) {
    if (coveredRows.has(row)) continue;
    const name = rowName(row.Names);
    items.push({
      name,
      preset: rowLabels(row)['mysandbox.service-preset'] ?? 'custom',
      image: row.Image,
      ip: await containerIpamIp(name),
      state: row.State,
      status: row.Status,
      running: row.State === 'running',
      volume: null,
      ports: [],
      envKeys: [],
      env: {},
      connect: [],
      createdAt: row.CreatedAt,
      hasCompose: false,
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

// 服务池视图：占用 = 网络 running 端点（10.88.0.x 全体，含非服务容器）∪ 底账文件里的
// 静态 IP ∪ 外部栈成员记账 IP ∪ reserved ∪ 进行中任务预占的 IP（jobs.ts）。与 network.ts
// 的容器池互不相交（服务在 .200+，容器在 10.88.10.x）。
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
  // 底账文件里的静态 IP 也是占用（停机/未创建的目录服务不进 network 端点）；外部栈
  // 成员的 IP 是我们 connect --ip 给的（原文件里没有），记账在 stub 的 meta.json——
  // docker 侧 IPAMConfig 虽随容器保留，但容器被 compose down 后连 inspect 都没了。
  for (const dirName of await listProjectDirs()) {
    const pm = await readProjectMeta(dirName);
    if (pm?.external) {
      for (const s of pm.members ?? []) if (s.ip) used.add(s.ip);
      continue;
    }
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

// 分配静态 IP。多源并集判定占用（网络端点只含 running——停机服务的静态 IP 在底账文件里，
// 外部栈成员在 stub meta.json，否则会被二次分配，start 时 docker 报 Address already in use）。
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
// 创建走 plan，收编走 shape 复刻——两条路最终都落成同一份 compose 文件形状。

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

  // 策展字段落每项目 meta.json（description 是创建表单给的；env/image 等配置真相在文件）
  await writeProjectMeta(name, { description: plan.description, createdAt: new Date().toISOString() });

  // 服务起来了 → 追平所有运行中 LXC 容器的 hosts（hash-skip，无变化近零成本）。
  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`服务 ${name} 就绪（${ip}）`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? viewFallback(name, plan.image, ip, true);
}

// listServices 没找到（极端竞态）时的兜底视图：用已知形状拼一个，不让任务死在收尾。
function viewFallback(name: string, image: string, ip: string | null, running: boolean): ServiceView {
  return {
    name,
    preset: 'custom',
    image,
    ip,
    state: running ? 'running' : 'exited',
    status: 'updated',
    running,
    volume: null,
    ports: [],
    envKeys: [],
    env: {},
    connect: [],
    hasCompose: true,
  };
}

// —— 应用（配置页保存）：文件已由路由层校验并写盘，这里只做收敛 ——
// up -d 幂等：配置没变 = 无事发生；变了 = 只重建受影响的容器。带 build 时顺带重建
// 本地镜像（自研服务迭代循环 = 改代码 → 构建并应用）。
export async function runServiceApply(cfg: Config, name: string, build: boolean, ctx: JobCtx): Promise<ServiceView> {
  ctx.setCancellable(true);
  ctx.status(build ? '构建并应用（compose up -d --build）' : '应用配置（compose up -d）');
  await composeUp(name, { build, onLine: (l) => ctx.log(l), signal: ctx.signal, hardTimeoutMs: cfg.services.pullTimeoutMs });
  ctx.setCancellable(false);

  // 应用注释：IP 记账无需回写——池占用直接读底账文件的静态 IP（ipv4_address 在文件里）。

  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`配置已应用：${name}`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? throwNotFound(name);
}

// 极端竞态兜底（列表瞬间也查不到）：让任务以 404 形状失败而不是编译期撒谎。
function throwNotFound(name: string): never {
  throw notFound(`service "${name}" not found`);
}

// —— 接管式收编（后台 job）：写底账 → rm 裸容器 → compose up ——
// rm 后失败不回滚（再点一次收敛）；收编完成后容器带全量 label + 底账在目录——与自建
// 服务无差别管理（删除/改配置全解锁），无需任何收编凭证。
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

  await writeProjectMeta(name, { description: '接管式收编（启动方式复刻自原容器）', createdAt: new Date().toISOString() });

  ctx.status('追平容器 hosts（服务名解析）');
  await applyServicesBlock(cfg);

  ctx.status(`已接管进 compose 底账：${name}`);
  return (await listServices(cfg)).items.find((x) => x.name === name) ?? viewFallback(name, def.image, def.networkMode ? null : def.ip, true);
}

// 路由层已确保 name 在 label 过滤集里（requireService）。
export async function deleteService(
  cfg: Config,
  name: string,
  opts: { deleteData?: boolean; confirmName?: string } = {},
): Promise<{ ok: true; dataRemoved: boolean; name: string }> {
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
    // 卷清单以底账为准（项目文件可能是多服务多卷）；解析失败 = 卷清单未知，不硬猜
    //（不能造卷名兜底，否则对无卷服务删除会报 no such volume——实测踩到）。
    const project = await readComposeProject(name);
    const volumes = project
      ? [...new Set(project.services.flatMap((s) => s.volumes))].filter((v) => !v.startsWith('/'))
      : [];
    for (const volume of volumes) {
      await removeVolume(volume); // 卷被别的容器占用等失败原样抛，不假装成功
      dataRemoved = true;
    }
  }
  // 底账随服务走：目录（含 meta.json）一并移除——服务没了文件留着只会变成误导性孤儿。
  await removeComposeDir(name).catch((e) => log.warn({ err: String(e), name }, 'compose dir cleanup failed'));
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
  yaml: string | null; // null = 无文件（有容器没底账的异常形态，前端只给提示）
  hasBuild: boolean; // 文件带 build: ——前端给「构建并应用」
  hash: string | null; // 当前文件的 compose hash（config --hash，按首个/入口服务）
  appliedHash: string | null; // 容器 label 里最后一次 up 的 hash
  drift: boolean; // hash 与 appliedHash 不一致 = 改了没应用
  readonly?: boolean; // adopted 栈：文件在原处（别人的底账），只读展示不提供编辑/应用
}

export async function getServiceConfig(cfg: Config, name: string): Promise<ServiceConfigView> {
  const t = await resolveTarget(name);
  // 外部栈：底账在原编排方——只读展示原文件，不提供编辑/应用（双真相是红线）
  if (t.external) {
    const yaml = t.external.file ? await readFile(t.external.file, 'utf8').catch(() => null) : null;
    return {
      name,
      path: t.external.file ?? '',
      yaml,
      hasBuild: false,
      hash: null,
      appliedHash: null,
      drift: false,
      readonly: true,
    };
  }
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
// 收编 = 纳入面板的管理边界。两种形态：裸容器 → 接管式（复刻形状进底账并重建，从此
// 与自建服务无差别）；compose 栈 → 只读收编（stub 目录登记 + 接入服务网络，本体与
// 原文件不动，管理不拥有）。只读收编单容器已退役——docker 不能后补 label，无底账的
// 单容器收编后与外部容器无法区分，唯一凭证曾是 state meta；而「不能重建」其实不成立
// （docker commit 可把可写层固化成镜像再接管），不值得为一个边缘形态养一套双源判定。
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

// 收编候选：宿主上非 mysandbox 管理的容器，排除目录注册表项目（已是服务/已收编的
// 外部栈——目录在即排除，stub 目录就是收编凭证）。裸容器逐个一行；compose 容器按
// project 聚合成栈一行。running 优先（Exited 试验残留是头号噪声）。
export async function listAdoptables(cfg: Config): Promise<{ items: AdoptableRow[]; stacks: AdoptableStack[] }> {
  const dirSet = new Set(await listProjectDirs());
  const rows = (await listExternalContainers()).filter(
    (r) =>
      !(dirSet.has(rowLabels(r)['com.docker.compose.project'] ?? '') || dirSet.has(rowName(r.Names))),
  );
  const net = await inspectNetwork(cfg.services.network);
  const onNet = new Map(net?.endpoints.map((e) => [e.name, e.ip]));
  const items: AdoptableRow[] = [];
  const stackMap = new Map<string, AdoptableStack>();
  for (const row of rows) {
    const name = rowName(row.Names);
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
// 两种形态：裸容器（无 compose label）= **接管式收编**——inspect 复刻启动方式生成
// compose 底账 → rm 裸容器 → compose up，文件进 compose 目录从此可查可改（重建中断
// 一次、可写层数据丢失的风险由前端确认；真不能丢可写层的先 docker commit 固化成镜像
// 再收编）；compose 栈容器（带 compose project label）= 只读收编——底账在原编排方，
// 复制过来就是双真相。只读收编单容器已退役（裸容器 takeover 缺失直接 400）。
export async function adoptService(cfg: Config, name: string, opts: { takeover?: boolean } = {}): Promise<ServiceView> {
  await ensureServiceNetwork(cfg);
  // 已受管（label 命中）不是收编对象；已收编的外部栈目录命中同样不是。与进行中任务
  // 撞名也要挡——任务预占的容器还没建出来，ps 查不到。试占名兜底，finally 释放。
  const managed = await listServiceContainers();
  if (managed.some((r) => rowName(r.Names) === name)) throw conflict(`"${name}" 已是受管服务`);
  if (await isExternalProject(name)) throw conflict(`"${name}" 已收编（外部栈）`);
  if (!tryReserveJobName(name)) throw conflict(`同名任务「${name}」进行中`);
  // 任务名预占的释放纪律：takeover/adoptStack 的 job 释放交给 jobs.ts run() 的 finally
  //（job 是异步的，这里 finally 释放会架空互斥）；栈收编是同步动作，尾部自己释放。
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
        hasCompose: true,
        description: '接管式收编（启动方式已复刻进 compose 底账）',
        createdAt: new Date().toISOString(),
        jobId: job.id,
      } as ServiceView & { jobId: string };
    }

    // —— 只读收编单容器已退役：裸容器只能接管（无 label 收编后无法与外部区分，
    // 凭证问题无解；数据不能丢的先 docker commit 固化可写层再收编）——
    throw badRequest(`"${name}" 是裸容器——收编即接管（重建容器、复刻启动方式进底账）。前端请带 takeover: true`);
  } finally {
    if (releaseHere) releaseJobName(name);
  }
}

// 栈级只读收编：项目全体成员接入服务网络（已在网复用现 IP）+ stub 目录（compose/<名>/
// meta.json：external 标记 + 成员记账——容器名/IP/入口；原文件路径从 compose label 拿，
// docker 早就记好了）。不碰容器本体、不碰原文件——管理不拥有。
async function adoptStack(cfg: Config, project: string, members: DockerContainerRow[]): Promise<ServiceView> {
  await ensureServiceNetwork(cfg);
  const net = await inspectNetwork(cfg.services.network);
  const first = members[0];
  const file = rowLabels(first)['com.docker.compose.project.config_files'] ?? null;
  const workdir = rowLabels(first)['com.docker.compose.project.working_dir'] ?? null;
  const refs: ProjectMemberRef[] = [];
  for (const r of members) {
    const cname = rowName(r.Names);
    const svcKey = rowLabels(r)['com.docker.compose.service'] ?? cname;
    let ip = net?.endpoints.find((e) => e.name === cname)?.ip;
    if (!ip) {
      ip = await allocateServiceIp(cfg);
      await connectServiceNetwork(cname, cfg.services.network, ip);
    }
    refs.push({ name: svcKey, container: cname, ip });
  }
  // 入口锚定：有发布端口的容器优先（对外入口）；没有就第一个
  for (const ref of refs) {
    if ((await containerPublishedPorts(ref.container)).length > 0) {
      ref.entry = true;
      break;
    }
  }
  if (!refs.some((r) => r.entry)) refs[0].entry = true;

  const description = `compose 栈收编（${refs.length} 个服务，原底账不动）`;
  await writeProjectMeta(project, {
    external: { file, workdir },
    preset: 'adopted',
    image: first.Image,
    description,
    createdAt: new Date().toISOString(),
    members: refs,
  });
  try {
    await applyServicesBlock(cfg);
  } catch (e) {
    log.warn({ err: String(e), name: project }, 'hosts re-apply after stack adopt failed');
  }
  log.info({ project, members: refs.length }, 'compose stack adopted');
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
    hasCompose: false,
    externalStack: true,
    stackFile: file,
    description,
    createdAt: new Date().toISOString(),
  };
}

// 取消收编：摘网络（还原）+ 删 stub 目录 + 追平 hosts。容器本体不动。栈 = 全体成员
// 一起摘（name 传项目名或任一成员容器名都行）。
export async function unadoptService(cfg: Config, name: string): Promise<void> {
  const direct = await readProjectMeta(name);
  let key: string;
  let pm: ProjectMeta;
  if (direct?.external) {
    key = name;
    pm = direct;
  } else {
    const hit = await externalProjectOfContainer(name);
    if (!hit) throw conflict(`"${name}" 不是收编的外部栈——删除请走 DELETE /api/services/${name}`);
    key = hit.key;
    pm = hit.meta;
  }
  for (const s of pm.members ?? []) {
    try {
      await disconnectServiceNetwork(s.container, cfg.services.network);
    } catch (e) {
      // 摘不掉不拦取消收编（容器可能已被外部删掉；hosts 反正要追平）
      log.warn({ err: String(e), name: s.container }, 'unadopt: network disconnect failed (ignored)');
    }
  }
  // stub 目录整个删掉（里面只有 meta.json，没有底账文件）
  await removeComposeDir(key).catch((e) => log.warn({ err: String(e), name: key }, 'stub dir cleanup failed'));
  try {
    await applyServicesBlock(cfg);
  } catch (e) {
    log.warn({ err: String(e) }, 'hosts re-apply after unadopt failed');
  }
  log.info({ name: key }, 'docker service unadopted');
}

// —— 路由 ——

// :name 的统一前置：名字合法 + 单源受管判定（findServiceTarget，serviceMeta.ts）——
// 目录项目 ∪ 外部栈 stub（项目名/成员容器名）∪ 受管行（label 集 ∪ compose project
// label ∈ 目录集）。未收编的外部容器结构性 404。
// ⚠️ 「ps 列表里没有」≠「真没了」：ps 失败被吞成空列表（listServiceContainers 的既定
// 降级），目录命中不受影响，行命中宁可 404；孤儿 stub 的清理走事件路径延迟确认
//（scheduleAdoptedOrphanCheck），这里不删任何东西——栈时代没有 rm→create 的可保护窗口。
async function requireService(name: string): Promise<void> {
  if (!NAME_RE.test(name) && !ADOPT_NAME_RE.test(name)) {
    throw badRequest('invalid service name');
  }
  if (!(await findServiceTarget(name))) throw notFound(`service "${name}" not found`);
}

// 服务名 → 实际容器名：目录注册表服务 compose 项目名 ≠ container_name 时（agent 自放
// 文件用 compose 默认命名 <project>-<service>-1），docker 直操作要对准容器真名。
// 我们生成的文件 container_name 恒 = 服务名，此 helper 是零成本的直读。
async function resolveContainerName(name: string): Promise<string> {
  const parsed = await readComposeService(name);
  return parsed?.containerName ?? name;
}

// 操作目标解析：API 的 :name 可能是 项目名（目录项目 / 外部栈 stub）或 栈成员容器名
// （「加入列表」的升格卡片）。返回 docker 操作锚点 + 项目上下文（外部栈 compose 驱动）。
interface ServiceTarget {
  container: string; // docker 操作锚点
  project: string | null; // 所属项目（= name 或反查得到）
  // 外部栈上下文：非 null = 启停 compose 驱动（原文件）、配置只读、删除 409
  external: { file: string | null; workdir?: string | null; members: ProjectMemberRef[] } | null;
  // 项目成员（logs ?service 定位；外部栈 = meta.json 记账，目录项目 = compose 文件解析）
  members: { name: string; container: string }[];
  // 目录项目 >1 服务：启停走 compose 驱动整个项目（而非只动入口容器）
  multiService: boolean;
}

async function resolveTarget(name: string): Promise<ServiceTarget> {
  // 1) 目录项目（compose.yaml 或外部栈 stub）
  if ((await composeFileExists(name)) || (await readProjectMeta(name))?.external) {
    const pm = await readProjectMeta(name);
    if (pm?.external) {
      const members = pm.members ?? [];
      const entry = pickExternalEntry(members);
      return {
        container: entry.container,
        project: name,
        external: { file: pm.external.file, workdir: pm.external.workdir, members },
        members: members.map((m) => ({ name: m.name, container: m.container })),
        multiService: false,
      };
    }
    const proj = await readComposeProject(name);
    const rows = await listComposeProjectContainers([name]);
    const byKey = new Map(rows.map((r) => [rowLabels(r)['com.docker.compose.service'] ?? rowName(r.Names), r]));
    const pick = proj ? proj.services[pickEntryIndex(proj.services, pm ?? undefined)] : undefined;
    const row = pick ? byKey.get(pick.key) : undefined;
    const container = row ? rowName(row.Names) : (pick?.containerName ?? name);
    return {
      container,
      project: name,
      external: null,
      members: (proj?.services ?? []).map((svc) => {
        const r = byKey.get(svc.key);
        return { name: svc.key, container: r ? rowName(r.Names) : (svc.containerName ?? `${name}-${svc.key}-1`) };
      }),
      multiService: (proj?.services.length ?? 1) > 1,
    };
  }
  // 2) 外部栈成员容器名（升格卡片）
  const owner = await externalProjectOfContainer(name);
  if (owner) {
    const ex = owner.meta.external;
    const members = owner.meta.members ?? [];
    return {
      container: name,
      project: owner.key,
      external: { file: ex?.file ?? null, workdir: ex?.workdir, members },
      members: members.map((m) => ({ name: m.name, container: m.container })),
      multiService: false,
    };
  }
  // 3) 单服务目录 / label 行（resolveContainerName 直读 container_name，零成本）
  return { container: await resolveContainerName(name), project: null, external: null, members: [], multiService: false };
}

export function registerServices(app: FastifyInstance, cfg: Config): void {
  // 侧栏（闲 15s/任务 3s 收紧已退役改事件驱动）与抽屉两个 poller 都打这里，每次都是
  // 全量 docker ps -a 扫描——withPollCache 把多消费方收敛为一次真实执行（cwd/listen
  // 同款模式）。TTL 2.5s：抽屉 3s 节奏下最多省一拍，事件驱动侧不受影响。
  // 只在路由层缓存；内部其他 listServices 调用点（任务收尾、查重）要新鲜数据，不包。
  app.get('/api/services', async () => withPollCache('svc:list', 2_500, () => listServices(cfg)));

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
    // compose 栈容器走栈级只读收编（stub 登记，服务内部按 label 挡，409 给人话）。
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

  // —— 元数据（显示名）—— 写 compose/<名>/meta.json（策展数据与底账同目录）：项目名
  // 直接写 displayName；升格成员卡片（名字 = 容器名）反查所属项目写 memberNames；
  // 清空显示名传空串即删键。
  app.patch<{ Params: { name: string } }>('/api/services/:name/meta', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const body = (req.body as { displayName?: unknown } | null) || {};
    if (body.displayName !== undefined && typeof body.displayName !== 'string') throw badRequest('displayName must be a string');
    const dn = typeof body.displayName === 'string' ? body.displayName.trim() || undefined : undefined;
    if ((await composeFileExists(name)) || (await readProjectMeta(name))?.external) {
      await writeProjectMeta(name, { displayName: dn });
      return { ok: true };
    }
    const setMember = async (project: string): Promise<void> => {
      const pm = await readProjectMeta(project);
      const memberNames = { ...(pm?.memberNames ?? {}) };
      if (dn) memberNames[name] = dn;
      else delete memberNames[name];
      await writeProjectMeta(project, { memberNames });
    };
    const stub = await externalProjectOfContainer(name);
    if (stub) {
      await setMember(stub.key);
      return { ok: true };
    }
    // 目录项目的升格成员卡：ps 行的 project label 反查所属项目
    const rows = await listComposeProjectContainers(await listProjectDirs());
    const row = rows.find((r) => rowName(r.Names) === name);
    const proj = row ? rowLabels(row)['com.docker.compose.project'] : null;
    if (proj && (await composeFileExists(proj))) {
      await setMember(proj);
      return { ok: true };
    }
    throw notFound(`service "${name}" meta missing`);
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/start', async (req) => {
    await requireService(req.params.name);
    const t = await resolveTarget(req.params.name);
    if (t.external || t.multiService) await composeStackStart(stackFileOf(t), t.project ? composeDir(t.project) : null);
    else await startContainer(t.container);
    await applyServicesBlock(cfg);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/stop', async (req) => {
    await requireService(req.params.name);
    const t = await resolveTarget(req.params.name);
    if (t.external || t.multiService) await composeStackStop(stackFileOf(t), t.project ? composeDir(t.project) : null);
    else await stopContainer(t.container);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/restart', async (req) => {
    await requireService(req.params.name);
    const t = await resolveTarget(req.params.name);
    if (t.external || t.multiService) await composeStackRestart(stackFileOf(t), t.project ? composeDir(t.project) : null);
    else await restartContainer(t.container);
    await applyServicesBlock(cfg);
    return { ok: true };
  });

  // 栈的 compose 驱动启停：外部栈用原文件；目录项目就是我们目录里的文件。
  function stackFileOf(t: ServiceTarget): string {
    if (t.external?.file) return t.external.file;
    if (t.project) return composeFileOf(t.project);
    throw conflict('该服务没有 compose 文件可供驱动');
  }

  // —— 「加入列表」/「设为入口」（多容器项目的展示策展）——
  // listed = 升格为独立卡片；entry = 卡片锚点换人。写 compose/<名>/meta.json：目录项目
  // 记 service key（entry: string / listed: string[]），外部栈 stub 记成员 ref。
  app.post<{ Params: { name: string } }>('/api/services/:name/stack', async (req) => {
    let name = req.params.name;
    await requireService(name);
    const body = (req.body as { service?: unknown; listed?: unknown; entry?: unknown } | null) || {};
    const svc = String(body.service ?? '');
    if (!svc) throw badRequest('缺少 service');
    const pm = await readProjectMeta(name);
    if (pm?.external) {
      const members = pm.members ?? [];
      const ref = members.find((m) => m.container === svc) ?? members.find((m) => m.name === svc);
      if (!ref) throw notFound(`栈 "${name}" 里没有服务 "${svc}"`);
      if (body.entry === true) for (const m of members) m.entry = m === ref;
      if (typeof body.listed === 'boolean') ref.listed = body.listed;
      await writeProjectMeta(name, { members });
      return { ok: true };
    }
    if (!(await composeFileExists(name))) {
      // 升格成员卡传的是容器名 → ps 行的 project label 反查所属目录项目
      const rows = await listComposeProjectContainers(await listProjectDirs());
      const row = rows.find((r) => rowName(r.Names) === name);
      const proj = row ? rowLabels(row)['com.docker.compose.project'] : null;
      if (!proj || !(await composeFileExists(proj))) throw notFound(`service "${name}" not found`);
      name = proj;
    }
    const project = await readComposeProject(name);
    if (!project?.services.some((x) => x.key === svc)) throw notFound(`项目 "${name}" 里没有服务 "${svc}"`);
    const prev = await readProjectMeta(name);
    const patch: Partial<ProjectMeta> = {};
    if (body.entry === true) patch.entry = svc;
    if (typeof body.listed === 'boolean') {
      const listed = new Set(prev?.listed ?? []);
      if (body.listed) listed.add(svc);
      else listed.delete(svc);
      patch.listed = [...listed];
    }
    await writeProjectMeta(name, patch);
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/api/services/:name', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const t = await resolveTarget(name);
    if (t.external) {
      throw conflict(`"${t.project}" 是收编的外部栈，不能删除——请用「取消收编」（POST /api/services/${name}/unadopt）`);
    }
    if (t.project && t.project !== name) {
      throw conflict(`"${name}" 是项目 "${t.project}" 的成员——删除请针对项目 "${t.project}"`);
    }
    const proj = t.project ? await readComposeProject(t.project) : null;
    if (proj && proj.services.length > 1) {
      throw conflict(`"${t.project}" 是多容器项目——删除请直接删 compose 目录（或先删文件再等列表刷新）`);
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
    // 项目成员可指定 service 看单容器日志；缺省 = 入口/目标容器
    const t = await resolveTarget(req.params.name);
    let container = t.container;
    if (q.service) {
      const ref = t.members.find((m) => m.name === q.service);
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
    // 外部栈成员的探测 IP 必须在 mysandbox-lan 上（可能与 compose 网并存，见 listServices）。
    const ip = t.external
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
    const t = await resolveTarget(name);
    if (t.external) throw conflict('外部栈的底账在原编排方，不能在这里应用（只读收编）');
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
}

// —— 服务事件 → hosts 追平 ——
// 服务容器 start/die/destroy（含 mysandbox 之外的手工 docker stop/restart）都会改变
// hosts 里的服务行。订阅不带 label 过滤（目录注册表容器也要进来）：受管事件直接扫描，
// 非受管事件按目录命中一挡——外部容器 churning 只是一次 readdir，不触发扫描。
// 2s trailing debounce 合并 crash-loop 的 die→start 风暴；断流（docker daemon 重启会杀掉
// events 子进程）指数退避重连 + 重连后全量补刷一次。骨架照抄 hosts-sync 的 startHostsEventSync。
export function startServicesEventSync(cfg: Config): void {
  if (!cfg.services.enabled) return;
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeServiceEvents((ev) => {
          relayServiceState(ev.name, ev.action); // 原样转给前端事件总线（侧栏即时跟刷）
          if (!ev.managed) {
            void (async () => {
              // 目录注册表项目（agent 自放文件 / 外部栈 stub）：compose project label 命中
              // 目录即受管；stub 成员拿不到 label 时按名字反查 stub 记账兜底。
              const stub = (ev.composeProject ? await readProjectMeta(ev.composeProject) : null)?.external
                ? { key: ev.composeProject as string }
                : await externalProjectOfContainer(ev.name);
              if (!stub && !(ev.composeProject && (await isManagedComposeProject(ev.composeProject)))) return;
              scheduleSweep(cfg);
              // 外部栈成员：start 自愈重连服务网络 / destroy 延迟清账（目录注册表项目无记账，无需）
              if (stub) {
                if (ev.action === 'start') void healAdopted(cfg, ev.name);
                if (ev.action === 'destroy') scheduleAdoptedOrphanCheck(cfg, ev.name);
              }
            })().catch(() => {});
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

// 外部栈成员被外部重建（原编排方 compose down/up：同名新容器、不带我们的网络接入）→
// start 事件自动重连，self-heal。成员 IP 记账在 stub 的 meta.json members 里；旧 IP 被
// 占（重建窗口期 docker IPAM 不认我们的记账）就重新分配并回写。
async function healAdopted(cfg: Config, name: string): Promise<void> {
  try {
    const hit = await externalProjectOfContainer(name);
    if (!hit) return;
    await ensureServiceNetwork(cfg);
    const net = await inspectNetwork(cfg.services.network);
    if (net?.endpoints.some((e) => e.name === name)) return; // 已在网，无需要
    const members = hit.meta.members ?? [];
    const ref = members.find((m) => m.container === name);
    let ip = ref?.ip;
    try {
      await connectServiceNetwork(name, cfg.services.network, ip);
    } catch {
      ip = await allocateServiceIp(cfg); // 旧 IP 在记账里算占用，allocate 天然避开
      await connectServiceNetwork(name, cfg.services.network, ip);
    }
    if (ref && ip && ip !== ref.ip) {
      ref.ip = ip;
      await writeProjectMeta(hit.key, { members });
    }
    log.info({ name, ip }, 'external stack member re-connected to service network');
    scheduleSweep(cfg);
  } catch (e) {
    log.warn({ err: String(e), name }, 'adopted container heal failed');
  }
}

// 外部栈成员被外部 destroy：stub 先留着——compose force-recreate 是 destroy→create→start，
// 立刻删会弄丢自愈。延迟确认全体成员真没了（没有同名重建）才删 stub 目录 + 追平。
const orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleAdoptedOrphanCheck(cfg: Config, name: string): void {
  const prev = orphanTimers.get(name);
  if (prev) clearTimeout(prev);
  orphanTimers.set(
    name,
    setTimeout(() => {
      orphanTimers.delete(name);
      void (async () => {
        const hit = await externalProjectOfContainer(name);
        if (!hit) return;
        const members = (hit.meta.members ?? []).map((m) => m.container);
        // 同名重建的成员带原 compose project label（= 项目名），按 project 命中扫描——
        // 它们没有我们的 label，listServiceContainers 看不见
        const rows = await listComposeProjectContainers([hit.key]);
        if (rows.some((r) => members.includes(rowName(r.Names)))) return; // 有成员活着/重建了
        await removeComposeDir(hit.key);
        log.info({ name: hit.key }, 'external stack gone — stub dir cleaned');
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
