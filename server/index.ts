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
import { makeRewriteUrl, registerProxy, proxyBases, proxyUnauthorizedHtml } from './proxy.js';
import { startActivityPoller } from './activity.js';
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
  // rewriteUrl：vhost 门面的入口（HTTP 与 WS upgrade 都经 fastify.routing，都吃到改写）。
  // 必须在 Fastify() 构造时传入——它包在路由分发最外层（fastify.js wrapRouting）。
  const app = Fastify({ logger: loggerOptions, rewriteUrl: makeRewriteUrl(cfg) });
  await app.register(websocket);

  // 鉴权：health 公开；其余 /api、/ws 与 Web 代理 /proxy 需 token。
  // /proxy 额外收 cookie（浏览器导航带不上 header，见 server/proxy.ts）；
  // 未授权的浏览器导航回 HTML 引导页而不是一行 JSON。
  app.addHook('onRequest', async (req, reply) => {
    const u = req.url;
    if (u.startsWith('/api/health')) return;
    if (u.startsWith('/api/') || u.startsWith('/ws/') || u.startsWith('/proxy/')) {
      if (u.startsWith('/proxy/') && req.method === 'GET' && !tokenOk(req, cfg)) {
        const bases = await proxyBases(cfg);
        return reply
          .code(401)
          .type('text/html; charset=utf-8')
          .send(proxyUnauthorizedHtml(bases[0]?.base ?? null, cfg.listen.port));
      }
      await requireToken(req, reply, cfg);
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
