// REST 路由。/api/health 免鉴权；其余 /api/* + /ws/* 需 token（见 index.ts onRequest）。
import { homedir } from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { dockerStatus } from './docker.js';
import {
  checkEngine,
  listManaged,
  startContainer,
  stopContainer,
  restartContainer,
  renameContainer,
  inspectContainer,
  execRun,
  getEngine,
} from './engine/index.js';
import { setMeta, getMeta, deleteMeta } from './state.js';
import { getSkillHub, getSkillRegistry, getAiProviders, getAiBinding, getAiTargetOverrides, getAiProjectRules, setAiProvider, setAiBinding, type AiProvider, type AiBinding } from './aiState.js';
import { wrapEngineError, conflict, HttpError, badRequest } from './errors.js';
import { listContainerSessions, killContainerSession, TERMID_RE } from './terminal.js';
import { listHostSessions, killHostSession, listServiceSessions, killServiceSession } from './hostTerminal.js';
import { listSshSessions, killSshSession } from './sshTerminal.js';
import { terminalActivity } from './activity.js';
import { createContainer, deleteManaged, type CreateInput } from './lifecycle.js';
import type { CreateSource, BaseProgress } from './engine/index.js';
import { beginSse } from './sse.js';
import { ipPoolView } from './network.js';
import { batchGit, batchSsh, batchClaudeRun, batchExec, type BatchResult } from './batch.js';
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
  validateProjectSelection,
  PROVIDER_ID_RE,
  HOST_TARGET,
} from './aiconfig.js';
import { testlensView, testlensInstall } from './testlens.js';
import {
  syncSkillsAll,
  hubView,
  addSkillRule,
  updateSkillRule,
  deleteSkillRule,
  installSkillsToSpot,
  skillInventory,
  registryList,
  registryAdd,
  registryRemove,
  registryUpdate,
  registryCheckUpdate,
  registryCheckUpdates,
  registryProbeGit,
  registryImportGit,
} from './skillSync.js';
import { getVersion } from './version.js';
import { readHostHosts } from './hosts.js';
import { overwriteHosts, type ApplyHostsResult } from './hosts-sync.js';
import { probeHtmlPort } from './portprobe.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

// 全部运行中受管理容器 id（hosts 覆写缺省目标）。
async function runningIds(cfg: Config): Promise<string[]> {
  const views = await listManaged(cfg);
  return views.filter((v) => v.state === 'running').map((v) => v.id);
}

export interface Resolved {
  id: string;
  name: string;
  managed: boolean;
  adopted: boolean;
  running: boolean;
  ip: string | null; // 运行中 = lxc-info 实测；停机 = config 静态值
}

export async function resolve(cfg: Config, id: string): Promise<Resolved> {
  let info: Awaited<ReturnType<typeof inspectContainer>>;
  try {
    info = await inspectContainer(cfg, id);
  } catch (e) {
    throw wrapEngineError(e, id);
  }
  const adopted = (await getMeta(info.name))?.managed === true;
  return {
    id,
    name: info.name,
    managed: info.managed,
    adopted,
    running: info.running,
    ip: info.ip ?? null,
  };
}

// 生命周期动作（start/stop/restart/terminal/exec）：需 managed 或 adopted
export function requireControlled(r: Resolved): void {
  if (!r.managed && !r.adopted) {
    throw conflict('container is external; adopt it first (POST /api/containers/:id/adopt)');
  }
}
// 所有权动作（rename/remove）：仅 mysandbox 创建的容器
function requireOwned(r: Resolved): void {
  if (!r.managed) {
    throw conflict('only mysandbox-created containers support this action');
  }
}

// —— 端口 HTML 探测在 portprobe.ts（LXC 容器与 docker 服务共用）——

export async function registerRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // engine + caps 暴露给前端：删除/改名/端口映射的 UI 差异由 caps 驱动，
  // 前端不要自己判 engine 名（见 web/src/lib/api.ts 的 Health 类型）。
  app.get('/api/health', async () => {
    const engineStatus = await checkEngine(cfg);
    const engine = getEngine(cfg);
    return {
      ok: true,
      version: getVersion(),
      engineStatus,
      engine: engine.name,
      caps: engine.caps,
      // docker 服务层可用性（1.5s 快败，不拖死 health）。只回 bool：health 免鉴权，
      // 不放名字/路径/配置值（约束见 CLAUDE.md）。
      services: {
        available: cfg.services.enabled ? (await dockerStatus()).reachable : false,
      },
    };
  });

  app.get('/api/containers', async () => ({ items: await listManaged(cfg) }));

  // —— 终端会话发现（web 会话对话框：tab 列表只在各自浏览器的 localStorage 里，
  // 换浏览器 tmux 会话就「找不到」；这里扫出全部活跃会话供找回/接入/清理）——
  // 扫描 = 全部运行中容器各跑一次只读 tmux list-sessions（并行；单容器失败/超时经
  // allSettled 降级为「该容器 0 会话」，不拖垮整体）+ 宿主专用 socket。外部容器也扫：
  // 终端本来就允许对列表里任何容器打开。前端拿 containerId 自己解析显示名。
  app.get('/api/terminal-sessions', async () => {
    const items = await listManaged(cfg);
    const running = items.filter((c) => c.state === 'running');
    const settled = await Promise.allSettled(running.map((c) => listContainerSessions(cfg, c.id)));
    const sessions = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
    sessions.push(...(await listHostSessions()));
    // 服务终端会话（docker exec 挂宿主 tmux，见 hostTerminal.ts）：同 socket 不同前缀。
    sessions.push(...(await listServiceSessions()));
    // SSH 目标会话（会话本体在远端 tmux，见 sshTerminal.ts）：逐目标并行、失败降级为 0。
    sessions.push(...(await listSshSessions()));
    return { sessions };
  });

  // 结束一条会话（孤儿清理：别处开的、本窗口没有 tab 的）。token 即宿主权限，不设
  // 额外归属校验；termId 白名单校验防路径注入。
  app.delete('/api/terminal-sessions/host/:termId', async (req) => {
    const { termId } = req.params as { termId: string };
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    await killHostSession(termId);
    return { ok: true };
  });

  app.delete('/api/terminal-sessions/container/:id/:termId', async (req) => {
    const { id, termId } = req.params as { id: string; termId: string };
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    await killContainerSession(cfg, id, termId);
    return { ok: true };
  });

  app.delete('/api/terminal-sessions/service/:termId', async (req) => {
    const { termId } = req.params as { termId: string };
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    await killServiceSession(termId);
    return { ok: true };
  });

  app.delete('/api/terminal-sessions/ssh/:name/:termId', async (req) => {
    const { name, termId } = req.params as { name: string; termId: string };
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    await killSshSession(name, termId);
    return { ok: true };
  });

  // —— 终端输出活动快照（「无输出提醒」，server/activity.ts 周期扫 tmux）——
  // threshold = 服务端判 quiet 的安静秒数（cfg.terminal.quietSeconds），前端对齐用。
  // 谁在看着由前端自判（可见 tab v-show 常驻，tmux attached ≠ 用户在看）。
  app.get('/api/terminal-activity', async () => ({
    threshold: cfg.terminal.quietSeconds,
    items: terminalActivity(),
  }));

  app.get('/api/network/ips', async () => ipPoolView(cfg));

  // —— 新建容器 ——
  // SSE 流式：克隆/解包 + 启动分钟级（前端 api() 的 10s 超时撑不住），进度逐条推。
  // 快错误（重名/IP 占用）变 error 帧，streamOp 在前端照样抛给对话框内联显示。
  app.post('/api/containers', async (req, reply) => {
    const body = (req.body as Record<string, unknown> | null) || {};
    // 来源归一：{kind:'container',name} / {kind:'archive',path}，其余（含畸形）按模板走
    const raw = body.source as Record<string, unknown> | undefined;
    let source: CreateSource | undefined;
    if (raw?.kind === 'container' && raw.name) source = { kind: 'container', name: String(raw.name) };
    else if (raw?.kind === 'archive' && raw.path) source = { kind: 'archive', path: String(raw.path) };

    const input: CreateInput = {
      name: String(body.name ?? ''),
      ip: body.ip ? String(body.ip) : undefined,
      gitName: body.gitName ? String(body.gitName) : undefined,
      gitEmail: body.gitEmail ? String(body.gitEmail) : undefined,
      role: body.role ? String(body.role) : undefined,
      description: body.description ? String(body.description) : undefined,
      hosts: body.hosts === 'host' ? 'host' : 'template',
      source,
    };
    const { sink, finalize } = beginSse(reply);
    await finalize(() => createContainer(cfg, input, (e: BaseProgress) => sink(e)));
  });

  // —— 删除容器（仅 managed；删 data 需 confirmName）——
  app.delete('/api/containers/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body as { deleteData?: boolean; confirmName?: string } | null) || {};
    const result = await deleteManaged(cfg, id, {
      deleteData: !!body.deleteData,
      confirmName: body.confirmName,
    });
    return result;
  });

  // —— 生命周期 ——
  app.post('/api/containers/:id/start', async (req) => {
    const r = await resolve(cfg, (req.params as { id: string }).id);
    requireControlled(r);
    await startContainer(cfg, r.id);
    return { ok: true };
  });

  app.post('/api/containers/:id/stop', async (req) => {
    const r = await resolve(cfg, (req.params as { id: string }).id);
    requireControlled(r);
    const t = (req.body as { t?: number } | null)?.t ?? 5;
    await stopContainer(cfg, r.id, t);
    return { ok: true };
  });

  app.post('/api/containers/:id/restart', async (req) => {
    const r = await resolve(cfg, (req.params as { id: string }).id);
    requireControlled(r);
    const t = (req.body as { t?: number } | null)?.t ?? 5;
    await restartContainer(cfg, r.id, t);
    return { ok: true };
  });

  // —— adoption：纳入管理（仅写 sidecar，不重建、不打 label）——
  app.post('/api/containers/:id/adopt', async (req) => {
    const id = (req.params as { id: string }).id;
    let info: Awaited<ReturnType<typeof inspectContainer>>;
    try {
      info = await inspectContainer(cfg, id);
    } catch (e) {
      throw wrapEngineError(e, id);
    }
    const name = info.name;
    const managed = info.managed;
    const body = (req.body as { displayName?: string; source?: string } | null) || {};
    await setMeta(name, {
      managed: true,
      adopted: !managed,
      displayName: body.displayName || name,
      source: managed ? 'mysandbox' : body.source || 'external',
      createdAt: new Date().toISOString(),
    });
    return { ok: true, name, managed, adopted: !managed };
  });

  // —— 重命名（仅 managed）——
  app.post('/api/containers/:id/rename', async (req: FastifyRequest) => {
    const r = await resolve(cfg, (req.params as { id: string }).id);
    requireOwned(r);
    const name = (req.body as { name?: string } | null)?.name;
    if (!name || !NAME_RE.test(name)) {
      throw new HttpError(400, 'invalid name (^[a-z0-9][a-z0-9-]{1,30}$)', 'bad_request');
    }
    await renameContainer(cfg, r.id, name);
    const m = await getMeta(r.name);
    if (m) {
      await setMeta(name, m);
      await deleteMeta(r.name);
    }
    return { ok: true, name };
  });

  // —— 元数据（描述/标签/显示名）——
  app.patch('/api/containers/:id/meta', async (req) => {
    const r = await resolve(cfg, (req.params as { id: string }).id);
    const body = (req.body as Record<string, unknown> | null) || {};
    const patch: { description?: string; tags?: string[]; displayName?: string } = {};
    if (typeof body.description === 'string') patch.description = body.description;
    if (Array.isArray(body.tags)) patch.tags = body.tags as string[];
    if (typeof body.displayName === 'string') patch.displayName = body.displayName;
    await setMeta(r.name, patch);
    return { ok: true };
  });

  // —— 批量配置 ——
  // ids 校验：必须是字符串数组；去重。所有批量端点返回统一的 BatchResult。
  function parseIds(body: unknown): string[] {
    const arr = (body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new HttpError(400, 'ids must be a non-empty array', 'bad_request');
    }
    const ids = arr.map((x) => String(x));
    return [...new Set(ids)];
  }

  app.post('/api/batch/git', async (req): Promise<BatchResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const ids = parseIds(body);
    const name = String(body.name ?? '').trim();
    const email = String(body.email ?? '').trim();
    if (!name || !email) throw new HttpError(400, 'name and email required', 'bad_request');
    return batchGit(cfg, ids, { name, email });
  });

  app.post('/api/batch/ssh', async (req): Promise<BatchResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const ids = parseIds(body);
    const mode = String(body.mode ?? '');
    if (mode === 'reseed') return batchSsh(cfg, ids, { mode: 'reseed' });
    if (mode === 'append-key') {
      const key = String(body.key ?? '').trim();
      if (!key) throw new HttpError(400, 'key required for append-key', 'bad_request');
      return batchSsh(cfg, ids, { mode: 'append-key', key });
    }
    throw new HttpError(400, 'mode must be reseed or append-key', 'bad_request');
  });

  app.post('/api/batch/claude', async (req): Promise<BatchResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const ids = parseIds(body);
    const prompt = String(body.prompt ?? '').trim();
    if (!prompt) throw new HttpError(400, 'prompt required', 'bad_request');
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
    return batchClaudeRun(cfg, ids, { prompt, timeoutMs });
  });

  app.post('/api/batch/exec', async (req): Promise<BatchResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const ids = parseIds(body);
    const command = String(body.command ?? '').trim();
    if (!command) throw new HttpError(400, 'command required', 'bad_request');
    const timeoutMs = typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined;
    return batchExec(cfg, ids, { command, timeoutMs });
  });

  // —— skills 同步（server/skillSync.ts）：手动触发一次全量同步（watch/启动 sweep 之外）——
  // 不收任何路径参数：规则只来自 sidecar（面板/API 管理），API 无法被用来指路。
  app.post('/api/skills/sync', async () => {
    const hub = await getSkillHub();
    const reg = await getSkillRegistry();
    if (!hub.rules.some((r) => r.skills.length) && !Object.keys(reg.skills).length) {
      throw new HttpError(400, '技能库是空的、也没有安装规则（面板「AI 工具 → 技能中心」配置）', 'bad_request');
    }
    return syncSkillsAll(cfg);
  });

  // —— 技能分发规则 CRUD。规则 = {库内技能集合, 去向, 范围}，库（registry）是唯一
  // 技能真相源。表单校验在此处转 4xx，重复去向转 409；视图（GET /hub）是一次全量
  // 同步的返回（聚合副本刷新 + 分发结果）。——
  app.get('/api/skills/hub', async () => hubView(cfg));

  app.post('/api/skills/rules', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = String(body.to ?? '').trim();
    if (!to) throw new HttpError(400, 'to 必填（容器内目标路径，如 ~/.claude/skills）', 'bad_request');
    const skills = Array.isArray(body.skills) ? body.skills.map(String) : [];
    try {
      await addSkillRule(cfg, to, body.all === true, skills);
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : String(e), 'conflict');
    }
    return hubView(cfg);
  });

  app.patch('/api/skills/rules/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { to?: string; all?: boolean; skills?: string[] } = {};
    if (typeof body.to === 'string' && body.to.trim()) patch.to = body.to.trim();
    if (typeof body.all === 'boolean') patch.all = body.all;
    if (Array.isArray(body.skills)) patch.skills = body.skills.map(String);
    if (!Object.keys(patch).length) throw new HttpError(400, 'to / all / skills 至少给一个', 'bad_request');
    try {
      await updateSkillRule(cfg, id, patch);
    } catch (e) {
      throw new HttpError(404, e instanceof Error ? e.message : String(e), 'not_found');
    }
    return hubView(cfg);
  });

  app.delete('/api/skills/rules/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    try {
      await deleteSkillRule(cfg, id);
    } catch (e) {
      throw new HttpError(404, e instanceof Error ? e.message : String(e), 'not_found');
    }
    return hubView(cfg);
  });

  // —— skills 已安装清单：宿主 + 受管容器的标准落点只读扫描（落点常量在 skillSync.ts，
  // 不收任何路径参数）。纯 readdir + SKILL.md 读，容器不必在跑。——
  app.get('/api/skills/inventory', async () => skillInventory(cfg));

  // —— 技能库（registry）：用户策展的权威技能集。入库的 from 形态由 resolveSyncSource
  // 校验（容器:路径 / 宿主路径），git 导入走专门探测+导入两步。——
  app.get('/api/skills/registry', async () => registryList());

  app.post('/api/skills/registry', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const from = String(body.from ?? '').trim();
    if (!from) throw new HttpError(400, 'from 必填（技能目录：<容器名>:<路径> 或宿主路径）', 'bad_request');
    try {
      return await registryAdd(cfg, from, body.force === true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('不合法') || msg.includes('不存在') || msg.includes('缺 SKILL.md')) {
        throw new HttpError(400, msg, 'bad_request');
      }
      if (msg.includes('已有同名')) throw new HttpError(409, msg, 'conflict');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  app.delete('/api/skills/registry/:name', async (req) => {
    try {
      await registryRemove((req.params as { name: string }).name);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e), 'bad_request');
    }
    return registryList();
  });

  // 显式更新库条目：库是静态快照（来源改动不自动进库）。先比对内容指纹——来源没变
  // 幂等空转（changed:false），变了才重拉 + 全量分发（订阅侧只认库）。
  app.post('/api/skills/registry/:name/update', async (req) => {
    const name = (req.params as { name: string }).name;
    try {
      return await registryUpdate(cfg, name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('库中没有')) throw new HttpError(404, msg, 'not_found');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  // 检查更新（只读指纹比对，不动库不动分发）：单条 + 批量（头部「检查更新」，逐条
  // 独立 status，git 源的 ls-remote 失败不拖垮整批）。
  app.post('/api/skills/registry/check-updates', async () => ({ results: await registryCheckUpdates(cfg) }));

  app.post('/api/skills/registry/:name/check-update', async (req) => {
    const name = (req.params as { name: string }).name;
    try {
      return await registryCheckUpdate(cfg, name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('库中没有')) throw new HttpError(404, msg, 'not_found');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  // git 导入：不带 path = 探测候选（不导入）；带 path = 导入该候选。
  app.post('/api/skills/registry/git', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = String(body.url ?? '').trim();
    if (!url) throw new HttpError(400, 'url 必填（git 仓库地址）', 'bad_request');
    const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
    try {
      if (!path) return { candidates: await registryProbeGit(url) };
      return await registryImportGit(cfg, url, path, body.force === true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('已有同名')) throw new HttpError(409, msg, 'conflict');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  // —— skills 就地安装（文件面板「安装技能」的主入口）：pull 语义——人在哪个项目
  // 就装到哪。确保 <spot> 的安装规则存在（全局落点铺全部容器 / 项目落点跟项目走）
  // + 勾上这些技能 + 立即为该容器分发一次；规则此后由同步系统接管。不收任意写路径：
  // spot 限于 dev home 内（containerRel 校验），技能必须已在库里。——
  app.post('/api/skills/install', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const container = String(body.container ?? '').trim();
    const spot = String(body.spot ?? '').trim();
    const skills = Array.isArray(body.skills) ? [...new Set(body.skills.map(String))] : [];
    if (!container || !spot || !skills.length) {
      throw new HttpError(400, 'container / spot / skills 必填', 'bad_request');
    }
    try {
      return await installSkillsToSpot(cfg, container, spot, skills);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e), 'bad_request');
    }
  });

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
    // 端点两路分开收；填了但不像 URL → 400 点名，不静默当没填。
    const epIn = (body.endpoints ?? {}) as Record<string, unknown>;
    const pickUrl = (v: unknown, side: 'openai' | 'anthropic'): string | undefined => {
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
      ...(pickUrl(epIn.anthropic, 'anthropic') ? { anthropic: { baseUrl: pickUrl(epIn.anthropic, 'anthropic')! } } : {}),
    };
    if (!endpoints.openai && !endpoints.anthropic) throw badRequest('至少填一个端点（OpenAI 兼容 / Anthropic 兼容）');
    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) throw badRequest('apiKey 必填');
    const models = Array.isArray(body.models)
      ? body.models.map(String).map((s) => s.trim()).filter(Boolean)
      : typeof body.models === 'string'
        ? body.models.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        : undefined;
    const prev = lib[pid];
    const p: AiProvider = {
      id: pid,
      name,
      endpoints,
      apiKey,
      ...(models && models.length ? { models } : prev?.models?.length ? { models: prev.models } : {}),
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
      ...(pick(epIn.anthropic) ? { anthropic: { baseUrl: pick(epIn.anthropic)! } } : {}),
    });
  });

  // 拉模型清单（两路独立，一路失败不影响另一路；错误在 errors 里点侧）。
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
      ...(pick(epIn.anthropic) ? { anthropic: { baseUrl: pick(epIn.anthropic)! } } : {}),
    };
    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) throw badRequest('apiKey 必填');
    if (!endpoints.openai && !endpoints.anthropic) throw badRequest('至少填一个端点');
    return fetchProviderModels(endpoints, apiKey);
  });

  // 保存全局绑定 + 立即应用。ids 缺省 = 全部受管容器（本机不进缺省——宿主是真实
  // 环境，只有显式覆盖才写）；ids 显式给 = 只应用这些（仍保存为全局绑定）。
  app.post('/api/ai/binding', async (req): Promise<BatchResult> => {
    await ensureAiMigrated();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lib = await getAiProviders();
    const invalid = validateBinding(body.binding, lib);
    if (invalid) throw badRequest(invalid);
    const binding = body.binding as AiBinding;
    await setAiBinding(binding);
    const ids = Array.isArray(body.ids) && body.ids.length ? (body.ids as unknown[]).map(String) : (await listManaged(cfg)).map((v) => v.id);
    if (ids.includes(HOST_TARGET)) {
      throw badRequest(`本机不进全局应用的缺省/批量目标——为本机配置走 /api/ai/targets/${HOST_TARGET}`);
    }
    return applyAiBindingToTargets(cfg, ids, binding);
  });

  // 目标覆盖（key = 容器名或 __host__）：保存 + 立即应用到这台。存在即生效
  // （sweep / 建容器补发用它替代全局绑定）。
  app.post('/api/ai/targets/:target', async (req): Promise<BatchResult> => {
    await ensureAiMigrated();
    const target = (req.params as { target: string }).target;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lib = await getAiProviders();
    const invalid = validateBinding(body.binding, lib);
    if (invalid) throw badRequest(invalid);
    return setTargetOverride(cfg, target, body.binding as AiBinding);
  });

  // 清除目标覆盖：容器 = 恢复跟随全局（立即应用全局绑定）；本机 = 回收本机受管条目。
  app.delete('/api/ai/targets/:target', async (req) => {
    const target = (req.params as { target: string }).target;
    const overrides = await getAiTargetOverrides();
    if (!overrides[target]) {
      throw new HttpError(404, target === HOST_TARGET ? '本机没有配置覆盖' : '该目标没有覆盖配置', 'not_found');
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

  // —— hosts 覆写（批量配置 tab） ——
  // 显式动作：content 是要写入的完整 base，服务块照常组合。ids 缺省 = 全部运行中
  // 受管理容器（模板由 overwriteHosts 内部排除——它是新容器的源头资产）。
  // 全局 hosts 面板已删：新容器的默认来自模板容器（可选中宿主 /etc/hosts 作源）。
  app.post('/api/hosts/apply', async (req): Promise<ApplyHostsResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const content = typeof body.content === 'string' ? body.content : '';
    if (!content.trim()) {
      throw new HttpError(400, 'no hosts content to apply', 'bad_request');
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return overwriteHosts(cfg, ids.length ? ids : await runningIds(cfg), content, 'manual');
  });

  // —— 容器内监听端口（内部服务直达）——
  // 无 ss/netstat 依赖：读 /proc/net/tcp{,6}，st=0A(LISTEN) 行的 local port 是十六进制，
  // busybox awk 无 strtonum，手写 hex->dec。dev(1000) 可读 /proc/net。
  app.get('/api/containers/:id/listen', async (req): Promise<{ ports: number[]; web: number[] }> => {
    const id = (req.params as { id: string }).id;
    const r = await resolve(cfg, id);
    requireControlled(r);
    if (!r.running) throw conflict('container not running');
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'awk',
        'NR>1 && $4=="0A" {split($2,a,":"); h=a[2]; d=0; for(i=1;i<=length(h);i++){v=index("0123456789abcdef",tolower(substr(h,i,1)))-1; d=d*16+v}; print d}',
        '/proc/net/tcp',
        '/proc/net/tcp6',
      ],
      Tty: false,
      timeoutMs: 8_000,
    });
    if (res.exitCode !== 0) throw wrapEngineError(new Error(res.stderr.trim() || `listen scan failed`), id);
    const ports = [...new Set(
      res.stdout
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
    )].sort((a, b) => a - b);
    // 并发探测全部端口（每端口独立超时，最坏 ~2s；实际内网毫秒级）。无 IP/探测失败 → 不标 web。
    if (!r.ip) return { ports, web: [] };
    const marks = await Promise.all(ports.map((p) => probeHtmlPort(r.ip as string, p)));
    const web = ports.filter((_, i) => marks[i]);
    return { ports, web };
  });
}
