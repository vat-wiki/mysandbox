// fastify 装配：websocket + static(可选) + 鉴权 hook + 路由。
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import { requireToken } from './auth.js';
import { registerRoutes } from './routes.js';
import { registerFileRoutes } from './files.js';
import { registerTerminal } from './terminal.js';
import { registerHostTerminal } from './hostTerminal.js';
import { registerHostFileRoutes } from './hostFiles.js';
import { registerBaseRoutes } from './base.js';
import { HttpError, wrapDocker } from './errors.js';
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
  const app = Fastify({ logger: loggerOptions });
  await app.register(websocket);

  // 鉴权：health 公开；其余 /api 与 /ws 需 token。
  app.addHook('onRequest', async (req, reply) => {
    const u = req.url;
    if (u.startsWith('/api/health')) return;
    if (u.startsWith('/api/') || u.startsWith('/ws/')) {
      await requireToken(req, reply, cfg);
    }
  });

  // 错误处理：HttpError -> 状态码 + {error}；docker 404 -> not_found；其余 500。
  app.setErrorHandler((err, _req, reply) => {
    const mapped = wrapDocker(err);
    if (mapped instanceof HttpError) {
      return reply.code(mapped.status).send({ error: { code: mapped.code, message: mapped.message } });
    }
    app.log.error({ err: mapped }, 'request failed');
    return reply.code(500).send({ error: { code: 'internal', message: mapped.message } });
  });

  await registerRoutes(app, cfg);
  await registerFileRoutes(app, cfg);
  await registerTerminal(app, cfg);
  await registerHostTerminal(app, cfg);
  await registerHostFileRoutes(app);
  await registerBaseRoutes(app, cfg);

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
