// AI 网关批量配置：把任意 OpenAI/Anthropic 兼容网关（如 myapikey）的接入配置
// 批量分发到容器的 home。与 batch.ts 的 exec 路线不同——这里走 **宿主直写 rootfs**
// （D1 uid 直通：容器内 dev(1000) = 宿主 leon，直写的文件属主天然正确），所以
// 容器不必在跑，CLI 下次启动即生效。
//
// 端点按 wire 协议分两条路（endpoints.openai / endpoints.anthropic）。各工具的协议情况：
// - claude    固定 Anthropic Messages（env 注入）
// - codex     固定 OpenAI Responses——官方 API 已停 /v1/chat/completions，没有选项可言
// - opencode  wire 多选（数组）：每个选中的协议注册一个独立 provider 变体
//             （myapikey-chat / myapikey-responses / myapikey-anthropic），
//             同一网关的模型按协议挂在各自变体下，工具内 /models 可切
// - pi        同 opencode，api 字段 openai-completions|openai-responses|anthropic-messages
//
// 各工具落点（相对容器 home）：
// - claude   .claude/settings.json          env 块注入 BASE_URL/AUTH_TOKEN（Claude Code 自读，不依赖 shell）
// - codex    .codex/config.toml            锚点块追加 model_providers.myapikey（responses）
//            .zshrc                        锚点块 export MYAPIKEY_API_KEY（codex 只认 env_key 引用的运行时环境）
// - opencode .config/opencode/opencode.json 合并 provider.<变体>*（key 明文内联，零环境依赖）
// - pi       .pi/agent/models.json         合并 providers.<变体>*（apiKey 内联字面量）
//
// 幂等靠两类锚点：JSON 只深改本方案的键（保留用户其余配置；变体 provider 重跑只更新对应键，
// 协议被取消勾选时旧变体条目清除）；TOML/zshrc 用 `# >>> myapikey >>>` … 标记块整块替换。
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { execRun, getEngine, inspectContainer, listManaged } from './engine/index.js';
import { getAiGateway, getAiGatewayOverrides, setAiGatewayOverride, deleteAiGatewayOverride } from './state.js';
import type { BatchItemResult, BatchResult } from './batch.js';
import { log } from './logger.js';

export const CODEX_PROVIDER_ID = 'myapikey';
const PROVIDER_ID = CODEX_PROVIDER_ID; // codex 的 provider 名就是主 ID
const KEY_ENV = 'MYAPIKEY_API_KEY'; // codex env_key 指向的环境变量名
const CONCURRENCY = 4;

// wire 协议统一枚举。
export type GatewayWire = 'openai-chat' | 'openai-responses' | 'anthropic-messages';

// 多选工具的三个变体后缀：同网关同 key，仅 wire 不同 → 独立 provider 条目并存。
const WIRE_VARIANTS: Record<Exclude<GatewayWire, never>, string> = {
  'openai-chat': `${CODEX_PROVIDER_ID}-chat`,
  'openai-responses': `${CODEX_PROVIDER_ID}-responses`,
  'anthropic-messages': `${CODEX_PROVIDER_ID}-anthropic`,
};

export interface AiGatewayInput {
  // 两条协议端点；用到哪条哪条必填（校验按所勾工具 + wire 推导，见 routes）
  endpoints: {
    openai?: { baseUrl: string }; // OpenAI 兼容端点（…/openai/v1）
    anthropic?: { baseUrl: string }; // Anthropic 兼容端点（…/anthropic）
  };
  apiKey: string;
  tools: { claude: boolean; codex: boolean; opencode: boolean; pi: boolean };
  // 各工具的 wire 协议多选；claude 固定 anthropic、codex 固定 responses 都不进表。
  // 缺省 []？不——缺省视为 ['openai-chat']（无脑最稳公共分母），空数组表示显式清空所有变体。
  wire?: {
    opencode?: GatewayWire[];
    pi?: GatewayWire[];
  };
  // 模型 ID 列表：opencode 的 models 映射与 pi 的 models 注册共用；codex 不需要。
  models?: string[];
  // codex：额外把 model_provider 设为 myapikey；opencode：把 model 设为 <首个变体>/<首个模型>
  setDefault?: boolean;
}

// 读某工具的有效 wire 列表（模块级统一缺省，别处不要再 ?? 散落；routes 校验也用它）。
// 剔除重复项保序。未传 → ['openai-chat']，空数组 → 显式无变体。
export function wiresOf(input: AiGatewayInput, tool: 'opencode' | 'pi'): GatewayWire[] {
  const list = input.wire?.[tool];
  if (!list) return ['openai-chat'];
  return [...new Set(list)];
}

// —— 小工具 ——

// sh/zsh 通用的单引号转义（.zshrc 里 export 用）
function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
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
    throw new Error(`${relHome(path)} 不是合法 JSON，拒绝覆盖，请手动合并`);
  }
}

async function writeJsonObject(path: string, obj: unknown): Promise<void> {
  await writeText(path, JSON.stringify(obj, null, 2) + '\n');
}

// 宿主绝对路径 → 容器内 ~/ 相对展示（仅用于人话摘要）
function relHome(hostPath: string): string {
  const idx = hostPath.indexOf('/rootfs/home/dev/');
  return idx >= 0 ? '~' + hostPath.slice(idx + '/rootfs/home/dev'.length) : hostPath;
}

// 标记块整块替换：有 BEGIN..END 区间则原位替换，否则追加到文尾（补空行分隔）。
// 纯函数导出仅供冒烟/测试复用。
const BEGIN = '# >>> myapikey >>>';
const END = '# <<< myapikey <<<';
export function replaceAnchored(content: string, block: string): string {
  const b = content.indexOf(BEGIN);
  if (b >= 0) {
    const e = content.indexOf(END, b);
    if (e >= 0) return content.slice(0, b) + block + content.slice(e + END.length);
  }
  const base = content.length === 0 || content.endsWith('\n') ? content : content + '\n';
  return base + '\n' + block + '\n';
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

// —— 各工具写入器。全部幂等，成功后往 notes 推一行人话摘要。——

type Writer = (home: string, input: AiGatewayInput, notes: string[]) => Promise<void>;

const configClaude: Writer = async (home, input, notes) => {
  const path = join(home, '.claude', 'settings.json');
  const obj = await readJsonObject(path);
  obj.env = {
    ...((obj.env as Record<string, unknown> | undefined) ?? {}),
    ANTHROPIC_BASE_URL: input.endpoints.anthropic!.baseUrl,
    ANTHROPIC_AUTH_TOKEN: input.apiKey,
  };
  await writeJsonObject(path, obj);
  notes.push(`claude: 写 ${relHome(path)}（env 注入，CLI 启动即生效）`);
};

const configCodex: Writer = async (home, input, notes) => {
  // config.toml：尾部锚点块加 provider 表。codex 官方 API 已停 chat completions，
  // wire_api 固定 responses——没有选项可言，也就不进 wire 多选。
  const tomlPath = join(home, '.codex', 'config.toml');
  const raw = (await readText(tomlPath)) ?? '';
  const block = [
    BEGIN,
    `[model_providers.${PROVIDER_ID}]`,
    `name = "${PROVIDER_ID}"`,
    `base_url = "${input.endpoints.openai!.baseUrl}"`,
    `wire_api = "responses"`,
    `env_key = "${KEY_ENV}"`,
    END,
  ].join('\n');
  let next = replaceAnchored(raw, block);
  if (input.setDefault) {
    next = tomlSetTopLevel(next, 'model_provider', `model_provider = "${PROVIDER_ID}"`);
  }
  await writeText(tomlPath, next);

  // 2) .zshrc：codex 只从运行时环境读 env_key，标记块 export（登录 shell 都会带上）
  const zshPath = join(home, '.zshrc');
  const zshRaw = (await readText(zshPath)) ?? '';
  const zshNext = replaceAnchored(
    zshRaw,
    [BEGIN, `export ${KEY_ENV}=${shq(input.apiKey)}`, END].join('\n'),
  );
  await writeText(zshPath, zshNext);
  notes.push(
    `codex: 写 ${relHome(tomlPath)}${input.setDefault ? '（设为默认 provider）' : ''} + ${relHome(zshPath)}`,
  );
};

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
      while (i < src.length && src[i] !== '\n') i++;
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

// 从 JSON 配置对象里清除本方案变体中已不在 wires 集合里的旧条目（协议被取消勾选后
// 上次写入的变体不能残留——残留会让工具的 /models 里出现指向未知配置的死条目）。
function pruneVariants(
  section: Record<string, unknown> | undefined,
  wires: Set<string>,
): Record<string, unknown> | undefined {
  if (!section) return section;
  for (const [wire, variant] of Object.entries(WIRE_VARIANTS)) {
    if (!wires.has(wire)) delete section[variant];
  }
  return section;
}

const configOpencode: Writer = async (home, input, notes) => {
  // 存量文件名自适应：有人（和部分版本文档）用 .jsonc。存在哪个就写回哪个；
  // 都没有则落标准 opencode.json。.jsonc 合并会丢注释（人话里注明）。
  const jsonPath = join(home, '.config', 'opencode', 'opencode.json');
  const jsoncPath = join(home, '.config', 'opencode', 'opencode.jsonc');
  const useJsonc = !existsSync(jsonPath) && existsSync(jsoncPath);
  const path = useJsonc ? jsoncPath : jsonPath;
  const raw = await readText(path);
  let obj: Record<string, unknown> = {};
  let hadComments = false;
  if (raw != null) {
    try {
      obj = JSON.parse(raw);
    } catch {
      try {
        obj = JSON.parse(stripJsonc(raw));
        hadComments = raw !== JSON.stringify(obj, null, 2);
      } catch {
        throw new Error(`${relHome(path)} 既非 JSON 也非可解析的 JSONC，拒绝覆盖`);
      }
    }
    if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(`${relHome(path)} 顶层不是对象，拒绝覆盖`);
    }
  }
  const models = input.models ?? [];
  const wires = wiresOf(input, 'opencode');
  // 每个选中的 wire 注册一个独立 provider 变体（同网关同 key，仅 npm 包/语义不同）：
  // openai-chat→@ai-sdk/openai-compatible、openai-responses→@ai-sdk/openai、
  // anthropic-messages→@ai-sdk/anthropic。工具内 /models 按 <变体>/<模型> 切。
  for (const wire of wires) {
    const entry = {
      npm:
        wire === 'anthropic-messages'
          ? '@ai-sdk/anthropic'
          : wire === 'openai-responses'
            ? '@ai-sdk/openai'
            : '@ai-sdk/openai-compatible',
      name: `${PROVIDER_ID} ${wireLabel(wire)}`,
      options: { baseURL: endpointFor(input, 'opencode', wire).baseUrl, apiKey: input.apiKey },
      ...(models.length ? { models: Object.fromEntries(models.map((m) => [m, { name: m }])) } : {}),
    };
    obj.provider = { ...((obj.provider as object) ?? {}), [WIRE_VARIANTS[wire]]: entry };
    obj.providers = { ...((obj.providers as object) ?? {}), [WIRE_VARIANTS[wire]]: entry };
  }
  pruneVariants(obj.provider as Record<string, unknown> | undefined, new Set(wires));
  pruneVariants(obj.providers as Record<string, unknown> | undefined, new Set(wires));
  if (input.setDefault && models.length && wires.length) {
    obj.model = `${WIRE_VARIANTS[wires[0]]}/${models[0]}`;
  }
  await writeJsonObject(path, obj);
  notes.push(
    `opencode: 写 ${relHome(path)}（${wires.map(wireLabel).join('、') || '无变体'}）${
      hadComments ? '（原文件含注释，已按 JSON 重写）' : ''
    }${input.setDefault && models.length && wires.length ? `（默认 ${String(obj.model)}）` : ''}`,
  );
};

const configPi: Writer = async (home, input, notes) => {
  const path = join(home, '.pi', 'agent', 'models.json');
  const obj = await readJsonObject(path);
  const models = (input.models ?? []).map((id) => ({ id, name: id }));
  const wires = wiresOf(input, 'pi');
  // 同 opencode：每个选中的 wire 一个独立 provider 变体，api 字段按 wire 定
  for (const wire of wires) {
    obj.providers = {
      ...((obj.providers as object) ?? {}),
      [WIRE_VARIANTS[wire]]: {
        name: `${PROVIDER_ID} ${wireLabel(wire)}`,
        baseUrl: endpointFor(input, 'pi', wire).baseUrl,
        api:
          wire === 'anthropic-messages'
            ? 'anthropic-messages'
            : wire === 'openai-responses'
              ? 'openai-responses'
              : 'openai-completions',
        apiKey: input.apiKey,
        ...(models.length ? { models } : {}),
      },
    };
  }
  pruneVariants(obj.providers as Record<string, unknown> | undefined, new Set(wires));
  await writeJsonObject(path, obj);
  notes.push(`pi: 写 ${relHome(path)}（${wires.map(wireLabel).join('、') || '无变体'}）`);
};

// wire → 人话标签（notes 摘要用）
function wireLabel(wire: GatewayWire): string {
  return wire === 'openai-responses'
    ? 'OpenAI responses 协议'
    : wire === 'anthropic-messages'
      ? 'Anthropic messages 协议'
      : 'OpenAI chat 协议';
}

// 指定 wire 取对应侧端点（anthropic-messages 走 anthropic 侧，其余走 openai 侧）
function endpointFor(
  input: AiGatewayInput,
  _tool: 'claude' | 'codex' | 'opencode' | 'pi',
  wire: GatewayWire = 'anthropic-messages',
): { baseUrl: string } {
  const side = wire === 'anthropic-messages' ? input.endpoints.anthropic : input.endpoints.openai;
  if (!side?.baseUrl) throw new Error(`wire=${wire} 但未提供对应协议的 baseUrl`);
  return side;
}

export const WRITERS: Record<keyof AiGatewayInput['tools'], Writer> = {
  claude: configClaude,
  codex: configCodex,
  opencode: configOpencode,
  pi: configPi,
};

// —— 容器内可达性探测：curl 打各自的模型列表端点，只看连通——（HTTP 码本身不代表
// 鉴权通过）。两侧 baseUrl 约定不同，探测路径跟着约定走：anthropic 侧按 Claude Code
// 的 ANTHROPIC_BASE_URL 约定不含 /v1（客户端自己拼 /v1/messages），列表在 <base>/v1/models；
// openai 侧 baseUrl 含 /v1，直接拼 /models。仅对 running 容器做，失败不影响配置写入。
async function probeOne(
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
    if (!code || code === '000')
      return `探测: ${kind}网关不可达（容器内连不上，检查防火墙/地址）`;
    // 404/405 = 网络与 HTTP 服务都通，只是网关没开模型列表这条路由（有的中转只实现
    // 调用端点）——连通性目的已达成，不算故障，单独说明免得被误读成出错
    if (code === '404' || code === '405')
      return `探测: ${kind}网关可达 (HTTP ${code}，${probePath} 探测路径未开放，不影响实际调用)`;
    return `探测: ${kind}网关可达 (HTTP ${code})`;
  } catch {
    return `探测: ${kind}失败（curl 缺失或超时），不影响配置`;
  }
}

// 单容器：解析名 → 定位 home → 逐工具写入（单工具失败不拖垮其他）→ 可选探测。
// 任何前置异常收敛成一条 result，绝不抛出。
async function applyOne(cfg: Config, id: string, input: AiGatewayInput): Promise<BatchItemResult> {
  let name = id;
  const finish = (
    ok: boolean,
    patch: Partial<BatchItemResult>,
  ): BatchItemResult => ({ id, name, ok, exitCode: ok ? 0 : 1, stdout: '', stderr: '', ...patch });
  try {
    let info;
    try {
      info = await inspectContainer(cfg, id);
    } catch (e) {
      const err = e as { statusCode?: number };
      if (err?.statusCode === 404) return finish(false, { error: 'container not found' });
      throw e;
    }
    name = info.name;
    const home = getEngine(cfg).hostHomePath(cfg, name);
    if (!home || !existsSync(home)) {
      return finish(false, { error: 'container home not found（rootfs 未就绪或非标准布局）' });
    }

    const notes: string[] = [];
    const failed: string[] = [];
    for (const tool of Object.keys(WRITERS) as (keyof AiGatewayInput['tools'])[]) {
      if (!input.tools[tool]) continue;
      try {
        await WRITERS[tool](home, input, notes);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(tool);
        notes.push(`${tool}: 失败 — ${msg}`);
        log.warn({ container: name, tool, err: msg }, 'ai-config tool failed');
      }
    }

    // 探测分侧做：只探「本容器实际用到的」协议端点（按各工具 wire 集合去重）
    if (info.running) {
      const sides = new Set<string>();
      if (input.tools.claude && input.endpoints.anthropic) sides.add('anthropic');
      if (input.tools.codex && input.endpoints.openai) sides.add('openai'); // codex 固定 responses
      for (const tool of ['opencode', 'pi'] as const) {
        if (!input.tools[tool]) continue;
        for (const wire of wiresOf(input, tool)) {
          sides.add(wire === 'anthropic-messages' ? 'anthropic' : 'openai');
        }
      }
      if (sides.has('openai') && input.endpoints.openai)
        notes.push(await probeOne(cfg, id, 'OpenAI 兼容', input.endpoints.openai.baseUrl));
      if (sides.has('anthropic') && input.endpoints.anthropic)
        notes.push(await probeOne(cfg, id, 'Anthropic 兼容', input.endpoints.anthropic.baseUrl));
    }

    return finish(failed.length === 0, {
      stdout: notes.join('\n'),
      error: failed.length ? `${failed.join('/')} 写入失败` : undefined,
    });
  } catch (e) {
    return finish(false, { error: e instanceof Error ? e.message : String(e) });
  }
}

// 并发扇出，返回形状与 batch 系列一致（exitCode 无 exec 语义，ok/失败看 ok 与 error）。
export async function applyAiGateway(
  cfg: Config,
  ids: string[],
  input: AiGatewayInput,
): Promise<BatchResult> {
  const limit = pLimit(CONCURRENCY);
  log.info({ op: 'ai-config', count: ids.length }, 'ai-config start');
  const items = await Promise.all(ids.map((id) => limit(() => applyOne(cfg, id, input))));
  const result: BatchResult = {
    total: items.length,
    ok: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length,
    items,
  };
  log.info({ op: 'ai-config', ok: result.ok, failed: result.failed }, 'ai-config done');
  return result;
}

// —— 声明式追平（sidecar 的 AiGatewayState 是期望状态）——

// 容器的有效网关配置：覆盖 ?? 全局（覆盖即生效——全局不再应用到这台，手改的
// 专属配置因此是合法状态而非被 sweep 冲掉的暂态）。都没有 = 无事发生。
async function gatewayFor(name: string): Promise<AiGatewayInput | undefined> {
  const overrides = await getAiGatewayOverrides();
  if (overrides[name]) return overrides[name];
  return getAiGateway();
}

// 单容器补发（create() 建容器后调用）：有配置（覆盖优先）就照写一份，容器内凭据
// 与新容器同步就位。无配置/容器不可见 = 无事发生。尽力而为不抛（失败靠下次
// sweep/手动重推追平）。
export async function applyGatewayToContainer(cfg: Config, name: string): Promise<void> {
  try {
    const input = await gatewayFor(name);
    if (!input) return;
    const home = getEngine(cfg).hostHomePath(cfg, name);
    if (!home || !existsSync(home)) return;
    await applyOne(cfg, name, input);
    log.info({ container: name }, 'ai-config applied to container');
  } catch (e) {
    log.warn({ container: name, err: String(e) }, 'ai-config apply to container failed');
  }
}

// 启动 sweep（cli.ts 装配）：逐容器按「覆盖 ?? 全局」应用（宿主直写 rootfs，容器
// 不必在跑）。都没有 = 无事发生；尽力而为不抛。
export async function applyGatewayAll(cfg: Config): Promise<void> {
  try {
    const global = await getAiGateway();
    const overrides = await getAiGatewayOverrides();
    if (!global && !Object.keys(overrides).length) return;
    const views = await listManaged(cfg);
    if (!views.length) return;
    const limit = pLimit(CONCURRENCY);
    const items = await Promise.all(
      views.map((v) =>
        limit(async () => {
          const input = overrides[v.id] ?? global;
          if (!input) return null;
          return applyOne(cfg, v.id, input);
        }),
      ),
    );
    const done = items.filter((i): i is BatchItemResult => i !== null);
    log.info(
      { op: 'ai-config', ok: done.filter((i) => i.ok).length, failed: done.filter((i) => !i.ok).length, overridden: done.filter((i) => overrides[i.id]).length },
      'ai-config sweep done',
    );
  } catch (e) {
    log.warn({ err: String(e) }, 'ai-config startup sweep failed');
  }
}

// 保存容器覆盖（routes：卡片菜单「AI 网关…」保存）并立即应用到这台。
export async function setGatewayOverride(cfg: Config, name: string, input: AiGatewayInput): Promise<BatchResult> {
  await setAiGatewayOverride(name, { ...input, updatedAt: new Date().toISOString() });
  return applyAiGateway(cfg, [name], input);
}

// 清除覆盖（恢复跟随全局）并立即把全局配置应用到这台（有全局才应用；下次 sweep 兜底）。
export async function clearGatewayOverride(cfg: Config, name: string): Promise<void> {
  await deleteAiGatewayOverride(name);
  const global = await getAiGateway();
  if (global) await applyAiGateway(cfg, [name], global);
  log.info({ container: name }, 'ai-config override cleared');
}
