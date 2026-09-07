# Web 代理：从面板外访问容器/服务的端口

实现：`server/proxy.ts`（转发核心 + 门面）+ `web/src/lib/proxy.ts`（URL 拼装单例）。

## 动机

容器（mysandbox0，10.88.10.0/24）与 docker 服务（mysandbox-lan，10.88.0.0/24）组成的是
宿主旁边的私网，外部设备只能摸到宿主本身。在别的机器/别的网络上想打开 mytest:10004
这类服务，需要一个出口。Web 代理把出口收敛进 mysandbox：**同一个监听端口、同一套
token**，浏览器点端口图标就得到一个可远程访问的 URL。

范围：HTTP(+WS)。裸 TCP（数据库、SSH 等）浏览器进不来——远程场景用 tailscale 子网
路由直连（advertise-routes）。

## 两条门面，一套转发核心

```
门面 A（主）：vhost   Host: mytest-10004.10-12-135-150.sslip.io:7321
门面 B（兜底）：子路径 http://<控制台>/proxy/c/mytest/10004/
                     转发核心：/proxy/<c|s>/<name>/<port><路径?query>
```

- 门面 A 由 **fastify `rewriteUrl`** 实现（index.ts 构造参数，proxy.ts 的
  `makeRewriteUrl`）：Host 首标签按「最后一个 `-数字` 段 = 端口」解析出 name-port，
  白名单命中即把 URL 改写成规范子路径。**关键机制**：WS upgrade 经 @fastify/websocket
  的 `fastify.routing` 分发，而 `fastify.routing` 就是包了 rewriteUrl 的 handler
  （fastify.js `wrapRouting` → `routing: httpHandler`）——所以 HTTP 与 WS 都吃到改写，
  不需要自己挂 upgrade 监听。
- 白名单未命中（含基域名裸访问 = 控制台自己）原样放行 → 走控制台路由。这就是
  「`10-0-0-5` 这种首标签会被误解析成 name `10-0-0` port 5」不构成问题的原因：
  白名单精确匹配兜住了。
- 门面 B 是同一条路由的直接访问形态，dev 模式（vite 代理 /proxy）与 DNS 不可用时用。
  注意子路径门面对绝对路径加载资源的 SPA 会破（应用需支持 base path）；vhost 门面
  没有这个问题。

### vhost 基域名（config.proxy.vhost）

- `auto`（默认）：候选序 **`mysandbox.test`（固定好记）→ LAN sslip（`10-12-135-150.sslip.io`）→
  tailscale sslip**。前端加载时逐个探测（`msbprobe.<base>/api/health`，no-cors 下任何
  HTTP 应答即「DNS 可解析 + 控制台端口可达」），命中哪个用哪个，全败降级子路径门面
  ——所以候选解析不了也不会坏，只是 URL 丑一点。
  - `mysandbox.test`：URL 不随 IP 漂，但 `.local` **没有公共 DNS**，需要宿主侧有东西
    应答 `*.mysandbox.test`（mihomo `hosts` + `dns.use-hosts`、dnsmasq、路由器均可；
    本机 clash 已如此配置）。`.local` 被 RFC 6762 划给 mDNS——macOS/iOS/Android 设备
    对 `.local` 走组播解析、单播 DNS 不查，**别的设备上大概率不通**；跨设备场景用
    sslip 候选或自有域名。
  - sslip：公共 DNS 恒等该 IP，任何设备可解析，零配置；可达性仍由 tailscale/LAN 决定。
    tailscale 地址（100.64/10 段）会一并列为候选——远程设备选 tailscale 候选（LAN IP
    基在网外不可达）。
- `off`：关闭 vhost，前端退回子路径门面。
- 其他值：自有域名，需泛解析 `*.<域名> → 宿主 IP`。**有域名优先用自有**：sslip.io 不在
  Public Suffix List（实测 publicsuffix.org，cookie/same-site 都成立），代价是全体
  sslip 用户互为 same-site，存在理论上的跨站同名 cookie 投毒面（auth.ts 的
  cookieToken 取第一条=最具体域那条，已缓解）。
- `proxy.ip`：钉死基 IP（多网卡/动态 IP 想让域名稳定时设），默认 `auto`。

## 鉴权

- 浏览器直接导航/新开 tab 到代理 URL 带不上 `X-Sandbox-Token` header →
  `POST /api/auth/session`（登录后 App.vue 自动调）下发 `mysandbox_token` cookie，
  **本体 `Path=/`**（vhost 门面的页面路径任意——应用的 `/`、`/dashboard`……Path 限
  /proxy 的话浏览器根本不随行），HttpOnly SameSite=Strict。每个候选基域各发一份
  Domain cookie（浏览器拒收 domain-match 不成立的）：本机走 `mysandbox.test`，远程
  设备经 tailscale 域名开控制台也能种上；宿主级那份兜子路径门面。
- **隔离性在 auth hook 而非 Path**：cookie 仅在 `/proxy` 门面被承认（auth.ts
  extractToken 的 allowCookie），`/api/*`、`/ws/*` 维持 header/query-only——被代理
  页面里的 JS 拿着 cookie 打不进控制台 API，爆炸半径不因 Path=/ 而扩。
- SameSite=Strict：控制台内 window.open（同站）与地址栏直贴都带 cookie；从其他应用
  点链接会 401 → HTML 引导页（`proxyUnauthorizedHtml`）给控制台链接，链接带
  `?proxyBack=` 回跳参数——App 种完 cookie 校验目标 host 在基域名内后自动送回
  （防开放重定向），免掉「先开控制台再点端口」两步。
- 未授权的浏览器导航（GET + Accept html）回 HTML 引导页而非 JSON；其余回 JSON 401。

## 「都走域名」重定向

registerProxy 里挂的 onRequest hook：**IP/localhost 口径的页面导航（GET/HEAD）302
到首选基域名**（`http://mysandbox.test:<port>` 原路径原 query，hash 由浏览器保留）。
豁免三类：`/api/*`、`/ws/*`、`/proxy/*`（CLI 深链/脚本/curl 探活不受影响）；其他
域名口径也不拦——tailscale sslip 等远程入口的设备未必解析得了 `mysandbox.test`，
拦了会把远程用户挡在 DNS 错误页上。`proxy.vhost: off` 时整个重定向与 vhost 一起关闭。

## 白名单（SSRF 边界）

目标 = 受管容器 IP（`listManaged`，模板恒排除；停机读 config 静态值，可解析）∪
docker 服务 IP（state.services 权威，停机可解析；docker ps 补 running 状态与孤儿）。
**精确集合不放网段**——网段含 `.1`（宿主在桥上的副 IP），放网段等于把代理当跳板指回
宿主。缓存 TTL 3s：`rewriteUrl` 是同步钩子只读缓存（过期触发后台刷新，去重于
`inflight`），转发 handler 走 `resolveTargetFresh`；服务启动时预热一次。

## 转发内部

- HTTP：`@fastify/reply-from`，动态上游 `reply.from(fullUrl)`。代理封装作用域内
  addContentTypeParser 全量 pass-through（JSON/text 也不解析）→ body 原始流直通，
  SSE/上传不缓冲；`undici.bodyTimeout: 0`（长 SSE 不断流）。query 由 reply-from 从
  原 req.url 附加（source 不带 query，不会重复）。
- 请求头：剥 `cookie` 与 `x-sandbox-token`（**token 不出面板，不喂给被代理应用**，
  已实测上游 headers dump 为 null）；加 `x-forwarded-{for,host,proto}`；Host 原样
  透传（reply-from 默认改上游 host，rewriteRequestHeaders 改回来——应用侧
  ALLOWED_HOSTS/绝对重定向看 vhost 域名比看容器 IP 更可能过）。
- 响应头改写：`Location` 相对路径与指向上游/控制台 origin 的绝对地址补代理前缀
  （外部跳转原样）；`Set-Cookie` 的 Path 映射进代理前缀（上游 `Path=/` →
  `/proxy/c/<name>/<port>/`，否则多应用同名 cookie 在 / 上互相覆盖）。
- WS：同一路由全声明式 `handler` + `wsHandler`（@fastify/websocket 支持同路径双挂；
  wsHandler 类型只在 RouteOptions 全声明式上，shorthand 没有）。ws 客户端连上游、
  两侧对泵（message 按 binary 标志透传），子协议透传，关闭码白名单转发
  （1005/1006/1015 不可主动发，回退 1000）。
- 错误内页：GET + Accept html 回自绘深色 HTML（`proxyErrorHtml`），错误按
  `ECONNREFUSED`（端口没监听）/ 不可达 / 其他分类；容器停机有「启动容器并重试」
  按钮 → `/proxy/__ctl/{start,ping}`（放在 /proxy 路径内所以 cookie 可达；find-my-way
  静态段优先于参数段不撞通配）。fetch/XHR 场景回统一 JSON 形状。
  reply-from 把底层错误包成 `FST_REPLY_FROM_*`，原始 code 在 `error.cause` 里——
  分类要同时看两者。

## 配置参考

```yaml
proxy:
  vhost: auto   # auto | off | <自有域名>
  ip: auto      # 钉死基 IP；auto = 默认路由接口 IPv4
```

## 已知限制

- 只代理 HTTP/WS；非 HTTP 的 TCP 服务浏览器无解（tailscale 直连）。
- vhost 门面要求设备能解析基域名（`mysandbox.test` 需宿主侧 DNS 应答——mihomo
  hosts/dnsmasq；`.local` 不行：Chromium 对它走 mDNS 组播解析、不查单播 DNS，实测
  ERR_NAME_NOT_RESOLVED，故默认域用 `.test`）；sslip 自动满足；自有域名需配泛解析。
  控制台前端会探测择优，全败自动落子路径门面。
- 子路径门面与控制台同源：被代理应用能读到控制台 origin 的 localStorage（含
  token）。vhost 门面无此问题（应用 origin 独立、localStorage 隔离、cookie 剥除）。
  安全敏感场景优先 vhost / 自有域名。
- 控制台必须经「域名口径」访问，Domain cookie 才设得进（裸 IP 访问时宿主级 cookie
  仍够子路径门面用；App 会 toast 提示经基域名打开控制台；401 引导页也给直达链接）。
- LAN IP 是 DHCP 时 sslip 基跟着漂：路由器静态租约或 `proxy.ip` 钉死。
- HTTPS 缺席：http + tailscale（wireguard 加密）够用；要真证书就自有域名 + 泛证书
  （可后挂 Caddy，forward_auth 回 mysandbox 鉴权）。
