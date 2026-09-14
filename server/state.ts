// sidecar 状态：易变元数据（adopted/displayName/description/tags）。存在 XDG data 目录。
// label 不可变，所以这些走 JSON。容器名作 key。
// AI 板块（技能 + 模型接入）的状态不在这里——独居 ai/ 专用目录（server/aiState.ts），
// 本文件只在 load 时把存量旧键抽过去（takeLegacyAiKeys）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_FILE, STATE_DIR } from './config.js';
import { takeLegacyAiKeys } from './aiState.js';

export interface ContainerMeta {
  managed: boolean; // 纳入管理（adopted 或 mysandbox 创建后登记）
  adopted: boolean;
  displayName?: string;
  description?: string;
  tags?: string[];
  source?: string; // 'mysandbox' | 'dener' | 自定义
  ipHint?: string;
  createdAt?: string;
}

// docker 服务（数据库等）的 sidecar 元数据。与容器同款两层身份模型：
// docker label 是不可变身份（mysandbox.kind=service，随容器走），这里只存易变/展示数据
// 与停机时也必须保留的 IP 记录（network inspect 只列 running 端点，静态 IP 占用判定靠它）。
// ⚠️ env 含密码：state.json 本就 0600；列表 API 回全量 env（token = 宿主完整权限，
// 鉴权边界在 token 上收住，UI 需展示连接凭据）。
// compose 文件原生是多服务（1 文件 = 1 项目 = N 容器）：多容器栈收编时 meta 以
// 项目名为 key，stack.services 记全量成员（容器名/服务名/入口/是否加入列表）；
// 单容器服务没有 stack（key 即容器名），展示层规则「一张卡 = 入口」对两者一致。
export interface StackServiceRef {
  name: string; // compose service key（显示用）
  container: string; // 实际容器名（docker 操作锚点，唯一）
  ip?: string; // 服务网络上的静态 IP（停机占用记账）
  entry?: boolean; // 入口容器：栈卡片的锚（终端/文件/日志默认开在这里）
  listed?: boolean; // 用户「加入列表」的服务——升格为独立卡片
}

export interface ServiceMeta {
  preset: string; // 'postgres' | 'redis' | 'mysql' | 'custom' | 'adopted'（收编外部容器）
  image: string;
  env: Record<string, string>;
  command?: string[];
  volume: string | null; // 'mysandbox-svc-<name>' | null（custom/收编无卷）
  ip: string; // 创建/收编时分配的静态 IP（权威在 docker IPAMConfig，此处为停机占用记录）
  ports?: number[];
  displayName?: string; // 显示名（侧栏卡片/终端 tab），不动容器真名——与容器 meta.displayName 同语义
  description?: string;
  createdAt: string;
  // 收编的外部容器：无 label（docker 不能后补），纳管凭证就是这条 meta——所有按
  // label 过滤的判定点都要并上 adoptedServiceNames(meta)（双源，见 docker.ts 文件头）。
  adopted?: boolean;
  // 多容器栈（adopted 收编的原生 compose 栈 / 多服务目录项目）：
  // file = 项目 compose 文件（adopted 栈在原处；目录项目 = 我们目录里的文件）
  stack?: { file: string | null; workdir?: string | null; services: StackServiceRef[] };
}

// 收编容器名集：listServiceContainers 等双源过滤点的第二源。栈按成员容器名展开
// （ps 过滤按容器名匹配），项目 key 本身不是容器名——两个都要。
export function adoptedServiceNames(meta: Record<string, ServiceMeta>): string[] {
  return Object.entries(meta)
    .filter(([, m]) => m.adopted)
    .map(([n]) => n);
}

export function adoptedContainerNames(meta: Record<string, ServiceMeta>): string[] {
  const out: string[] = [];
  for (const [key, m] of Object.entries(meta)) {
    if (!m.adopted) continue;
    if (m.stack) for (const s of m.stack.services) out.push(s.container);
    else out.push(key);
  }
  return out;
}

// 反查：容器名 → 所在栈的 meta key（adopted 栈成员的事件自愈/操作路由用）。
export function stackMetaOfContainer(meta: Record<string, ServiceMeta>, container: string): { key: string; meta: ServiceMeta } | null {
  for (const [key, m] of Object.entries(meta)) {
    if (m.stack?.services.some((s) => s.container === container)) return { key, meta: m };
  }
  return null;
}

// 本机（宿主）作为一等目标的哨兵 id：终端区 TermGroup.kind='host' 的 containerId、
// AI 目标覆盖的 key、skills/AI 配置分发目标都用它。宿主 home 与容器契约 home 同形
// （D1 uid 直通），所以 skills/ai 的「目标 = {name, home}」模型对宿主原样成立。
export const HOST_TARGET = '__host__';

// SSH 终端目标（server/sshTerminal.ts）：远程主机的连接定义。只作为「终端延伸」存在
// （侧栏终端区的本机之外条目），不是被管理对象——无 sidecar 生命周期、不进批量操作/
// hosts/总览。存这里而非 config.yaml：UI 可增删（config.yaml 是用户手改文件，程序
// 回写会丢注释），且属易变元数据，与 displayName 同语义。
export interface SshTarget {
  name: string; // 标识 + 显示名（唯一）
  host: string; // ssh 目的地：host / user@host / ~/.ssh/config 别名均可（凭据全走宿主 ssh）
  user?: string;
  port?: number;
  createdAt?: string;
}

interface StateShape {
  containers: Record<string, ContainerMeta>;
  services: Record<string, ServiceMeta>;
  sshTargets?: SshTarget[];
}

let cache: StateShape | null = null;

async function load(): Promise<StateShape> {
  if (cache) return cache;
  if (!existsSync(STATE_FILE)) {
    cache = { containers: {}, services: {}, sshTargets: [] };
    return cache;
  }
  try {
    cache = JSON.parse(await readFile(STATE_FILE, 'utf8')) as StateShape;
    if (!cache.containers) cache.containers = {};
    if (!cache.services) cache.services = {};
    if (!cache.sshTargets) cache.sshTargets = [];
  } catch {
    cache = { containers: {}, services: {}, sshTargets: [] };
  }
  // AI 板块状态已迁往 ai/（server/aiState.ts）：存量键从这里抽走并立即持久化，
  // 之后的任何 persist 都不会再把它们带回来。
  if (await takeLegacyAiKeys(cache as unknown as Record<string, unknown>)) await persist(cache);
  return cache;
}

async function persist(s: StateShape): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  cache = s;
}

export async function getMeta(name: string): Promise<ContainerMeta | undefined> {
  return (await load()).containers[name];
}

export async function getAllMeta(): Promise<Record<string, ContainerMeta>> {
  return (await load()).containers;
}

export async function setMeta(name: string, patch: Partial<ContainerMeta>): Promise<ContainerMeta> {
  const s = await load();
  const prev = s.containers[name] || { managed: false, adopted: false };
  const next: ContainerMeta = { ...prev, ...patch };
  s.containers[name] = next;
  await persist(s);
  return next;
}

export async function deleteMeta(name: string): Promise<void> {
  const s = await load();
  delete s.containers[name];
  await persist(s);
}

// —— docker 服务 meta（与容器 meta 同款 API 形状） ——

export async function getServiceMeta(name: string): Promise<ServiceMeta | undefined> {
  return (await load()).services[name];
}

export async function getAllServiceMeta(): Promise<Record<string, ServiceMeta>> {
  return (await load()).services;
}

export async function setServiceMeta(name: string, meta: ServiceMeta): Promise<ServiceMeta> {
  const s = await load();
  s.services[name] = meta;
  await persist(s);
  return meta;
}

export async function deleteServiceMeta(name: string): Promise<void> {
  const s = await load();
  delete s.services[name];
  await persist(s);
}

// —— SSH 终端目标（与容器/服务 meta 同款 sidecar 形状）——

export async function getSshTargets(): Promise<SshTarget[]> {
  return (await load()).sshTargets ?? [];
}

/** 新增（name 查重，冲突返回 null）。 */
export async function addSshTarget(t: SshTarget): Promise<SshTarget | null> {
  const s = await load();
  if (!s.sshTargets) s.sshTargets = [];
  if (s.sshTargets.some((x) => x.name === t.name)) return null;
  s.sshTargets.push(t);
  await persist(s);
  return t;
}

export async function deleteSshTarget(name: string): Promise<boolean> {
  const s = await load();
  const before = s.sshTargets?.length ?? 0;
  if (!s.sshTargets) return false;
  s.sshTargets = s.sshTargets.filter((x) => x.name !== name);
  const removed = s.sshTargets.length !== before;
  if (removed) await persist(s);
  return removed;
}

export function resetStateCache(): void {
  cache = null;
}
