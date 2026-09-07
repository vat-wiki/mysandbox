// Web 代理：让面板之外（其他设备 / 不在宿主局域网）经 mysandbox 访问容器与 docker
// 服务的 HTTP(+WS) 端口。
//
// 动机：容器/服务都在 mysandbox 自管的内网（mysandbox0 / mysandbox-lan），外部设备
// 只能摸到宿主。把出口收敛进面板：同一个监听端口、同一套 token 鉴权、按目标转发。
//
// 两条门面，一套转发核心（rewriteUrl 把 vhost 归一到子路径形式）：
// - vhost 门面（主）：Host 首标签解析 `<name>-<port>.<基域名>` → 改写成
//   /proxy/<c|s>/<name>/<port><原路径>。fastify 的 rewriteUrl 在路由前调用，且 WS
//   upgrade 经 @fastify/websocket 的 fastify.routing 分发（见 fastify.js wrapRouting
//   的 `routing: httpHandler`）——HTTP 与 WS 都吃到改写，无需自己挂 upgrade 监听。
//   首标签解析不出 name-port、或白名单未命中（含基域名裸访问 = 控制台自己）→ 原样放行。
// - 子路径门面（兜底）：/proxy/<c|s>/<name>/<port>/... 直接访问（DNS 不可用等场景；
//   vite dev 也走这条）。
//
// 基域名（proxy.vhost）：auto = 按默认路由 IPv4 生成 <ip-连字符>.sslip.io（公共 DNS
// 恒等该 IP，无需自有域名；tailscale0 的 100.64/10 地址一并给候选，远程设备选它）；
// off = 关闭 vhost；其他值 = 自有域名（需泛解析 *.<域名> → 宿主）。sslip.io 不在
// Public Suffix List（实测 publicsuffix.org），Domain cookie 与 same-site 均成立；
// 有自有域名优先自有（sslip 全体用户互为 same-site，理论上有跨站 cookie 投毒面，
// 读 cookie 时取最具体域那条即可缓解——auth.ts 的 cookieToken 语义天然如此）。
//
// 转发实现：
// - HTTP：@fastify/reply-from，动态上游 reply.from(fullUrl)。body 原始流透传（代理
//   封装作用域内 addContentTypeParser 全量 pass-through，JSON/text 也不解析），SSE/
//   上传不缓冲；响应头改写 Location（相对/上游 origin → 代理前缀）与 Set-Cookie 的
//   Path（上游 Path=/ 收进代理前缀，避免多应用同名 cookie 互相覆盖）。Host 原样透传
//   （vhost 域名对应用侧的 ALLOWED_HOSTS/绝对重定向更友好，reply-from 默认改上游
//   host，rewriteRequestHeaders 里改回来）。
// - WS：同一路由全声明式挂 wsHandler（@fastify/websocket 支持 handler+wsHandler 同
//   路径），ws 客户端连上游、两侧对泵，子协议透传。
// - 裸 TCP（数据库等）浏览器本就进不来，不在范围——远程场景用 tailscale 子网路由直连。
//
// 安全面：
// - 目标白名单 = 受管容器 IP（listManaged，模板恒排除）∪ docker 服务 IP（state 权威，
//   停机服务可解析；running 实测补漏）。**精确集合不放网段**——网段含 .1（宿主副 IP），
//   放网段等于把代理当 SSRF 跳板指回宿主。rewriteUrl 同步读缓存（TTL 懒刷新，写错
//   这里会每请求 spawn 进程，见 refreshTargets）。
// - cookie 鉴权：浏览器导航/新开 tab 带不上 header → POST /api/auth/session 下发
//   mysandbox_token cookie（Path=/，HttpOnly SameSite=Strict）。**隔离性在 auth hook
//   而非 Path**：cookie 仅在 /proxy 门面被承认，/api、/ws 维持 header/query-only——
//   被代理页面的 JS 拿着 cookie 打不进控制台 API。每个候选基域各发一份 Domain 版
//   （本机 mysandbox.test、远程 tailscale 域名各自种上；domain-match 不成立的被
//   浏览器拒收，无害）。
// - 转发上游前剥掉 cookie 与 x-sandbox-token（token 不出面板，不喂给被代理应用）。
// - SameSite=Strict：控制台内 window.open（同站）与地址栏直贴都带 cookie；从其他
//   站点点链接会 401 → 引导页给控制台链接，接受。
import { networkInterfaces } from 'node:os';
import { readFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawRequestDefaultExpression } from 'fastify';
import type { WebsocketHandler } from '@fastify/websocket';
import WebSocket, { type RawData } from 'ws';
import replyFrom from '@fastify/reply-from';
import type { Config } from './config.js';
import { listManaged, startContainer } from './engine/index.js';
import { containerIpamIp, listServiceContainers } from './docker.js';
import { getAllServiceMeta } from './state.js';
import { log } from './logger.js';
import { badRequest, notFound } from './errors.js';
import { COOKIE_NAME } from './auth.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const TARGET_TTL_MS = 3_000;

// —— 目标白名单（精确集合缓存） ——

interface ProxyTarget {
  kind: 'c' | 's';
  name: string;
  ip: string;
  running: boolean;
}

let cache: { at: number; map: Map<string, ProxyTarget> } = { at: 0, map: new Map() };
let inflight: Promise<void> | null = null;

function rowNameOf(names: string): string {
  return names.split(',')[0].replace(/^\//, '');
}

async function refreshTargets(cfg: Config): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const map = new Map<string, ProxyTarget>();
    // 容器段：listManaged 已排除模板；IP 运行中实测、停机读 config 静态值（停机可解析）。
    try {
      for (const v of await listManaged(cfg)) {
        if (!v.ip) continue;
        map.set(`c/${v.name}`, { kind: 'c', name: v.name, ip: v.ip, running: v.state === 'running' });
      }
    } catch {
      /* 引擎不可用：容器段空，服务段照常 */
    }
    // 服务段：state.services 是停机也可解析的权威；running 实测补状态与 state 缺失的孤儿。
    try {
      for (const [name, m] of Object.entries(await getAllServiceMeta())) {
        if (!m.ip) continue;
        map.set(`s/${name}`, { kind: 's', name, ip: m.ip, running: false });
      }
      for (const row of await listServiceContainers()) {
        const name = rowNameOf(row.Names);
        const t = map.get(`s/${name}`);
        if (t) {
          t.running = row.State === 'running';
        } else {
          const ip = await containerIpamIp(name).catch(() => null);
          if (ip) map.set(`s/${name}`, { kind: 's', name, ip, running: row.State === 'running' });
        }
      }
    } catch {
      /* docker daemon 挂了：服务段空，不拖垮容器段 */
    }
    cache = { at: Date.now(), map };
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

// rewriteUrl 是同步钩子（每请求都跑）：只读缓存，过期则触发后台刷新、本次用旧表。
function resolveTargetSync(cfg: Config, kind: 'c' | 's', name: string): ProxyTarget | null {
  if (Date.now() - cache.at > TARGET_TTL_MS) void refreshTargets(cfg);
  return cache.map.get(`${kind}/${name}`) ?? null;
}

async function resolveTargetFresh(cfg: Config, kind: 'c' | 's', name: string): Promise<ProxyTarget | null> {
  if (Date.now() - cache.at > TARGET_TTL_MS) await refreshTargets(cfg);
  return cache.map.get(`${kind}/${name}`) ?? null;
}

// —— vhost 基域名 ——

export interface ProxyBase {
  base: string;
  kind: 'custom' | 'local' | 'lan' | 'tailscale';
}

// auto 模式的固定本地域（产品默认的好记域名）。解析前提见 proxyBases 内注释。
const LOCAL_BASE = 'mysandbox.test';

// 默认路由接口的 IPv4（镜像 cli.ts resolveAutoHost 的读法；拿不到返回 null）。
async function defaultRouteIp(): Promise<string | null> {
  let ifname: string | undefined;
  try {
    for (const line of (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[1] === '00000000') {
        ifname = c[0];
        break;
      }
    }
  } catch {
    /* 非 Linux 或读取失败 */
  }
  const ifaces = networkInterfaces();
  const pick = (name?: string) =>
    name ? (ifaces[name] ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address : undefined;
  return pick(ifname) ?? Object.keys(ifaces).map(pick).find(Boolean) ?? null;
}

function ipToSslip(ip: string): string {
  return `${ip.replaceAll('.', '-')}.sslip.io`;
}

function inCgnat(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

// vhost 域名候选：固定本地域 > LAN sslip > tailscale sslip。前端拿 bases 逐个探测
// （DNS 可解析 + 控制台端口可达）择优，全败降级子路径门面——见 web/src/lib/proxy.ts。
export async function proxyBases(cfg: Config): Promise<ProxyBase[]> {
  const v = cfg.proxy.vhost;
  if (v === 'off') return [];
  if (v !== 'auto') return [{ base: v.replace(/^\*\./, ''), kind: 'custom' }];
  const bases: ProxyBase[] = [
    // 固定好记的本地域：URL 不随 IP 漂。⚠️ .local 无公共 DNS，需要宿主侧有应答
    // （mihomo hosts / dnsmasq / 路由器）；没人应答时前端探测自动跳过它。
    { base: LOCAL_BASE, kind: 'local' },
  ];
  const ip = cfg.proxy.ip !== 'auto' ? cfg.proxy.ip : await defaultRouteIp();
  if (ip) bases.push({ base: ipToSslip(ip), kind: 'lan' });
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && inCgnat(a.address)) {
        bases.push({ base: ipToSslip(a.address), kind: 'tailscale' });
      }
    }
  }
  return bases;
}

// Host 首标签 `<name>-<port>`：最后一个 `-数字` 段是端口（容器名含数字/连字符无歧义：
// web-8080-8080 → name web-8080, port 8080）。
export function parseNamePort(label: string): { name: string; port: number } | null {
  const i = label.lastIndexOf('-');
  if (i <= 0) return null;
  const port = Number(label.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const name = label.slice(0, i);
  if (!NAME_RE.test(name)) return null;
  return { name, port };
}

// fastify 选项 rewriteUrl：路由前同步调用（HTTP 与 WS upgrade 都过这里）。
export function makeRewriteUrl(cfg: Config): (req: RawRequestDefaultExpression) => string {
  if (cfg.proxy.vhost === 'off') return (req) => req.url ?? '/';
  return (req) => {
    const raw = req.url ?? '/';
    // 子路径门面（含 __ctl 控制端点）已是规范形式，不再嵌套改写。
    if (raw.startsWith('/proxy/')) return raw;
    const host = req.headers.host;
    if (!host || host.startsWith('[')) return raw; // IPv6 字面量不玩 vhost
    const label = host.split(':')[0].toLowerCase().split('.')[0];
    const np = parseNamePort(label);
    if (!np) return raw;
    const t = resolveTargetSync(cfg, 'c', np.name) ?? resolveTargetSync(cfg, 's', np.name);
    if (!t) return raw; // 非目标主机（含基域名裸访问 = 控制台）原样走控制台路由
    return `/proxy/${t.kind}/${t.name}/${np.port}${raw}`;
  };
}

// —— 代理参数与错误内页 ——

function parseProxyParams(
  req: FastifyRequest,
): { kind: 'c' | 's'; name: string; port: number; rest: string } | null {
  const p = req.params as Record<string, string | undefined>;
  const kind = p.kind === 'c' ? 'c' : p.kind === 's' ? 's' : null;
  const port = Number(p.port);
  if (!kind || !p.name || !NAME_RE.test(p.name) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { kind, name: p.name, port, rest: p['*'] ?? '' };
}

interface CanStart {
  kind: 'c' | 's';
  name: string;
  port: number;
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// 错误内页：浏览器导航场景（GET + Accept html）给人话 + 「启动容器并重试」按钮；
// fetch/XHR（被代理应用自己的请求）回统一 JSON 错误形状。
// reply 参数用最小结构类型：onError 回调传进来的 reply 泛型带 http2 联合，
// 精确签名会因 raw 不兼容拒收。
interface ErrorReply {
  code(status: number): unknown;
  type(contentType: string): unknown;
  send(payload: unknown): unknown;
}

function sendProxyError(
  reply: ErrorReply,
  req: FastifyRequest,
  status: number,
  code: string,
  title: string,
  message: string,
  target: string,
  canStart?: CanStart,
): void {
  const accept = String(req.headers.accept ?? '');
  if (req.method === 'GET' && accept.includes('text/html')) {
    reply.code(status);
    reply.type('text/html; charset=utf-8');
    reply.send(proxyErrorHtml({ status, title, message, target, canStart }));
  } else {
    reply.code(status);
    reply.send({ error: { code, message } });
  }
}

function proxyErrorHtml(o: {
  status: number;
  title: string;
  message: string;
  target: string;
  canStart?: CanStart;
}): string {
  const start = o.canStart
    ? `<button id="sb-start">启动容器并重试</button><p class="hint" id="sb-hint"></p>
<script>
(function () {
  var b = document.getElementById('sb-start'), h = document.getElementById('sb-hint');
  b.onclick = async function () {
    b.disabled = true; b.textContent = '启动中…';
    try {
      await fetch('/proxy/__ctl/start?kind=${esc(o.canStart.kind)}&name=${esc(o.canStart.name)}', { method: 'POST' });
      for (var i = 0; i < 30; i++) {
        await new Promise(function (r) { setTimeout(r, 1000) });
        try {
          var r = await fetch('/proxy/__ctl/ping?kind=${esc(o.canStart.kind)}&name=${esc(o.canStart.name)}&port=${o.canStart.port}');
          if ((await r.json()).ok) break;
        } catch (e) {}
      }
    } catch (e) { h.textContent = '启动请求失败：' + e; b.disabled = false; b.textContent = '重试'; return; }
    location.reload();
  };
})();
</script>`
    : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mysandbox 代理 — ${o.status}</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font:15px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{max-width:580px;margin:16px;padding:36px 40px;border:1px solid #27272a;border-radius:14px;background:#131316}
h1{font-size:17px;font-weight:600;margin:0 0 10px}
p{margin:6px 0;color:#d4d4d8}
.code{font:12px/1.6 ui-monospace,SFMono-Regular,monospace;color:#a1a1aa;word-break:break-all}
button{margin-top:18px;padding:8px 18px;border-radius:8px;border:1px solid #3f3f46;background:#26262b;color:#fafafa;font-size:14px;cursor:pointer}
button:hover{background:#333338}
button:disabled{opacity:.6;cursor:default}
.hint{margin-top:12px;font-size:12px;color:#71717a}
</style></head><body><div class="card">
<h1>${esc(o.title)}</h1>
<p>${esc(o.message)}</p>
<p class="code">目标：${esc(o.target)}</p>
${start}
</div></body></html>`;
}

// —— 响应头改写（Location / Set-Cookie） ——

function rewriteLocation(prefix: string, authorities: string[], loc: string): string {
  if (loc.startsWith('/')) return `${prefix}${loc}`;
  const m = /^https?:\/\/([^/]+)(\/.*)?$/i.exec(loc);
  if (m && authorities.includes(m[1].toLowerCase())) {
    return `${prefix}${m[2] ?? '/'}`;
  }
  return loc; // 外部跳转（OAuth 等）原样
}

function scopeCookie(prefix: string, cookie: string): string {
  // 显式 Path（含 /）→ 映射进代理前缀（应用视代理前缀为自己的根）；无 Path → 补前缀根。
  // 其余属性（Domain/Secure/HttpOnly…）原样保留。
  const m = /;[ \t]*path=([^;]*)/i.exec(cookie);
  if (m) {
    const p = m[1].trim() || '/';
    if (p.startsWith('/')) return cookie.replace(m[0], `; Path=${prefix}${p}`);
    return cookie;
  }
  return `${cookie}; Path=${prefix}/`;
}

function rewriteResponseHeaders(
  prefix: string,
  authorities: string[],
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out = { ...headers };
  if (typeof out.location === 'string' && out.location) {
    out.location = rewriteLocation(prefix, authorities, out.location);
  }
  if (out['set-cookie']) {
    const arr = Array.isArray(out['set-cookie']) ? out['set-cookie'] : [out['set-cookie']];
    out['set-cookie'] = arr.map((c) => scopeCookie(prefix, c));
  }
  return out;
}

// ws 关闭码转发白名单（1005/1006/1015 不可主动发送，非法值回退 1000）。
function forwardCloseCode(code: number | undefined): number {
  if (code == null) return 1000;
  if (code === 1000 || code === 1002 || code === 1003 || (code >= 1007 && code <= 1011)) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1000;
}

// —— 注册入口 ——

export async function registerProxy(app: FastifyInstance, cfg: Config): Promise<void> {
  // 预热白名单缓存：服务起来 vhost 门面立即可用（否则前 3s 的 vhost 请求会漏进控制台路由）。
  void refreshTargets(cfg);

  const bases = await proxyBases(cfg);
  const primary = bases[0] ?? null;

  // IP:端口 与 域名:端口 是平级的两种口径，服务端不做互转重定向：经 IP 打开控制台
  // 就用 IP 口径（端口点击由前端按 origin 口径直连目标 IP，见 web/src/lib/proxy.ts），
  // 经基域名打开就走代理口径。

  // —— cookie 会话：/proxy 门面（vhost + 子路径）的鉴权凭证 ——
  // Path=/：vhost 门面的页面路径任意（应用的 /、/dashboard…），Path 限 /proxy 的话
  // 浏览器根本不会随行。隔离性不靠 Path 靠 auth hook：cookie 仅在 /proxy 被承认，
  // /api、/ws 维持 header/query-only（见 auth.ts extractToken 的 allowCookie）。
  // 每个候选基域各发一份 Domain cookie（浏览器拒收 domain-match 不成立的那份）：
  // 本机走 mysandbox.test，远程设备经 tailscale 域名开控制台也能种上。
  app.post('/api/auth/session', async (_req, reply) => {
    const attrs = `Path=/; HttpOnly; SameSite=Strict; Max-Age=${60 * 60 * 24 * 365}`;
    const cookies = new Set<string>([`${COOKIE_NAME}=${cfg.token}; ${attrs}`]);
    for (const b of bases) cookies.add(`${COOKIE_NAME}=${cfg.token}; Domain=${b.base}; ${attrs}`);
    reply.header('set-cookie', [...cookies]);
    return { ok: true };
  });

  // —— vhost 信息（前端拼代理 URL 与探测择优用；次选候选给远程设备）——
  app.get('/api/proxy/config', async () => {
    return {
      mode: cfg.proxy.vhost === 'off' ? 'subpath' : 'vhost',
      bases,
      primary: primary?.base ?? null,
    };
  });

  // —— 代理侧控制端点（/proxy 路径内，cookie 可达）：错误内页的「启动容器并重试」——
  // find-my-way 静态段优先于参数段，不会撞下面的 :kind/:name/:port 通配。
  app.post('/proxy/__ctl/start', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.kind !== 'c') throw badRequest('只有容器支持经代理启动');
    const t = await resolveTargetFresh(cfg, 'c', String(q.name ?? ''));
    if (!t) throw notFound(`容器 ${q.name ?? ''} 不在代理白名单`);
    if (!t.running) await startContainer(cfg, t.name);
    return { ok: true };
  });

  app.get('/proxy/__ctl/ping', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const port = Number(q.port);
    const t = await resolveTargetFresh(cfg, q.kind === 's' ? 's' : 'c', String(q.name ?? ''));
    if (!t || !Number.isInteger(port) || port < 1 || port > 65535) return { ok: false };
    const ok = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: t.ip, port });
      const done = (v: boolean) => {
        s.destroy();
        resolve(v);
      };
      s.setTimeout(800, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
    return { ok };
  });

  // —— 转发核心：封装作用域（catch-all content-type parser 只影响 /proxy 路由）——
  await app.register(async function proxyScope(scope) {
    // 代理路由一律不解析 body：原始流直通上游（JSON/表单/上传/SSE 全部字节级保真）。
    for (const ct of ['application/json', 'text/plain', '*']) {
      scope.addContentTypeParser(ct, (_req, payload, done) => done(null, payload));
    }
    await scope.register(replyFrom, {
      undici: {
        headersTimeout: 30_000,
        bodyTimeout: 0, // 0 = 不限：长 SSE / 慢响应不断流
        connect: { timeout: 5_000 },
      },
    });

    const httpProxy = async (req: FastifyRequest, reply: FastifyReply) => {
      const p = parseProxyParams(req);
      if (!p) {
        sendProxyError(reply, req, 400, 'bad_request', '代理路径不合法', 'URL 形如 /proxy/<c|s>/<名称>/<端口>/…', req.url);
        return;
      }
      const t = await resolveTargetFresh(cfg, p.kind, p.name);
      if (!t) {
        sendProxyError(
          reply, req, 404, 'not_found',
          '未找到可代理的目标',
          `「${p.name}」不在受管容器/服务列表里（白名单精确到实例，不放网段）。`,
          `${p.kind}/${p.name}:${p.port}`,
        );
        return;
      }
      const prefix = `/proxy/${p.kind}/${p.name}/${p.port}`;
      const target = `${t.name}（${t.ip}:${p.port}）`;
      if (!t.running) {
        sendProxyError(
          reply, req, 502, 'bad_gateway',
          p.kind === 'c' ? '容器未运行' : '服务未运行',
          '目标当前不在运行状态，启动后即可访问。',
          target,
          p.kind === 'c' ? { kind: p.kind, name: p.name, port: p.port } : undefined,
        );
        return;
      }
      const authorities = [`${t.ip}:${p.port}`, String(req.headers.host ?? '').toLowerCase()];
      return reply.from(`http://${t.ip}:${p.port}/${p.rest}`, {
        rewriteRequestHeaders: (_req, headers) => {
          const h = { ...headers } as Record<string, string | string[] | undefined>;
          // token 不出面板：鉴权 cookie 与自定义 token 头都不喂给被代理应用。
          delete h.cookie;
          delete h['x-sandbox-token'];
          h['x-forwarded-for'] = req.ip;
          h['x-forwarded-host'] = String(req.headers.host ?? '');
          h['x-forwarded-proto'] = 'http';
          // Host 原样透传（reply-from 默认改成上游 host）。应用侧的绝对重定向、
          // ALLOWED_HOSTS 类校验看 vhost 域名比看容器 IP 更可能通过。
          if (req.headers.host) h.host = String(req.headers.host);
          return h as typeof headers;
        },
        rewriteHeaders: (headers) => rewriteResponseHeaders(prefix, authorities, headers),
        onError: (errReply, { error }) => {
          // reply-from 把底层错误包成 FST_REPLY_FROM_* fastify 错误，原始 code 在
          // cause 里（见 reply-from index.js requestImpl 的错误分发）。
          const err = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
          const codes = [err.code ?? '', err.cause?.code ?? ''];
          const detail = (err.cause?.message ?? err.message ?? '未知错误').slice(0, 160);
          const reason = codes.includes('ECONNREFUSED')
            ? '连接被拒绝——目标可达，但该端口没有服务在监听。'
            : codes.some((c) => ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(c))
              ? '目标不可达——容器可能刚重启（IP 变了）或网络不通。'
              : `上游异常：${detail}。若目标不是 HTTP(S) 服务（数据库/SSH 等），浏览器代理不适用——远程场景建议 tailscale 直连。`;
          log.warn({ target: `${p.kind}/${p.name}:${p.port}`, codes }, 'proxy upstream error');
          sendProxyError(errReply, req, 502, 'bad_gateway', '上游无法访问', reason, target);
        },
      });
    };

    const wsProxy: WebsocketHandler = async (socket, req) => {
      const p = parseProxyParams(req);
      if (!p) {
        socket.close(1008, 'bad proxy path');
        return;
      }
      const t = await resolveTargetFresh(cfg, p.kind, p.name);
      if (!t) {
        socket.close(1008, `unknown proxy target ${p.name}`);
        return;
      }
      const qi = req.url.indexOf('?');
      const search = qi >= 0 ? req.url.slice(qi) : '';
      const protoHeader = req.headers['sec-websocket-protocol'];
      const protocols =
        typeof protoHeader === 'string'
          ? protoHeader.split(',').map((s) => s.trim()).filter(Boolean)
          : [];
      // 同 HTTP 门面：Host 透传、不喂 cookie/token。
      const headers: Record<string, string> = {
        'x-forwarded-for': req.ip,
        'x-forwarded-host': String(req.headers.host ?? ''),
        'x-forwarded-proto': 'http',
      };
      if (req.headers.host) headers.host = String(req.headers.host);
      let upstream: WebSocket;
      try {
        upstream = new WebSocket(`ws://${t.ip}:${p.port}/${p.rest}${search}`, protocols, {
          headers,
          handshakeTimeout: 5_000,
          maxPayload: 0,
        });
      } catch {
        socket.close(1011, 'proxy upstream error');
        return;
      }
      upstream.on('open', () => {
        log.debug({ target: `${p.kind}/${p.name}:${p.port}` }, 'proxy ws established');
      });
      upstream.on('message', (data: RawData, isBinary: boolean) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(data, { binary: isBinary });
      });
      socket.on('message', (data: RawData, isBinary: boolean) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
      });
      upstream.on('close', (code) => {
        try {
          socket.close(forwardCloseCode(code), 'upstream closed');
        } catch {
          /* noop */
        }
      });
      socket.on('close', (code) => {
        try {
          upstream.close(forwardCloseCode(code), 'client closed');
        } catch {
          /* noop */
        }
      });
      upstream.on('error', (err) => {
        log.warn({ target: `${p.kind}/${p.name}:${p.port}`, err: String(err) }, 'proxy ws upstream error');
        try {
          socket.close(1011, 'upstream error');
        } catch {
          /* noop */
        }
      });
      socket.on('error', () => {
        try {
          upstream.terminate();
        } catch {
          /* noop */
        }
      });
    };

    // GET 一条路由全声明式双挂（upgrade → wsProxy，普通请求 → httpProxy；wsHandler
    // 类型只在 RouteOptions 全声明式上，shorthand 没有）；写方法走无 wsHandler 的
    // 独立路由（@fastify/websocket 只允许 GET 带 wsHandler）。
    for (const url of ['/proxy/:kind/:name/:port', '/proxy/:kind/:name/:port/*']) {
      scope.route({ method: 'GET', url, handler: httpProxy, wsHandler: wsProxy });
      scope.route({ method: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url, handler: httpProxy });
    }
  });
}

// 控制台入口 origin（/proxy 401 引导页的「打开控制台」链接用，index.ts 传入）：
// 基域名口径 + scheme/端口随 listen.tls。primary 为 null（off/全败）时退相对路径。
export function consoleOrigin(cfg: Config, primary: string | null): string {
  if (!primary) return '/';
  const scheme = cfg.listen.tls ? 'https' : 'http';
  const defaultPort = cfg.listen.tls ? 443 : 80;
  const portPart = cfg.listen.port === defaultPort ? '' : `:${cfg.listen.port}`;
  return `${scheme}://${primary}${portPart}`;
}

// 401 内页：vhost 门面下未带 cookie 的导航——JSON 一行人看不懂，给控制台链接引导登录。
// origin 由调用方经 consoleOrigin(cfg, primary) 传入（index.ts 的 hook 本就是 async）。
export function proxyUnauthorizedHtml(origin: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mysandbox 代理 — 未授权</title>
<style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#e4e4e7;font:15px/1.7 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.card{max-width:580px;margin:16px;padding:36px 40px;border:1px solid #27272a;border-radius:14px;background:#131316}
h1{font-size:17px;font-weight:600;margin:0 0 10px}
p{margin:6px 0;color:#d4d4d8}
a{color:#93c5fd}
</style></head><body><div class="card">
<h1>需要先在控制台登录</h1>
<p>代理入口与控制台共用同一 token。打开控制台完成 token 校验后，这里会自动带上会话 cookie（SameSite=Strict：从其他应用里点进来的链接不带 cookie，属于预期行为）。</p>
<p><a id="sb-console-link" data-origin="${esc(origin)}" href="${esc(origin)}">打开 mysandbox 控制台 →</a></p>
<script>
// 控制台链接带上回跳：App 种完会话 cookie（Domain=<基域名>）后自动送回本页，
// 免掉「先开控制台、再回来点端口」的两步。
(function () {
  var a = document.getElementById('sb-console-link');
  var o = a.dataset.origin === '/' ? '' : a.dataset.origin;
  a.href = o + '/?proxyBack=' + encodeURIComponent(location.href);
})();
</script>
</div></body></html>`;
}
