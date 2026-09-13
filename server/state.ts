// sidecar 状态：易变元数据（adopted/displayName/description/tags）。存在 XDG data 目录。
// label 不可变，所以这些走 JSON。容器名作 key。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_FILE, STATE_DIR } from './config.js';

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

// AI 网关（myapikey 等）的**声明式配置**（全局一份）。形状同 aiconfig.ts 的
// AiGatewayInput（两路端点 + opencode/pi 的 wire 多选）+ updatedAt。语义是「期望
// 状态」而非一次性动作：服务启动 sweep + 新建容器补发自动把它写到全部受管容器
// （aiconfig.ts 宿主直写 rootfs），改 key 重推 = 改这里 + 重推。含 apiKey——
// state.json 本就 0600，与 services.env 同一泄露面；GET 回全量供前端预填。
export interface AiGatewayState {
  endpoints: {
    openai?: { baseUrl: string };
    anthropic?: { baseUrl: string };
  };
  apiKey: string;
  tools: { claude: boolean; codex: boolean; opencode: boolean; pi: boolean };
  wire?: {
    opencode?: ('openai-chat' | 'openai-responses' | 'anthropic-messages')[];
    pi?: ('openai-chat' | 'openai-responses' | 'anthropic-messages')[];
  };
  models?: string[];
  setDefault?: boolean;
  updatedAt: string;
}

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

// 技能分发规则（server/skillSync.ts）：以「库」为唯一技能真相源的安装规则——
// 规则 = 库里勾选的一组技能 + 去向位置（全局 ~/.claude/skills 或某项目的
// .claude/skills）+ 范围。技能级的勾选取代了旧版「目标聚合多源目录」的模型
// （旧版重名靠目标内源顺序先到先得，库内同名天然唯一后冲突不存在）。存这里而非
// config.yaml：UI 可增删（config.yaml 是用户手改文件，程序回写会丢注释），与
// sshTargets 同款理由。
export interface SkillRule {
  id: string; // 随机短 id（操作锚点）
  to: string; // 分发目标（容器内路径，相对 dev home）。唯一——同 to 不允许两条规则
  // 范围：true = 全部受管容器（全局语义）；false = 仅已有该项目的容器（目标路径
  // 逐级向上探测落点，项目克隆到哪 skill 跟到哪；容器 start 事件补发闭环）。
  all: boolean;
  // 库内技能名集合（安装什么）。同步时取「库目录仍存在」的有效集，库里缺失的
  // 在面板标红（missing），不影响其他技能。
  skills: string[];
  // 旧版迁移遗留：targets 模型下挂的目录源（{from, enabled}）。由 skillSync.ts 的
  // ensureLegacyMigrated 一次性转换成库条目 + skills 名单后删掉本字段。新版不写。
  legacy?: { from: string; enabled: boolean }[];
  createdAt?: string;
}

export interface SkillHubState {
  rules: SkillRule[];
  // 旧版 config.skills.sync 静态规则的一次性迁移时间戳（迁移后该 config 键被忽略）。
  staticMigratedAt?: string;
}

// 技能库（registry，server/skillSync.ts）：唯一技能真相源——放什么由用户定
// （自产 + 外部导入），库内每技能一份独立副本（STATE_DIR/skills/registry/<名>/，
// 与来源解耦），分发以库为源。follow 条目每次同步先从 from 刷新库内容（本地目录
// 来源 = 跟随开发中的技能；源删了副本冻结保留）。这里只存成员元数据，技能本体在文件系统。
export interface SkillRegistryMeta {
  from: string; // 导入来源（原样记录：<容器>:<路径> / 宿主路径 / git URL#子路径）
  importedAt: string;
  // true = 跟随刷新（目录来源，registryAdd 默认）；undefined = 快照（git 导入）。
  follow?: boolean;
}

interface StateShape {
  containers: Record<string, ContainerMeta>;
  services: Record<string, ServiceMeta>;
  sshTargets?: SshTarget[];
  aiGateway?: AiGatewayState;
  aiGatewayOverrides?: Record<string, AiGatewayState>;
  skillsHub?: SkillHubState;
  skillsRegistry?: { skills: Record<string, SkillRegistryMeta> };
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

// —— AI 网关声明式配置（全局一份 + 容器覆盖；应用到全部受管容器）——

// 容器覆盖（pull 语义的落点）：某台容器在卡片菜单「AI 网关…」里保存的专属配置——
// 存在即生效（启动 sweep / 建容器补发用它替代全局），全局配置不再应用到这台。让
// 「手改某台容器的 key」成为合法状态而不是被 sweep 冲掉的暂态。容器名作 key；
// 删容器时随手清（lifecycle.deleteManaged）。
export type AiGatewayOverride = AiGatewayState;

export async function getAiGatewayOverrides(): Promise<Record<string, AiGatewayOverride>> {
  return (await load()).aiGatewayOverrides ?? {};
}

export async function setAiGatewayOverride(name: string, state: AiGatewayOverride): Promise<void> {
  const s = await load();
  if (!s.aiGatewayOverrides) s.aiGatewayOverrides = {};
  s.aiGatewayOverrides[name] = state;
  await persist(s);
}

export async function deleteAiGatewayOverride(name: string): Promise<boolean> {
  const s = await load();
  if (!s.aiGatewayOverrides?.[name]) return false;
  delete s.aiGatewayOverrides[name];
  await persist(s);
  return true;
}

export async function getAiGateway(): Promise<AiGatewayState | undefined> {
  return (await load()).aiGateway;
}

export async function setAiGateway(state: AiGatewayState): Promise<void> {
  const s = await load();
  s.aiGateway = state;
  await persist(s);
}

// —— 技能分发规则（库为真相源；server/skillSync.ts）——

// 全局规则（铺全部容器）的缺省去向。
export const SKILL_HUB_DEFAULT_TO = '~/.claude/skills';

export async function getSkillHub(): Promise<SkillHubState> {
  const s = await load();
  const raw = s.skillsHub as unknown;
  // 迁移（三代形状逐级归一）：
  // ① 最旧：扁平 sources[]（源带可选 to）→ targets 模型（旧全局源归全局目标，
  //    显式 to 的源归各自项目目标）。
  // ② 旧：targets 模型（目标聚合多源目录）→ rules 模型：源不再内嵌——enabled 的
  //    目录源挪进 rule.legacy（由 skillSync.ts 的 ensureLegacyMigrated 转成库条目 +
  //    skills 名单），from='registry' 的源展开为当时的库成员名单。
  if (raw && typeof raw === 'object' && Array.isArray((raw as { sources?: unknown }).sources)) {
    const old = raw as { to: string; sources: { id: string; from: string; to?: string; enabled: boolean; createdAt?: string }[] };
    const targets = new Map<string, { id: string; to: string; all: boolean; sources: { from: string; enabled: boolean; createdAt?: string }[] }>();
    for (const src of old.sources) {
      const to = src.to || old.to || SKILL_HUB_DEFAULT_TO;
      let t = targets.get(to);
      if (!t) {
        t = { id: randomId(), to, all: to === (old.to || SKILL_HUB_DEFAULT_TO), sources: [] };
        targets.set(to, t);
      }
      t.sources.push({ from: src.from, enabled: src.enabled, createdAt: src.createdAt });
    }
    s.skillsHub = {
      rules: [...targets.values()].map((t) => ({ id: t.id, to: t.to, all: t.all, skills: [], legacy: t.sources })),
    };
    void persist(s).catch(() => {});
    return s.skillsHub;
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { targets?: unknown }).targets)) {
    const old = raw as { targets: { id: string; to: string; all: boolean; sources: { from: string; enabled: boolean }[]; createdAt?: string }[] };
    s.skillsHub = {
      rules: old.targets.map((t) => ({
        id: t.id,
        to: t.to,
        all: t.all,
        skills: [],
        legacy: t.sources.map((src) => ({ from: src.from, enabled: src.enabled })),
        createdAt: t.createdAt,
      })),
    };
    void persist(s).catch(() => {});
    return s.skillsHub;
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)) {
    return raw as SkillHubState;
  }
  // 首次：种一条全局规则（零技能），面板即有「全局」去向可勾技能。
  s.skillsHub = {
    rules: [{ id: randomId(), to: SKILL_HUB_DEFAULT_TO, all: true, skills: [] }],
  };
  await persist(s);
  return s.skillsHub;
}

export async function setSkillHub(hub: SkillHubState): Promise<void> {
  const s = await load();
  s.skillsHub = hub;
  await persist(s);
}

// —— 技能库成员元数据（本体在 STATE_DIR/skills/registry/，元数据只记来源/时间）——

export async function getSkillRegistry(): Promise<{ skills: Record<string, SkillRegistryMeta> }> {
  const s = await load();
  if (!s.skillsRegistry) s.skillsRegistry = { skills: {} };
  return s.skillsRegistry;
}

export async function setSkillRegistry(reg: { skills: Record<string, SkillRegistryMeta> }): Promise<void> {
  const s = await load();
  s.skillsRegistry = reg;
  await persist(s);
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10);
}

export function resetStateCache(): void {
  cache = null;
}
