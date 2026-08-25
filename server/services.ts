// docker 服务层：配套服务（数据库等）的预设、编排与路由。
//
// 形态（v1，刻意收窄）：一服务 = 单容器 + 固定 IP（dev-lan 上 --ip）+ 命名卷
// mysandbox-svc-<name>；不发布端口到宿主——与 LXC 容器同语义（固定 IP 直连、无 NAT），
// LXC 容器里 `psql -h <服务名>` 的通路靠 hosts 注入（hosts-sync 组合 listServiceEndpoints）。
// 管理边界结构性隔离：一切操作带 SERVICE_FILTER（label mysandbox.kind=service），
// 宿主上其它 docker 容器（dener-* 等）没有该 label，永远不进列表、操作只会 404。
//
// docker 原语在 docker.ts（CLI 客户端）；这里只有业务编排。对标 base.ts 的「路由薄 + 实现厚」。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { badRequest, conflict, notFound } from './errors.js';
import { beginSse, type ProgressEvent } from './sse.js';
import { applyHostsToContainers } from './hosts-sync.js';
import { log } from './logger.js';
import {
  MANAGED_LABEL,
  KIND_LABEL,
  serviceVolumeName,
  dockerStatus,
  inspectNetwork,
  listServiceContainers,
  serviceNameExists,
  createServiceContainer,
  containerIpamIp,
  startContainer,
  stopContainer,
  restartContainer,
  removeContainer,
  containerLogs,
  imageExistsLocal,
  pullImageStream,
  ensureVolume,
  removeVolume,
  subscribeServiceEvents,
} from './docker.js';
import {
  getAllServiceMeta,
  getServiceMeta,
  setServiceMeta,
  deleteServiceMeta,
  type ServiceMeta,
} from './state.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

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
    description: 'PostgreSQL 17，默认库/用户 app',
    volumePath: '/var/lib/postgresql/data',
    ports: [5432],
    fixedEnv: { POSTGRES_DB: 'app', POSTGRES_USER: 'app' },
    userEnv: [
      { key: 'POSTGRES_PASSWORD', label: '密码（POSTGRES_PASSWORD）', required: true, secret: true },
    ],
    hint: '容器内：psql -h <服务名> -U app -d app',
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

// —— 视图 ——
// envKeys 只回 key：env 值含密码，绝不出 API（state.json 0600 落盘是另一回事）。
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
  description?: string;
  createdAt?: string;
  command?: string[];
  metaMissing?: boolean; // label 在但 sidecar 缺（state.json 被清过）——前端提示重建元数据
}

export interface ServicesStatus {
  enabled: boolean;
  reachable: boolean;
  version?: string;
  error?: string;
  network: {
    name: string;
    bridgeOk: boolean;
    subnet: string | null;
    detail?: string; // bridgeOk=false 时的人话说明
  };
  pool: { from: string; to: string; reserved: string[]; assigned: string[]; free: string[] };
}

export interface CreateServiceInput {
  name: string;
  preset: string; // 'postgres' | 'redis' | 'mysql' | 'custom'
  image?: string; // custom 必填
  env?: Record<string, string>; // 预设的 userEnv 值 / custom 的全量 env
  command?: string; // custom 可选，空格分词（无 shell）
  ip?: string; // 手动指定；缺省自动分配
  description?: string;
}

// —— 编排 ——

function rowName(names: string): string {
  return names.split(',')[0].replace(/^\//, '');
}

export async function listServices(cfg: Config): Promise<{ items: ServiceView[]; status: ServicesStatus }> {
  const status = await servicesStatus(cfg);
  if (!status.reachable) return { items: [], status };
  const rows = await listServiceContainers();
  const meta = await getAllServiceMeta();
  const items: ServiceView[] = [];
  for (const row of rows) {
    const name = rowName(row.Names);
    const m = meta[name];
    const ip = (await containerIpamIp(name)) ?? m?.ip ?? null;
    items.push({
      name,
      preset: m?.preset ?? row.Labels['mysandbox.service-preset'] ?? 'custom',
      image: m?.image ?? row.Image,
      ip,
      state: row.State,
      status: row.Status,
      running: row.State === 'running',
      volume: m?.volume ?? null,
      ports: m?.ports ?? [],
      envKeys: m ? Object.keys(m.env) : [],
      description: m?.description,
      createdAt: m?.createdAt ?? row.CreatedAt,
      command: m?.command,
      metaMissing: !m,
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { items, status };
}

export async function servicesStatus(cfg: Config): Promise<ServicesStatus> {
  const docker = await dockerStatus();
  const poolView = await servicePoolView(cfg);
  const status: ServicesStatus = {
    enabled: cfg.services.enabled,
    reachable: docker.reachable,
    version: docker.version,
    error: docker.error,
    network: { name: cfg.services.network, bridgeOk: false, subnet: null },
    pool: poolView,
  };
  if (!docker.reachable) return status;
  const net = await inspectNetwork(cfg.services.network);
  if (!net) {
    status.network.detail = `docker 网络 "${cfg.services.network}" 不存在——在 docker 里创建它（或改 services.network 配置）`;
    return status;
  }
  status.network.subnet = net.subnet;
  status.network.bridgeOk = net.bridge === cfg.network;
  if (!status.network.bridgeOk) {
    status.network.detail =
      `网络 "${net.name}" 对应桥 ${net.bridge}，与 config.network（${cfg.network}）不一致——` +
      'dev-lan 被重建过？需同步更新 config.network 与 mysandbox-bridge-subnet.service';
  }
  return status;
}

// 服务池视图：占用 = 网络 running 端点（10.88.0.x 全体，含非服务容器）∪ state.services
// 登记 IP ∪ reserved。与 network.ts 的容器池互不相交（服务在 .200+，容器在 10.88.10.x）。
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
  for (const m of Object.values(await getAllServiceMeta())) used.add(m.ip);
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

export async function createService(
  cfg: Config,
  input: CreateServiceInput,
  onProgress: (e: ProgressEvent) => void,
): Promise<ServiceView> {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw badRequest('服务名 2–31 位，小写字母/数字/连字符，字母或数字开头');
  }
  if (!cfg.services.enabled) throw badRequest('services 层未启用（config services.enabled）');

  const preset = input.preset === 'custom' ? null : findPreset(input.preset);
  if (!preset && input.preset !== 'custom') throw badRequest(`未知预设 "${input.preset}"`);

  const image = (preset?.image ?? input.image ?? '').trim();
  if (!image) throw badRequest('custom 服务必须提供镜像名');

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
  const volume = preset?.volumePath ? { source: serviceVolumeName(name), target: preset.volumePath } : null;

  if (await imageExistsLocal(image)) {
    onProgress({ status: `镜像 ${image} 已在本地，跳过拉取` });
  } else {
    onProgress({ status: `拉取镜像 ${image}` });
    await pullImageStream(image, (line) => onProgress({ stream: line }));
  }

  onProgress({ status: volume ? `创建数据卷 ${volume.source}` : '创建容器' });
  if (volume) await ensureVolume(volume.source);

  await createServiceContainer({
    name,
    image,
    ip,
    network: cfg.services.network,
    labels: {
      [MANAGED_LABEL]: 'mysandbox',
      [KIND_LABEL]: 'service',
      'mysandbox.service-preset': preset?.key ?? 'custom',
      'mysandbox.created-at': new Date().toISOString(),
    },
    env,
    volume,
    command,
  });

  onProgress({ status: `启动 ${name}（${ip}）` });
  try {
    await startContainer(name);
  } catch (e) {
    // 半成品清理：刚创建、无用户数据，连容器带卷一起删；清理失败只 log（原始错误优先）。
    try {
      await removeContainer(name);
      if (volume) await removeVolume(volume.source);
    } catch (e2) {
      log.warn({ err: String(e2), name }, 'service create cleanup failed');
    }
    throw e;
  }

  const meta: ServiceMeta = {
    preset: preset?.key ?? 'custom',
    image,
    env,
    command,
    volume: volume?.source ?? null,
    ip,
    ports: preset?.ports ?? [],
    description: input.description,
    createdAt: new Date().toISOString(),
  };
  await setServiceMeta(name, meta);

  // 服务起来了 → 追平所有运行中 LXC 容器的 hosts（hash-skip，无变化近零成本）。
  onProgress({ status: '追平容器 hosts（服务名解析）' });
  await applyHostsToContainers(cfg, { skipUnchanged: true, reason: 'service' });

  onProgress({ status: `服务 ${name} 就绪（${ip}）` });
  return {
    name,
    preset: meta.preset,
    image,
    ip,
    state: 'running',
    status: 'just created',
    running: true,
    volume: meta.volume,
    ports: meta.ports ?? [],
    envKeys: Object.keys(env),
    description: meta.description,
    createdAt: meta.createdAt,
    command,
  };
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
  await removeContainer(name);
  let dataRemoved = false;
  if (opts.deleteData) {
    // meta 里 volume 为 null 表示该服务没有数据卷（custom 可无卷）——不能兜底硬造卷名，
    // 否则对无卷服务删除会报 no such volume（实测踩到）。
    const volume = m?.volume;
    if (volume) {
      await removeVolume(volume); // 卷被别的容器占用等失败原样抛，不假装成功
      dataRemoved = true;
    }
  }
  await deleteServiceMeta(name);
  // hosts 里的服务行要消失：追平一次（hash-skip）。
  try {
    await applyHostsToContainers(cfg, { skipUnchanged: true, reason: 'service' });
  } catch (e) {
    log.warn({ err: String(e) }, 'hosts re-apply after service delete failed');
  }
  log.info({ name, dataRemoved }, 'docker service deleted');
  return { ok: true, dataRemoved, name };
}

// —— 路由 ——

// :name 的统一前置：NAME_RE + label 过滤集里存在——dener-* 等外部容器结构性 404。
// 容器没了但 meta 还在（外部 docker rm / 上次删除中途失败）→ 顺手清孤儿 meta 再 404，
// 不然 state.json 里会积累指向不存在容器的条目。
async function requireService(name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw badRequest('invalid service name');
  const rows = await listServiceContainers();
  if (!rows.some((r) => rowName(r.Names) === name)) {
    if (await getServiceMeta(name)) {
      await deleteServiceMeta(name);
      log.info({ name }, 'service meta orphaned (container gone) — cleaned');
    }
    throw notFound(`service "${name}" not found`);
  }
}

export function registerServices(app: FastifyInstance, cfg: Config): void {
  app.get('/api/services', async () => listServices(cfg));

  app.get('/api/services/presets', async () => {
    // 前端建表单用：预设元数据，不含 fixedEnv 的值（无所谓，但保持「不回环境变量值」的一致性）。
    return { presets: SERVICE_PRESETS.map((p) => ({ ...p, fixedEnv: {} })) };
  });

  // SSE：pull 进度逐行推；错误走 error 帧（HTTP 200 已发出，契约见 sse.ts）。
  app.post('/api/services', async (req, reply) => {
    const input = (req.body as CreateServiceInput | null) || ({} as CreateServiceInput);
    const { sink, finalize } = beginSse(reply);
    await finalize(() => createService(cfg, input, (e) => sink(e)));
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/start', async (req) => {
    await requireService(req.params.name);
    await startContainer(req.params.name);
    await applyHostsToContainers(cfg, { skipUnchanged: true, reason: 'service' });
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/stop', async (req) => {
    await requireService(req.params.name);
    await stopContainer(req.params.name);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>('/api/services/:name/restart', async (req) => {
    await requireService(req.params.name);
    await restartContainer(req.params.name);
    await applyHostsToContainers(cfg, { skipUnchanged: true, reason: 'service' });
    return { ok: true };
  });

  app.delete<{ Params: { name: string } }>('/api/services/:name', async (req) => {
    const name = req.params.name;
    await requireService(name);
    const body = (req.body as { deleteData?: boolean; confirmName?: string } | null) || {};
    return deleteService(cfg, name, { deleteData: !!body.deleteData, confirmName: body.confirmName });
  });

  app.get<{ Params: { name: string } }>('/api/services/:name/logs', async (req) => {
    await requireService(req.params.name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const tail = Math.min(Math.max(Number(q.tail) || 200, 1), 2000);
    return { logs: await containerLogs(req.params.name, tail) };
  });
}

// —— 服务事件 → hosts 追平 ——
// 服务容器 start/die/destroy（含 mysandbox 之外的手工 docker stop/restart）都会改变
// hosts 里的服务行。2s trailing debounce 合并 crash-loop 的 die→start 风暴；断流
// （docker daemon 重启会杀掉 events 子进程）指数退避重连 + 重连后全量补刷一次。
// 骨架照抄 hosts-sync 的 startHostsEventSync。
export function startServicesEventSync(cfg: Config): void {
  if (!cfg.services.enabled) return;
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeServiceEvents(() => {
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

let sweepTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSweep(cfg: Config): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void applyHostsToContainers(cfg, { skipUnchanged: true, reason: 'service-event' }).catch((e) => {
      log.warn({ err: String(e) }, 'services event hosts re-apply failed');
    });
  }, 2_000);
}
