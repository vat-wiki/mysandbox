// 文件分享链接（web 文件 tab「复制链接」）：短期、单路径、只读下载。
//
// 链接**不携带任何凭证本体**——只带一枚对 (target, path, exp) 的 HMAC-SHA256 签名。
// 拿到链接 = 只能对这一个目标的一个路径发起 GET /download，且到期即失效；主 token
// 与账户 token 永不出现在 URL 里（不落浏览器历史/服务器访问日志的明文凭证面）。
// 签名密钥复用主 token：HMAC 单向，签名不反推密钥，且主 token 本就是本部署的
// 信任根，不引入第二份需要持久化的密钥。验签在全局鉴权 hook 的豁免位做
//（index.ts——收链接的人没有 token，必须在 identity 解析前放行），签发入口是
// 常规鉴权下的 POST /api/files/share-link（files.ts；账户仅可对自己白名单内的
// 裸容器名签发）。
//
// target 采用 web 侧 api.ts filesBase 的哨兵约定：容器名 | '__host__' | 's:<名>'
// | 'ssh:<名>'——验签时从 URL 形状反解出同一约定值比对，签名换 URL 用不了。
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';

const CONTEXT = 'mysandbox:share:';
// TTL 硬顶：签发入口的 ttlMinutes 上限 1h（默认 10min 在路由层给）。
export const SHARE_MAX_TTL_MS = 60 * 60_000;

export interface ShareGrant {
  t: string; // target（filesBase 哨兵约定，见文件头）
  p: string; // path（签发时的规范形）
  e: number; // exp：到期 epoch ms
}

function sign(cfg: Config, payload: string): string {
  // cfg.token 理论上可缺省（config 生成前）——调用方两侧都有 guard，这里非空断言由
  // mint/verify 的前置检查兜住。
  return createHmac('sha256', cfg.token || '').update(CONTEXT + payload).digest('base64url');
}

// 签发：ttlMs 钳到 [1min, SHARE_MAX_TTL_MS]，返回给前端拼 URL 的 share 参数与到期时刻。
export function mintShareToken(
  cfg: Config,
  target: string,
  path: string,
  ttlMs: number,
): { share: string; expiresAt: number } {
  if (!cfg.token) throw new Error('token not configured; cannot mint share link');
  const exp = Date.now() + Math.min(Math.max(ttlMs, 60_000), SHARE_MAX_TTL_MS);
  const payload = Buffer.from(JSON.stringify({ t: target, p: path, e: exp } satisfies ShareGrant)).toString(
    'base64url',
  );
  return { share: `${payload}.${sign(cfg, payload)}`, expiresAt: exp };
}

function verifyShareToken(cfg: Config, share: string, target: string, path: string): boolean {
  if (!cfg.token || typeof share !== 'string') return false;
  const dot = share.lastIndexOf('.');
  if (dot <= 0) return false;
  const payload = share.slice(0, dot);
  const mac = share.slice(dot + 1);
  const expected = sign(cfg, payload);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  let g: ShareGrant;
  try {
    g = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ShareGrant;
  } catch {
    return false;
  }
  // target/path/exp 三绑定：签名挪到别的路径、别的目标、别的端点（target 形状不同）
  // 一律不认；过期不认。
  return g.t === target && g.p === path && typeof g.e === 'number' && g.e > Date.now();
}

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// 全局 hook 的豁免判定：GET 且 URL 是四侧 /download 形状、带 share+path query、
// 验签通过。query 手工正则提取而非 URLSearchParams——后者把裸 `+` 解成空格，
// 路径里的 `+` 会造成合法链接验签失败（encodeURIComponent 不转义 `+`）。
export function shareDownloadAllows(req: FastifyRequest, cfg: Config): boolean {
  if (req.method !== 'GET') return false;
  const u = req.url;
  const qIdx = u.indexOf('?');
  const pathname = qIdx < 0 ? u : u.slice(0, qIdx);
  // 四侧 download 端点（与 files.ts/hostFiles.ts/serviceFiles.ts/sshFiles.ts 注册的
  // 路由一比一），反解出 filesBase 哨兵约定的 target。
  let target: string | null = null;
  let m = /^\/api\/containers\/([^/]+)\/download$/.exec(pathname);
  if (m) target = dec(m[1]);
  if (target === null && pathname === '/api/host-terminal/download') target = '__host__';
  if (target === null) {
    m = /^\/api\/services\/([^/]+)\/download$/.exec(pathname);
    if (m) target = 's:' + dec(m[1]);
  }
  if (target === null) {
    m = /^\/api\/ssh\/([^/]+)\/download$/.exec(pathname);
    if (m) target = 'ssh:' + dec(m[1]);
  }
  if (target === null) return false;
  const qs = qIdx < 0 ? '' : u.slice(qIdx + 1);
  // 在完整 url 上找（首个参数前面是 '?' 而非 '&'，只在 qs 里找会漏掉第一参）。
  const pick = (k: string): string | null => {
    const mm = new RegExp(`[?&]${k}=([^&]*)`).exec(u);
    return mm ? dec(mm[1]) : null;
  };
  const share = pick('share');
  const path = pick('path');
  if (!share || !path) return false;
  return verifyShareToken(cfg, share, target, path);
}
