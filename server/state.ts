// sidecar 状态：LXC 容器易变元数据（adopted/displayName/description/tags）+ SSH 目标。
// docker 服务的元数据已迁往 compose/<名>/meta.json（serviceMeta.ts），不在这里。
// label 不可变，所以这些走 JSON。容器名作 key。
// AI 板块（技能 + 模型接入）的状态不在这里——独居 ai/ 专用目录（server/aiState.ts），
// 本文件只在 load 时把存量旧键抽过去（takeLegacyAiKeys）。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
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

// docker 服务 meta（ServiceMeta/StackServiceRef 等）已退役：策展元数据搬到每项目
// compose/<名>/meta.json（server/serviceMeta.ts），state.json 只剩容器 meta 与 SSH 目标。

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
  password?: string; // 可选：密码认证目标（经 sshpass 自动应答；存本文件 0600，不出 API 响应）
  note?: string; // 可选：备注（纯展示，仅进列表）
  createdAt?: string;
}

// —— 受限账户（分享用）——
// 与主 token 的关系：主 token = owner 全权（宿主属主等价），账户 = 只能操作白名单
// 容器的第二凭证层（终端 + 文件面板）。存 sidecar 而非 config.yaml：UI 可增删改、
// 属易变凭据（与 sshTargets 同语义）。passwordHash 由 accounts.ts 生成（scrypt），
// 本文件只管存取，不做密码学。
export interface SandboxAccount {
  name: string; // 唯一标识 + 登录名（^[a-z0-9][a-z0-9_-]{0,30}$）
  passwordHash: string; // scrypt：<salt hex>:<hash hex>（accounts.ts verifyAccount 消费）
  containers: string[]; // 容器名白名单：账户可见/可连的受管容器
  createdAt?: string;
}

interface StateShape {
  containers: Record<string, ContainerMeta>;
  sshTargets?: SshTarget[];
  accounts?: SandboxAccount[];
}

// docker 服务的策展元数据已迁往每项目 compose/<名>/meta.json（server/serviceMeta.ts）——
// state.json 只剩容器 meta 与 SSH 目标。存量 services 键在 load() 里一次性迁走并删除。
let cache: StateShape | null = null;

async function load(): Promise<StateShape> {
  if (cache) return cache;
  if (!existsSync(STATE_FILE)) {
    cache = { containers: {}, sshTargets: [] };
    return cache;
  }
  try {
    cache = JSON.parse(await readFile(STATE_FILE, 'utf8')) as StateShape;
    if (!cache.containers) cache.containers = {};
    if (!cache.sshTargets) cache.sshTargets = [];
  } catch {
    cache = { containers: {}, sshTargets: [] };
  }
  // AI 板块状态已迁往 ai/（server/aiState.ts）：存量键从这里抽走并立即持久化，
  // 之后的任何 persist 都不会再把它们带回来。
  // docker 服务 meta → compose/<名>/meta.json 同理（serviceMeta.ts）。
  const raw = cache as unknown as Record<string, unknown>;
  const legacyServices = raw.services as Record<string, Record<string, unknown>> | undefined;
  if ((await takeLegacyAiKeys(raw)) || (legacyServices && Object.keys(legacyServices).length)) {
    if (legacyServices) {
      const { migrateLegacyServiceMeta } = await import('./serviceMeta.js');
      await migrateLegacyServiceMeta(legacyServices);
    }
    delete raw.services;
    await persist(cache);
  }
  return cache;
}

async function persist(s: StateShape): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  // 原子写：tmp + rename（state.json 承载 sshTargets/技能规则等，半截文件会连环炸）
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  await rename(tmp, STATE_FILE);
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

// —— SSH 终端目标（与容器 meta 同款 sidecar 形状）——

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

/** 局部更新（名称不可改；patch 只含调用方显式给出的键——显式 undefined = 清除该可选字段）。 */
export async function updateSshTarget(
  name: string,
  patch: Partial<Pick<SshTarget, 'user' | 'port' | 'password' | 'note'>>,
): Promise<SshTarget | null> {
  const s = await load();
  const t = s.sshTargets?.find((x) => x.name === name);
  if (!t) return null;
  Object.assign(t, patch);
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

// —— 受限账户（与 sshTargets 同款 sidecar 形状）——

export async function getAccounts(): Promise<SandboxAccount[]> {
  return (await load()).accounts ?? [];
}

export async function getAccount(name: string): Promise<SandboxAccount | undefined> {
  return (await load()).accounts?.find((x) => x.name === name);
}

/** 新增（name 查重，冲突返回 null）。 */
export async function addAccount(a: SandboxAccount): Promise<SandboxAccount | null> {
  const s = await load();
  if (!s.accounts) s.accounts = [];
  if (s.accounts.some((x) => x.name === a.name)) return null;
  s.accounts.push(a);
  await persist(s);
  return a;
}

/** 局部更新（名称不可改；patch 只含调用方显式给出的键）。账户不存在返回 null。 */
export async function updateAccount(
  name: string,
  patch: Partial<Pick<SandboxAccount, 'passwordHash' | 'containers'>>,
): Promise<SandboxAccount | null> {
  const s = await load();
  const a = s.accounts?.find((x) => x.name === name);
  if (!a) return null;
  Object.assign(a, patch);
  await persist(s);
  return a;
}

export async function deleteAccount(name: string): Promise<boolean> {
  const s = await load();
  const before = s.accounts?.length ?? 0;
  if (!s.accounts) return false;
  s.accounts = s.accounts.filter((x) => x.name !== name);
  const removed = s.accounts.length !== before;
  if (removed) await persist(s);
  return removed;
}
