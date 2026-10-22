// AI 路由（/api/ai/* + /api/testlens/*）：AI 工具与技能中心的路由面（server/aiconfig.ts
// /aiState.ts/testlens.ts）。从 routes.ts 拆出对齐 base/services 的模块惯例——AI 域路由
// 体量（~300 行）早就不是「杂项」量级。鉴权走 index.ts 全局 hook，本模块不自行处理。
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import {
  getAiProviders,
  getAiBinding,
  getAiTargetOverrides,
  getAiToolConfig,
  getAiProjectRules,
  setAiProvider,
  setAiBinding,
  setAiToolConfig,
  AI_TOOL_KEYS,
  type AiProvider,
  type AiBinding,
  type AiToolKey,
  type AiClaudeToolConfig,
  type AiOpenCodeToolConfig,
  type AiCodexToolConfig,
  type GatewayWire,
} from './aiState.js';
import { badRequest, conflict, HttpError } from './errors.js';
import { batchAgentUpdate, hostAgentUpdate, type BatchResult } from './batch.js';
import {
  applyAiBindingToTargets,
  setTargetOverride,
  clearTargetOverride,
  ensureAiMigrated,
  removeAiProviderEverywhere,
  probeProvider,
  fetchProviderModels,
  installAiProjectRule,
  deleteAiProjectRuleById,
  validateBinding,
  validateToolConfig,
  validateOpenCodeToolConfig,
  validateCodexToolConfig,
  removedCodexKeys,
  setClaudeToolConfig,
  setClaudePageConfig,
  validateProjectSelection,
  allTargets,
  PROVIDER_ID_RE,
  WIRES,
  HOST_TARGET,
} from './aiconfig.js';
import { testlensView, testlensInstall } from './testlens.js';

export async function registerAiRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // —— AI 配置：provider 库 × 智能体绑定 × 项目级规则（server/aiconfig.ts）——
  // 三层模型：provider 库存凭据与端点（N 个）；绑定只引用 provider id（全局一份 +
  // 目标覆盖，key = 容器名或 __host__）；落盘由绑定+库解析后执行（宿主直写，容器不必
  // 在跑）。GET 回全量（含 key——sidecar 0600 同 services.env 泄露面，token 边界收住）。
  app.get('/api/ai/view', async () => {
    await ensureAiMigrated();
    return {
      hostHome: homedir(), // 宿主 spot → 规则 to（~/rel）归一化用（面板端不知宿主 home）
      providers: Object.values(await getAiProviders()),
      binding: (await getAiBinding()) ?? null,
      overrides: await getAiTargetOverrides(),
      toolConfig: await getAiToolConfig(),
      projectRules: await getAiProjectRules(),
    };
  });

  // provider 库 CRUD：body 带 id = 更新（改名走 id 不变），不带 = 新建（id 查重）。
  app.post('/api/ai/providers', async (req) => {
    await ensureAiMigrated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const id = typeof body.id === 'string' ? body.id.trim() : '';
    const name = String(body.name ?? '').trim();
    if (!name) throw badRequest('name 必填');
    if (!id && !PROVIDER_ID_RE.test(String(body.wantId ?? '').trim())) {
      throw badRequest('id 必填（小写字母开头，小写字母/数字/短横线，≤32 位）——它会被用作各工具配置里的 provider 名');
    }
    const pid = id || String(body.wantId).trim();
    const lib = await getAiProviders();
    if (!id && lib[pid]) throw conflict(`provider id 已存在：${pid}`);
    if (id && !lib[pid]) throw new HttpError(404, `provider 不存在：${pid}`, 'not_found');
    // 端点三路分开收（openai / responses / anthropic）；填了但不像 URL → 400 点名，不静默当没填。
    const epIn = (body.endpoints ?? {}) as Record<string, unknown>;
    const pickUrl = (v: unknown, side: 'openai' | 'responses' | 'anthropic'): string | undefined => {
      const raw = typeof v === 'string' ? v : (v as { baseUrl?: unknown })?.baseUrl;
      if (raw == null || String(raw).trim() === '') return undefined;
      const s = String(raw).trim();
      if (!/^https?:\/\//.test(s)) {
        throw badRequest(`endpoints.${side}.baseUrl 必须以 http:// 或 https:// 开头（收到 ${JSON.stringify(s)}）`);
      }
      return s.replace(/\/+$/, '');
    };
    const endpoints = {
      ...(pickUrl(epIn.openai, 'openai') ? { openai: { baseUrl: pickUrl(epIn.openai, 'openai')! } } : {}),
      ...(pickUrl(epIn.responses, 'responses') ? { responses: { baseUrl: pickUrl(epIn.responses, 'responses')! } } : {}),
      ...(pickUrl(epIn.anthropic, 'anthropic') ? { anthropic: { baseUrl: pickUrl(epIn.anthropic, 'anthropic')! } } : {}),
    };
    if (!endpoints.openai && !endpoints.responses && !endpoints.anthropic) {
      throw badRequest('至少填一个端点（OpenAI 兼容 / OpenAI responses 兼容 / Anthropic 兼容）');
    }
    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) throw badRequest('apiKey 必填');
    // 模型清单按协议（wire）各一份：对象键 ∈ WIRES、值数组或逗号串，空清单视为未配；
    // 兼容旧共享形状（数组/逗号串归 openai-chat）。没给 models 键 = 保留原值。
    const list = (v: unknown): string[] => {
      const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : [];
      return arr.map(String).map((s) => s.trim()).filter(Boolean);
    };
    let models: AiProvider['models'] | undefined;
    if (body.models !== undefined) {
      if (typeof body.models === 'object' && body.models !== null && !Array.isArray(body.models)) {
        const m = body.models as Record<string, unknown>;
        models = {};
        for (const k of Object.keys(m)) {
          if (!(WIRES as string[]).includes(k)) throw badRequest(`models.${k} 不是合法协议（合法值 ${WIRES.join('/')}）`);
          const l = list(m[k]);
          if (l.length) models[k as GatewayWire] = l;
        }
      } else {
        const l = list(body.models);
        models = l.length ? { 'openai-chat': l } : {};
      }
    }
    const prev = lib[pid];
    const p: AiProvider = {
      id: pid,
      name,
      endpoints,
      apiKey,
      ...(models ? { models } : prev?.models ? { models: prev.models } : {}),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await setAiProvider(p);
    return { provider: p };
  });

  // 删 provider：库删除 + 本机与全部可见容器 home 的落盘条目回收（aiconfig.removeAiProviderEverywhere）。
  app.delete('/api/ai/providers/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const lib = await getAiProviders();
    if (!lib[id]) throw new HttpError(404, `provider 不存在：${id}`, 'not_found');
    await removeAiProviderEverywhere(cfg, id);
    return { ok: true };
  });

  // 探测（编辑中的端点即可探，不必先入库）：进程内 fetch，逐侧回人话结果。
  app.post('/api/ai/providers/probe', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const epIn = (body.endpoints ?? {}) as Record<string, unknown>;
    const pick = (v: unknown): string | undefined => {
      const raw = typeof v === 'string' ? v : (v as { baseUrl?: unknown })?.baseUrl;
      const s = raw == null ? '' : String(raw).trim();
      return s || undefined;
    };
    return probeProvider({
      ...(pick(epIn.openai) ? { openai: { baseUrl: pick(epIn.openai)! } } : {}),
      ...(pick(epIn.responses) ? { responses: { baseUrl: pick(epIn.responses)! } } : {}),
      ...(pick(epIn.anthropic) ? { anthropic: { baseUrl: pick(epIn.anthropic)! } } : {}),
    });
  });

  // 拉模型清单（三路独立，一路失败不影响另一路；错误在 errors 里点侧）。
  app.post('/api/ai/providers/models', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const epIn = (body.endpoints ?? {}) as Record<string, unknown>;
    const pick = (v: unknown): string | undefined => {
      const raw = typeof v === 'string' ? v : (v as { baseUrl?: unknown })?.baseUrl;
      const s = raw == null ? '' : String(raw).trim();
      return s || undefined;
    };
    const endpoints = {
      ...(pick(epIn.openai) ? { openai: { baseUrl: pick(epIn.openai)! } } : {}),
      ...(pick(epIn.responses) ? { responses: { baseUrl: pick(epIn.responses)! } } : {}),
      ...(pick(epIn.anthropic) ? { anthropic: { baseUrl: pick(epIn.anthropic)! } } : {}),
    };
    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) throw badRequest('apiKey 必填');
    if (!endpoints.openai && !endpoints.responses && !endpoints.anthropic) throw badRequest('至少填一个端点');
    return fetchProviderModels(endpoints, apiKey);
  });

  // 保存全局绑定 + 立即应用。ids 缺省 = 本机 + 全部受管容器（本机与容器同权，
  // 全局绑定同样追平宿主）；ids 显式给 = 只应用这些（仍保存为全局绑定）。
  // apply 缺省 = 全部工具槽；显式给出 = 存储整份保存、下发只带这些工具
  // （页签按工具保存的「只写本工具落盘配置」语义，见 aiconfig.sliceBinding）。
  app.post('/api/ai/binding', async (req): Promise<BatchResult> => {
    await ensureAiMigrated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lib = await getAiProviders();
    const invalid = validateBinding(body.binding, lib);
    if (invalid) throw badRequest(invalid);
    const binding = body.binding as AiBinding;
    let apply: AiToolKey[] | undefined;
    if (body.apply !== undefined) {
      if (!Array.isArray(body.apply)) throw badRequest('apply 必须是工具键数组');
      apply = (body.apply as unknown[]).map(String) as AiToolKey[];
      const bad = apply.filter((k) => !AI_TOOL_KEYS.includes(k));
      if (bad.length) throw badRequest(`apply 含非法工具键：${bad.join('、')}（合法值 ${AI_TOOL_KEYS.join('/')}）`);
      if (!apply.length) throw badRequest('apply 不能为空数组');
    }
    await setAiBinding(binding);
    // opencode/codex 配置随页签保存一起提交（页签一个保存按钮）；校验过再落存储，
    // 下发时 configOpencode/configCodex 读到的就是新值。
    const ocTc = (body.toolConfig as { opencode?: unknown } | undefined)?.opencode;
    if (ocTc !== undefined) {
      const invalidOc = validateOpenCodeToolConfig(ocTc);
      if (invalidOc) throw badRequest(invalidOc);
      await setAiToolConfig({ opencode: ocTc as AiOpenCodeToolConfig });
    }
    const cdTc = (body.toolConfig as { codex?: unknown } | undefined)?.codex;
    let removedCd: string[] | undefined;
    if (cdTc !== undefined) {
      const invalidCd = validateCodexToolConfig(cdTc);
      if (invalidCd) throw badRequest(invalidCd);
      // 差集回收键要在覆盖存储前算（对比的是上一版 toolConfig.codex）。
      removedCd = removedCodexKeys((await getAiToolConfig()).codex, cdTc as AiCodexToolConfig);
      await setAiToolConfig({ codex: cdTc as AiCodexToolConfig });
    }
    // 缺省目标 = 本机 + 受管容器 + 模板（allTargets，与 Claude 页签同集）——模板追平
    // 让新容器克隆即自带配置。
    const ids = Array.isArray(body.ids) && body.ids.length ? (body.ids as unknown[]).map(String) : await allTargets(cfg);
    return applyAiBindingToTargets(cfg, ids, binding, apply, { removedCodexKeys: removedCd });
  });

  // 工具自身配置（toolConfig，全局一份；claude：默认模型 + 自定义 env）。PUT 按工具键
  // 替换（claude 槽整体替换，其他工具的槽保留）+ 立即下发（落点跟着 claude 绑定走，
  // 见 aiconfig.setClaudeToolConfig）。
  // env 保留键（BASE_URL/AUTH_TOKEN）路由层点名拒绝——由模型服务绑定管。
  app.put('/api/ai/tool-config', async (req): Promise<BatchResult> => {
    await ensureAiMigrated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const invalid = validateToolConfig('claude', body.claude);
    if (invalid) throw badRequest(invalid);
    const tc = (body.claude ?? {}) as AiClaudeToolConfig;
    const ids = Array.isArray(body.ids) && body.ids.length ? (body.ids as unknown[]).map(String) : undefined;
    return setClaudeToolConfig(cfg, tc, ids);
  });

  // Claude 页签合并保存：绑定（claude 槽）+ 自身配置一次提交——页签一个保存按钮，
  // 不打两个接口。claude 槽替换进已存全局绑定（其余工具原样），两份校验都过才动存储；
  // 下发只写 claude（工具间互相独立——其余工具的落盘动作归各自页签，见 aiconfig.setClaudePageConfig）。
  app.post('/api/ai/claude-config', async (req): Promise<BatchResult> => {
    await ensureAiMigrated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const invalidTc = validateToolConfig('claude', body.toolConfig);
    if (invalidTc) throw badRequest(invalidTc);
    const provider = String(body.provider ?? '').trim();
    if (!provider) throw badRequest('provider 必填（Claude Code 绑定的模型服务）');
    const binding = { ...(await getAiBinding()), claude: { provider } } as AiBinding;
    const lib = await getAiProviders();
    const invalid = validateBinding(binding, lib);
    if (invalid) throw badRequest(invalid);
    const tc = (body.toolConfig ?? {}) as AiClaudeToolConfig;
    const ids = Array.isArray(body.ids) && body.ids.length ? (body.ids as unknown[]).map(String) : undefined;
    // 写入策略：缺省 merge（合并，其它键保留）；replace = 整文件替换（清历史残留的显式手段）。
    const mode = body.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') {
      throw badRequest("mode 只认 'merge'（合并写入）或 'replace'（替换整个文件）");
    }
    return setClaudePageConfig(cfg, binding, tc, ids, mode);
  });

  // —— Agent CLI 一键更新（AI 工具页签）：宿主 + 全部受管容器（含模板）npm 全局包拉
  // @latest。npm 是唯一可靠通道（原生安装器在本网络区域不可达，见模板脚本 claude 段）。
  // 容器侧按工具探测存在才更新（收编容器工具集不齐不凭空装）；停机容器经 runBatch 报
  // not running 明示——要更新先启动。同步跑完回 BatchResult（单个 npm 10min 硬顶），
  // 复用前端 BatchResult 结果表。宿主不进容器批（allTargets 的 HOST_TARGET 哨兵要滤掉，
  // 宿主走 hostAgentUpdate 的 npm 直跑——execRun 对它只会报 invalid container name）。
  app.post('/api/ai/agent-update', async (): Promise<BatchResult> => {
    const ids = (await allTargets(cfg)).filter((id) => id !== HOST_TARGET);
    const [result, host] = await Promise.all([batchAgentUpdate(cfg, ids), hostAgentUpdate()]);
    result.items.unshift(host);
    result.total += 1;
    if (host.ok) result.ok += 1;
    else result.failed += 1;
    return result;
  });

  // 目标覆盖（key = 容器名）：保存 + 立即应用到这台。存在即生效
  // （sweep / 建容器补发用它替代全局绑定）。本机跟随全局，不是覆盖目标。
  app.post('/api/ai/targets/:target', async (req): Promise<BatchResult> => {
    await ensureAiMigrated();
    const target = (req.params as { target: string }).target;
    if (target === HOST_TARGET) {
      throw badRequest('本机跟随全局绑定（全局应用目标含本机），没有专属覆盖——直接保存全局绑定即可');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lib = await getAiProviders();
    const invalid = validateBinding(body.binding, lib);
    if (invalid) throw badRequest(invalid);
    return setTargetOverride(cfg, target, body.binding as AiBinding);
  });

  // 清除目标覆盖 = 恢复跟随全局（立即应用全局绑定）。本机不是覆盖目标。
  app.delete('/api/ai/targets/:target', async (req) => {
    const target = (req.params as { target: string }).target;
    if (target === HOST_TARGET) {
      throw badRequest('本机跟随全局绑定（全局应用目标含本机），没有专属覆盖');
    }
    const overrides = await getAiTargetOverrides();
    if (!overrides[target]) {
      throw new HttpError(404, '该目标没有覆盖配置', 'not_found');
    }
    await clearTargetOverride(cfg, target);
    return { overrides: await getAiTargetOverrides() };
  });

  // 项目级规则 CRUD（文件面板「AI 配置」是就地安装入口；这里看账 + 删）。
  app.delete('/api/ai/projects/:id', async (req) => {
    try {
      await deleteAiProjectRuleById(cfg, (req.params as { id: string }).id);
    } catch (e) {
      throw new HttpError(404, e instanceof Error ? e.message : String(e), 'not_found');
    }
    return { projectRules: await getAiProjectRules() };
  });

  // 项目级规则就地安装（pull 语义）：容器当前浏览位置落成/并入规则并立即写一次。
  app.post('/api/ai/projects/install', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const container = String(body.container ?? '').trim();
    const spot = String(body.spot ?? '').trim();
    if (!container || !spot) throw badRequest('container / spot 必填');
    const lib = await getAiProviders();
    const sel = (body.selection ?? {}) as Record<string, unknown>;
    const invalid = validateProjectSelection(sel, lib);
    if (invalid) throw badRequest(invalid);
    try {
      return await installAiProjectRule(
        cfg,
        container,
        spot,
        sel as { claude?: AiBinding['claude']; opencode?: AiBinding['opencode'] },
      );
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : String(e));
    }
  });

  // —— TestLens 批量配置（设置弹框「TestLens」分区，server/testlens.ts）——
  // 往目标 home 写两份种子文件（agent-browser cdp + testlens CLI host）；文件即
  // 真相（view 读实际值），install 读-改-写合并只动 cdp/host 键。
  app.get('/api/testlens/view', async () => {
    return testlensView(cfg);
  });

  app.post('/api/testlens/install', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const items = await testlensInstall(cfg, body);
    return {
      total: items.length,
      ok: items.filter((i) => i.ok).length,
      failed: items.filter((i) => !i.ok).length,
      items,
    };
  });
}
