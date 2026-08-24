// REST 路由。/api/health 免鉴权；其余 /api/* + /ws/* 需 token（见 index.ts onRequest）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import {
  checkDocker,
  listManaged,
  startContainer,
  stopContainer,
  restartContainer,
  renameContainer,
  inspectContainer,
  execRun,
  MANAGED_LABEL,
} from './docker.js';
import { setMeta, getMeta, deleteMeta } from './state.js';
import { wrapDocker, conflict, HttpError } from './errors.js';
import { createContainer, deleteManaged } from './lifecycle.js';
import { ipPoolView } from './network.js';
import { batchGit, batchSsh, batchClaudeRun, batchExec, type BatchResult } from './batch.js';
import { getVersion } from './version.js';
import { getCustomHostsContent, setCustomHostsContent, readHostHosts } from './hosts.js';
import {
  resolveHostsContent,
  applyHostsToContainers,
  type ApplyHostsResult,
} from './hosts-sync.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export interface Resolved {
  id: string;
  name: string;
  managed: boolean;
  adopted: boolean;
  running: boolean;
}

export async function resolve(cfg: Config, id: string): Promise<Resolved> {
  let info: Awaited<ReturnType<typeof inspectContainer>>;
  try {
    info = await inspectContainer(cfg, id);
  } catch (e) {
    throw wrapDocker(e, id);
  }
  const name = (info.Name || '').replace(/^\//, '');
  const managed = info.Config?.Labels?.[MANAGED_LABEL] === 'mysandbox';
  const adopted = (await getMeta(name))?.managed === true;
  return { id, name, managed, adopted, running: info.State?.Running === true };
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

export async function registerRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  app.get('/api/health', async () => {
    const docker = await checkDocker(cfg);
    return { ok: true, version: getVersion(), docker };
  });

  app.get('/api/containers', async () => ({ items: await listManaged(cfg) }));

  app.get('/api/network/ips', async () => ipPoolView(cfg));

  // —— 新建容器 ——
  app.post('/api/containers', async (req) => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const result = await createContainer(cfg, {
      name: String(body.name ?? ''),
      ip: body.ip ? String(body.ip) : undefined,
      gitName: body.gitName ? String(body.gitName) : undefined,
      gitEmail: body.gitEmail ? String(body.gitEmail) : undefined,
      role: body.role ? String(body.role) : undefined,
      description: body.description ? String(body.description) : undefined,
      portMappings: body.portMappings as Record<string, Array<{ HostPort: string; HostIp?: string }>> | undefined,
    });
    return result;
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
      throw wrapDocker(e, id);
    }
    const name = (info.Name || '').replace(/^\//, '');
    const managed = info.Config?.Labels?.[MANAGED_LABEL] === 'mysandbox';
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

  // —— 全局 hosts 配置 ——
  // GET：panel 打开一次拿全。已保存自定义内容 -> isCustom；否则回退宿主 /etc/hosts 作建议默认 -> isHostDefault。
  app.get('/api/hosts', async () => {
    const custom = await getCustomHostsContent();
    if (custom != null) {
      return { content: custom, isCustom: true, isHostDefault: false };
    }
    const host = await readHostHosts();
    if (host) return { content: host, isCustom: false, isHostDefault: true };
    return {
      content: '',
      isCustom: false,
      isHostDefault: true,
      hostError: '无法读取宿主 /etc/hosts',
    };
  });

  // 实时读宿主 /etc/hosts，供「用宿主机内容」按钮。
  app.get('/api/hosts/host', async () => {
    const content = await readHostHosts();
    return content ? { content } : { content: '', error: '无法读取宿主 /etc/hosts' };
  });

  // 保存自定义 hosts（纯文本 sidecar，0600）+ 保存即生效：立即应用到所有运行中容器。
  // 空内容只保存不动容器（清空 /etc/hosts 从不是合法意图）。failed>0 仍 200——保存成功
  // 是主语义，失败在 applied 结果表可见。不带 skipUnchanged：重复保存同内容也强制刷，
  // 覆盖「用户手改了容器内 /etc/hosts 想重置」场景。
  app.put('/api/hosts', async (req): Promise<{ ok: true; applied: ApplyHostsResult | null }> => {
    const body = (req.body as { content?: unknown } | null) || {};
    const content = typeof body.content === 'string' ? body.content : '';
    await setCustomHostsContent(content);
    if (!content) return { ok: true, applied: null };
    const applied = await applyHostsToContainers(cfg, { content, reason: 'save' });
    return { ok: true, applied };
  });

  // 应用到运行中容器：以 root exec 覆写各容器 /etc/hosts。
  // 事件自动重刷后此路由是兜底（自动应用失败 / 手改过容器内 hosts 想强制重置 / 定向 ids）。
  // content 优先 body override > 已保存 > 宿主默认；ids 缺省=全部运行中受管理容器。
  app.post('/api/hosts/apply', async (req): Promise<ApplyHostsResult> => {
    const body = (req.body as Record<string, unknown> | null) || {};
    const explicit = typeof body.content === 'string' ? body.content : undefined;
    const { content } = await resolveHostsContent(explicit);
    if (!content) {
      throw new HttpError(400, 'no hosts content to apply (save first or pass content)', 'bad_request');
    }
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    return applyHostsToContainers(cfg, {
      content,
      ids: ids.length ? ids : undefined,
      reason: 'manual',
    });
  });

  // —— 容器内监听端口（内部服务直达）——
  // 无 ss/netstat 依赖：读 /proc/net/tcp{,6}，st=0A(LISTEN) 行的 local port 是十六进制，
  // busybox awk 无 strtonum，手写 hex->dec。dev(1000) 可读 /proc/net。
  app.get('/api/containers/:id/listen', async (req): Promise<{ ports: number[] }> => {
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
    if (res.exitCode !== 0) throw wrapDocker(new Error(res.stderr.trim() || `listen scan failed`), id);
    const ports = [...new Set(
      res.stdout
        .split('\n')
        .map((l) => Number(l.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
    )].sort((a, b) => a - b);
    return { ports };
  });
}
