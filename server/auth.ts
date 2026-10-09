// token 校验。REST 走 header X-Sandbox-Token 或 query ?token=（WS 复用）；
// cookie 供 Web 代理门面用——浏览器导航到 vhost 代理页带不上 header，靠
// POST /api/auth/session 种下的会话 cookie（Path=/，但仅在 /proxy 门面被承认，
// 见 server/proxy.ts）。
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

// cookie 名。代理转上游前会剥掉（token 不出面板，不喂给被代理应用）。
export const COOKIE_NAME = 'mysandbox_token';

// 代理会话 cookie 的值是主 token 的 HMAC 派生值：账号密码登录者从 devtools 里也只
// 能看到代理凭据，不能拿它作为 X-Sandbox-Token 打 /api。
const PROXY_SESSION_CONTEXT = 'mysandbox:proxy-session';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function proxySessionToken(cfg: Config): string {
  if (!cfg.token) return '';
  return createHmac('sha256', cfg.token).update(PROXY_SESSION_CONTEXT).digest('base64url');
}

export function tokenValid(
  provided: string | undefined,
  cfg: Config,
  allowCookie = false,
): boolean {
  const expected = cfg.token;
  if (!expected || !provided) return false;
  if (safeEqual(expected, provided)) return true;
  return allowCookie && safeEqual(provided, proxySessionToken(cfg));
}

export function extractToken(req: FastifyRequest, allowCookie = false): string | undefined {
  const h = req.headers['x-sandbox-token'];
  if (typeof h === 'string') return h;
  const q = req.query as Record<string, unknown> | undefined;
  if (q && typeof q.token === 'string') return q.token;
  // cookie 只在 /proxy 门面被承认：vhost 门面的页面路径任意（cookie 必须 Path=/ 才
  // 随行），若 /api 也认 cookie，被代理页面的 JS 就能拿它打控制台 API——header/query
  // 管住 /api，隔离性不因 Path=/ 而丢。
  if (allowCookie) return cookieToken(req);
  return undefined;
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
  allowCookie = false,
): Promise<void> {
  if (!tokenValid(extractToken(req, allowCookie), cfg, allowCookie)) {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'invalid or missing token' },
    });
  }
}

// 布尔版：index.ts 的 hook 对 /proxy 浏览器导航要先判再回 HTML 引导页（而非 JSON 401）。
export function tokenOk(req: FastifyRequest, cfg: Config, allowCookie = false): boolean {
  return tokenValid(extractToken(req, allowCookie), cfg, allowCookie);
}
