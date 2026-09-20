// AI 板块专用存储（STATE_DIR/ai/）：技能（库 + 安装规则 + 分发副本）与 AI 配置
// （provider 库 + 绑定 + 覆盖 + 项目规则）整体搬出共享 sidecar state.json——
// AI 是一个自洽的产品板块，状态、文件、密钥都该住自己的屋檐下（备份/迁移/排查
// 一个目录看全），也不让 state.json 随着面板功能膨胀。
//
// 目录布局：
//   ai/skills/               技能文件本体（skillSync.ts：registry/<名>/ 库副本、
//                            hub-<hash(to)>/ 聚合副本、hub-*.json 分发清单）
//   ai/skills.json           安装规则（hub）+ 库成员元数据（registry）
//   ai/ai-config.json        provider 库 / 绑定 / 目标覆盖 / 项目规则 / 旧档迁移旗标
//
// 迁移（一次性、全自动）：
//   ① 旧文件目录 STATE_DIR/skills → ai/skills：进程首次加载本模块时 renameSync
//      （同盘原子；目标已存在 = 之前搬过/搬过一半，保新不动旧，旧目录留给人工）。
//   ② state.json 里的 ai*/skills* 状态键 → 两个新 JSON。两个加载方向都闭环：
//      - state.ts 的 load() 调 takeLegacyAiKeys（键从缓存抽走、立即持久化，
//        防止后续任意 persist 把键带回来），aiState 收到暂存；
//      - 若 aiState 先于 state.ts 加载（CLI 一次性命令路径），直接裸读
//        state.json 抽键、回写（此刻 state 缓存尚未建立，无竞态）。
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR, STATE_FILE } from './config.js';
import { log } from './logger.js';
import { HOST_TARGET } from './state.js';

export const AI_DIR = join(STATE_DIR, 'ai');
const SKILLS_STATE_FILE = join(AI_DIR, 'skills.json');
const AI_CONFIG_STATE_FILE = join(AI_DIR, 'ai-config.json');

// —— 领域类型（随状态一起从 state.ts 迁来）——

// 旧 AI 网关（已被 provider 库 + 绑定取代；ensureAiMigrated 一次性迁移后删除）。
// 形状语义见 aiconfig.ts。含 apiKey——本文件 0600，与 services.env 同一泄露面。
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

export type GatewayWire = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

// AI 模型服务提供商库：N 个 OpenAI/Anthropic 兼容网关的凭据与端点。绑定只引用
// id 不内联端点——provider 改 key 重推即全局生效。id 落进各工具配置当 provider 名。
//
// models 按协议（wire）各一份：OpenAI 兼容网关同一条 /models 端点下 chat completions
// 与 responses 两套协议实际可用的模型集合不同（有的模型不支持 responses），anthropic
// 侧同样各是各的——单一共享清单会失真。取某协议的清单一律走 wireModels（容忍旧
// 数组形状，见其注释）。
export interface AiProvider {
  id: string; // /^[a-z][a-z0-9-]{0,31}$/；工具配置里的 provider key 前缀（禁 _ 防与 - 转换后撞名）
  name: string; // 显示名
  endpoints: {
    openai?: { baseUrl: string }; // OpenAI 兼容端点（…/openai/v1）
    responses?: { baseUrl: string }; // OpenAI responses 兼容端点（同 openai 约定；多数网关与 openai 同址可不填——缺省回落 openai，两协议不同址才单独填）
    anthropic?: { baseUrl: string }; // Anthropic 兼容端点（…/anthropic，不含 /v1）
  };
  apiKey: string;
  models?: Partial<Record<GatewayWire, string[]>>; // 各协议（opencode/pi 变体）下挂的模型清单（手填或从网关 /models 拉取）
  createdAt?: string;
  updatedAt?: string;
}

// provider 某协议的模型清单。旧档的共享清单（string[]）读入时已自愈归 openai-chat
//（loadAiConfigState），这里再兜一层数组形状防迁移窗口内的半旧数据；键没配 = 空
// 清单（该协议变体不挂模型，工具端手填不受限）。
export function wireModels(p: Pick<AiProvider, 'models'>, wire: GatewayWire): string[] {
  if (Array.isArray(p.models)) return p.models;
  return p.models?.[wire] ?? [];
}

// opencode 绑定：provider 多选，每个 provider 独立配协议，每个协议独立配模型——
// wires[].models 缺省 = 该 provider 库里的全部模型。defaultModel = "<变体>/<模型>"
// 显式默认；缺省（setDefault）自动取第一个配置组合。旧形状 {providers, wires?,
// setDefault?} 读入时经 aiconfig.normalizeOpenCodeSlot 懒归一，下一次保存落新形状。
export interface AiOpenCodeWireBinding {
  wire: GatewayWire;
  models?: string[];
}
export interface AiOpenCodeEntry {
  provider: string;
  wires: AiOpenCodeWireBinding[];
}
export interface AiOpenCodeBinding {
  entries: AiOpenCodeEntry[];
  setDefault?: boolean;
  defaultModel?: string;
}
// pi 绑定：与 opencode 同形状（entries：每 provider 独立配协议、每协议独立配模型清单；
// 变体 key 同为 <pid>-<后缀>，落 .pi/agent/models.json）。pi 没有显式默认模型的概念
// （defaultModel 不存在）。旧形状 {providers, wires?, setDefault?}（providers × wires
// 笛卡尔积）读到时经 aiconfig.normalizePiSlot 懒归一，下一次保存落新形状。
export interface AiPiBinding {
  entries: AiOpenCodeEntry[];
  setDefault?: boolean;
}

// 绑定（智能体配置的声明层）：工具 → 用哪些 provider。单槽工具绑一个；多槽工具
// 绑 N 个共存，setDefault 取 providers[0]。providers 空数组 = 显式清空该工具的
// 全部受管条目。缺某工具键 = 不碰该工具的落盘配置。
export interface AiBinding {
  claude?: { provider: string };
  // codex 单槽：model 必填（不写顶层 model = codex 落回内置 gpt-5.x slug，第三方
  // 网关没有这些模型，请求必 404）。旧形状的 setDefault 读到即弃（单槽恒写
  // model_provider，勾不勾没有语义差——勾选框是 opencode 多槽时代的遗留概念）。
  codex?: { provider: string; model?: string };
  opencode?: AiOpenCodeBinding;
  pi?: AiPiBinding;
}

// 绑定里的工具键（下发的 apply 过滤、绑定校验共用）。
export type AiToolKey = 'claude' | 'codex' | 'opencode' | 'pi';
export const AI_TOOL_KEYS: AiToolKey[] = ['claude', 'codex', 'opencode', 'pi'];

// 工具自身配置（只此全局一份，不进绑定的四层模型）：各 agent CLI 除了「用哪些
// 模型服务」之外自己的特殊配置。本期只做 claude——model → env.ANTHROPIC_MODEL，
// env 是自定义 env 键值对，settings 是 settings.json 顶级键（effortLevel /
// skipDangerousModePermissionPrompt / autoMemoryEnabled / permissions…，键级 owned：
// 整键覆盖，保存路径回收已移除键），由 aiconfig 的 configClaude 在写 settings.json 时
// 合并（env 块内受管绑定键 BASE_URL/AUTH_TOKEN 恒赢）。落点跟着 claude 绑定走：
// 未绑 claude 的目标不写（aiconfig.setClaudeToolConfig 注释有详版）。
export interface AiClaudeToolConfig {
  model?: string; // 默认模型 → env.ANTHROPIC_MODEL
  env?: Record<string, string>; // 自定义 env 键值对（禁 BASE_URL/AUTH_TOKEN，路由层校验）
  settings?: Record<string, unknown>; // settings.json 顶级键（禁 env——env 块另有归属，路由层校验）
}

// OpenCode 自身配置（全局一份，像 claude 的 toolConfig）：权限 auto（permission='allow'，
// 等价 CLI --auto——自动批准未显式拒绝的权限，缺省开）+ model/small_model（provider
// 变体/模型 格式，如 myapikey-chat/opencode-coding）。由 aiconfig 的 configOpencode
// 在写 opencode.json 时消费，仅 user scope（项目级文件常进仓库，权限放宽不带进去）。
export interface AiOpenCodeToolConfig {
  permissionAuto?: boolean; // 缺省 true → permission:'allow'；显式 false = 不碰权限键（回收不猜，手改值保留）
  model?: string; // 默认主模型 → 顶层 model（优先于绑定 setDefault 的自动推导）
  smallModel?: string; // 轻量任务模型（会话标题等）→ 顶层 small_model（给了才写，清空不碰已有值）
}

// Codex 自身配置（全局一份，像 claude/opencode 的 toolConfig）：config.toml 顶层键，
// 由 aiconfig 的 configCodex 消费——给了才写；保存路径对上一版做差集回收（removedCodexKeys
// 写过又删掉的键整行剥掉，sweep 只合并不删，与 claude 顶级键同口径）。reasoning effort
// 只对 responses 协议生效（codex 固定走 responses，恒适用）。
export interface AiCodexToolConfig {
  approvalPolicy?: string; // → 顶层 approval_policy（on-request/on-failure/never，路由层枚举校验）
  reasoningEffort?: string; // → 顶层 model_reasoning_effort（minimal/low/medium/high/xhigh，路由层枚举校验）
  verbosity?: string; // → 顶层 model_verbosity（low/medium/high，路由层枚举校验）
  sandboxMode?: string; // → 顶层 sandbox_mode（read-only/workspace-write/danger-full-access，路由层枚举校验）
  networkAccess?: boolean; // → sandbox_workspace_write.network_access（仅 sandbox_mode=workspace-write 时写）
  contextWindow?: number; // → 顶层 model_context_window
  autoCompactTokenLimit?: number; // → 顶层 model_auto_compact_token_limit
  reasoningSummary?: string; // → 顶层 model_reasoning_summary（auto/concise/detailed/none，路由层枚举校验）
  historyPersistence?: string; // → history.persistence（save-all/none，路由层枚举校验）
}

export interface AiToolConfigState {
  claude?: AiClaudeToolConfig;
  opencode?: AiOpenCodeToolConfig;
  codex?: AiCodexToolConfig;
}

// 项目级 AI 配置规则（像技能规则）：去向 = 项目目录（容器内 ~/rel，唯一），写入
// 项目级配置文件。范围语义同技能的项目规则：只写「已有该项目」的目标，容器 start
// 事件补发。codex/pi 无项目级配置形状，不进表。
export interface AiProjectRule {
  id: string;
  to: string;
  claude?: { provider: string };
  opencode?: { providers: string[]; wires?: GatewayWire[]; setDefault?: boolean };
  createdAt?: string;
}

// 技能分发规则（server/skillSync.ts）：以「库」为唯一技能真相源的安装规则——
// 规则 = 库里勾选的一组技能 + 去向位置（全局 ~/.agents/skills——~/.claude/skills
// 孪生跟铺，两处独立实体副本无软链——或某项目的 .claude/skills）+ 范围。true = 本机 + 全部受管容器；false = 仅已有该项目的目标
// （落点逐级向上探测，项目克隆到哪 skill 跟到哪）。
export interface SkillRule {
  id: string; // 随机短 id（操作锚点）
  to: string; // 分发目标（容器内路径，相对 dev home）。唯一——同 to 不允许两条规则
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

// 技能库成员元数据：本体在 ai/skills/registry/<名>/（与来源解耦的静态快照），
// 这里只记来源与时间。
export interface SkillRegistryMeta {
  from: string; // 导入来源（原样记录：<容器>:<路径> / 宿主路径 / git URL#子路径）
  importedAt: string;
  // 内容指纹（hashTree：排序相对路径 + 文件内容的 sha256）——检查更新 = 来源指纹
  // 与它比对，变了才重拉分发。旧数据没有此字段：首次检查对库副本现算补上（自愈）。
  hash?: string;
  // git 来源的导入/更新时 commit（ls-remote 快路径的比对基准：commit 没变 = 内容没变，
  // 免 clone）。commit 变了 ≠ 子路径内容变了——慢路径仍要比内容 hash。
  gitCommit?: string;
}

// —— 文件形状 ——

interface SkillsStateFile {
  hub?: SkillHubState;
  registry?: { skills: Record<string, SkillRegistryMeta> };
}

interface AiConfigStateFile {
  providers?: Record<string, AiProvider>;
  binding?: AiBinding;
  targetOverrides?: Record<string, AiBinding>;
  toolConfig?: AiToolConfigState;
  projectRules?: AiProjectRule[];
  migratedAt?: string;
  // 旧 aiGateway 单网关档（ensureAiMigrated 迁移后删除）。
  gateway?: AiGatewayState;
  gatewayOverrides?: Record<string, AiGatewayState>;
}

// state.json 里待迁出的旧键（形状不声明成强类型——跨代形状容忍 unknown）。
interface LegacyKeys {
  skillsHub?: unknown;
  skillsRegistry?: unknown;
  aiProviders?: unknown;
  aiBinding?: unknown;
  aiTargetOverrides?: unknown;
  aiProjectRules?: unknown;
  aiMigratedAt?: unknown;
  aiGateway?: unknown;
  aiGatewayOverrides?: unknown;
}

// —— 文件读写（cache 整文件读写，与 state.ts 同款语义）——

let skillsCache: SkillsStateFile | null = null;
let aiConfigCache: AiConfigStateFile | null = null;

// 旧文件目录搬迁（模块加载即做——renameSync 同盘原子；早于任何读写路径）。
function moveLegacySkillsDir(): void {
  const legacy = join(STATE_DIR, 'skills');
  if (!existsSync(legacy)) return;
  const target = join(AI_DIR, 'skills');
  if (existsSync(target)) {
    log.warn({ legacy, target }, 'ai state: both skills dirs exist, keeping new one (legacy left in place)');
    return;
  }
  try {
    mkdirSync(AI_DIR, { recursive: true });
    renameSync(legacy, target);
    log.info({ from: legacy, to: target }, 'ai state: legacy skills dir moved');
  } catch (e) {
    log.warn({ err: String(e) }, 'ai state: legacy skills dir move failed');
  }
}
moveLegacySkillsDir();

// 从 state.json 裸读旧键（aiState 先于 state.ts 加载的路径；此刻 state 缓存未建，
// 裸写回无竞态）。返回抽到的键（可能为 null）。
async function readLegacyFromStateFile(): Promise<LegacyKeys | null> {
  if (!existsSync(STATE_FILE)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Record<string, unknown>;
  } catch {
    return null; // 坏文件：state.ts 自己会兜，这里不背
  }
  const keys = Object.keys(raw).filter((k) => k.startsWith('ai') || k.startsWith('skills'));
  if (!keys.length) return null;
  const out: LegacyKeys = {};
  for (const k of keys) {
    out[k as keyof LegacyKeys] = raw[k];
    delete raw[k];
  }
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  return out;
}

async function readSkillsFile(): Promise<SkillsStateFile> {
  try {
    return JSON.parse(await readFile(SKILLS_STATE_FILE, 'utf8')) as SkillsStateFile;
  } catch {
    return {};
  }
}

async function persistSkillsState(s: SkillsStateFile): Promise<void> {
  await mkdir(AI_DIR, { recursive: true });
  await writeFile(SKILLS_STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  skillsCache = s;
}

async function readAiConfigFile(): Promise<AiConfigStateFile> {
  try {
    return JSON.parse(await readFile(AI_CONFIG_STATE_FILE, 'utf8')) as AiConfigStateFile;
  } catch {
    return {};
  }
}

async function persistAiConfigState(s: AiConfigStateFile): Promise<void> {
  await mkdir(AI_DIR, { recursive: true });
  await writeFile(AI_CONFIG_STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  aiConfigCache = s;
}

// state.ts 在 load() 里调用：把 ai/skills 键从 sidecar 缓存抽走（调用方随即持久化
// state.json），**当场合并进两个 AI 状态文件并落盘**——迁移的落点就在抽取动作本身，
// 不依赖「本进程之后会不会真的去读 AI 状态」。键级缺省填充：AI 文件已有的键以文件
// 为准（迁移完成后文件是权威），只补文件里缺的。
export async function takeLegacyAiKeys(s: Record<string, unknown>): Promise<boolean> {
  const keys = Object.keys(s).filter((k) => k.startsWith('ai') || k.startsWith('skills'));
  if (!keys.length) return false;
  const legacy: LegacyKeys = {};
  for (const k of keys) {
    legacy[k as keyof LegacyKeys] = s[k];
    delete s[k];
  }
  const take = <K extends keyof LegacyKeys, T extends keyof AiConfigStateFile>(
    file: AiConfigStateFile, lk: K, tk: T,
  ): void => {
    if (legacy[lk] !== undefined && (file as Record<string, unknown>)[tk] === undefined) {
      (file as Record<string, unknown>)[tk] = legacy[lk];
    }
  };
  const skills = await readSkillsFile();
  if (skills.hub === undefined && legacy.skillsHub !== undefined) skills.hub = legacy.skillsHub as SkillHubState;
  if (skills.registry === undefined && legacy.skillsRegistry !== undefined) {
    skills.registry = legacy.skillsRegistry as SkillsStateFile['registry'];
  }
  await persistSkillsState(skills);
  const ai = await readAiConfigFile();
  take(ai, 'aiProviders', 'providers');
  take(ai, 'aiBinding', 'binding');
  take(ai, 'aiTargetOverrides', 'targetOverrides');
  take(ai, 'aiProjectRules', 'projectRules');
  take(ai, 'aiMigratedAt', 'migratedAt');
  take(ai, 'aiGateway', 'gateway');
  take(ai, 'aiGatewayOverrides', 'gatewayOverrides');
  await persistAiConfigState(ai);
  log.info({ keys }, 'ai state: legacy keys migrated from state.json');
  return true;
}

async function loadSkillsState(): Promise<SkillsStateFile> {
  if (skillsCache) return skillsCache;
  const file = await readSkillsFile();
  const empty = !file.hub && !file.registry;
  skillsCache = file;
  // 文件缺失/空（aiState 先于 state.ts 加载的路径）：从 state.json 裸读迁移。
  // state 先加载的场景里 takeLegacyAiKeys 已把文件写好，这里读到的就是成品。
  if (empty) {
    const legacy = await readLegacyFromStateFile();
    if (legacy) {
      if (legacy.skillsHub !== undefined && !file.hub) file.hub = legacy.skillsHub as SkillHubState;
      if (legacy.skillsRegistry !== undefined && !file.registry) {
        file.registry = legacy.skillsRegistry as SkillsStateFile['registry'];
      }
      await persistSkillsState(file);
    }
  }
  return file;
}

async function loadAiConfigState(): Promise<AiConfigStateFile> {
  if (aiConfigCache) return aiConfigCache;
  const file = await readAiConfigFile();
  const empty = !file.providers && !file.binding && !file.targetOverrides && !file.toolConfig
    && !file.projectRules && !file.migratedAt && !file.gateway && !file.gatewayOverrides;
  aiConfigCache = file;
  // 同 loadSkillsState：文件为空才走 state.json 裸读迁移（有货说明迁移早已完成，
  // 空库是合法状态也不能每轮回读——用「键全空」判别首启）。
  if (empty) {
    const legacy = await readLegacyFromStateFile();
    if (legacy) {
      const take = <K extends keyof LegacyKeys, T extends keyof AiConfigStateFile>(lk: K, tk: T): void => {
        if (legacy[lk] !== undefined && (file as Record<string, unknown>)[tk] === undefined) {
          (file as Record<string, unknown>)[tk] = legacy[lk];
        }
      };
      take('aiProviders', 'providers');
      take('aiBinding', 'binding');
      take('aiTargetOverrides', 'targetOverrides');
      take('aiProjectRules', 'projectRules');
      take('aiMigratedAt', 'migratedAt');
      take('aiGateway', 'gateway');
      take('aiGatewayOverrides', 'gatewayOverrides');
      await persistAiConfigState(file);
    }
  }
  // 存量自愈①：__host__ 覆盖已随「本机跟随全局绑定」退役（2026-09-16）——清理存档里
  // 的旧键（一次性，删了才持久化），本机从此回落跟随全局绑定。
  if (file.targetOverrides && HOST_TARGET in file.targetOverrides) {
    delete file.targetOverrides[HOST_TARGET];
    if (!Object.keys(file.targetOverrides).length) delete file.targetOverrides;
    await persistAiConfigState(file);
    log.info('ai state: __host__ override pruned (host now follows global binding)');
  }
  // 存量自愈②：provider.models 旧形状（全协议共享 string[]）→ 按协议对象（旧清单
  // 归 openai-chat——旧拉取的主消费方；responses/anthropic 空着待补，编辑页重新拉/
  // 手填）。一次性，归一后才持久化；wireModels 对数组形状兜底防迁移窗口半旧数据。
  if (file.providers) {
    let healed = false;
    for (const p of Object.values(file.providers)) {
      if (Array.isArray((p as { models?: unknown }).models)) {
        p.models = { 'openai-chat': (p.models as unknown as string[]).filter((m) => typeof m === 'string' && m) };
        healed = true;
      }
    }
    if (healed) {
      await persistAiConfigState(file);
      log.info('ai state: provider.models legacy shared list normalized to per-wire shape');
    }
  }
  return file;
}

function randomId(): string {
  return Math.random().toString(16).slice(2, 10);
}

// —— AI 模型服务提供商库（provider）——

export async function getAiProviders(): Promise<Record<string, AiProvider>> {
  return (await loadAiConfigState()).providers ?? {};
}

export async function setAiProvider(p: AiProvider): Promise<void> {
  const s = await loadAiConfigState();
  if (!s.providers) s.providers = {};
  s.providers[p.id] = p;
  await persistAiConfigState(s);
}

export async function deleteAiProvider(id: string): Promise<boolean> {
  const s = await loadAiConfigState();
  if (!s.providers?.[id]) return false;
  delete s.providers[id];
  await persistAiConfigState(s);
  return true;
}

export async function getAiBinding(): Promise<AiBinding | undefined> {
  return (await loadAiConfigState()).binding;
}

export async function setAiBinding(b: AiBinding): Promise<void> {
  const s = await loadAiConfigState();
  s.binding = b;
  await persistAiConfigState(s);
}

// 工具自身配置（全局一份；见 AiClaudeToolConfig 注释）。
export async function getAiToolConfig(): Promise<AiToolConfigState> {
  return (await loadAiConfigState()).toolConfig ?? {};
}

// 按工具键合并写入：调用方（claude 页签保存 / opencode 页签保存）都只传本次管的
// 工具槽，整份替换会把其他工具的自身配置冲掉（保存 OpenCode 丢 Claude 配置、反之
// 亦然）。单键内仍是整体替换（传 {claude:{}} 即清 Claude 自身配置）。
export async function setAiToolConfig(tc: AiToolConfigState): Promise<void> {
  const s = await loadAiConfigState();
  s.toolConfig = { ...(s.toolConfig ?? {}), ...tc };
  await persistAiConfigState(s);
}

// 目标级覆盖（绑定层的 pull 语义）：key = 容器名。存在即生效
// （sweep / 建容器补发用它替代全局绑定，全局不再应用到这台）。本机跟随全局绑定、
// 不是覆盖目标（旧 '__host__' 覆盖在 loadAiConfigState 里自愈清除）。
export async function getAiTargetOverrides(): Promise<Record<string, AiBinding>> {
  return (await loadAiConfigState()).targetOverrides ?? {};
}

export async function setAiTargetOverride(target: string, b: AiBinding): Promise<void> {
  const s = await loadAiConfigState();
  if (!s.targetOverrides) s.targetOverrides = {};
  s.targetOverrides[target] = b;
  await persistAiConfigState(s);
}

export async function deleteAiTargetOverride(target: string): Promise<boolean> {
  const s = await loadAiConfigState();
  if (!s.targetOverrides?.[target]) return false;
  delete s.targetOverrides[target];
  await persistAiConfigState(s);
  return true;
}

export async function getAiProjectRules(): Promise<AiProjectRule[]> {
  return (await loadAiConfigState()).projectRules ?? [];
}

export async function setAiProjectRules(rules: AiProjectRule[]): Promise<void> {
  const s = await loadAiConfigState();
  s.projectRules = rules;
  await persistAiConfigState(s);
}

// 旧档迁移旗标 + 旧键清理（aiconfig.ensureAiMigrated 一次性用）。
export async function getAiMigratedAt(): Promise<string | undefined> {
  return (await loadAiConfigState()).migratedAt;
}

export async function setAiMigratedAt(ts: string): Promise<void> {
  const s = await loadAiConfigState();
  s.migratedAt = ts;
  await persistAiConfigState(s);
}

export async function getAiGateway(): Promise<AiGatewayState | undefined> {
  return (await loadAiConfigState()).gateway;
}

export async function getAiGatewayOverrides(): Promise<Record<string, AiGatewayState>> {
  return (await loadAiConfigState()).gatewayOverrides ?? {};
}

export async function clearLegacyAiGateway(): Promise<void> {
  const s = await loadAiConfigState();
  if (s.gateway === undefined && !s.gatewayOverrides) return;
  delete s.gateway;
  delete s.gatewayOverrides;
  await persistAiConfigState(s);
}

// —— 技能分发规则（库为真相源；server/skillSync.ts）——

// 全局规则（铺本机 + 全部受管容器）的缺省去向——canonical 全局落点（~/.claude/skills
// 孪生跟铺；与前端 GLOBAL_TO / installSkillsToSpot 的归一一致）。
export const SKILL_HUB_DEFAULT_TO = '~/.agents/skills';

export async function getSkillHub(): Promise<SkillHubState> {
  const s = await loadSkillsState();
  let hub = s.hub;
  const raw = hub as unknown;
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
    hub = {
      rules: [...targets.values()].map((t) => ({ id: t.id, to: t.to, all: t.all, skills: [], legacy: t.sources })),
    };
    s.hub = hub;
    void persistSkillsState(s).catch(() => {});
    return hub;
  }
  if (raw && typeof raw === 'object' && Array.isArray((raw as { targets?: unknown }).targets)) {
    const old = raw as { targets: { id: string; to: string; all: boolean; sources: { from: string; enabled: boolean }[]; createdAt?: string }[] };
    hub = {
      rules: old.targets.map((t) => ({
        id: t.id,
        to: t.to,
        all: t.all,
        skills: [],
        legacy: t.sources.map((src) => ({ from: src.from, enabled: src.enabled })),
        createdAt: t.createdAt,
      })),
    };
    s.hub = hub;
    void persistSkillsState(s).catch(() => {});
    return hub;
  }
  if (hub && typeof hub === 'object' && Array.isArray(hub.rules)) {
    return hub;
  }
  // 首次：种一条全局规则（零技能），面板即有「全局」去向可勾技能。
  s.hub = {
    rules: [{ id: randomId(), to: SKILL_HUB_DEFAULT_TO, all: true, skills: [] }],
  };
  await persistSkillsState(s);
  return s.hub;
}

export async function setSkillHub(hub: SkillHubState): Promise<void> {
  const s = await loadSkillsState();
  s.hub = hub;
  await persistSkillsState(s);
}

// —— 技能库成员元数据（本体在 ai/skills/registry/，元数据只记来源/时间）——

export async function getSkillRegistry(): Promise<{ skills: Record<string, SkillRegistryMeta> }> {
  const s = await loadSkillsState();
  if (!s.registry) s.registry = { skills: {} };
  return s.registry;
}

export async function setSkillRegistry(reg: { skills: Record<string, SkillRegistryMeta> }): Promise<void> {
  const s = await loadSkillsState();
  s.registry = reg;
  await persistSkillsState(s);
}

// 测试/工具用：清空进程内缓存（下次访问重读文件）。
export function resetAiStateCache(): void {
  skillsCache = null;
  aiConfigCache = null;
}
