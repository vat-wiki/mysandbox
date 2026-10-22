// fastify 装配：websocket + static(可选) + 鉴权 hook + 路由。
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import type { SandboxIdentity } from './auth.js';
import { resolveIdentity, tokenOk } from './auth.js';
import { registerAccounts } from './accounts.js';
import { registerRoutes } from './routes.js';
import { registerFileRoutes } from './files.js';
import { registerTerminal } from './terminal.js';
import { registerDesktop } from './desktop.js';
import { registerCodeServer } from './codeserver.js';
import { registerHostTerminal } from './hostTerminal.js';
import { registerSshTerminal } from './sshTerminal.js';
import { registerSshFileRoutes } from './sshFiles.js';
import { registerHostFileRoutes } from './hostFiles.js';
import { registerBaseRoutes } from './base.js';
import { registerAiRoutes } from './ai.js';
import { registerSkillRoutes } from './skills.js';
import { registerServices } from './services.js';
import { registerServiceFileRoutes } from './serviceFiles.js';
import { makeRewriteUrl, registerProxy, proxyUnauthorizedHtml } from './proxy.js';
import { registerMetrics } from './metrics.js';
import { startActivityPoller } from './activity.js';
import { startCodeServerIdleSweeper } from './codeserver.js';
import { ensureTlsMaterial } from './tls.js';
import { HttpError, wrapEngineError } from './errors.js';
import { getVersion } from './version.js';
import { loggerOptions } from './logger.js';
import { trustedNetworkRequest } from './trust.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findWebDist(): string | null {
  // dev: server/../web/dist；compiled/packaged: dist/server/../../web/dist
  const candidates = [
    join(__dirname, '..', 'web', 'dist'),
    join(__dirname, '..', '..', 'web', 'dist'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// —— 受限账户的访问白名单（deny-by-default）——
// 账户 = 「白名单容器的终端 + 文件面板」（server/accounts.ts 文件头）。路径层先放行
// 方法+形状，容器层再对 :id/query id 判白名单；不在表内一律 403——新增 owner 路由
// 默认对账户关闭，漏改是「账户用不了新功能」而不是「账户越权」，失败方向安全。
// 返回：'pass'（放行）| 'id-gate'（还需容器白名单判定）| 'deny'。
function accountPathVerdict(
  method: string,
  pathname: string,
  query: Record<string, unknown>,
): 'pass' | 'id-gate' | 'deny' {
  if (pathname === '/api/containers' && method === 'GET') return 'pass'; // handler 内过滤
  if (pathname === '/api/account/me' && method === 'GET') return 'pass';
  // 跨面板复制：两侧容器 id 在 body 里，hook 拿不到——'pass' 后由 handler 内对账户
  // 身份做双侧白名单判定（files.ts copyAccountOk）。
  if (pathname === '/api/files/copy' && method === 'POST') return 'pass';
  // 容器文件面板 + 终端支撑端点（fg/cwd/resolve/git）：全部对 :id 判白名单。
  const m = /^\/api\/containers\/([^/]+)(\/.*)?$/.exec(pathname);
  if (m) {
    const sub = m[2] ?? '/';
    if (method === 'GET' && ['/files', '/search', '/file', '/download', '/cwd', '/fg', '/resolve'].includes(sub)) {
      return 'id-gate';
    }
    if (method === 'PUT' && sub === '/file') return 'id-gate';
    if (method === 'POST' && /^\/fs\/(create|rename|delete)$/.test(sub)) return 'id-gate';
    if (/^\/git(\/|$)/.test(sub) && (method === 'GET' || method === 'POST')) return 'id-gate';
    return 'deny';
  }
  if (pathname === '/ws/terminal' && method === 'GET' && typeof query.id === 'string') {
    return 'id-gate';
  }
  return 'deny';
}

// 容器白名单判定（'id-gate' 的后半段）：id 即容器名（LXC engine id === name），
// URL 解码后对齐。不在白名单 → 403（前面已过鉴权，这里的 403 = 「账户越权」）。
function containerAllowed(identity: SandboxIdentity, rawId: string): boolean {
  if (identity.kind !== 'account') return true;
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    /* 保留原值 */
  }
  return identity.containers.has(id);
}

export async function buildServer(cfg: Config) {
  // listen.tls 现在描述 HTTPS 门面（server/facade.ts），控制台本体恒为 HTTP。
  const tls = cfg.listen.tls ? await ensureTlsMaterial(cfg) : null;
  // rewriteUrl：vhost 门面的入口（HTTP 与 WS upgrade 都经 fastify.routing，都吃到改写）。
  // 必须在 Fastify() 构造时传入——它包在路由分发最外层（fastify.js wrapRouting）。
  const app = Fastify({
    logger: loggerOptions,
    rewriteUrl: makeRewriteUrl(cfg),
  });
  await app.register(websocket);

  // CA 下载（公开材料，导入浏览器/系统信任库用）：不在 /api、/ws、/proxy 前缀下，
  // 全局鉴权 hook 天然不覆盖。
  if (tls) {
    app.get('/tls-ca.crt', async (_req, reply) => {
      reply.type('application/x-x509-ca-cert');
      return tls.caCert;
    });
  }

  // 鉴权：health 公开；其余 /api、/ws 与 Web 代理 /proxy 需 token。
  // 身份两级：主 token = owner 全权；账户派生 token = 白名单容器的终端+文件面板
  // （deny-by-default，见 accountPathVerdict）。cookie 仅在 /proxy 门面被承认
  // （vhost 页面路径任意，cookie 必须 Path=/ 才随行；/api、/ws 维持 header/query-only，
  // 被代理页面拿 cookie 打不进控制台 API——账户凭证也因此刻意走 header 而非 cookie）。
  // /proxy 未授权的浏览器导航回 HTML 引导页而不是一行 JSON。
  app.addHook('onRequest', async (req, reply) => {
    const u = req.url;
    if (u.startsWith('/api/health')) return;
    // session 自带 token 校验；vhost 401 内页用同源请求完成登录。
    if (
      (u === '/api/auth/session' || u === '/proxy/__auth/session')
      && (req.method === 'POST' || req.method === 'OPTIONS')
    ) return;
    // 账户登录本身公开（用户名+密码换账户 token，server/accounts.ts）。
    if (u === '/api/account/login' && req.method === 'POST') return;
    if (trustedNetworkRequest(req, cfg)) {
      // 内网互信 = owner（既有语义：trustLan 开着时私网来源免 token 全权）。
      req.sandboxIdentity = { kind: 'owner' };
      return;
    }
    const identity = await resolveIdentity(req, cfg);
    const isProxy = u.startsWith('/proxy/');
    if (!identity) {
      if (isProxy && req.method === 'GET' && !tokenOk(req, cfg, true)) {
        return reply
          .code(401)
          .type('text/html; charset=utf-8')
          .send(proxyUnauthorizedHtml());
      }
      if (u.startsWith('/api/') || u.startsWith('/ws/') || isProxy) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'invalid or missing token' },
        });
      }
      return;
    }
    if (identity.kind === 'account') {
      // 账户身份只走 /api、/ws 的白名单端点；/proxy 门面不开放（那是 proxy 凭据的
      // 地盘，且 cookie 流不适用于账户）。deny-by-default：新 owner 路由对账户恒 403。
      if (!u.startsWith('/api/') && !u.startsWith('/ws/')) {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'account identity is not allowed here' },
        });
      }
      const verdict = accountPathVerdict(req.method, u.split('?')[0] ?? u, (req.query ?? {}) as Record<string, unknown>);
      if (verdict === 'deny') {
        return reply.code(403).send({
          error: { code: 'forbidden', message: 'account identity is not allowed here' },
        });
      }
      if (verdict === 'id-gate') {
        const ok = /^\/ws\//.test(u)
          ? containerAllowed(identity, String((req.query as Record<string, unknown>).id ?? ''))
          : containerAllowed(identity, (/^\/api\/containers\/([^/]+)/.exec(u)?.[1]) ?? '');
        if (!ok) {
          return reply.code(403).send({
            error: { code: 'forbidden', message: 'container is not in this account allowlist' },
          });
        }
      }
    }
    req.sandboxIdentity = identity;
  });

  // 错误处理：HttpError -> 状态码 + {error}；引擎 404 -> not_found；其余 500。
  app.setErrorHandler((err, _req, reply) => {
    const mapped = wrapEngineError(err);
    if (mapped instanceof HttpError) {
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }
    app.log.error({ err: mapped }, 'request failed');
    return reply.code(500).send({ error: { code: 'internal', message: mapped.message } });
  });

  await registerMetrics(app);
  await registerRoutes(app, cfg);
  // 受限账户（server/accounts.ts）：公开登录 + owner 管理 CRUD。
  await registerAccounts(app, cfg);
  await registerFileRoutes(app, cfg);
  await registerTerminal(app, cfg);
  await registerDesktop(app, cfg);
  await registerCodeServer(app, cfg);
  await registerHostTerminal(app, cfg);
  // SSH 终端（server/sshTerminal.ts）：远程主机的 tmux 会话 + 目标 CRUD（sidecar）。
  await registerSshTerminal(app);
  await registerHostFileRoutes(app);
  await registerBaseRoutes(app, cfg);
  registerServices(app, cfg);
  // AI 路由（server/ai.ts）：AI 工具与技能中心（/api/ai/* + /api/testlens/*）。
  await registerAiRoutes(app, cfg);
  // 技能中心路由（server/skills.ts）：技能库/分发规则/已装清单（/api/skills/*）。
  await registerSkillRoutes(app, cfg);
  // 服务文件端点（server/serviceFiles.ts）：docker 服务容器的文件面板/编辑器/git 套件，
  // 前端 's:' 前缀 id（api.ts filesBase）切到这里。
  await registerServiceFileRoutes(app);
  // SSH 文件端点（server/sshFiles.ts）：远程主机（sshTerminal.ts 的 targets）的文件面板，
  // 四足鼎立的第四足；前端 'ssh:' 前缀 id（api.ts filesBase）切到这里。
  await registerSshFileRoutes(app);
  // Web 代理（server/proxy.ts）：cookie 会话 + /api/proxy/config + /proxy 转发核心。
  await registerProxy(app, cfg);
  // 终端输出活动扫描（server/activity.ts）：进程内周期轮询，供 /api/terminal-activity。
  startActivityPoller(cfg);
  // code-server 闲置自动停（server/codeserver.ts）：进程内周期 sweep。
  startCodeServerIdleSweeper(cfg);

  // 前端静态资源（web/dist）。开发期未构建则回退占位。
  const webDist = findWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist });
    // HTML5 路由 fallback：只对浏览器导航（Accept: text/html）回 index.html，静态
    // 资源缺失仍应 404，API/WS/代理路径维持各自的鉴权与错误语义。
    app.setNotFoundHandler(async (req, reply) => {
      const path = req.url.split(/[?#]/, 1)[0] ?? '';
      const protectedPrefix = path.startsWith('/api/') || path.startsWith('/ws/') || path.startsWith('/proxy/');
      const acceptsHtml = (req.headers.accept ?? '').includes('text/html');
      if (req.method === 'GET' && acceptsHtml && !protectedPrefix) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    });
  } else {
    app.get('/', async () => ({
      app: 'mysandbox',
      version: getVersion(),
      message: 'web UI not built yet — run `npm run build:web`',
      api: '/api/health',
    }));
  }

  return app;
}
