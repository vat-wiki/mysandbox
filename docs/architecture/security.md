# 安全模型（改动前必读）

**拿到 token 等于拿到宿主属主用户的完整权限**：LXC 容器本身是 unprivileged（容器 root → 宿主 uid 100000），拿不到宿主 root；但**容器内 uid 1000 直通宿主属主用户**（D1——install.sh 按属主 uid/gid 生成 idmap，不要求属主 uid 是 1000），且服务能读写宿主 `~/.ssh`、跑宿主终端（`/ws/host-terminal`）。

所以约束不变：

- 只监听 `127.0.0.1`（默认）；非 localhost 监听时 CLI 必须打印警告。
- 所有 `/api/*` 与 `/ws/*`（除 `/api/health`）经 `server/auth.ts` 的 token 鉴权 hook；新路由注册在 `routes.ts` / `base.ts` / `terminal.ts` / `hostTerminal.ts` 即自动被覆盖，不要绕过。`/proxy/*`（Web 代理）也在 hook 内，且额外收 cookie（header/query/cookie 三路，见 `auth.ts` extractToken）。
- sidecar 文件（state.json、config.yaml）权限 `0600`。
- `/api/health` 免鉴权，所以它只暴露版本/引擎连通性/`caps`——**不要往里加容器名、路径、配置值**。
- `dockerApi.enabled`（默认关）时容器可经 docker API 桥拿到**宿主 root 级能力**（docker 可挂宿主 /）——桥绑网关 IP、随 mysandbox 进程存活；ufw 信任模型（下条）下 services 网段同样可达 2375（见 [services.md](services.md) 末条）。
- **ufw 信任模型（2026-09-15 起，替代旧逐端口白名单）**：自管网段（LXC/services）= 完全可信的开发工作区，INPUT 各一条全端口 blanket（`firewall.ts` 推导）；需要隔离的只剩外部网段（热点/局域网设备），走 `firewall.allow` 逐端口放行（缺 port = 全端口）。验证防火墙要用**宿主自有端口**（如 xrdp 3389）——docker-proxy 发布的容器端口走 DNAT→FORWARD 不经 INPUT，拿它们测试会得出「本来就通」的假象。

## 受限账户（2026-10-22 起，分享用第二凭证层）

主 token 之外可开账户——每账户一张容器白名单，登录后只能对白名单容器用**终端 + 文件面板**（含 fg/cwd/resolve/git/跨面板复制双侧白名单），其余全部 403。

- **凭据** = 主 token 的 HMAC 派生 token（`a:<名>:<mac>` 形态，`accountToken()`），走同一个 `X-Sandbox-Token`——**刻意不用 cookie**（/api、/ws 维持 header/query-only 是既有隔离面：被代理页面的 JS 拿 cookie 打不进控制台 API）。
- **身份解析 + deny-by-default 白名单全部收口在 `index.ts` 鉴权 hook**（`resolveIdentity` + `accountPathVerdict`）——新增 owner 路由默认对账户关闭，漏改是「账户用不了新功能」而不是越权，失败方向安全。
- **账户数据**在 sidecar `state.json`（`SandboxAccount`，scrypt 存哈希，0600）；删账户即时失效（每次请求对 state 活体复核，token 本身无会话）。
- **owner 管理** CRUD 在 `/api/accounts*`（账户身份天然 403），登录 `POST /api/account/login` 公开（恒 401 不区分账户不存在/密码错）。
- **前端**：TokenGate 有「受限账户登录」入口；`GuestConsole.vue` 精简工作区（Terminal/FilePanel/FileEditorPane 组装，不复用 ContainerList 管理面）；`AccountsPanel.vue` owner 管理（侧栏 ⋯ 菜单进入）。
- 注意：`proxy.trustLan` 开着时私网来源免 token = owner 语义不变——同网络下的访客不经账户体系，这是既有信任决策。
