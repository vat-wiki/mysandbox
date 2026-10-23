# 架构总览

后端 fastify；业务层只 import `server/engine/index.js`，不直接碰引擎实现（**此约定限于容器引擎**——docker 服务层经 `server/docker.ts` 自持 docker 访问，不经过 engine，见 [services.md](services.md)）。注释与文档均用中文，新代码保持一致。

## 请求流

`cli.ts`（入口/参数/config 加载）→ `index.ts buildServer()`（websocket + static + 鉴权 hook + 错误处理）→ 路由十块，每块一个 `register*` 模块自注册、`index.ts` 单点装配：

| 模块 | 路由 | 职责 |
| --- | --- | --- |
| `routes.ts` | REST 主域 | containers/会话发现/push/batch/hosts 等 |
| `accounts.ts` | `/api/account/*` + `/api/accounts*` | 账户登录/me + owner 管理 CRUD（见 [security.md](security.md)） |
| `base.ts` | `/api/base*` | 模板操作 + `mysandbox base` CLI |
| `services.ts` + `serviceFiles.ts` | `/api/services*` | docker 配套服务 + 服务文件端点（见 [services.md](services.md)、[terminals.md](terminals.md)） |
| `ai.ts` | `/api/ai/*` + `/api/testlens/*` | AI 工具与技能中心的模型供应商/绑定侧（见 [ai-skills.md](ai-skills.md)） |
| `skills.ts` | `/api/skills/*` | 技能库/分发规则侧（见 [ai-skills.md](ai-skills.md)） |
| `terminal.ts` | `/ws/terminal` | 容器 PTY（见 [terminals.md](terminals.md)） |
| `hostTerminal.ts` | `/ws/host-terminal` + `/api/host-terminal/cwd` | 宿主 PTY（见 [terminals.md](terminals.md)） |
| `sshTerminal.ts` | `/ws/ssh-terminal` + `/api/ssh/targets*` | SSH 主机终端（见 [terminals.md](terminals.md)） |
| `desktop.ts` | `/ws/desktop` + `/ws/desktop-vnc` | 容器图形桌面（见 [desktop.md](desktop.md)） |
| `proxy.ts` | `/proxy/*` | Web 代理（见 [web-proxy.md](web-proxy.md)） |

SSE 进度流的公共实现在 `sse.ts`。

## 关键设计

- **引擎抽象**在 `server/engine/`：`types.ts` 定接口 + `EngineCaps`，`lxc.ts` 实现，`index.ts` 是消费方唯一 import 点（`getEngine(cfg)` + 一堆便捷转发）。单引擎后 `getEngine` 恒返回 `lxcEngine`，但保留「业务层不直接 import 实现」的约定。引擎差异的唯一出口是 `EngineCaps`（详见 [containers.md](containers.md)）。
- **创建/删除**在 `lifecycle.ts`（IP 分配 + home 种子 + hosts 来源编排），建容器动作（克隆模板 + 改写 config）在 `engine/lxc.ts` 的 `create()` 里。IP 池计算在 `network.ts`——LXC 的 IP 配在容器 config 里，`assignedIps` 扫全部 config 即权威源；`gatewayOf(cfg)` 网关 = `<ipPool 前缀>.1`（宿主在桥上的副 IP）。
- **受管理容器的判定**：在配置的网桥上，或 config 里有 mysandbox 标记（`lxc.environment = MYSANDBOX_MANAGED=true` 纯文本行，可 diff 可手改）。标记不可变，所以易变元数据（displayName、adopted、tags 等）走 **sidecar JSON**（`state.ts`，存 `~/.mysandbox/state.json`，容器名作 key）。adopt 外部容器只写 sidecar，不动容器对象。
- **批量操作**（git 身份 / ssh reseed / claude -p / 任意命令）在 `batch.ts`，用 p-limit 并发，底层走 engine 的 `execRun`。
- **hosts（全局面板已删）**：模板容器的 /etc/hosts 是新容器 hosts 的**源头**——lxc-copy 克隆原样复制，想改默认就改模板（宿主用户写不进属主 100000 的 rootfs，要进 `lxc-usernsexec`）。新建容器可选宿主 `/etc/hosts` 作源（`CreateInput.hosts`）。mysandbox 对已落地容器只拥有**尾部服务块**：`hosts-sync.ts` 的 `applyServicesBlock` 读-改-写（直读 rootfs → `stripServicesBlock` 剥旧块 → 追新块），base 永不动；`overwriteHosts` 是显式整体覆写（批量配置 tab / 宿主源创建）。模板在两处被排除出目标（`dropTemplate` + `handleEvent` 前置）——它 running 时事件路径不得追平（旧版在这里污染过模板）。
- **错误处理**：抛 `errors.ts` 的 `HttpError`（带 code/status），`wrapEngineError` 把 404 形状错误映射为 `not_found`。
- **轮询缓存**（`server/cache.ts`）：`withPollCache(key, ttlMs, fn)` 给「多前端 poller 打同一 exec」的端点用（cwd/listen），TTL 复用 + in-flight 去重，错误不缓存。cwd 四侧（容器/宿主/服务/SSH）2.5s、/listen 3s——文件面板跟随与 pane 标题双 poller 由此收敛为一次真实执行。
- **进程内指标**（`server/metrics.ts`，`GET /api/metrics`，鉴权走全局 hook）：onRequest/onResponse hook 聚合 per-route 计数/耗时分桶/错误数；慢请求 warn（>2s，每路由限频 1/min）；10 分钟一行 top5 摘要进日志（journalctl 直接看负载画像）。诊断「远程访问变卡/掉线」类问题的量化入口，刻意不持久化、不引依赖。
- **配置**：`config.ts` 从 `config.default.yaml` 读默认 + `~/.mysandbox/config.yaml` 覆盖，首启生成随机 token。全部自有数据收在单一根 `~/.mysandbox/`（config.yaml、compose 底账、state.json、ai/、logs/、tls/——备份/搬机一条命令；config.ts 模块加载时做一次性 XDG→~/.mysandbox 迁移），例外是 LXC 容器本体（liblxc 硬编码 `~/.local/share/lxc`）。
