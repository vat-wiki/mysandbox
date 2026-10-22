// token 校验。REST 走 header X-Sandbox-Token 或 query ?token=（WS 复用）；
// cookie 供 Web 代理门面用——浏览器导航到 vhost 代理页带不上 header，靠
// POST /api/auth/session 种下的会话 cookie（Path=/，但仅在 /proxy 门面被承认，
// 见 server/proxy.ts）。
import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';
import { getAccount } from './state.js';

// cookie 名。代理转上游前会剥掉（token 不出面板，不喂给被代理应用）。
export const COOKIE_NAME = 'mysandbox_token';

// —— 受限账户身份（分享用，见 server/accounts.ts）——
// 账户凭证 = 主 token 的 HMAC 派生 token（`a:<名>:<mac>`），走同一个 X-Sandbox-Token
// header/query。刻意不用 cookie：/api、/ws 维持 header/query-only 是既有隔离面（被
// 代理页面的 JS 拿 cookie 打不进控制台 API），账户若走 cookie 就把这层凿穿了。
export type SandboxIdentity =
  | { kind: 'owner' } // 主 token（或 trustLan 内网互信）：宿主属主等价，全权
  | { kind: 'account'; name: string; containers: Set<string> }; // 受限账户：白名单容器

declare module 'fastify' {
  interface FastifyRequest {
    sandboxIdentity?: SandboxIdentity;
  }
}

const ACCOUNT_CONTEXT = 'mysandbox:account:';

// 账户 token 与 proxy session cookie 同构（主 token 派生）：泄露账户 token 打不进
// owner 面（不是主 token），owner 面（主 token）也从不出去做账户登录。
export function accountToken(name: string, cfg: Config): string {
  if (!cfg.token) return '';
  const mac = createHmac('sha256', cfg.token)
    .update(ACCOUNT_CONTEXT + name)
    .digest('base64url');
  return `a:${name}:${mac}`;
}

export function isAccountTokenShape(provided: string): boolean {
  return provided.startsWith('a:') && provided.slice(2).includes(':');
}

async function accountFromToken(provided: string, cfg: Config): Promise<SandboxIdentity | null> {
  if (!cfg.token) return null;
  const rest = provided.slice(2);
  const sep = rest.lastIndexOf(':');
  if (sep <= 0) return null;
  const name = rest.slice(0, sep);
  const mac = rest.slice(sep + 1);
  const expected = createHmac('sha256', cfg.token)
    .update(ACCOUNT_CONTEXT + name)
    .digest('base64url');
  if (!safeEqual(mac, expected)) return null;
  // HMAC 命中只能证明「曾经发过这枚 token」，账户可能已被删除/改密——每次请求对
  // state（进程内缓存）活体复核，删账户即时失效。
  const acct = await getAccount(name);
  if (!acct) return null;
  return { kind: 'account', name: acct.name, containers: new Set(acct.containers) };
}

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

// 身份解析：主 token → owner；账户派生 token → account；都没有 → null（401）。
// 只认 header/query（allowCookie 恒 false）——cookie 是 /proxy 门面的专用通道，
// 混进 /api 会破坏「被代理页面打不进控制台」的隔离（见文件头）。
export async function resolveIdentity(req: FastifyRequest, cfg: Config): Promise<SandboxIdentity | null> {
  const provided = extractToken(req);
  if (!provided || !cfg.token) return null;
  if (safeEqual(provided, cfg.token)) return { kind: 'owner' };
  if (isAccountTokenShape(provided)) return accountFromToken(provided, cfg);
  return null;
}
