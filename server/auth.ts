// token 校验。REST 走 header X-Sandbox-Token 或 query ?token=（WS 复用）；
// cookie 供 Web 代理门面用——浏览器直接导航到 /proxy/... 带不上 header，靠
// POST /api/auth/session 种下的会话 cookie（Path 限 /proxy，见 server/proxy.ts）。
import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

// cookie 名。代理转上游前会剥掉（token 不出面板，不喂给被代理应用）。
export const COOKIE_NAME = 'mysandbox_token';

export function tokenValid(provided: string | undefined, cfg: Config): boolean {
  const expected = cfg.token;
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractToken(req: FastifyRequest): string | undefined {
  const h = req.headers['x-sandbox-token'];
  if (typeof h === 'string') return h;
  const q = req.query as Record<string, unknown> | undefined;
  if (q && typeof q.token === 'string') return q.token;
  return cookieToken(req);
}

// 手工解析（不引 @fastify/cookie）：同名多值时取第一条——按 RFC 6265 更长 Path/更具体
// Domain 的 cookie 在前，天然取到最具体域那条（sslip 同基跨站投毒的缓解，见 proxy.ts）。
function cookieToken(req: FastifyRequest): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export async function requireToken(
  req: FastifyRequest,
  reply: FastifyReply,
  cfg: Config,
): Promise<void> {
  if (!tokenValid(extractToken(req), cfg)) {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'invalid or missing token' },
    });
  }
}

// 布尔版：index.ts 的 hook 对 /proxy 浏览器导航要先判再回 HTML 引导页（而非 JSON 401）。
export function tokenOk(req: FastifyRequest, cfg: Config): boolean {
  return tokenValid(extractToken(req), cfg);
}
