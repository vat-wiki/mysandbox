// REST 路由。/api/health 免鉴权；其余 /api/* + /ws/* 需 token（见 index.ts onRequest）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { connect as netConnect, type Socket } from 'node:net';
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
import { wrapEngineError, conflict, HttpError, badRequest } from './errors.js';
import { listContainerSessions, killContainerSession, TERMID_RE } from './terminal.js';
import { listHostSessions, killHostSession, listServiceSessions, killServiceSession } from './hostTerminal.js';
import { terminalActivity } from './activity.js';
import { createContainer, deleteManaged, type CreateInput } from './lifecycle.js';
import type { CreateSource, BaseProgress } from './engine/index.js';
import { beginSse } from './sse.js';
import { ipPoolView } from './network.js';
import { batchGit, batchSsh, batchClaudeRun, batchExec, type BatchResult } from './batch.js';
import { applyAiGateway, wiresOf, type AiGatewayInput, type GatewayWire } from './aiconfig.js';
import { getAiGateway, setAiGateway } from './state.js';
import { getVersion } from './version.js';
import { readHostHosts } from './hosts.js';
import { overwriteHosts, type ApplyHostsResult } from './hosts-sync.js';

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

// —— 端口 HTML 探测（区分「真 web 页面」与其他监听端口）——
// 宿主直连容器 IP 发最小 HTTP 请求：状态行是 HTTP 且（Content-Type text/html 或 body 以 '<' 开头）
// 才算 web。ssh/redis/postgres 这类要么先发 banner（非 HTTP 状态行）、要么等输入超时、
// 要么回 JSON/二进制——都判 false。HTTP/1.0 + Connection: close 让服务端回完即断，不留半开连接。
const PROBE_IDLE_MS = 800; // 连接后/发出请求后等待对端说话的上限（内网足够宽裕）
const PROBE_TOTAL_MS = 2_000; // 单端口总兜底

function probeHtmlPort(ip: string, port: number): Promise<boolean> {
  return new Promise((settled) => {
    const socket: Socket = netConnect({ host: ip, port });
    let buf = '';
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(totalTimer);
      socket.destroy();
      settled(v);
    };
    const totalTimer = setTimeout(() => finish(false), PROBE_TOTAL_MS);
    socket.setTimeout(PROBE_IDLE_MS, () => finish(false)); // 对端不说话（等输入的协议）→ 非 HTTP
    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.0\r\nHost: ${ip}:${port}\r\nUser-Agent: mysandbox-probe\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1 && buf.length < 16 * 1024) return; // 头部没完，继续收
      const head = idx === -1 ? buf : buf.slice(0, idx);
      if (!/^HTTP\/[\d.]+ \d{3}/.test(head)) return finish(false); // ssh banner 等：连了但不是 HTTP
      const ct = /content-type:[^\r\n]*/i.exec(head)?.[0] ?? '';
      const bodyStart = idx === -1 ? '' : buf.slice(idx + 4, idx + 64);
      // text/html 或 body 直接以 <!doctype / <html 开头（个别 dev server 不带正确 content-type）
      finish(/text\/html/i.test(ct) || /^\s*<(?:!doctype|html)/i.test(bodyStart));
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false)); // 头部没收全就断：不算（正常情况 data 里已 finish）
  });
}

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

  // —— AI 网关批量配置（myapikey 等兼容网关）——
  // GET 回最近一次下发存档（含 key；sidecar 0600 同 services.env 泄露面）供前端预填。
  app.get('/api/batch/ai-config', async () => ({ config: await getAiGateway() ?? null }));

  app.post('/api/batch/ai-config', async (req): Promise<BatchResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const ids = parseIds(body);
    const tools = (body.tools ?? {}) as Record<string, unknown>;
    const bool = (v: unknown) => v === true;
    // endpoints 两路协议分开收（openai / anthropic）；wire 是工具级协议多选
    // （数组，opencode/pi 专用；claude 固定 anthropic、codex 固定 responses 不进表）
    const epIn = (body.endpoints ?? {}) as Record<string, unknown>;
    const wireIn = (body.wire ?? {}) as Record<string, unknown>;
    const WIRE_VALUES: GatewayWire[] = ['openai-chat', 'openai-responses', 'anthropic-messages'];
    // URL 收参：收 string 或 {baseUrl} 两种形状（前端按 AiGatewayInput 发对象）。
    // 填了但不像 URL → 400 点名（而不是静默当没填，让用户以为配上了）；
    // 没填返回 undefined，由下方按工具需求校验。注意旧版这里只吃 string，导致
    // 前端发来的 {baseUrl} 被静默丢成 undefined——端点提取从未生效过。
    const pickUrl = (v: unknown, side: 'openai' | 'anthropic'): string | undefined => {
      const raw = typeof v === 'string' ? v : (v as { baseUrl?: unknown })?.baseUrl;
      if (raw == null || String(raw).trim() === '') return undefined;
      const s = String(raw).trim();
      if (!/^https?:\/\//.test(s))
        throw new HttpError(400, `endpoints.${side}.baseUrl 必须以 http:// 或 https:// 开头（收到 ${JSON.stringify(s)}）`, 'bad_request');
      return s.replace(/\/+$/, '');
    };
    // 单工具的 wire 数组收参：合法值校验 + 去重保序。未传（undefined）与空数组分明——
    // 前者走后端缺省 ['openai-chat']，后者是显式「清空所有变体」。
    const pickWires = (tool: string): GatewayWire[] | undefined => {
      const rawList = wireIn[tool];
      if (!Array.isArray(rawList)) return undefined;
      const seen: GatewayWire[] = [];
      for (const v of rawList) {
        if (typeof v !== 'string' || !(WIRE_VALUES as string[]).includes(v)) {
          throw new HttpError(400, `wire.${tool} 非法：${String(v)}（合法值 ${WIRE_VALUES.join('/')}）`, 'bad_request');
        }
        if (!seen.includes(v as GatewayWire)) seen.push(v as GatewayWire);
      }
      return seen;
    };
    const input: AiGatewayInput = {
      endpoints: {
        ...(pickUrl(epIn.openai, 'openai') ? { openai: { baseUrl: pickUrl(epIn.openai, 'openai')! } } : {}),
        ...(pickUrl(epIn.anthropic, 'anthropic') ? { anthropic: { baseUrl: pickUrl(epIn.anthropic, 'anthropic')! } } : {}),
      },
      apiKey: String(body.apiKey ?? '').trim(),
      tools: {
        claude: bool(tools.claude),
        codex: bool(tools.codex),
        opencode: bool(tools.opencode),
        pi: bool(tools.pi),
      },
      wire: {
        opencode: pickWires('opencode'),
        pi: pickWires('pi'),
      },
      models: Array.isArray(body.models)
        ? body.models.map(String).map((s) => s.trim()).filter(Boolean)
        : typeof body.models === 'string'
          ? body.models.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
          : [],
      setDefault: bool(body.setDefault),
    };
    // 校验按所勾工具动态收紧：某工具要哪条端点由它自己的 wire 集合决定。
    // claude/codex 是固定消费者（anthropic / openai），不依赖 wire 表。
    const t = input.tools;
    if (!t.claude && !t.codex && !t.opencode && !t.pi) {
      throw new HttpError(400, '至少勾选一个工具', 'bad_request');
    }
    if (!input.apiKey) throw new HttpError(400, 'apiKey required', 'bad_request');
    // 需求方点名（错误信息直接说谁要这条 URL，不让人猜）
    const needOpenaiWho: string[] = [];
    const needAnthropicWho: string[] = [];
    if (t.codex) needOpenaiWho.push('codex');
    if (t.claude) needAnthropicWho.push('claude');
    for (const tool of ['opencode', 'pi'] as const) {
      if (!t[tool]) continue;
      const wires = wiresOf(input, tool);
      const openaiWires = wires.filter((w) => w !== 'anthropic-messages');
      if (openaiWires.length)
        needOpenaiWho.push(`${tool}（${openaiWires.map((w) => (w === 'openai-responses' ? 'responses' : 'chat')).join('、')}）`);
      if (wires.includes('anthropic-messages')) needAnthropicWho.push(`${tool}（anthropic）`);
    }
    if (needOpenaiWho.length && !input.endpoints.openai) {
      throw new HttpError(400, `需要 OpenAI 兼容 Base URL：${needOpenaiWho.join('、')} 要走这条端点（或取消勾选/清空对应协议）`, 'bad_request');
    }
    if (needAnthropicWho.length && !input.endpoints.anthropic) {
      throw new HttpError(400, `需要 Anthropic 兼容 Base URL：${needAnthropicWho.join('、')} 要走这条端点（或取消勾选/清空对应协议）`, 'bad_request');
    }
    const modelsWho = (['opencode', 'pi'] as const).filter(
      (tool) => t[tool] && wiresOf(input, tool).length > 0,
    );
    if (modelsWho.length && (input.models ?? []).length === 0) {
      throw new HttpError(400, `${modelsWho.join('、')} 需要至少一个模型 ID（逗号分隔）`, 'bad_request');
    }
    const result = await applyAiGateway(cfg, ids, input);
    // 存档无条件记录最近一次意图（含部分失败），换 key 重推直接预填
    await setAiGateway({ ...input, updatedAt: new Date().toISOString() });
    return result;
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
