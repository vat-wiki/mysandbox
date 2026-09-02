# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

mysandbox：本地 dev 容器的网页控制台。后端 fastify，管理 **unprivileged LXC 系统容器**（经 `lxc-*` 命令行）；前端 Vue 3 + Vite + Tailwind v4（shadcn-vue 风格，reka-ui）。注释与文档均用中文，新代码保持一致。

业务层只 import `server/engine/index.js`，不直接碰 `engine/lxc.ts`（**此约定限于容器引擎**——docker 服务层经 `server/docker.ts` 自持 docker 访问，不经过 engine，见下「docker 服务层」）。LXC 的设计与实测记录在 `docs/lxc-migration.md`——碰引擎相关的东西先读它。

## 常用命令

```bash
npm install                # 后端依赖
npm -C web install         # 前端依赖（独立 package.json，无 workspace）

npm run dev                # 后端 tsx watch，监听 7321（--host auto 绑本机默认路由 IPv4；⚠️ 裸 shell 下 lxc-start 会失败，见下）
npm -C web run dev         # 前端 vite dev（5173，/api 与 /ws 代理到 7321）
npm run typecheck          # 后端 tsc --noEmit
npm -C web run build       # 前端 vue-tsc -b && vite build（类型检查只在这里）
npm run build              # 全量：tsc -> dist/ + vite -> web/dist/
node dist/server/cli.js    # 跑产物验证
```

没有测试框架；改动后验证方式是 `npm run typecheck` + `npm -C web run build` + 实际起服务走一遍流程。

CLI 子命令：`mysandbox [--port] [--host]`，`mysandbox base <动作>`（模板操作：status/clone/export/import，`mysandbox image` 是历史别名），`mysandbox status`（宿主上全部 mysandbox 资产总览：容器/模板/docker 服务与卷/宿主终端会话/瞬态单元/sidecar，只读、各段独立降级、不需要服务在跑），`mysandbox open <路径>`。日志级别 `MYSANDBOX_LOG_LEVEL=debug`。

模板制作：`scripts/lxc-template.sh <容器名>`。

## Git 工作流

每次更改完成后（typecheck/build 验证通过），必须本地合入 `main` 分支并推送到远端（`origin/main`）。改动不留未提交状态、不滞留在旁支分支。

## 安全模型（改动前必读）

**拿到 token 等于拿到宿主 leon 用户的完整权限**：LXC 容器本身是 unprivileged（容器 root → 宿主 uid 100000），拿不到宿主 root；但**容器内 uid 1000 直通宿主 `leon`**（D1），且服务能读写宿主 `~/.ssh`、跑宿主终端（`/ws/host-terminal`）。

所以约束不变：

- 只监听 `127.0.0.1`（默认）；非 localhost 监听时 CLI 必须打印警告。
- 所有 `/api/*` 与 `/ws/*`（除 `/api/health`）经 `server/auth.ts` 的 token 鉴权 hook；新路由注册在 `routes.ts` / `base.ts` / `terminal.ts` / `hostTerminal.ts` 即自动被覆盖，不要绕过。
- sidecar 文件（state.json、config.yaml）权限 `0600`。
- `/api/health` 免鉴权，所以它只暴露版本/引擎连通性/`caps`——**不要往里加容器名、路径、配置值**。

## 架构

### server/（NodeNext ESM，import 要带 `.js` 后缀）

请求流：`cli.ts`（入口/参数/config 加载）→ `index.ts buildServer()`（websocket + static + 鉴权 hook + 错误处理）→ 路由六块：`routes.ts`（REST）、`base.ts`（`/api/base*`，模板操作 + `mysandbox base` CLI）、`services.ts`（`/api/services*`，docker 配套服务）、`terminal.ts`（`/ws/terminal`，容器 PTY）、`hostTerminal.ts`（`/ws/host-terminal` + `/api/host-terminal/cwd`，宿主 PTY）、`desktop.ts`（`/ws/desktop` + `/ws/desktop-vnc`，容器图形桌面）。SSE 进度流的公共实现在 `sse.ts`。

关键设计：

- **引擎抽象**在 `server/engine/`：`types.ts` 定接口 + `EngineCaps`，`lxc.ts` 实现，`index.ts` 是消费方唯一 import 点（`getEngine(cfg)` + 一堆便捷转发）。单引擎后 `getEngine` 恒返回 `lxcEngine`，但保留「业务层不直接 import 实现」的约定。
- 创建/删除在 `lifecycle.ts`（IP 分配 + home 种子 + hosts 来源编排），建容器动作（克隆模板 + 改写 config）在 `engine/lxc.ts` 的 `create()` 里。IP 池计算在 `network.ts`——LXC 的 IP 配在容器 config 里，`assignedIps` 扫全部 config 即权威源；`gatewayOf(cfg)` 网关 = `<ipPool 前缀>.1`（宿主在桥上的副 IP）。
- **受管理容器的判定**：在配置的网桥上，或 config 里有 mysandbox 标记（`lxc.environment = MYSANDBOX_MANAGED=true` 纯文本行，可 diff 可手改）。标记不可变，所以易变元数据（displayName、adopted、tags 等）走 **sidecar JSON**（`state.ts`，存 XDG data 目录，容器名作 key）。adopt 外部容器只写 sidecar，不动容器对象。
- **批量操作**（git 身份 / ssh reseed / claude -p / 任意命令）在 `batch.ts`，用 p-limit 并发，底层走 engine 的 `execRun`。
- **hosts（全局面板已删）**：模板容器的 /etc/hosts 是新容器 hosts 的**源头**——lxc-copy 克隆原样复制，想改默认就改模板（宿主 leon 写不进属主 100000 的 rootfs，要进 `lxc-usernsexec`）。新建容器可选宿主 `/etc/hosts` 作源（`CreateInput.hosts`）。mysandbox 对已落地容器只拥有**尾部服务块**：`hosts-sync.ts` 的 `applyServicesBlock` 读-改-写（直读 rootfs → `stripServicesBlock` 剥旧块 → 追新块），base 永不动；`overwriteHosts` 是显式整体覆写（批量配置 tab / 宿主源创建）。模板在两处被排除出目标（`dropTemplate` + `handleEvent` 前置）——它 running 时事件路径不得追平（旧版在这里污染过模板）。
- **错误处理**：抛 `errors.ts` 的 `HttpError`（带 code/status），`wrapEngineError` 把 404 形状错误映射为 `not_found`。
- **配置**：`config.ts` 从 `config.default.yaml` 读默认 + `~/.config/mysandbox/config.yaml` 覆盖，首启生成随机 token。
- **容器内 mysandbox 命令**（`container-cli.ts`）：脚本由宿主种子写入 `<lxcpath>/<name>/rootfs/home/dev/.local/bin/mysandbox`（建容器时 + 启动扫描，幂等缺失才写）。web 终端（`terminal.ts`）注入 `MYSANDBOX_WEB` 标记——exec 的 Env 到不了 tmux server 起的 shell，所以挂 tmux 全局环境（`set-environment -g`），同时开 `allow-passthrough`（否则 tmux 吞掉未知 OSC）。命令运行时探测标记，web 下打印 OSC 7677（tmux 下 DCS passthrough 包裹），`Terminal.vue` 注册 OSC handler 捕获后冒泡 `ContainerList.vue` 定位文件面板/开编辑器（与 CLI `mysandbox open` 深链共用 `locateContainerPath`）。非 web 环境只打提示。

### 基座（base）——「新容器从哪儿来」

基座 = 模板容器。前端只需要三个答案：基座 ready 了吗、有哪些动作、进度如何。动作集合声明在 `caps.baseActions`。

- 路由 `base.ts`：`GET /api/base`（`BaseStatus`）、`GET /api/base/size`、`POST /api/base/:action`（SSE 进度）。
  准入在路由层查 `caps.baseActions`，不支持的动作回 400 并列出支持的——不让底层抛 500。
- 实现在 `engine/template.ts`（clone/export/import）。
- web：`BasePanel.vue` 按 `hasBaseAction()` 决定渲染哪些按钮，按 `caps.baseLabel` 决定文案（「模板」）。
- `BaseStatus` 的 `exists` 与 `ready` **是两件事**：LXC 模板可以「在，但在跑」，而 `lxc-copy` 对运行中的源静默失败，
  所以状态里就得让用户去 stop。引擎特有的展示字段塞 `detail: Record<string,string>`，加字段不用改前端类型。

LXC 基座操作的硬约束（`engine/template.ts` 文件头有详版）：**整 rootfs 遍历（du/tar）必须在 `lxc-usernsexec` 里跑**，
idmap 参数取自该容器 config 自己的 `lxc.idmap` 行（不能硬编码、不能给一条宽 map），tar 必须 `--numeric-owner`。
且 **ns 内创建的文件宿主用户连删都删不掉**（属主是 uid 100000），所以归档必须由宿主进程 `createWriteStream` 落盘、
让 ns 里的 tar 写 stdout。import 的 idmap 取**宿主** `~/.config/lxc/default.conf`（包可能来自 subuid 段不同的机器）。

### 容器契约

容器内契约：uid:gid `1000:1000`（用户名 `dev`，home `/home/dev`）、zsh/git/tmux/node/AI CLI 就位、
`/etc/skel-home/.zshrc` 作首启模板、宿主 `~/.ssh` 只读可见于 `/mnt/host/.ssh`、
`/etc/systemd/resolved.conf.d/mysandbox.conf` 配上游 DNS（静态 IP 无 DHCP）、
`fontconfig` + `fonts-noto-cjk` 中文字体（桌面/容器内 GUI 渲染中文；fc-list 必须在——只装字体包不装 fontconfig 工具，zh 查询恒 0）。

- 容器来源：模板容器 + `lxc-copy` 克隆（`scripts/lxc-template.sh` 制作）。
- PID 1：发行版自己的 systemd（真系统容器）。
- home：在 rootfs 内 `<lxcpath>/<name>/rootfs/home/dev`（宿主可直读直写——D1 uid 直通）。
- 首启 seed：引擎 `create()` 里 attach 进去跑一次 `seedHome()`（**缺才写**——用户改过的 `~/.zshrc`、`~/.gitconfig` 绝不覆盖）。
- 模板不存在/未 STOPPED → 明确报错（`lxc-copy` 对运行中的源**静默失败**，exit 1 无输出）。

**`EngineCaps`（`engine/types.ts`）是引擎差异的唯一出口**，业务层与 web 都判它：

- `dataInsideContainer`（true）：home 在 rootfs 内 → 删容器必连数据一起删，`deleteManaged` 无条件要求「输容器名确认」；`DeleteContainerDialog.vue` 是说明文案而非留不住数据的假选项。
- `liveRename`（false）：改名前必须先停容器，`rename` 抛 `conflict`。
- `portMappings`（false）：固定 IP 直连，`CreateDialog.vue` 无端口映射块。
- `baseKind`（`template`）+ `baseActions`：见上「基座」。

caps 经 `/api/health` 下发，前端存在 `web/src/lib/caps.ts` 单例（默认值取 LXC 语义）。**引擎差异想表达时先在这里加一项 cap**，别在业务层撒 if。

### LXC 引擎的运行环境约束（`engine/lxc.ts` 文件头有详版）

- mysandbox **必须以 systemd user service 形态跑**（cgroup 委派）。`lxc-attach` 可直接 spawn（继承 cgroup），但 `lxc-start` 必须进独立瞬态单元（`systemd-run --user --unit=mysandbox-<name> ... lxc-start -n <name> -F`），否则重启 mysandbox 会连带杀掉所有容器。
- LXC veth 挂在 **mysandbox 自有网桥 `mysandbox0`** 上（`cfg.network` 直接配桥设备名；桥由系统 unit `mysandbox-net.service` 建：桥 + 网关副 IP `<ipPool 前缀>.1` + 网段出网 MASQUERADE，**不依赖 docker**）。容器网段 10.88.10.0/24 与 docker 服务网段 10.88.0.0/24 分桥、经宿主路由互通——跨桥放行有**三处**：`mysandbox-docker-interop.service` 的 raw 表 ACCEPT（**docker 29 会在每次服务容器 start 时重写 `-t raw -A -d <服务IP> ! -i <桥> DROP` 隔离规则，删了会回来，必须 -I 1 恒压其上**）、同 unit 的 DOCKER-USER 链 ACCEPT、ufw before.rules 的 `-i mysandbox0 ACCEPT`（ufw 默认 routed deny）。`/etc/lxc/lxc-usernet` 按桥名放行 `leon veth mysandbox0`。历史：2026-09 前挂在 docker 的 dev-lan 桥（br-<hash>）上，见 docs/lxc-migration.md 补记。
- 静态 IP 无 DHCP → 容器内 systemd-resolved 没有上游 DNS，模板必须写 `/etc/systemd/resolved.conf.d/mysandbox.conf`（模板脚本已做）。
- `lxc-attach -u/-g` **只吃数字**，而调用方传的 User 混着名字（`'root'`/`'root:root'`/`'1000:1000'`）——`parseUser` 负责映射，改它时小心：早前 `Number('root')` → NaN 落回 1000，导致「以 root 写 /etc/hosts」静默变成 dev 身份、Permission denied。
- `scripts/lxc-template.sh` 里给容器喂脚本必须走 **stdin**（`bash -s`）而非 `bash -c "<脚本>"`：systemd-run 会先展开自己的 `${VAR}` 规格符，把脚本里的 `${ARCH}` 吃成空串。
- **liblxc 不认 XDG 变量**：lxcpath 与 default.conf 路径在 liblxc 里硬编码成 `$HOME/.local/share/lxc` / `$HOME/.config/lxc`。所以 `lxcPath()` 与 `readDefaultConf()` 用 `homedir()`，**不能**用 `xdgDataHome()`/`xdgConfigHome()`——设了 XDG_* 的环境下会与 `lxc-*` 命令看的路径分叉（我们说容器不存在，`lxc-ls` 说存在）。
- `start` 对已在跑的容器必须幂等（`create()` 已经把容器起来了）：撞同名瞬态单元会报 `already loaded`，把「本来就好着」变成 500。
- **克隆必须重新随机化网络身份**：`lxc-copy` 连 `/etc/machine-id` 一起拷，而容器内 udev 的 `MACAddressPolicy=persistent` 按 machine-id 哈希 MAC → 不处理的话所有容器同 MAC，同桥 fdb 摆动、容器间 ARP 永远达不成（宿主→容器却正常，极具迷惑性）。`create()` 里两步固化：config 写死随机 `lxc.net.0.hwaddr` + `lxc-usernsexec` truncate rootfs 的 machine-id（systemd 首启重生）。改 create 的网络段落时别把这两步弄丢。

### docker 服务层——「容器旁边的数据库们」

docker 引擎移除后 docker 的新角色：**配套服务层**。mysandbox 在宿主 docker 上起单容器服务（postgres/redis/mysql/自定义），挂在与 LXC 互通的 docker 网络（`cfg.services.network`，默认 `mysandbox-lan`，桥钉 `br-mysandbox`），固定 IP + 命名卷；LXC 容器按服务名直连（hosts 自动注入，跨桥互通见上面 LXC 网络段）。**服务网络自持**：`ensureServiceNetwork` 在缺失时按服务池隐含的 /24 自动重建（status 自愈 + 创建兜底），别手工建网络——手工建会落到 docker 默认池，与 LXC 网段不通。

- **模块归属**：`server/docker.ts`（docker CLI 客户端：execFile/spawn 数组参数、`--format '{{json .}}'` 解析、label 过滤、卷操作、`docker events` NDJSON 订阅）+ `server/services.ts`（预设/编排/路由，对标 `base.ts`）+ `server/jobs.ts`（服务创建的后台任务注册表）。**不经过 engine 抽象**——`Engine` 接口是容器生命周期形状，服务是另一种生命周期；上面「业务层只 import engine/index.js」的约定限于容器引擎。
- **创建是后台任务**（不是 SSE）：`POST /api/services` 快校验（`prepareServiceCreate`：校验/查重/IP 分配，失败回 4xx 内联显示）+ **同步预占名称与 IP**（`serviceNameExists` 查不到「还没建容器」的进行中任务，不锁名会双双通过查重）→ 立即返回 `{jobId}`；拉镜像/建容器在 `jobs.ts` 的进程内任务里跑（`runServiceCreate`）。任务 = 内存 Map + 环形日志（400 行）+ 终态保留 20 个，**刻意不持久化**（进程重启即丢，daemon 层缓存让重试近乎免费）。路由：`GET /api/services/jobs?tail=`（tail=0 极小 payload，侧栏轮询用）、`GET .../jobs/:id`（全量日志）、`POST .../jobs/:id/cancel`。**取消只对 pull 阶段生效**（`cancellable` 标志；docker create/start 是 execFile 杀不掉，其余阶段 409）。jobs.ts 不运行时 import services.ts（编排以 thunk 传入，防循环依赖）。
- **pull 的可读性**（`docker.ts pullImageStream`）：JSON 进度行解析——状态行透传、层进度聚合成 2s 一条摘要（原始 `[===>]` 进度条行是垃圾）、错误行提取；**两级超时**：`cfg.services.pullTimeoutMs`（默认 30min 硬顶）+ 5min 无输出看门狗（硬编码，TLS 握手卡死的 pull 完全静默）；daemon 没配 `registry-mirrors` 时失败信息追加人话提示（`registryMirrors()` 读 `docker info`，60s TTL 缓存进 `ServicesStatus.registryMirrors`，前端 amber 提示）。
- **管理边界靠 label**：`mysandbox.managed-by=mysandbox` + `mysandbox.kind=service`，所有列表/操作走 `--filter label=…`——宿主上外部容器（dener-* 等 7 个）**结构性**进不来列表、操作必 404。易变元数据（env 含密码、IP 登记、描述）走 sidecar `state.json` 的 `services` 键（0600）；API 回**全量 env 值**（含密码）并附现成连接命令——token = 宿主完整权限，鉴权边界在 token 上收住，UI 直接展示连接凭据。容器被外部 `docker rm` 后 meta 变孤儿：`requireService` 对它操作时顺手清再 404。**job 视图不携带 env**（只 name/image/ip）。
- **IP 池**：`cfg.services.ipPool`（默认 10.88.0.200–240，docker IPAM 动态分配从 .2 顺排天然隔离）。占用 = 运行中网络端点 ∪ state.services 已登记 IP ∪ reserved ∪ **进行中任务预占的 IP**（`jobs.ts` 的 reservedIps 并进 `servicePoolView`）——`network inspect` 只列 running 端点，**停机服务的 IP 必须靠 state 兜底**否则二次分配。
- **服务发现 = hosts 尾部服务块**：`hosts.ts` 的 `composeHostsContent(base, serviceBlockLines(...))` 是唯一组合点，`hosts-sync.ts` 的 `applyServicesBlock`（读-改-写，幂等无需 hash 记账）覆盖事件/启动/services 全部触发点；`docker events`（start/die/destroy，label 过滤）+ 2s trailing debounce 驱动外部启停追平。容器内验证：`getent hosts <服务名>` → `+PONG`。
- **坑**：docker 29 对本地已有 tag 的 pull 仍要联网验 manifest（离线直接失败）——`imageExistsLocal()` 先查再跳过 pull；本机 daemon.json 无 registry-mirrors 且宿主在 fake-ip 网络下，Docker Hub 直连常 EOF（apt 同理换过 aliyun 源）——所以有上面的 mirror 检测提示；docker daemon 挂 → health 仍 200（`dockerStatus` 1.5s 快败）、面板 reachable:false 降级、hosts 应用静默跳过。
- **前端**：`ServicesPanel`（状态行（含 mirrors 提示）+ 任务区（3s 轮询：进度行/日志/取消）+ 服务表 + DropdownMenu 操作（含「连接信息」凭据对话框）+ 行内日志）→ `ServiceCreateDialog`（预设表单/自定义镜像；shadcn-vue Select（reka-ui portal）——**别用原生 `<select>`**，强制 dark 下 OS 自绘弹层白底违和；提交拿 jobId 即关窗）。完成通知：`lib/serviceJobs.ts` 的 `trackServiceJobs`（模块级 Map 记上次 state，只有「见过 running 落到终态」才 toast——两个轮询器喂它天然去重，首拉不误报）+ 全局 `<Toaster>`（vue-sonner，`ui/sonner/Sonner.vue` 硬编码 dark，无 next-themes）。侧栏服务摘要条自适应轮询（闲时 15s / 有任务 3s），任务进行中显示「N 个服务任务进行中…」。SSE（`streamOp`）现在只有 base 在用。

### 宿主终端

- **宿主终端**（`hostTerminal.ts`）：与容器终端同协议同语义（**真 tmux 语义**：会话只被显式 kill 或 shell 退出终结，无任何定时清理——「只要服务还在，用户开的会话就活着」；kill 帧、activeCount 多窗口），但 PTY 由本进程管理：宿主 tmux 专用 socket `-L mysandbox-host`、会话 `mysandbox-host-<termId>`，`script(1)` 提供 PTY，`stty -F <pts>` 驱动 resize（tmux 3.4 的 `refresh-client` 不支持 -x/-y）。已知坑（都在注释里）：spawn script 必须 `SHELL=/bin/sh`（zsh 会把 `=mysandbox-host-xxx` 做 =word 展开）；node 退出时 `process.on('exit')` 同步 SIGKILL 全部 script 子进程（tsx 热重启每次触发）；**tmux server 必须经 `systemd-run --user --scope` 拉起在 mysandbox.service cgroup 之外**（service 单元形态会让毫秒级退出的 `new-session -d` client 完成单元 → systemd 清空 cgroup → 刚 fork 的 server 陪葬；scope 只要不监督进程、有活进程即保持）。会话 cwd = 宿主 home。前端 `ContainerList.vue` 侧栏顶部固定「宿主」条目，`TermGroup.kind='host'`（containerId 哨兵 `__host__`，修剪/OSC/FilePanel 均豁免）。

### 终端会话隐藏与跨窗口找回

- tab 布局（含隐藏列表）是**各浏览器自己的 localStorage 状态**（`mysandbox:term-tabs-v4` / `mysandbox:term-hidden`），不是服务端状态——换浏览器/窗口 tab 就「没了」。但会话本体（tmux）在服务端活着，所以找回走**服务端扫描**：`GET /api/terminal-sessions`（routes.ts 组合）并发扫全部运行中容器 + 宿主 socket（`listContainerSessions`/`listHostSessions`，allSettled 单容器失败按 0 会话降级），`DELETE /api/terminal-sessions/{host|container}/...` 结束孤儿会话。`termSessionKey`（api.ts）是两侧共用的去重 key：本窗口可见+隐藏组占用的 termId 不进远端列表。
- **tab 右键「隐藏」≠ ✕**：隐藏 = 组从 `groups` 挪进 `hiddenGroups`（Terminal 卸载 → WS 断 = 纯 detach，会话保留）；✕ = kill 帧（真杀）。恢复时 seq 撞号取可见+隐藏 max+1。
- **接入远端会话 = 复用 termId 建组**：后端 `new-session -A` 按 `mysandbox-<短id>-<termId>` 命中即 attach 回原会话（现场全保留）。跨窗口拿不回原分屏树（那是对方窗口的 localStorage），多会话「全部接入」合并成一个 ≤4 块的分屏组。UI 在 `TermSessionsDialog.vue`（tab 栏右上角归档图标）。
- kill 扫描/结束都要 `tmux -t =<精确名>`（tmux 的 -t 默认前缀/通配匹配，见 terminal.ts 里 reapOrphanClients 的教训注释）。

### 容器桌面

- **容器桌面**（`desktop.ts`）：浏览器查看/操作容器内 XFCE 桌面。容器内栈：Xvfb（`:10`，尺寸取自 query `w/h`）+ x11vnc（`:5901 -nopw`，仅容器内监听）+ startxfce4，全 dev 用户 + **setsid nohup**（lxc-attach 会话退出杀普通子进程）——关窗/重启 mysandbox 都不影响，容器重启后下次连接重起。
- **两条 WS 路由是刻意拆开的**：`/ws/desktop`（控制流，文本帧 JSON：progress/ready/error，承载 ensureDesktop 的安装/启动进度）与 `/ws/desktop-vnc`（RFB 纯二进制透传 `net.connect(容器IP, 5901)`）。不能合并——noVNC 的 Websock 只消费二进制 RFB，混进文本进度帧会破坏协议流。RFB 流 WS 关闭只 destroy TCP，不动容器内桌面。
- **按需 ensure**（照 terminal.ts 的 tmuxReady 模式）：模块级 Set 缓存 + 实测探测（pgrep Xvfb + /dev/tcp 5901）双确认；没装包则 sed 换源 aliyun + `apt install xvfb x11vnc xfce4 xfce4-terminal dbus-x11`（timeoutMs 10min，模板已预装时秒过）。
- **前端 noVNC 的三个坑**（都已有对策，改动前先看 `vite.config.ts`/`DesktopDialog.vue` 注释）：包的 exports 字段是非法形状（字符串）→ vite alias 直指磁盘 `core/rfb.js`（同 Monaco 手法）；rfb.js 有 top-level await → build target es2022；noVNC 在 canvas mousedown 时往 body 挂全屏鼠标捕获层（z-index 10000）→ **reka-ui Dialog 会把它当 outside 点击而关窗**，DialogContent 已 `@pointer-down-outside.prevent`，且组件卸载要手动 `remove()` 该层（disconnect 不回收）。
- Dialog 窗口可拖边缘/四角改大小（8 向手柄，`startResize`），右上角按钮/双击标题栏铺满；尺寸持久化 localStorage、位置不持久（默认居中，拖动后锚定左上角——`!translate-x-0` class 压居中 translate，**不能用 inline transform**：reka-ui 动画结束会清 inline style）。分辨率固定于连接时（`resizeSession: false`，Xvfb 屏幕尺寸不动态改）；`scaleViewport: true` 让 canvas 等比缩放适配窗口。

### web/（Vue 3 + Vite + Tailwind v4）

- UI 组件库走 **shadcn-vue**（reka-ui 底座），源码拷贝在 `src/components/ui/`。有 `.claude/skills/shadcn-vue` 技能：优先 `npx shadcn-vue@latest search` 找现成组件、用语义色（`bg-primary`）不用裸色值。
- 业务组件在 `src/components/`（ContainerList、Terminal、BatchDialog 等），API 封装在 `src/lib/api.ts`。
- 终端：xterm + fit/web-links/webgl 插件，WebSocket 到 `/ws/terminal`（容器）或 `/ws/host-terminal`（宿主，`Terminal.vue` 的 `host` prop 切换）；桌面是 `DesktopDialog.vue`（noVNC canvas，行菜单「桌面」）。
- **Monaco 是离线精简接法**（见 `vite.config.ts` 注释与 `src/lib/monaco.ts`）：只引 `editor.api`（通过 vite alias 深路径绕过 exports map），自定义词法高亮，worker 用相对路径 `?worker`，不引 `editor.main`。给 web 加 Monaco 相关功能时沿用此方案，不要引全量。
- dev 模式 vite 代理 `/api` `/ws` 到 7321；build 后 `web/dist` 由后端 `@fastify/static` 同源服务，无 CORS——部署形态决定了前后端接口无需处理跨域。

## 环境备注

- LXC 引擎需 `/etc/subuid`/`subgid` 有 `leon:100000:65536`、且 mysandbox 以 systemd user service 跑（linger 开着）。
- LXC 版本是 apt 的 **5.0.3**（刻意不用源码编译的 7.0）。容器落 `~/.local/share/lxc/<name>/`。
- docker 服务层需 leon 在 `docker` 组（免 sudo 走 CLI）+ docker 服务网络 `mysandbox-lan`（自持：缺失按服务池网段自动重建，见 docker 服务层段；手工建会落到 docker 默认池与 LXC 网段不通）。group 成员资格在 systemd user manager 启动时快照——后加组要 `systemctl --user daemon-restart`。
- 容器 zsh 是 oh-my-zsh 基座（`/usr/share/oh-my-zsh`，模板脚本 clone 后须 `chmod g-w,o-w`——compaudit 拒 group/other 可写目录）：history/menu select 补全/ls 颜色/git 别名（`gst`/`gd`/`glo`；注意 `gl` 是 git pull）omz 自带，`scripts/zshrc` 只补 omz 没有的（`ll`/`la`、两个 apt 插件：autosuggestions + syntax-highlighting，**omz 不含这两个**）。老容器 `~/.zshrc` 是首启 seed 的持久化副本不会被覆盖——换新配置要手工从 `/etc/skel-home/.zshrc` 重拷。
