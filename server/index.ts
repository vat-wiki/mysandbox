// fastify 装配：websocket + static(可选) + 鉴权 hook + 路由。
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import { requireToken, tokenOk } from './auth.js';
import { registerRoutes } from './routes.js';
import { registerFileRoutes } from './files.js';
import { registerTerminal } from './terminal.js';
import { registerDesktop } from './desktop.js';
import { registerHostTerminal } from './hostTerminal.js';
import { registerHostFileRoutes } from './hostFiles.js';
import { registerBaseRoutes } from './base.js';
import { registerServices } from './services.js';
import { registerServiceFileRoutes } from './serviceFiles.js';
import { makeRewriteUrl, registerProxy, consoleOrigin, proxyBases, proxyUnauthorizedHtml } from './proxy.js';
import { startActivityPoller } from './activity.js';
import { ensureTlsMaterial } from './tls.js';
import { HttpError, wrapEngineError } from './errors.js';
import { getVersion } from './version.js';
import { loggerOptions } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function findWebDist(): string | null {
  // dev: server/../web/dist；compiled/packaged: dist/server/../../web/dist
  const candidates = [
    join(__dirname, '..', 'web', 'dist'),
    join(__dirname, '..', '..', 'web', 'dist'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function buildServer(cfg: Config) {
  // 自签名 TLS（listen.tls）：本地 CA + 泛域名叶子，持久化 + 惰性重签（见 tls.ts）。
  const tls = cfg.listen.tls ? await ensureTlsMaterial(cfg) : null;
  // rewriteUrl：vhost 门面的入口（HTTP 与 WS upgrade 都经 fastify.routing，都吃到改写）。
  // 必须在 Fastify() 构造时传入——它包在路由分发最外层（fastify.js wrapRouting）。
  const app = Fastify({
    logger: loggerOptions,
    rewriteUrl: makeRewriteUrl(cfg),
    ...(tls ? { https: { key: tls.key, cert: tls.cert } } : {}),
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
  // cookie 仅在 /proxy 门面被承认（vhost 页面路径任意，cookie 必须 Path=/ 才随行；
  // /api、/ws 维持 header/query-only，被代理页面拿 cookie 打不进控制台 API）。
  // /proxy 未授权的浏览器导航回 HTML 引导页而不是一行 JSON。
  app.addHook('onRequest', async (req, reply) => {
    const u = req.url;
    if (u.startsWith('/api/health')) return;
    const isProxy = u.startsWith('/proxy/');
    if (u.startsWith('/api/') || u.startsWith('/ws/') || isProxy) {
      if (isProxy && req.method === 'GET' && !tokenOk(req, cfg, true)) {
        const bases = await proxyBases(cfg);
        return reply
          .code(401)
          .type('text/html; charset=utf-8')
          .send(proxyUnauthorizedHtml(consoleOrigin(cfg, bases[0]?.base ?? null)));
      }
      await requireToken(req, reply, cfg, isProxy);
    }
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

  await registerRoutes(app, cfg);
  await registerFileRoutes(app, cfg);
  await registerTerminal(app, cfg);
  await registerDesktop(app, cfg);
  await registerHostTerminal(app, cfg);
  await registerHostFileRoutes(app);
  await registerBaseRoutes(app, cfg);
  registerServices(app, cfg);
  // 服务文件端点（server/serviceFiles.ts）：docker 服务容器的文件面板/编辑器/git 套件，
  // 前端 's:' 前缀 id（api.ts filesBase）切到这里。
  await registerServiceFileRoutes(app);
  // Web 代理（server/proxy.ts）：cookie 会话 + /api/proxy/config + /proxy 转发核心。
  await registerProxy(app, cfg);
  // 终端输出活动扫描（server/activity.ts）：进程内周期轮询，供 /api/terminal-activity。
  startActivityPoller(cfg);

  // 前端静态资源（web/dist）。开发期未构建则回退占位。
  const webDist = findWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist });
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
