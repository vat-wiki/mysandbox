// AI 配置体系：模型服务提供商库 × 智能体绑定 × 落盘写入器。与 batch.ts 的 exec
// 路线不同——这里走 **宿主直写 rootfs**（D1 uid 直通：容器内 dev(1000) = 宿主 leon，
// 直写的文件属主天然正确），所以容器不必在跑，CLI 下次启动即生效。本机（宿主
// leon 的 home）是同一套 writer 的另一个 base——写宿主文件连 rootfs 路径都不用绕。
//
// 三层模型：
//   provider 库（state.aiProviders）——N 个 OpenAI/Anthropic 兼容网关的凭据与端点，
//     id 落进各工具配置当 provider 名。改 key 重推即全局生效；删 provider 全量回收
//     落盘条目。
//   绑定（state.aiBinding 全局一份 + state.aiTargetOverrides 目标覆盖）——工具 →
//     用哪些 provider（引用 id 不内联端点）。单槽工具（claude 的 env 只有一份、codex
//     的 model_provider 指一个）绑一个；多槽工具（opencode/pi 的 provider 表）绑 N
//     个共存，工具内 /models 切。目标覆盖 key = 容器名或 '__host__'（本机）；本机
//     不进 sweep——宿主是真实环境，只有显式覆盖才写，全局改 key 不连带刷掉宿主。
//   写入器（本文件）——绑定 + provider 库在入口解析成 AiApplyPlan，逐 base 落盘。
//
// 各工具落点（base = 用户 home 或项目根）：
// - claude   .claude/settings.json          env 块注入 BASE_URL/AUTH_TOKEN（单槽，重绑即覆盖）
// - codex    .codex/config.toml            每 provider 一个锚点块（多 provider 共存）
//            .zshrc                        各自的 env export 锚点块（codex 只认 env_key 引用的运行时环境）
// - opencode user: .config/opencode/opencode.json   合并 provider.<变体>*（key 明文内联）
//            project: <dir>/opencode.json
// - pi       .pi/agent/models.json         合并 providers.<变体>*（项目级无此形状，不支持）
//
// 幂等靠两类锚点：JSON 只深改本方案的键（保留用户其余配置）；TOML/zshrc 用
// `# >>> <pid> >>>` … `# <<< <pid> <<<` 标记块整块替换（旧版 pid 恒为 myapikey，
// 形状一致 → 存量块天然兼容，无需落盘迁移）。变体 key = <pid>-<wire 后缀>。
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { execRun, getEngine, inspectContainer, listManaged, subscribeEvents } from './engine/index.js';
import {
  HOST_TARGET,
  getAiGateway,
  getAiGatewayOverrides,
  getAiProviders,
  setAiProvider,
  deleteAiProvider,
  getAiBinding,
  setAiBinding,
  getAiTargetOverrides,
  setAiTargetOverride,
  deleteAiTargetOverride,
  getAiProjectRules,
  setAiProjectRules,
  getAiMigratedAt,
  setAiMigratedAt,
  clearLegacyAiGateway,
  type AiProvider,
  type AiBinding,
  type AiProjectRule,
  type AiGatewayState,
  type GatewayWire,
} from './state.js';
import type { BatchItemResult, BatchResult } from './batch.js';
import { log } from './logger.js';

export type { GatewayWire } from './state.js';
export { HOST_TARGET } from './state.js';

// 旧档迁移出的内置 provider id：与旧版写死的 provider 名一致，存量容器里的
// myapikey-chat 变体、锚点块、MYAPIKEY_API_KEY 环境变量语义全部不变，零落盘迁移。
const LEGACY_PROVIDER_ID = 'myapikey';
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const WIRES: GatewayWire[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];
const CONCURRENCY = 4;

// wire → 变体后缀（与旧版 myapikey-chat / -responses / -anthropic 一致）。
const WIRE_SUFFIX: Record<GatewayWire, string> = {
  'openai-chat': 'chat',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
};

// 多槽工具的有效 wire 列表（模块级统一缺省，别处不要再 ?? 散落）。
export function wiresOfBinding(b: AiBinding, tool: 'opencode' | 'pi'): GatewayWire[] {
  const list = b[tool]?.wires;
  if (!list) return ['openai-chat'];
  return [...new Set(list)];
}

// —— 解析层：绑定 + provider 库 → 应用计划 ——

// 写盘用的 provider 形状（解析后）。
export interface ResolvedProvider {
  id: string;
  endpoints: AiProvider['endpoints'];
  apiKey: string;
  models: string[];
}

// 解析后的应用计划：每个工具一组已解析 provider。单槽工具一个；多槽工具数组。
export interface AiApplyPlan {
  claude?: ResolvedProvider;
  codex?: { provider: ResolvedProvider; setDefault?: boolean };
  opencode?: { providers: ResolvedProvider[]; wires: GatewayWire[]; setDefault?: boolean };
  pi?: { providers: ResolvedProvider[]; wires: GatewayWire[]; setDefault?: boolean };
}

// 绑定解析：库里缺的 provider 记进 missing（应用时该工具失败并点名），不抛。
export function buildPlan(
  binding: AiBinding | undefined | null,
  lib: Record<string, AiProvider>,
): { plan: AiApplyPlan | null; missing: string[] } {
  if (!binding) return { plan: null, missing: [] };
  const missing: string[] = [];
  const resolve = (id: string): ResolvedProvider | null => {
    const p = lib[id];
    if (!p) {
      if (!missing.includes(id)) missing.push(id);
      return null;
    }
    return { id: p.id, endpoints: p.endpoints, apiKey: p.apiKey, models: p.models ?? [] };
  };
  const plan: AiApplyPlan = {};
  if (binding.claude) {
    const p = resolve(binding.claude.provider);
    if (p) plan.claude = p;
  }
  if (binding.codex) {
    const p = resolve(binding.codex.provider);
    if (p) plan.codex = { provider: p, setDefault: binding.codex.setDefault };
  }
  for (const tool of ['opencode', 'pi'] as const) {
    const t = binding[tool];
    if (!t) continue;
    const providers = t.providers.map(resolve).filter((p): p is ResolvedProvider => !!p);
    plan[tool] = { providers, wires: wiresOfBinding(binding, tool), setDefault: t.setDefault };
  }
  const any = plan.claude || plan.codex || plan.opencode || plan.pi;
  return { plan: any ? plan : null, missing };
}

// 绑定校验（routes 转 400）：引用存在、协议合法、端点侧匹配。返回错误文案或 null。
export function validateBinding(binding: unknown, lib: Record<string, AiProvider>): string | null {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return 'binding 必须是对象';
  const b = binding as AiBinding;
  if (!b.claude && !b.codex && !b.opencode && !b.pi) return '至少配置一个工具';
  if (b.claude) {
    if (!b.claude?.provider) return 'claude.provider 必填';
    const p = lib[b.claude.provider];
    if (!p) return `claude 引用的 provider 不存在：${b.claude.provider}`;
    if (!p.endpoints.anthropic) return `provider ${p.id} 没有配置 Anthropic 兼容端点（claude 需要）`;
  }
  if (b.codex) {
    if (!b.codex?.provider) return 'codex.provider 必填';
    const p = lib[b.codex.provider];
    if (!p) return `codex 引用的 provider 不存在：${b.codex.provider}`;
    if (!p.endpoints.openai) return `provider ${p.id} 没有配置 OpenAI 兼容端点（codex 需要）`;
  }
  for (const tool of ['opencode', 'pi'] as const) {
    const t = b[tool];
    if (!t) continue;
    if (!Array.isArray(t.providers)) return `${tool}.providers 必须是数组`;
    for (const pid of t.providers) {
      if (!lib[pid]) return `${tool} 引用的 provider 不存在：${pid}`;
    }
    if (t.wires !== undefined) {
      if (!Array.isArray(t.wires)) return `${tool}.wires 必须是数组`;
      for (const w of t.wires) {
        if (!(WIRES as string[]).includes(w as string)) {
          return `${tool}.wires 非法：${String(w)}（合法值 ${WIRES.join('/')}）`;
        }
      }
      if (t.providers.length && t.wires.length === 0) {
        return `${tool} 选了 provider 但协议为空（清空请传 providers: []）`;
      }
    }
  }
  return null;
}

// —— 小工具 ——

// sh/zsh 通用的单引号转义（.zshrc 里 export 用）
function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

// 读 JSON 配置：不存在 → {}；存在但坏 → 抛（宁可报错也不覆盖用户的配置文件）
async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const raw = await readText(path);
  if (raw == null) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    throw new Error('not an object');
  } catch {
    throw new Error(`${path} 不是合法 JSON，拒绝覆盖，请手动合并`);
  }
}

async function writeJsonObject(path: string, obj: unknown): Promise<void> {
  await writeText(path, JSON.stringify(obj, null, 2) + '\n');
}

// 宿主绝对路径 → 人话相对展示：base 内的路径显示 ~/…，外部路径原样。
function relTo(base: string, path: string): string {
  const norm = base.replace(/\/+$/, '');
  if (path.startsWith(norm + '/')) return '~' + path.slice(norm.length);
  return path;
}

// —— 锚点块（TOML/zshrc）——

// 标记块锚点按 provider 独立：`# >>> <pid> >>>`。旧版形状就是 `# >>> myapikey >>>`
// （pid=myapikey），存量块天然被新读写兼容。
function anchorsOf(pid: string): { begin: string; end: string } {
  return { begin: `# >>> ${pid} >>>`, end: `# <<< ${pid} <<<` };
}

// 标记块整块替换：有该 provider 的 BEGIN..END 区间则原位替换，否则追加到文尾（补空行分隔）。
// 纯函数导出仅供冒烟/测试复用。
export function replaceAnchored(content: string, block: string, pid: string): string {
  const { begin, end } = anchorsOf(pid);
  const b = content.indexOf(begin);
  if (b >= 0) {
    const e = content.indexOf(end, b);
    if (e >= 0) return content.slice(0, b) + block + content.slice(e + end.length);
  }
  const base = content.length === 0 || content.endsWith('\n') ? content : content + '\n';
  return base + '\n' + block + '\n';
}

// 标记块整块移除（provider 删除 / 清覆盖的回收）：块前的追加空行一起收，别留尾巴。
export function removeAnchored(content: string, pid: string): string {
  const { begin, end } = anchorsOf(pid);
  const b = content.indexOf(begin);
  if (b < 0) return content;
  const e = content.indexOf(end, b);
  if (e < 0) return content;
  const head = content.slice(0, b);
  const tail = content.slice(e + end.length);
  if (tail.trim() === '') return head.replace(/\n+$/, head.trim() === '' ? '' : '\n');
  return head.replace(/\n+$/, '\n') + tail.replace(/^\n+/, '');
}

// TOML 顶层键必须在第一个表头之前。setDefault 的 model_provider 不能进尾部
// provider 块（会落进该表作用域），单独在前导区设置/替换。
export function tomlSetTopLevel(content: string, key: string, line: string): string {
  const lines = content.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[') && !t.startsWith('#[')) {
      headerIdx = i;
      break;
    }
  }
  const scopeEnd = headerIdx === -1 ? lines.length : headerIdx;
  const re = new RegExp(`^${key}\\s*=`);
  for (let i = 0; i < scopeEnd; i++) {
    if (re.test(lines[i].trim())) {
      lines[i] = line;
      return lines.join('\n');
    }
  }
  lines.splice(scopeEnd, 0, line);
  return lines.join('\n');
}

// TOML 顶层键移除（仅当值引用了 expect）——provider 删除后 model_provider 悬空
// 引用比「回到内置默认」更糟，删行让 codex 落回默认。
export function tomlRemoveTopLevelIf(content: string, key: string, expect: string): string {
  const lines = content.split('\n');
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('[') && !t.startsWith('#[')) {
      headerIdx = i;
      break;
    }
  }
  const scopeEnd = headerIdx === -1 ? lines.length : headerIdx;
  const re = new RegExp(`^${key}\\s*=`);
  for (let i = 0; i < scopeEnd; i++) {
    if (re.test(lines[i].trim()) && lines[i].includes(`"${expect}"`)) {
      lines.splice(i, 1);
      return lines.join('\n');
    }
  }
  return content;
}

// codex env_key 指向的环境变量名：每 provider 独立（多 provider 共存时 key 隔离）。
// myapikey → MYAPIKEY_API_KEY，与旧版同名（存量 .zshrc 块语义不变）。
export function envKeyFor(pid: string): string {
  return pid.toUpperCase().replace(/-/g, '_') + '_API_KEY';
}

// —— 各工具写入器。全部幂等，成功后往 notes 推一行人话摘要。——

// claude：.claude/settings.json env 块注入（单槽——重绑即覆盖）。base = 用户 home
// 或项目根（项目级 = <dir>/.claude/settings.json，项目设置覆盖全局是工具自己的合并
// 语义，我们不发明别的）。
async function configClaude(base: string, p: ResolvedProvider, notes: string[]): Promise<void> {
  if (!p.endpoints.anthropic?.baseUrl) {
    throw new Error(`provider ${p.id} 没有配置 Anthropic 兼容端点`);
  }
  const path = join(base, '.claude', 'settings.json');
  const obj = await readJsonObject(path);
  obj.env = {
    ...((obj.env as Record<string, unknown> | undefined) ?? {}),
    ANTHROPIC_BASE_URL: p.endpoints.anthropic.baseUrl,
    ANTHROPIC_AUTH_TOKEN: p.apiKey,
  };
  await writeJsonObject(path, obj);
  notes.push(`claude: 写 ${relTo(base, path)}（${p.id} env 注入，CLI 启动即生效）`);
}

// codex：config.toml 每 provider 一个锚点块 + .zshrc 各自的 env export 块。回收 =
// managedIds 里未绑定的 provider：整块移除 + 悬空 model_provider 删行。
async function configCodex(
  base: string,
  p: ResolvedProvider,
  opts: { setDefault?: boolean },
  managedIds: string[],
  notes: string[],
): Promise<void> {
  if (!p.endpoints.openai?.baseUrl) {
    throw new Error(`provider ${p.id} 没有配置 OpenAI 兼容端点`);
  }
  const tomlPath = join(base, '.codex', 'config.toml');
  const zshPath = join(base, '.zshrc');
  let toml = (await readText(tomlPath)) ?? '';
  let zsh = (await readText(zshPath)) ?? '';
  const a = anchorsOf(p.id);
  // codex 官方 API 已停 chat completions，wire_api 固定 responses——没有选项可言。
  const tomlBlock = [
    a.begin,
    `[model_providers.${p.id}]`,
    `name = "${p.id}"`,
    `base_url = "${p.endpoints.openai.baseUrl}"`,
    `wire_api = "responses"`,
    `env_key = "${envKeyFor(p.id)}"`,
    a.end,
  ].join('\n');
  const zshBlock = [a.begin, `export ${envKeyFor(p.id)}=${shq(p.apiKey)}`, a.end].join('\n');
  toml = replaceAnchored(toml, tomlBlock, p.id);
  zsh = replaceAnchored(zsh, zshBlock, p.id);
  for (const pid of managedIds) {
    if (pid === p.id) continue;
    toml = removeAnchored(toml, pid);
    zsh = removeAnchored(zsh, pid);
    toml = tomlRemoveTopLevelIf(toml, 'model_provider', pid);
  }
  if (opts.setDefault) {
    toml = tomlSetTopLevel(toml, 'model_provider', `model_provider = "${p.id}"`);
  }
  await writeText(tomlPath, toml);
  await writeText(zshPath, zsh);
  notes.push(
    `codex: 写 ${relTo(base, tomlPath)}${opts.setDefault ? `（默认 provider = ${p.id}）` : ''} + ${relTo(base, zshPath)}`,
  );
}

// 去 // 行注释与 /* */ 块注释（串内的不管——jsonc 用户配置罕见字符串含 //，
// 误伤概率低于拒配 whole file）。再去尾逗号。
function stripJsonc(src: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < src.length) out += src[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i + 1 < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

// wire → 人话标签（notes 摘要用）
function wireLabel(wire: GatewayWire): string {
  return wire === 'openai-responses'
    ? 'OpenAI responses 协议'
    : wire === 'anthropic-messages'
      ? 'Anthropic messages 协议'
      : 'OpenAI chat 协议';
}

// 指定 wire 取对应侧端点（anthropic-messages 走 anthropic 侧，其余走 openai 侧）。
function baseUrlFor(p: ResolvedProvider, wire: GatewayWire): string {
  const side = wire === 'anthropic-messages' ? p.endpoints.anthropic : p.endpoints.openai;
  if (!side?.baseUrl) {
    throw new Error(
      `provider ${p.id} 没有 ${wire === 'anthropic-messages' ? 'Anthropic' : 'OpenAI'} 兼容端点（wire=${wire} 需要）`,
    );
  }
  return side.baseUrl;
}

// 受管 variant key 全集（managedIds × 全部 wire）——prune 的回收依据。
function managedVariantKeys(managedIds: string[]): Set<string> {
  const out = new Set<string>();
  for (const pid of managedIds) {
    for (const w of WIRES) out.add(`${pid}-${WIRE_SUFFIX[w]}`);
  }
  return out;
}

// 从 JSON 配置对象里清除受管 variant key 中不在 keep 集合里的条目（取消绑定/删
// provider 后残留会让工具的 /models 里出现指向未知配置的死条目）。返回删除数。
function pruneVariantsIn(obj: Record<string, unknown>, keys: Set<string>, keep: Set<string>): number {
  let removed = 0;
  for (const sectionKey of ['provider', 'providers'] as const) {
    const section = obj[sectionKey] as Record<string, unknown> | undefined;
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    for (const key of keys) {
      if (keep.has(key)) continue;
      if (key in section) {
        delete section[key];
        removed++;
      }
    }
  }
  return removed;
}

// 读 opencode 配置（json/jsonc 存量自适应）：不存在 → {path: 标准路径, obj: {}}；
// 存在但坏 → 抛（宁可报错也不覆盖用户的配置文件）。
async function readOpencodeConfig(
  dir: string,
): Promise<{ path: string; obj: Record<string, unknown>; hadComments: boolean }> {
  const jsonPath = join(dir, 'opencode.json');
  const jsoncPath = join(dir, 'opencode.jsonc');
  const useJsonc = !existsSync(jsonPath) && existsSync(jsoncPath);
  const path = useJsonc ? jsoncPath : jsonPath;
  const raw = await readText(path);
  if (raw == null) return { path, obj: {}, hadComments: false };
  let obj: Record<string, unknown>;
  let hadComments = false;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    try {
      obj = JSON.parse(stripJsonc(raw)) as Record<string, unknown>;
      hadComments = raw !== JSON.stringify(obj, null, 2);
    } catch {
      throw new Error(`${path} 既非 JSON 也非可解析的 JSONC，拒绝覆盖`);
    }
  }
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${path} 顶层不是对象，拒绝覆盖`);
  }
  return { path, obj, hadComments };
}

// opencode：provider 变体 = <pid>-<suffix>（user scope: ~/.config/opencode/；project
// scope: <dir>/opencode.json）。每 provider × wire 一个独立变体（同 key 不同协议语义），
// 工具内 /models 按 <变体>/<模型> 切。
async function configOpencode(
  base: string,
  scope: 'user' | 'project',
  providers: ResolvedProvider[],
  wires: GatewayWire[],
  setDefault: boolean | undefined,
  managedIds: string[],
  notes: string[],
): Promise<void> {
  // 先全量校验端点侧，再动文件——单个 provider 缺侧不落半个写。
  for (const p of providers) {
    for (const wire of wires) baseUrlFor(p, wire);
  }
  const dir = scope === 'user' ? join(base, '.config', 'opencode') : base;
  const { path, obj, hadComments } = await readOpencodeConfig(dir);
  const keep = new Set<string>();
  for (const p of providers) {
    for (const wire of wires) {
      const key = `${p.id}-${WIRE_SUFFIX[wire]}`;
      keep.add(key);
      const entry = {
        npm:
          wire === 'anthropic-messages'
            ? '@ai-sdk/anthropic'
            : wire === 'openai-responses'
              ? '@ai-sdk/openai'
              : '@ai-sdk/openai-compatible',
        name: `${p.id} ${wireLabel(wire)}`,
        options: { baseURL: baseUrlFor(p, wire), apiKey: p.apiKey },
        ...(p.models.length ? { models: Object.fromEntries(p.models.map((m) => [m, { name: m }])) } : {}),
      };
      obj.provider = { ...((obj.provider as object) ?? {}), [key]: entry };
      obj.providers = { ...((obj.providers as object) ?? {}), [key]: entry };
    }
  }
  pruneVariantsIn(obj, managedVariantKeys(managedIds), keep);
  if (setDefault && providers.length && wires.length && providers[0].models.length) {
    obj.model = `${providers[0].id}-${WIRE_SUFFIX[wires[0]]}/${providers[0].models[0]}`;
  }
  await writeJsonObject(path, obj);
  notes.push(
    `opencode: 写 ${relTo(base, path)}（${providers.map((p) => p.id).join('、') || '无'} × ${
      wires.map(wireLabel).join('、') || '无变体'
    }）${hadComments ? '（原文件含注释，已按 JSON 重写）' : ''}${
      setDefault && providers.length && wires.length && providers[0].models.length
        ? `（默认 ${String(obj.model)}）`
        : ''
    }`,
  );
}

// pi：providers.<pid>-<suffix>（user scope: ~/.pi/agent/models.json；项目级无此形状）。
async function configPi(
  base: string,
  providers: ResolvedProvider[],
  wires: GatewayWire[],
  managedIds: string[],
  notes: string[],
): Promise<void> {
  for (const p of providers) {
    for (const wire of wires) baseUrlFor(p, wire);
  }
  const path = join(base, '.pi', 'agent', 'models.json');
  const obj = await readJsonObject(path);
  const keep = new Set<string>();
  for (const p of providers) {
    for (const wire of wires) {
      const key = `${p.id}-${WIRE_SUFFIX[wire]}`;
      keep.add(key);
      obj.providers = {
        ...((obj.providers as object) ?? {}),
        [key]: {
          name: `${p.id} ${wireLabel(wire)}`,
          baseUrl: baseUrlFor(p, wire),
          api:
            wire === 'anthropic-messages'
              ? 'anthropic-messages'
              : wire === 'openai-responses'
                ? 'openai-responses'
                : 'openai-completions',
          apiKey: p.apiKey,
          ...(p.models.length ? { models: p.models.map((id) => ({ id, name: id })) } : {}),
        },
      };
    }
  }
  pruneVariantsIn(obj, managedVariantKeys(managedIds), keep);
  await writeJsonObject(path, obj);
  notes.push(
    `pi: 写 ${relTo(base, path)}（${providers.map((p) => p.id).join('、') || '无'} × ${
      wires.map(wireLabel).join('、') || '无变体'
    }）`,
  );
}

// —— 计划落盘 ——

// 把计划写进一个 base（用户 home 或项目目录）。逐工具执行，单工具失败不拖垮其他；
// notes 收人话摘要，返回失败的工具名。scope 区分 opencode 的落点（项目级无 pi/codex）。
async function applyPlanToHome(
  base: string,
  plan: AiApplyPlan,
  managedIds: string[],
  notes: string[],
  scope: 'user' | 'project' = 'user',
): Promise<string[]> {
  const failed: string[] = [];
  if (plan.claude) {
    try {
      await configClaude(base, plan.claude, notes);
    } catch (e) {
      failed.push('claude');
      notes.push(`claude: 失败 — ${errMsg(e)}`);
      log.warn({ base, tool: 'claude', err: errMsg(e) }, 'ai-config tool failed');
    }
  }
  if (plan.codex && scope === 'user') {
    try {
      await configCodex(base, plan.codex.provider, { setDefault: plan.codex.setDefault }, managedIds, notes);
    } catch (e) {
      failed.push('codex');
      notes.push(`codex: 失败 — ${errMsg(e)}`);
      log.warn({ base, tool: 'codex', err: errMsg(e) }, 'ai-config tool failed');
    }
  }
  if (plan.opencode) {
    try {
      await configOpencode(base, scope, plan.opencode.providers, plan.opencode.wires, plan.opencode.setDefault, managedIds, notes);
    } catch (e) {
      failed.push('opencode');
      notes.push(`opencode: 失败 — ${errMsg(e)}`);
      log.warn({ base, tool: 'opencode', err: errMsg(e) }, 'ai-config tool failed');
    }
  }
  if (plan.pi && scope === 'user') {
    try {
      await configPi(base, plan.pi.providers, plan.pi.wires, managedIds, notes);
    } catch (e) {
      failed.push('pi');
      notes.push(`pi: 失败 — ${errMsg(e)}`);
      log.warn({ base, tool: 'pi', err: errMsg(e) }, 'ai-config tool failed');
    }
  }
  return failed;
}

// —— 探测 ——

// 本机探测：进程内 fetch，6s 超时。HTTP 码本身不代表鉴权通过——连通性目的即达成。
// 两侧 baseUrl 约定不同：anthropic 侧按 Claude Code 的 ANTHROPIC_BASE_URL 约定不含
// /v1（客户端自己拼 /v1/messages），列表在 <base>/v1/models；openai 侧 baseUrl 含
// /v1，直接拼 /models。
async function probeHttp(kind: 'OpenAI 兼容' | 'Anthropic 兼容', baseUrl: string): Promise<string> {
  const probePath = kind === 'Anthropic 兼容' ? '/v1/models' : '/models';
  const url = baseUrl.replace(/\/$/, '') + probePath;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    const code = String(r.status);
    // 404/405 = 网络与 HTTP 服务都通，只是网关没开模型列表这条路由（有的中转只实现
    // 调用端点）——不算故障，单独说明免得被误读成出错
    if (code === '404' || code === '405') {
      return `探测: ${kind}网关可达 (HTTP ${code}，${probePath} 探测路径未开放，不影响实际调用)`;
    }
    return `探测: ${kind}网关可达 (HTTP ${code})`;
  } catch {
    return `探测: ${kind}网关不可达（${url}）`;
  }
}

// 容器探测：execRun curl 打模型列表端点，只看连通（仅 running 容器做，失败不影响配置写入）。
async function probeContainer(
  cfg: Config,
  id: string,
  kind: 'OpenAI 兼容' | 'Anthropic 兼容',
  baseUrl: string,
): Promise<string> {
  const probePath = kind === 'Anthropic 兼容' ? '/v1/models' : '/models';
  try {
    const r = await execRun(cfg, id, {
      Cmd: ['sh', '-c', `curl -m 5 -s -o /dev/null -w '%{http_code}' ${shq(baseUrl.replace(/\/$/, '') + probePath)}`],
      Tty: false,
      timeoutMs: 8_000,
    });
    const code = r.stdout.trim();
    if (!code || code === '000') return `探测: ${kind}网关不可达（容器内连不上，检查防火墙/地址）`;
    if (code === '404' || code === '405') {
      return `探测: ${kind}网关可达 (HTTP ${code}，${probePath} 探测路径未开放，不影响实际调用)`;
    }
    return `探测: ${kind}网关可达 (HTTP ${code})`;
  } catch {
    return `探测: ${kind}失败（curl 缺失或超时），不影响配置`;
  }
}

// 计划里实际用到的协议端点（按 provider×wire 聚合去重）——只探本目标用到的。
async function probePlan(
  cfg: Config,
  target: string,
  plan: AiApplyPlan,
): Promise<string[]> {
  const checks = new Map<string, { kind: 'OpenAI 兼容' | 'Anthropic 兼容'; url: string }>();
  const add = (kind: 'OpenAI 兼容' | 'Anthropic 兼容', url?: string) => {
    if (url) checks.set(url, { kind, url });
  };
  if (plan.claude) add('Anthropic 兼容', plan.claude.endpoints.anthropic?.baseUrl);
  if (plan.codex) add('OpenAI 兼容', plan.codex.provider.endpoints.openai?.baseUrl);
  for (const tool of ['opencode', 'pi'] as const) {
    const t = plan[tool];
    if (!t) continue;
    for (const p of t.providers) {
      for (const wire of t.wires) {
        if (wire === 'anthropic-messages') add('Anthropic 兼容', p.endpoints.anthropic?.baseUrl);
        else add('OpenAI 兼容', p.endpoints.openai?.baseUrl);
      }
    }
  }
  if (!checks.size) return [];
  if (target === HOST_TARGET) {
    const out: string[] = [];
    for (const c of checks.values()) out.push(await probeHttp(c.kind, c.url));
    return out;
  }
  let running = false;
  try {
    running = (await inspectContainer(cfg, target)).running;
  } catch {
    return []; // 容器不可见：跳过探测（写入已完成）
  }
  if (!running) return [];
  const out: string[] = [];
  for (const c of checks.values()) out.push(await probeContainer(cfg, target, c.kind, c.url));
  return out;
}

// —— 目标应用 ——

// 目标定位：'__host__' = 本机 home；否则容器名（D1 直通宿主可直写 rootfs home）。
function homeOf(cfg: Config, target: string): string | null {
  if (target === HOST_TARGET) return homedir();
  return getEngine(cfg).hostHomePath(cfg, target);
}

function targetName(target: string): string {
  return target === HOST_TARGET ? '本机' : target;
}

// 单目标：解析绑定 → 定位 home → 逐工具写入（单工具失败不拖垮其他）→ 可选探测。
// 任何前置异常收敛成一条 result，绝不抛出。
async function applyOneTarget(
  cfg: Config,
  target: string,
  binding: AiBinding | undefined | null,
): Promise<BatchItemResult> {
  const id = target;
  const name = targetName(target);
  const finish = (
    ok: boolean,
    patch: Partial<BatchItemResult>,
  ): BatchItemResult => ({ id, name, ok, exitCode: ok ? 0 : 1, stdout: '', stderr: '', ...patch });
  try {
    const lib = await getAiProviders();
    const { plan, missing } = buildPlan(binding, lib);
    if (!plan) {
      return finish(missing.length ? false : true, {
        error: missing.length ? `绑定的 provider 不在库中：${missing.join('、')}` : undefined,
        stdout: '无可应用配置（绑定为空）',
      });
    }
    const home = homeOf(cfg, target);
    if (!home || !existsSync(home)) {
      return finish(false, { error: 'home not found（rootfs 未就绪或非标准布局）' });
    }
    const notes: string[] = [];
    for (const pid of missing) notes.push(`${pid}: provider 不在库中，跳过（「模型服务」补建或改绑定）`);
    const failed = await applyPlanToHome(home, plan, Object.keys(lib), notes);
    notes.push(...(await probePlan(cfg, target, plan)));
    const ok = failed.length === 0 && missing.length === 0;
    return finish(ok, {
      stdout: notes.join('\n'),
      error: missing.length ? `绑定的 provider 不在库中：${missing.join('、')}` : failed.length ? `${failed.join('/')} 写入失败` : undefined,
    });
  } catch (e) {
    return finish(false, { error: errMsg(e) });
  }
}

// 批量扇出：targets = 容器名 | HOST_TARGET。同一绑定逐目标解析应用。
export async function applyAiBindingToTargets(
  cfg: Config,
  targets: string[],
  binding: AiBinding,
): Promise<BatchResult> {
  const limit = pLimit(CONCURRENCY);
  log.info({ op: 'ai-config', count: targets.length }, 'ai-config start');
  const items = await Promise.all(targets.map((t) => limit(() => applyOneTarget(cfg, t, binding))));
  const result: BatchResult = {
    total: items.length,
    ok: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length,
    items,
  };
  log.info({ op: 'ai-config', ok: result.ok, failed: result.failed }, 'ai-config done');
  return result;
}

// —— prune-only 回收（清本机覆盖 / 删 provider）——

// 把 base 里全部受管 provider 条目回收。claude 的 env 不动——单槽且可能混有用户
// 自己的值，删 provider 不猜；codex 块/zshrc 块/opencode+pi 变体按 id 精确回收。
async function pruneHomeManaged(
  base: string,
  managedIds: string[],
  notes: string[],
  scope: 'user' | 'project' = 'user',
): Promise<void> {
  if (!managedIds.length) return;
  if (scope === 'user') {
    const tomlPath = join(base, '.codex', 'config.toml');
    const zshPath = join(base, '.zshrc');
    let toml = (await readText(tomlPath)) ?? '';
    let zsh = (await readText(zshPath)) ?? '';
    let tomlTouched = false;
    let zshTouched = false;
    for (const pid of managedIds) {
      const t2 = removeAnchored(toml, pid);
      if (t2 !== toml) {
        toml = t2;
        tomlTouched = true;
      }
      if (toml.includes(`model_provider = "${pid}"`)) {
        toml = tomlRemoveTopLevelIf(toml, 'model_provider', pid);
        tomlTouched = true;
      }
      const z2 = removeAnchored(zsh, pid);
      if (z2 !== zsh) {
        zsh = z2;
        zshTouched = true;
      }
    }
    if (tomlTouched) {
      await writeText(tomlPath, toml);
      notes.push(`codex: 回收 ${relTo(base, tomlPath)}`);
    }
    if (zshTouched) {
      await writeText(zshPath, zsh);
      notes.push(`codex: 回收 ${relTo(base, zshPath)}`);
    }
  }
  // opencode（user = ~/.config/opencode；project = <dir>）
  const ocDir = scope === 'user' ? join(base, '.config', 'opencode') : base;
  try {
    const { path, obj } = await readOpencodeConfig(ocDir);
    if (pruneVariantsIn(obj, managedVariantKeys(managedIds), new Set()) > 0) {
      await writeJsonObject(path, obj);
      notes.push(`opencode: 回收 ${relTo(base, path)}`);
    }
  } catch (e) {
    notes.push(`opencode: 回收跳过 — ${errMsg(e)}`);
  }
  // pi（仅 user scope）
  if (scope === 'user') {
    const piPath = join(base, '.pi', 'agent', 'models.json');
    try {
      const obj = await readJsonObject(piPath);
      if (pruneVariantsIn(obj, managedVariantKeys(managedIds), new Set()) > 0) {
        await writeJsonObject(piPath, obj);
        notes.push(`pi: 回收 ${relTo(base, piPath)}`);
      }
    } catch {
      /* 无文件或坏文件：跳过（回收是尽力而为） */
    }
  }
}

// —— 声明式追平（sidecar 的绑定是期望状态）——

// 目标的有效绑定：目标覆盖 ?? 全局。都没有 = 无事发生。
async function bindingFor(target: string): Promise<AiBinding | undefined> {
  const overrides = await getAiTargetOverrides();
  return overrides[target] ?? (await getAiBinding());
}

// 建容器补发（lifecycle.create 后调用）：有绑定（覆盖优先）就照写一份，容器内凭据
// 与新容器同步就位。尽力而为不抛（失败靠下次 sweep/手动重推追平）。
export async function applyAiToContainer(cfg: Config, name: string): Promise<void> {
  try {
    const binding = await bindingFor(name);
    if (!binding) return;
    const home = getEngine(cfg).hostHomePath(cfg, name);
    if (!home || !existsSync(home)) return;
    await applyOneTarget(cfg, name, binding);
    log.info({ container: name }, 'ai-config applied to container');
  } catch (e) {
    log.warn({ container: name, err: String(e) }, 'ai-config apply to container failed');
  }
}

// 启动 sweep（cli.ts 装配）：逐受管容器按「覆盖 ?? 全局」应用（宿主直写 rootfs，容器
// 不必在跑）。本机不在 sweep——宿主 leon 是真实环境，只有显式覆盖才写，全局改 key
// 不连带刷掉宿主。都没有 = 无事发生；尽力而为不抛。
export async function applyAiAll(cfg: Config): Promise<void> {
  try {
    await ensureAiMigrated();
    const global = await getAiBinding();
    const overrides = await getAiTargetOverrides();
    if (global || Object.keys(overrides).length) {
      const views = await listManaged(cfg);
      const limit = pLimit(CONCURRENCY);
      const items = await Promise.all(
        views.map((v) =>
          limit(async () => {
            const binding = overrides[v.id] ?? global;
            if (!binding) return null;
            return applyOneTarget(cfg, v.id, binding);
          }),
        ),
      );
      const done = items.filter((i): i is BatchItemResult => i !== null);
      log.info(
        {
          op: 'ai-config',
          ok: done.filter((i) => i.ok).length,
          failed: done.filter((i) => !i.ok).length,
          overridden: done.filter((i) => overrides[i.id]).length,
        },
        'ai-config sweep done',
      );
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'ai-config startup sweep failed');
  }
  // 项目规则：全目标（本机 + 容器）按落点追平——本机没有 start 事件，全量追平靠这里。
  await applyAiProjectRulesAll(cfg);
}

// 保存目标覆盖（容器 or 本机）并立即应用到这台。
export async function setTargetOverride(
  cfg: Config,
  target: string,
  binding: AiBinding,
): Promise<BatchResult> {
  await setAiTargetOverride(target, binding);
  return applyAiBindingToTargets(cfg, [target], binding);
}

// 清除目标覆盖：
//   容器 = 恢复跟随全局——删覆盖 + 立即把全局绑定应用到这台（下次 sweep 兜底）。
//   本机 = 没有全局语义可回——删覆盖 + 回收本机 home 里全部受管条目。
export async function clearTargetOverride(cfg: Config, target: string): Promise<BatchResult | void> {
  await deleteAiTargetOverride(target);
  if (target !== HOST_TARGET) {
    const global = await getAiBinding();
    if (global) return applyAiBindingToTargets(cfg, [target], global);
    return;
  }
  const notes: string[] = [];
  try {
    await pruneHomeManaged(homedir(), Object.keys(await getAiProviders()), notes);
  } catch (e) {
    log.warn({ err: String(e) }, 'ai-config host prune failed');
  }
  log.info({ target, notes }, 'ai-config host override cleared');
}

// —— provider 库操作（routes 调用）——

// 删 provider：先从库删，再把它的落盘条目从本机 + 全部可见容器 home 回收（codex 块/
// zshrc 块/opencode+pi 变体；claude env 不动——单槽可能混用户自己的值）。引用它的
// 绑定不自动改：视图层可见引用缺失，重保存绑定即修复。
export async function removeAiProviderEverywhere(cfg: Config, id: string): Promise<void> {
  await deleteAiProvider(id);
  const homes: string[] = [homedir()];
  const engine = getEngine(cfg);
  try {
    for (const v of await listManaged(cfg)) {
      const h = engine.hostHomePath(cfg, v.id);
      if (h && existsSync(h)) homes.push(h);
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'ai provider removal: list managed failed');
  }
  for (const home of homes) {
    try {
      const notes: string[] = [];
      await pruneHomeManaged(home, [id], notes);
      if (notes.length) log.info({ provider: id, home, notes }, 'ai provider entries pruned');
    } catch (e) {
      log.warn({ provider: id, home, err: String(e) }, 'ai provider prune failed');
    }
  }
  log.info({ provider: id, homes: homes.length }, 'ai provider removed');
}

// provider 连通性探测（进程内，库页「探测」按钮用）。HTTP 码不代表鉴权通过。
export async function probeProvider(endpoints: AiProvider['endpoints']): Promise<{
  openai?: string;
  anthropic?: string;
}> {
  const out: { openai?: string; anthropic?: string } = {};
  if (endpoints.openai?.baseUrl) out.openai = await probeHttp('OpenAI 兼容', endpoints.openai.baseUrl);
  if (endpoints.anthropic?.baseUrl) out.anthropic = await probeHttp('Anthropic 兼容', endpoints.anthropic.baseUrl);
  return out;
}

// 从网关拉模型清单（两路独立，一路失败不影响另一路）。模型清单归 provider 所有
// （opencode/pi 变体下挂的就是它），分发时随绑定走。
export async function fetchProviderModels(endpoints: AiProvider['endpoints'], apiKey: string): Promise<{
  models: string[];
  errors: string[];
}> {
  const models = new Set<string>();
  const errors: string[] = [];
  const o = endpoints.openai?.baseUrl;
  if (o) {
    try {
      const r = await fetch(o.replace(/\/$/, '') + '/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { data?: { id?: string }[] };
      for (const m of j.data ?? []) if (m.id) models.add(m.id);
    } catch (e) {
      errors.push(`OpenAI 侧拉取失败：${errMsg(e)}`);
    }
  }
  const a = endpoints.anthropic?.baseUrl;
  if (a) {
    try {
      const r = await fetch(a.replace(/\/$/, '') + '/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { data?: { id?: string }[] };
      for (const m of j.data ?? []) if (m.id) models.add(m.id);
    } catch (e) {
      errors.push(`Anthropic 侧拉取失败：${errMsg(e)}`);
    }
  }
  return { models: [...models].sort(), errors };
}

// —— 项目级 AI 配置（像技能的项目规则）——

// 容器内路径 → home 内相对：'~/x' / '~' / '/home/dev/x'（契约 home=/home/dev）。
// 与 skillSync 的 containerRel 同形（那边私有，这边 10 行不抽公共）。
function containerRel(p: string): string {
  if (p === '~') return '';
  if (p.startsWith('~/')) return p.slice(2);
  if (p === '/home/dev') return '';
  if (p.startsWith('/home/dev/')) return p.slice('/home/dev/'.length);
  throw new Error(`容器内路径只认 ~/ 与 /home/dev 前缀（契约 home=/home/dev）："${p}"`);
}

// 项目落点探测：rel 的任一前缀（含 rel 本身）在 home 里已存在（同 skillSync）。
function landingExists(home: string, rel: string): boolean {
  const parts = rel.split('/');
  for (let i = parts.length; i >= 1; i--) {
    if (existsSync(join(home, parts.slice(0, i).join('/')))) return true;
  }
  return false;
}

// 宿主路径 → home 内相对：'~/x' / '~' / 宿主绝对路径（相对 $HOME）。宿主 spot 走
// 真实路径（文件面板宿主面板的 path 本身），与容器的契约前缀检查分形。
function hostRel(p: string): string {
  if (p === '~') return '';
  if (p.startsWith('~/')) return p.slice(2);
  const home = homedir().replace(/\/+$/, '');
  if (p === home) return '';
  if (p.startsWith(home + '/')) return p.slice(home.length + 1);
  throw new Error(`宿主路径必须在 home 内（${home}）："${p}"`);
}

// 全部 AI 配置目标：本机 + 全部受管容器（本机排最前——展示/结果里它先出现）。
async function allTargets(cfg: Config): Promise<string[]> {
  try {
    return [HOST_TARGET, ...(await listManaged(cfg)).map((v) => v.id)];
  } catch (e) {
    log.warn({ err: String(e) }, 'ai-config: list managed failed, host only');
    return [HOST_TARGET];
  }
}

// 项目规则校验：codex/pi 没有项目级配置形状（一期不支持，别硬凑），只收 claude/opencode。
export function validateProjectSelection(sel: unknown, lib: Record<string, AiProvider>): string | null {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) return '选择必须是对象';
  const s = sel as AiBinding;
  if (s.codex || s.pi) return 'codex / pi 没有项目级配置形状（项目级只支持 claude / opencode）';
  if (!s.claude && !s.opencode) return '至少配置 claude 或 opencode';
  return validateBinding(s, lib);
}

// 规则在单个目标上的项目级写入：只写「已有该项目」的目标（落点逐级向上探测），
// 没项目的不制造目录。本机与容器同构（homeOf 分流）。尽力而为不抛。
async function applyProjectRuleToTarget(cfg: Config, rule: AiProjectRule, target: string): Promise<void> {
  try {
    const home = homeOf(cfg, target);
    if (!home || !existsSync(home)) return;
    const rel = containerRel(rule.to);
    if (!landingExists(home, rel)) return;
    const lib = await getAiProviders();
    const { plan, missing } = buildPlan({ claude: rule.claude, opencode: rule.opencode }, lib);
    if (!plan) {
      if (missing.length) log.warn({ rule: rule.id, missing }, 'ai project rule: providers missing');
      return;
    }
    const root = join(home, rel);
    const notes: string[] = [];
    const failed = await applyPlanToHome(root, plan, Object.keys(lib), notes, 'project');
    if (failed.length) log.warn({ target, to: rule.to, failed }, 'ai project rule apply failed');
    else log.info({ target, to: rule.to }, 'ai project rule applied');
  } catch (e) {
    log.warn({ target, to: rule.to, err: String(e) }, 'ai project rule apply error');
  }
}

// 全部项目规则 → 全部目标（本机 + 受管容器；sweep 与手动触发用——本机没有 start
// 事件，项目规则的全量追平靠这里闭环）。
export async function applyAiProjectRulesAll(cfg: Config): Promise<void> {
  const rules = await getAiProjectRules();
  if (!rules.length) return;
  try {
    for (const rule of rules) {
      for (const target of await allTargets(cfg)) {
        await applyProjectRuleToTarget(cfg, rule, target);
      }
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'ai project rules sweep failed');
  }
}

// 就地安装（文件面板「AI 配置」入口——pull 语义：人到哪个项目就配到哪；本机同样
// 可配，container 传 HOST_TARGET）：把选择落成/并入项目规则 + 立即为该目标写一次。
// to 唯一（同一落点两种写法归并同一条规则）——宿主与容器的同一项目共享同一条规则，
// 克隆到别的目标 start 时自动跟上。规则此后由同步系统接管——安装只是规则系统的糖。
export async function installAiProjectRule(
  cfg: Config,
  container: string,
  spot: string,
  sel: { claude?: { provider: string }; opencode?: AiBinding['opencode'] },
): Promise<{ to: string; created: boolean; ruleId: string }> {
  const isHost = container === HOST_TARGET;
  const home = isHost ? homedir() : getEngine(cfg).hostHomePath(cfg, container);
  if (!home || !existsSync(home)) {
    throw new Error(isHost ? '本机 home 不可见' : `容器 ${container} 的 home 不可见`);
  }
  const rel = isHost ? hostRel(spot) : containerRel(spot);
  if (!rel) throw new Error('配置位置不能是 home 根（home 级走全局绑定/目标覆盖）');
  const to = `~/${rel}`;
  const lib = await getAiProviders();
  const invalid = validateProjectSelection(sel, lib);
  if (invalid) throw new Error(invalid);
  const rules = await getAiProjectRules();
  let rule = rules.find((r) => r.to === to);
  let created = false;
  if (!rule) {
    rule = { id: randomBytes(4).toString('hex'), to, createdAt: new Date().toISOString() };
    rules.push(rule);
    created = true;
  }
  if ('claude' in sel) rule.claude = sel.claude;
  if ('opencode' in sel) rule.opencode = sel.opencode;
  await setAiProjectRules(rules);
  await applyProjectRuleToTarget(cfg, rule, container);
  log.info({ container, to, created }, 'ai project rule installed at spot');
  return { to, created, ruleId: rule.id };
}

// 删项目规则 + 孤儿回收：把该 to 在所有「已有该项目」目标（本机 + 容器）里的受管
// 条目清掉（prune-only 对项目根；claude env 仅当 base URL 与规则绑定的 provider 端点
// 一致才删——不猜用户的值）。
export async function deleteAiProjectRuleById(cfg: Config, id: string): Promise<void> {
  const rules = await getAiProjectRules();
  const rule = rules.find((r) => r.id === id);
  if (!rule) throw new Error(`规则不存在：${id}`);
  await setAiProjectRules(rules.filter((r) => r.id !== id));
  const lib = await getAiProviders();
  const rel = containerRel(rule.to);
  const anthropicUrl = rule.claude ? lib[rule.claude.provider]?.endpoints.anthropic?.baseUrl : undefined;
  try {
    for (const target of await allTargets(cfg)) {
      const home = homeOf(cfg, target);
      if (!home || !existsSync(home)) continue;
      if (!landingExists(home, rel)) continue;
      const root = join(home, rel);
      const notes: string[] = [];
      await pruneHomeManaged(root, Object.keys(lib), notes, 'project');
      if (anthropicUrl) {
        const settingsPath = join(root, '.claude', 'settings.json');
        try {
          const obj = await readJsonObject(settingsPath);
          const env = obj.env as Record<string, unknown> | undefined;
          if (env && env.ANTHROPIC_BASE_URL === anthropicUrl) {
            delete env.ANTHROPIC_BASE_URL;
            delete env.ANTHROPIC_AUTH_TOKEN;
            if (!Object.keys(env).length) delete obj.env;
            await writeJsonObject(settingsPath, obj);
            notes.push(`claude: 回收 ${relTo(root, settingsPath)}`);
          }
        } catch {
          /* 无文件/坏文件：跳过 */
        }
      }
      if (notes.length) log.info({ target, to: rule.to, notes }, 'ai project rule orphan pruned');
    }
  } catch (e) {
    log.warn({ rule: id, err: String(e) }, 'ai project rule orphan cleanup failed');
  }
}

// 容器 start/restart 事件补发（cli.ts 装配）：home 级绑定（覆盖 ?? 全局）+ 项目规则
// 一起闭环停机期间的变化。断线指数退避重连（hosts-sync/skillSync 同款骨架）。
const startTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function startAiConfigEvents(cfg: Config): void {
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeEvents(cfg, (ev) => {
          if (ev.action !== 'start' && ev.action !== 'restart') return;
          const id = ev.containerId;
          const t = startTimers.get(id);
          if (t) clearTimeout(t);
          startTimers.set(
            id,
            setTimeout(() => {
              startTimers.delete(id);
              void Promise.all([applyAiToContainer(cfg, id), applyProjectRulesAllToContainer(cfg, id)]).catch(
                (e) => log.warn({ container: id, err: String(e) }, 'ai-config event sync failed'),
              );
            }, 2_000),
          );
        });
        delay = 1_000;
        log.info({ engine: 'lxc' }, 'ai-config event sync: subscribed');
        await sub.closed;
      } catch (e) {
        log.warn({ err: String(e), retryMs: delay }, 'ai-config event sync: subscribe failed, retrying');
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}

// 单容器的全部项目规则补发（事件路径；显式失败仅记日志）。
async function applyProjectRulesAllToContainer(cfg: Config, name: string): Promise<void> {
  for (const rule of await getAiProjectRules()) {
    await applyProjectRuleToTarget(cfg, rule, name);
  }
}

// —— 旧单网关档迁移（一次性）——
// aiGateway/aiGatewayOverrides → provider 'myapikey'（id 不变——存量容器里的
// myapikey-chat 变体、`# >>> myapikey >>>` 锚点块、MYAPIKEY_API_KEY 环境变量全部
// 语义不变，零落盘迁移）+ 全局绑定/目标覆盖引用它。迁移后旧键删除（避免双真相源）。
let migratedInProc = false; // 进程内缓存：迁移只跑一次，sweep/路由反复进来不再读盘
export async function ensureAiMigrated(): Promise<void> {
  if (migratedInProc) return;
  const done = await getAiMigratedAt();
  if (done) {
    migratedInProc = true;
    return;
  }
  try {
    const global = await getAiGateway();
    const overrides = await getAiGatewayOverrides();
    if (global || Object.keys(overrides).length) {
      const src = global ?? Object.values(overrides)[0]!;
      await setAiProvider({
        id: LEGACY_PROVIDER_ID,
        name: 'myapikey（迁移）',
        endpoints: src.endpoints,
        apiKey: src.apiKey,
        models: src.models,
        createdAt: new Date().toISOString(),
        updatedAt: src.updatedAt,
      });
      const toBinding = (g: AiGatewayState): AiBinding => ({
        ...(g.tools.claude ? { claude: { provider: LEGACY_PROVIDER_ID } } : {}),
        ...(g.tools.codex ? { codex: { provider: LEGACY_PROVIDER_ID, setDefault: g.setDefault } } : {}),
        ...(g.tools.opencode
          ? { opencode: { providers: [LEGACY_PROVIDER_ID], wires: g.wire?.opencode ?? ['openai-chat'], setDefault: g.setDefault } }
          : {}),
        ...(g.tools.pi ? { pi: { providers: [LEGACY_PROVIDER_ID], wires: g.wire?.pi ?? ['openai-chat'] } } : {}),
      });
      if (global) await setAiBinding(toBinding(global));
      for (const [target, g] of Object.entries(overrides)) {
        await setAiTargetOverride(target, toBinding(g));
      }
      log.info(
        { overrides: Object.keys(overrides).length },
        'ai-config: legacy single-gateway state migrated to provider library + bindings',
      );
    }
    await setAiMigratedAt(new Date().toISOString());
    await clearLegacyAiGateway();
  } catch (e) {
    log.warn({ err: String(e) }, 'ai-config legacy migration failed');
    return; // 不置位：下次再试（旧键还在，数据没丢）
  }
  migratedInProc = true;
}
