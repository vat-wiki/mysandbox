// REST 路由。/api/health 免鉴权；其余 /api/* + /ws/* 需 token（见 index.ts onRequest）。
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
import { wrapEngineError, conflict, HttpError, badRequest } from './errors.js';
import { listContainerSessions, killContainerSession, TERMID_RE } from './terminal.js';
import { listHostSessions, killHostSession, listServiceSessions, killServiceSession } from './hostTerminal.js';
import { listSshSessions, killSshSession } from './sshTerminal.js';
import { terminalActivity } from './activity.js';
import { putTerminalClipboard } from './terminalClipboard.js';
import { agentKeyOf, agentSeenOf, agentWaitingView } from './agentNotify.js';
import { pushPublicKey, subscribePush, unsubscribePush, noteWatching } from './push.js';
import { createContainer, deleteManaged, type CreateInput } from './lifecycle.js';
import { syncSshConfig } from './sshConfigSync.js';
import type { CreateSource, BaseProgress } from './engine/index.js';
import { beginSse } from './sse.js';
import { withPollCache } from './cache.js';
import { registerEventsRoute } from './events.js';
import { declareFileWatches } from './fileWatch.js';
import { ipPoolView } from './network.js';
import { batchGit, batchSsh, batchClaudeRun, batchExec, type BatchResult } from './batch.js';
import { getVersion } from './version.js';
import { readHostHosts } from './hosts.js';
import { overwriteHosts, type ApplyHostsResult } from './hosts-sync.js';
import { probeHtmlPort } from './portprobe.js';
import {
  joinCluster,
  acceptPeer,
  leaveCluster,
  receiveGossip,
  selfInfo,
  loadClusterState,
  pullTemplate,
  syncSkillsFromPeer,
  allocSnapshot,
  handleAllocate,
} from './cluster.js';
import { loadWgState, wgStatus } from './wireguard.js';

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
      // 不放名字/路径/配置值（约束见 AGENTS.md）。
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
  // items[].agent = 该会话收到过 agent 精准信号（agentNotify.ts）——前端据此整体
  // 退出启发式；agentWaiting = 待消费的 agent 等待事件（前端精准挂标的依据）。
  app.get('/api/terminal-activity', async () => ({
    threshold: cfg.terminal.quietSeconds,
    items: terminalActivity().map((r) => ({
      ...r,
      agent: agentSeenOf(agentKeyOf(r.kind, r.containerId ?? '', r.termId)),
    })),
    agentWaiting: agentWaitingView(),
  }));

  // —— Web Push（站外推送，server/push.ts）：订阅登记 + 「在看」心跳 ——
  // 均在全局鉴权 hook 内。推送发送不在路由——agentNotify 的 waiting 落表即推。
  app.get('/api/push/key', async () => ({ key: pushPublicKey() }));
  app.post('/api/push/subscribe', async (req) => {
    subscribePush(req.body);
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    const b = (req.body || {}) as Record<string, unknown>;
    if (typeof b.endpoint === 'string') unsubscribePush(b.endpoint);
    return { ok: true };
  });
  app.post('/api/push/watching', async () => {
    noteWatching();
    return { ok: true };
  });

  app.get('/api/network/ips', async () => ipPoolView(cfg));

  // —— web 终端剪贴板桥（暂存区在 terminalClipboard.ts）——
  // 前端 Ctrl+V 手势里读浏览器剪贴板推上来；容器内 xclip/wl-paste shim 经 peer
  // GET /clipboard 取走。bodyLimit 对齐文件端点（图片 base64 ~16MB）。
  app.post(
    '/api/terminal-clipboard',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req) => {
      const body = (req.body as { image?: unknown; text?: unknown }) || {};
      if (body.image !== undefined) {
        const img = body.image as { mime?: unknown; b64?: unknown };
        if (typeof img.b64 !== 'string') throw badRequest('image.b64 (string) required');
        // mime 由服务端钉死 image/png：前端 canvas 统一转 PNG 再推，字段根本不用传。
        if (img.mime !== undefined && img.mime !== 'image/png') {
          throw badRequest('image.mime must be image/png（前端统一转 PNG）');
        }
      }
      if (body.text !== undefined && typeof body.text !== 'string') {
        throw badRequest('text must be string');
      }
      if (body.image === undefined && body.text === undefined) {
        throw badRequest('image or text required');
      }
      putTerminalClipboard({
        ...(body.image !== undefined
          ? { image: { mime: 'image/png', b64: (body.image as { b64: string }).b64 } }
          : {}),
        ...(body.text !== undefined ? { text: body.text } : {}),
      });
      return { ok: true };
    },
  );

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
    void syncSshConfig(cfg); // 收编的容器（有 IP）也进 SSH 别名
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
    void syncSshConfig(cfg); // SSH 别名跟新名字（旧别名随整文件重写消失）
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
    // TTL 缓存 + in-flight 去重：前端 5s 一拍轮询（多个文件面板共享容器级结果），
    // 底层是整 exec + 全端口 HTML 探测（p50 ~850ms），缓存把每日数万次执行收敛到
    // 每容器每 3s 至多一次。端口集合在 3s 内变化用户无感。
    return withPollCache(`listen:${id}`, 3_000, async (): Promise<{ ports: number[]; web: number[] }> => {
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
  });

  // —— 全局事件通道（server/events.ts）+ 文件 watch 声明（server/fileWatch.ts）——
  // 前端轮询的事件化替代：容器/服务状态来自 lxc-monitor 与 docker events 的旁路转发，
  // 文件变化来自 fs.watch（前端声明要看的目录）。鉴权在全局 hook（/api/* 全覆盖）。
  registerEventsRoute(app);
  app.post('/api/file-watches', async (req) => {
    const b = (req.body ?? {}) as { clientId?: unknown; items?: unknown };
    const items = Array.isArray(b.items)
      ? (b.items as { target?: unknown; dirs?: unknown }[]).map((it) => ({
          target: typeof it?.target === 'string' ? it.target : '',
          dirs: Array.isArray(it?.dirs) ? (it.dirs as unknown[]).filter((d): d is string => typeof d === 'string') : [],
        }))
      : [];
    return declareFileWatches(cfg, typeof b.clientId === 'string' ? b.clientId : '', items);
  });

  // —— 集群（peer-to-peer 组网）——
  app.get('/api/cluster/info', async () => {
    return selfInfo(cfg);
  });

  app.get('/api/cluster/status', async () => {
    const cluster = await loadClusterState();
    const wg = await loadWgState();
    const tunnel = await wgStatus();
    // alloc = IP 分配表（裁决节点统一发放、各节点各存一份）。前端据此展示「谁分到哪段」。
    const alloc = await allocSnapshot(cfg);
    return {
      machineId: cluster?.machineId ?? wg?.machineId ?? null,
      name: cluster?.name ?? null,
      peers: cluster?.peers ?? [],
      wgPeers: wg?.peers ?? [],
      tunnel,
      alloc,
    };
  });

  // —— IP 分配表 ——
  // GET：本节点这份表；POST：向裁决节点申请一段（非裁决节点会转发给裁决节点）。
  app.get('/api/cluster/allocations', async () => {
    return allocSnapshot(cfg);
  });

  app.post('/api/cluster/allocate', async (req) => {
    const b = (req.body ?? {}) as { machineId?: unknown; name?: unknown };
    return handleAllocate(cfg, {
      machineId: typeof b.machineId === 'string' ? b.machineId : undefined,
      name: typeof b.name === 'string' ? b.name : undefined,
    });
  });

  app.post('/api/cluster/join', async (req) => {
    const b = (req.body ?? {}) as { url?: unknown; token?: unknown; name?: unknown };
    if (typeof b.url !== 'string' || !b.url) throw badRequest('url required');
    if (typeof b.token !== 'string' || !b.token) throw badRequest('token required');
    return joinCluster(cfg, b.url, b.token, typeof b.name === 'string' ? b.name : undefined);
  });

  app.put('/api/cluster/peer', async (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.machineId !== 'string') throw badRequest('machineId required');
    if (typeof b.publicKey !== 'string') throw badRequest('publicKey required');
    await acceptPeer(cfg, b as { machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; publicKey: string; endpoint: string });
    return { ok: true };
  });

  app.delete('/api/cluster/peer/:machineId', async (req) => {
    const { machineId } = req.params as { machineId: string };
    await leaveCluster(cfg, machineId);
    return { ok: true };
  });

  app.post('/api/cluster/gossip', async (req) => {
    const b = (req.body ?? {}) as { from?: { machineId?: unknown } | unknown; peers?: unknown };
    if (!Array.isArray(b.peers)) throw badRequest('peers array required');
    const from = typeof b.from === 'object' && b.from !== null && 'machineId' in b.from
      ? String((b.from as { machineId: unknown }).machineId)
      : typeof b.from === 'string' ? b.from : '';
    await receiveGossip(cfg, from, b.peers as { machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; url?: string; token?: string }[]);
    return { ok: true };
  });

  app.post('/api/cluster/template/pull', async (req) => {
    const b = (req.body ?? {}) as { machineId?: unknown };
    if (typeof b.machineId !== 'string') throw badRequest('machineId required');
    return pullTemplate(cfg, b.machineId);
  });

  app.post('/api/cluster/skills/sync', async (req) => {
    const b = (req.body ?? {}) as { machineId?: unknown };
    if (typeof b.machineId !== 'string') throw badRequest('machineId required');
    return syncSkillsFromPeer(cfg, b.machineId);
  });
}
