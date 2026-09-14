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

CLI 子命令：`mysandbox [--port] [--host]`，`mysandbox base <动作>`（模板操作：status/clone/export/import，`mysandbox image` 是历史别名），`mysandbox status`（宿主上全部 mysandbox 资产总览：容器/模板/docker 服务与卷/宿主终端会话/瞬态单元/sidecar，只读、各段独立降级、不需要服务在跑），`mysandbox firewall print`（按 config 算出期望 ufw 规则，`server/firewall.ts`，免 root），`mysandbox logs [N] [--raw]`（服务日志尾部，读落盘文件，不需要服务在跑），`mysandbox open <路径>`。日志级别 `MYSANDBOX_LOG_LEVEL=debug`。日志双路：journald（`journalctl --user -u mysandbox`，已持久化）+ 按天文件 `~/.mysandbox/logs/mysandbox-<date>.log`（JSON 行，`server/logger.ts` multistream，留 14 天；文件名带日期、换档不 rename，跨进程追加安全）。

模板制作：`scripts/lxc-template.sh <容器名>`。

## Git 工作流

每次更改完成后（typecheck/build 验证通过），必须本地合入 `main` 分支并推送到远端（`origin/main`）。改动不留未提交状态、不滞留在旁支分支。

## 安全模型（改动前必读）

**拿到 token 等于拿到宿主 leon 用户的完整权限**：LXC 容器本身是 unprivileged（容器 root → 宿主 uid 100000），拿不到宿主 root；但**容器内 uid 1000 直通宿主 `leon`**（D1），且服务能读写宿主 `~/.ssh`、跑宿主终端（`/ws/host-terminal`）。

所以约束不变：

- 只监听 `127.0.0.1`（默认）；非 localhost 监听时 CLI 必须打印警告。
- 所有 `/api/*` 与 `/ws/*`（除 `/api/health`）经 `server/auth.ts` 的 token 鉴权 hook；新路由注册在 `routes.ts` / `base.ts` / `terminal.ts` / `hostTerminal.ts` 即自动被覆盖，不要绕过。`/proxy/*`（Web 代理）也在 hook 内，且额外收 cookie（header/query/cookie 三路，见 `auth.ts` extractToken）。
- sidecar 文件（state.json、config.yaml）权限 `0600`。
- `/api/health` 免鉴权，所以它只暴露版本/引擎连通性/`caps`——**不要往里加容器名、路径、配置值**。
- `dockerApi.enabled`（默认关）时容器可经 docker API 桥拿到**宿主 root 级能力**（docker 可挂宿主 /）——桥绑网关 IP、ufw 只放 LXC 网段、随 mysandbox 进程存活（见「docker 服务层」末条）。

## 架构

### server/（NodeNext ESM，import 要带 `.js` 后缀）

请求流：`cli.ts`（入口/参数/config 加载）→ `index.ts buildServer()`（websocket + static + 鉴权 hook + 错误处理）→ 路由八块：`routes.ts`（REST）、`base.ts`（`/api/base*`，模板操作 + `mysandbox base` CLI）、`services.ts`（`/api/services*`，docker 配套服务）+ `serviceFiles.ts`（`/api/services/:name/*` 文件端点，见「服务文件端点」）、`terminal.ts`（`/ws/terminal`，容器 PTY）、`hostTerminal.ts`（`/ws/host-terminal` + `/api/host-terminal/cwd`，宿主 PTY）、`sshTerminal.ts`（`/ws/ssh-terminal` + `/api/ssh/targets*`，SSH 主机终端）、`desktop.ts`（`/ws/desktop` + `/ws/desktop-vnc`，容器图形桌面）、`proxy.ts`（`/proxy/*`，Web 代理）。SSE 进度流的公共实现在 `sse.ts`。

关键设计：

- **引擎抽象**在 `server/engine/`：`types.ts` 定接口 + `EngineCaps`，`lxc.ts` 实现，`index.ts` 是消费方唯一 import 点（`getEngine(cfg)` + 一堆便捷转发）。单引擎后 `getEngine` 恒返回 `lxcEngine`，但保留「业务层不直接 import 实现」的约定。
- 创建/删除在 `lifecycle.ts`（IP 分配 + home 种子 + hosts 来源编排），建容器动作（克隆模板 + 改写 config）在 `engine/lxc.ts` 的 `create()` 里。IP 池计算在 `network.ts`——LXC 的 IP 配在容器 config 里，`assignedIps` 扫全部 config 即权威源；`gatewayOf(cfg)` 网关 = `<ipPool 前缀>.1`（宿主在桥上的副 IP）。
- **受管理容器的判定**：在配置的网桥上，或 config 里有 mysandbox 标记（`lxc.environment = MYSANDBOX_MANAGED=true` 纯文本行，可 diff 可手改）。标记不可变，所以易变元数据（displayName、adopted、tags 等）走 **sidecar JSON**（`state.ts`，存 XDG data 目录，容器名作 key）。adopt 外部容器只写 sidecar，不动容器对象。
- **批量操作**（git 身份 / ssh reseed / claude -p / 任意命令）在 `batch.ts`，用 p-limit 并发，底层走 engine 的 `execRun`。
- **hosts（全局面板已删）**：模板容器的 /etc/hosts 是新容器 hosts 的**源头**——lxc-copy 克隆原样复制，想改默认就改模板（宿主 leon 写不进属主 100000 的 rootfs，要进 `lxc-usernsexec`）。新建容器可选宿主 `/etc/hosts` 作源（`CreateInput.hosts`）。mysandbox 对已落地容器只拥有**尾部服务块**：`hosts-sync.ts` 的 `applyServicesBlock` 读-改-写（直读 rootfs → `stripServicesBlock` 剥旧块 → 追新块），base 永不动；`overwriteHosts` 是显式整体覆写（批量配置 tab / 宿主源创建）。模板在两处被排除出目标（`dropTemplate` + `handleEvent` 前置）——它 running 时事件路径不得追平（旧版在这里污染过模板）。
- **错误处理**：抛 `errors.ts` 的 `HttpError`（带 code/status），`wrapEngineError` 把 404 形状错误映射为 `not_found`。
- **配置**：`config.ts` 从 `config.default.yaml` 读默认 + `~/.mysandbox/config.yaml` 覆盖，首启生成随机 token。全部自有数据收在单一根 `~/.mysandbox/`（config.yaml、compose 底账、state.json、ai/、logs/、tls/——备份/搬机一条命令；config.ts 模块加载时做一次性 XDG→~/.mysandbox 迁移），例外是 LXC 容器本体（liblxc 硬编码 `~/.local/share/lxc`）。
- **容器内 mysandbox 命令**（`container-cli.ts`）：脚本由宿主种子写入 `<lxcpath>/<name>/rootfs/home/dev/.local/bin/mysandbox`（建容器时 + 启动扫描；种子语义是**内容变就覆盖**的自更新，不是缺才写——脚本升级/peer 换配置靠它刷进存量容器）。web 终端（`terminal.ts`）注入 `MYSANDBOX_WEB` 标记——exec 的 Env 到不了 tmux server 起的 shell，所以挂 tmux 全局环境（`set-environment -g`），同时开 `allow-passthrough`（否则 tmux 吞掉未知 OSC）。命令运行时探测标记，web 下打印 OSC 7677（tmux 下 DCS passthrough 包裹），`Terminal.vue` 注册 OSC handler 捕获后冒泡 `ContainerList.vue` 定位文件面板/开编辑器（与 CLI `mysandbox open` 深链共用 `locateContainerPath`）。非 web 环境只打提示。
- **peer exec（容器间命令互通）**（`server/peer.ts`）：`mysandbox exec <目标> -- 命令`，目标 `host | c:<容器名> | s:<服务名> | 裸名`（先 LXC 后服务）。宿主 CLI 进程内直调（不需要服务在跑）；容器内 CLI 转发给种子写入的 `~/.config/mysandbox/peer-exec.mjs`（node 客户端，凭据在同目录 `peer.json`，0600）。宿主代为执行：LXC 走 `execRun`（默认 dev）、服务走 `docker exec`（label 边界）、host 直接 spawn。迷你 HTTP 绑网关 IP:7331（dockerApi.ts 同款 EADDRNOTAVAIL 退避、随进程存活、失败非致命）；凭据是独立 `peerToken`（config 生成，与主 token 分离），ufw INPUT 只放 LXC 网段（`firewall.ts` 按 `cfg.peer` 推导，改端口要 restart mysandbox-firewall）。每次 exec 记审计日志。

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
`fontconfig` + `fonts-noto-cjk` 中文字体（桌面/容器内 GUI 渲染中文；fc-list 必须在——只装字体包不装 fontconfig 工具，zh 查询恒 0）、
全局技能目录 `~/.agents/skills` 是唯一真身（`~/.claude/skills` 为指向它的相对软链 `../.agents/skills`；skillSync 的规则/盘点/范围判定只认真身，分发遇软链落点整台拒绝防穿透）。

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
- LXC veth 挂在 **mysandbox 自有网桥 `mysandbox0`** 上（`cfg.network` 直接配桥设备名；桥由系统 unit `mysandbox-net.service` 建：桥 + 网关副 IP `<ipPool 前缀>.1` + 网段出网 MASQUERADE，**不依赖 docker**）。容器网段 10.88.10.0/24 与 docker 服务网段 10.88.0.0/24 分桥、经宿主路由互通。防火墙放行**全部自管**，别手敲 ufw：FORWARD 层三处——`mysandbox-docker-interop.service` 的 raw 表 ACCEPT（**docker 29 会在每次服务容器 start 时重写 `-t raw -A -d <服务IP> ! -i <桥> DROP` 隔离规则，删了会回来，必须 -I 1 恒压其上**）、同 unit 的 DOCKER-USER 链 ACCEPT、ufw before.rules 的 `-i mysandbox0 ACCEPT`（ufw 默认 routed deny；`mysandbox-firewall.service` 会补一条等价的 `ufw route allow in on mysandbox0`，before.rules 那条留着无害）；INPUT 层（容器 → 宿主服务：DNS 53、非 localhost 监听时的 console 端口）由 `mysandbox-firewall.service`（`scripts/mysandbox-firewall.sh` + `server/firewall.ts` 的 `mysandbox firewall print`）按 config 计算应用——幂等、只增不删，环境特例（热点/clash/GLM 端口）配 `firewall.allow`，config 变更后 `sudo systemctl restart mysandbox-firewall`。ufw status 有坑：**裸 `ufw status` 的 INPUT 行是 `ALLOW` 单列没有 `IN`**（verbose/numbered 才有），按行解析判定已存在规则时要用 verbose。`/etc/lxc/lxc-usernet` 按桥名放行 `leon veth mysandbox0`。历史：2026-09 前挂在 docker 的 dev-lan 桥（br-<hash>）上，见 docs/lxc-migration.md 补记。
- 静态 IP 无 DHCP → 容器内 systemd-resolved 没有上游 DNS，模板必须写 `/etc/systemd/resolved.conf.d/mysandbox.conf`（模板脚本已做）。
- `lxc-attach -u/-g` **只吃数字**，而调用方传的 User 混着名字（`'root'`/`'root:root'`/`'1000:1000'`）——`parseUser` 负责映射，改它时小心：早前 `Number('root')` → NaN 落回 1000，导致「以 root 写 /etc/hosts」静默变成 dev 身份、Permission denied。
- `scripts/lxc-template.sh` 里给容器喂脚本必须走 **stdin**（`bash -s`）而非 `bash -c "<脚本>"`：systemd-run 会先展开自己的 `${VAR}` 规格符，把脚本里的 `${ARCH}` 吃成空串。
- **liblxc 不认 XDG 变量**：lxcpath 与 default.conf 路径在 liblxc 里硬编码成 `$HOME/.local/share/lxc` / `$HOME/.config/lxc`。所以 `lxcPath()` 与 `readDefaultConf()` 用 `homedir()`，**不能**用 `xdgDataHome()`/`xdgConfigHome()`——设了 XDG_* 的环境下会与 `lxc-*` 命令看的路径分叉（我们说容器不存在，`lxc-ls` 说存在）。
- `start` 对已在跑的容器必须幂等（`create()` 已经把容器起来了）：撞同名瞬态单元会报 `already loaded`，把「本来就好着」变成 500。
- **克隆必须重新随机化网络身份**：`lxc-copy` 连 `/etc/machine-id` 一起拷，而容器内 udev 的 `MACAddressPolicy=persistent` 按 machine-id 哈希 MAC → 不处理的话所有容器同 MAC，同桥 fdb 摆动、容器间 ARP 永远达不成（宿主→容器却正常，极具迷惑性）。`create()` 里两步固化：config 写死随机 `lxc.net.0.hwaddr` + `lxc-usernsexec` truncate rootfs 的 machine-id（systemd 首启重生）。改 create 的网络段落时别把这两步弄丢。

### docker 服务层——「容器旁边的数据库们」

docker 引擎移除后 docker 的新角色：**配套服务层**（界面名词：**应用容器**——与「系统容器」对仗，运行时迁移方案见 `docs/podman-migration.md`）。mysandbox 在宿主 docker 上起单容器服务（postgres/redis/mysql/自定义），挂在与 LXC 互通的 docker 网络（`cfg.services.network`，默认 `mysandbox-lan`，桥钉 `br-mysandbox`），固定 IP + 命名卷；LXC 容器按服务名直连（hosts 自动注入，跨桥互通见上面 LXC 网络段）。**服务网络自持**：`ensureServiceNetwork` 在缺失时按服务池隐含的 /24 自动重建（status 自愈 + 创建兜底），别手工建网络——手工建会落到 docker 默认池，与 LXC 网段不通。

- **compose 底账（v2 根模型，`server/serviceCompose.ts`）**：一服务 = `~/.mysandbox/compose/<名>/compose.yaml`（目录 0700/文件 0600，env 含密码）。**文件是唯一配置真相**：创建 = 生成首版文件 + `compose up`；改配置 = 编辑文件 + 应用（面板配置页或终端手改，等价——面板不持有第二份配置状态）；删除 = `compose down` + 删卷（按需）+ 删目录。文件形状实测验证过 compose v5：顶层 `name:` = 项目名，service key/container_name 同名；网络与卷 `external: true`（compose 不加 `<project>_` 前缀、down 不删 external 卷——保住 `mysandbox-svc-<名>` 命名与「删服务才许删卷」边界；external 卷须在 up 前 `ensureVolume`）。**yaml 发射是手写的**（JSON 引号值，YAML 是 JSON 超集）——本机 js-yaml 5.2.3 的 `dump` 把一切字符串打成 `>-` 折叠块，没法读。写入前必经 `compose config --quiet` 校验（坏文件不落盘，否则 delete 的 down 也会解析失败卡死删除）。**漂移检测** = 容器 label `com.docker.compose.config-hash`（最后一次 up 的 hash）vs `compose config --hash <service>`（当前文件 hash），同算法逐字节可比；hash 只在抽屉配置页懒算（spawn 有成本，不进 3s 轮询列表）。改配置语义：追新镜像 = 文件里改 image 版本 + 应用；本地 build 迭代 = `构建并应用`（`up -d --build`）；`up -d` 幂等收敛，没变化的 up 无事发生。**旧版 update/rebuild 任务链已退役**（声明式底账下没有「按原形状重建」的概念空间）。
- **模块归属**：`server/docker.ts`（docker CLI 客户端：execFile/spawn 数组参数、`--format '{{json .}}'` 解析、label 过滤、卷操作、`docker events` NDJSON 订阅）+ `server/serviceCompose.ts`（compose 文件层：生成/校验/读写/hash/up/down，见上条）+ `server/services.ts`（预设/编排/路由，对标 `base.ts`）+ `server/jobs.ts`（后台任务注册表）。**不经过 engine 抽象**——`Engine` 接口是容器生命周期形状，服务是另一种生命周期；上面「业务层只 import engine/index.js」的约定限于容器引擎。
- **目录注册表（agent 接口，1 目录 = 1 项目 = N 服务）**：`compose/<名>/` 目录本身是服务清单——agent/用户直接放一份 compose.yaml（顶层 `name:` = 目录名）+ `docker compose up -d`，面板即出现该服务。compose 文件原生多服务：单服务 = N=1 特例（行为同旧版），多服务项目 = **一张卡锚在入口服务**（自动选带发布端口的，可在抽屉「项目成员」里换），其余成员折叠展示——「加入列表」升格独立卡（name = 容器名）、「设为入口」换锚（`POST /:name/stack`，meta 懒创建并从文件补水）。listServices 目录 ∪ 容器双源扫描（容器经 compose project label 命中目录；成员按 service label 分桶）。创建对话框已退役（保留 `POST /api/services` API 与 presets 供 agent 调用）。
- **创建/应用/迁移/接管都是后台任务**（kind `create`/`apply`/`migrate`/`adopt`，不是 SSE）：`POST /api/services` 快校验（`prepareServiceCreate`：校验/查重/IP 分配，失败回 4xx 内联显示）+ **同步预占名称与 IP**（`serviceNameExists` 查不到「还没建容器」的进行中任务，不锁名会双双通过查重）→ 立即返回 `{jobId}`；写文件/建卷/`compose up` 在 `jobs.ts` 的进程内任务里跑（`runServiceCreate`/`runServiceApply`/`runServiceMigrate`/`runServiceAdopt`）。任务 = 内存 Map + 环形日志（400 行）+ 终态保留 20 个，**刻意不持久化**（进程重启即丢，重试近乎免费）。路由：`GET /api/services/jobs?tail=`（tail=0 极小 payload）、`GET .../jobs/:id`（全量日志）、`POST .../jobs/:id/cancel`。**compose up 全程可取消**（SIGKILL CLI；半途状态由下一次 up 幂等收敛——声明式底账消解了旧「取消必须落在 rm 之前」的时序枷锁）。配置页 = `GET /api/services/:name/config`（视图含 yaml/path/hash/appliedHash/drift/readonly；adopted 栈 = 原文件只读展示，编辑/应用归原编排方）+ `POST .../apply`（body yaml；校验写盘在路由同步段 400 回显，up 进 job）+ `POST .../migrate`（旧版服务迁移，见下）。jobs.ts 不运行时 import services.ts（编排以 thunk 传入，防循环依赖）。
- **迁移（legacy → compose）**：旧版 `docker create` 创建的服务（无底账，`ServiceView.hasCompose=false`）唯一出路 = `POST /api/services/:name/migrate`：从 meta（env/command/volume/ip）+ inspect 快照（labels、卷挂载点）复刻形状生成文件 → `docker rm -f` 旧容器（compose 接管不了同名裸容器）→ `compose up`。命名卷数据无损；**无卷 custom 的可写层会丢**——前端入口 `requestServiceMigrate` 先警告再动手。失败不自动回滚（同旧 update/rebuild 契约）：文件已在，再点一次迁移/应用即幂等收敛。meta 从此只剩展示性数据（displayName/description/ports/ip 记账），env 等配置一律以文件为准（listServices 读文件，坏文件降级 meta 不炸轮询）。
- **compose up 的流式输出**（`serviceCompose.ts composeUp`）：输出已是人话行（Pulling/Created/Started）直接进任务日志；**两级超时**沿用：`cfg.services.pullTimeoutMs`（默认 30min 硬顶，现为 compose up 硬顶）+ 5min 无输出看门狗（硬编码，TLS 卡死的 pull 完全静默）；daemon 没配 `registry-mirrors` 时前端 amber 提示保留（`registryMirrors()` 读 `docker info`，60s TTL）。收编容器的 409 边界：无删除/无配置/无迁移（生命周期归它自己的编排方），只有「取消收编」。
- **管理边界靠 label（双源）**：受管判定 = `mysandbox.managed-by=mysandbox` + `mysandbox.kind=service` 的 label 集 **∪ sidecar 收编集**（`adoptedServiceNames(meta)`）。docker **不能给既有容器后补 label**，所以 `listServiceContainers(extraNames)` 改为一次无过滤 `ps -a` 在 JS 分区——凡按 label 过滤的新旧代码都必须双源，否则收编容器会被误判孤儿/误删 meta（`requireService` 是重灾区）。未收编的外部容器（dener-* 等）依然**结构性**进不来列表、操作必 404。易变元数据走 sidecar `state.json` 的 `services` 键（0600）；API 回**全量 env 值**（含密码，真相在 compose 文件）并附现成连接命令——token = 宿主完整权限，鉴权边界在 token 上收住，UI 直接展示连接凭据。容器被外部 `docker rm` 后 meta 变孤儿：`requireService` 对它操作时顺手清再 404。**job 视图不携带 env**（只 name/image/ip）。
- **收编外部容器**（`adoptService`，routes：`GET /api/services/adoptables`、`POST /api/services/adopt`，body 带 `takeover`/`stack`）：三种形态按容器来源分流——**裸容器（docker run 起家）→ 接管式收编（takeover:true）**：`inspectContainerShape` + `inspectImageDefaults` 复刻「操作者加的形状」（env 减镜像默认、entrypoint/command 仅与镜像默认不同才写、端口/named+匿名卷/healthcheck/restart/原自定义网络原样保留——tl-db 挂 tl-test 网不能丢；host 网络模式写 `network_mode: host` 不进服务网络）生成 compose 底账 → rm 裸容器 → compose up（后台 job，重建中断/可写层丢失由前端确认框挑明）；收编完成后 meta.adopted 清位，按 label+底账双凭证管理（删除/改配置解锁）。**compose 栈（多容器项目）→ 栈级只读收编（stack:true 或命中 project label 自动走）**：一行收编整个项目——全体成员接入服务网络（IP 记 meta.stack.services）、meta 以项目名为 key（`stack: {file(从容器 label `com.docker.compose.project.config_files` 拿，零猜测), services[]}`）、**单入口展示**（入口 = 有发布端口的成员，抽屉「项目成员」可换锚/「加入列表」升格）；启停走 `docker compose -f <原文件> start/stop/restart`（管理不拥有），配置页原文件只读展示，删除 409，取消收编 = 全体成员摘网 + 清项目 meta。**已收编单容器（mymusic 式）→ 只读纳管**。收编名限定 `/^[a-z0-9][a-z0-9_-]{0,62}$/`。adoptables 三源分组（裸容器行 ∪ compose 栈行 ∪ 已收编排除；running 优先，Exited 噪声靠「显示已停止」开关；目录注册表项目的成员排除在外——已是服务）。事件自愈：`healAdopted` 对栈成员逐容器重连（ip 记在 stack.services 回写）；`destroy` 后 60s 确认**全体成员**无重建才清项目 meta；目录注册表服务的启停追平靠 composeProject 命中 compose 目录判定（事件 Attributes 自带全部 label）。前端：侧栏分区头 Inbox 与抽屉头部 Inbox 双入口 → `AdoptServiceDialog`（接管带 confirmName 确认；成功 toast + 即时刷侧栏）；栈卡片「项目成员」折叠区管入口/升格；侧栏卡片「收编」Badge 常驻（只读形态）、右键菜单无删除/改配置。
- **IP 池**：`cfg.services.ipPool`（默认 10.88.0.200–240，docker IPAM 动态分配从 .2 顺排天然隔离）。占用 = 运行中网络端点 ∪ state.services 已登记 IP ∪ reserved ∪ **进行中任务预占的 IP**（`jobs.ts` 的 reservedIps 并进 `servicePoolView`）——`network inspect` 只列 running 端点，**停机服务的 IP 必须靠 state 兜底**否则二次分配。收编容器的 IP 是多网络容器中 **mysandbox-lan 上的那个**（`containerNetIp(name, network)`，`containerIpamIp` 遍历全网络可能先命中 compose 网的静态 IP）。应用后按文件回写 meta.ip（用户改过 ipv4_address 时池记账跟上）。
- **服务发现 = hosts 尾部服务块**：`hosts.ts` 的 `composeHostsContent(base, serviceBlockLines(...))` 是唯一组合点，`hosts-sync.ts` 的 `applyServicesBlock`（读-改-写，幂等无需 hash 记账）覆盖事件/启动/services 全部触发点；`docker events`（start/die/destroy，无 label 过滤、回调按 managed/收编名集/composeProject 命中目录过滤）+ 2s trailing debounce 驱动外部启停追平。服务端点三源并集（label 集 ∪ 收编集 ∪ compose 目录集，`listServiceEndpoints` 的 composeProjects 参数）；hosts 行名字规则：单服务项目容器名 ≠ 项目名时 rename 成项目名（用户连接的名字），**多服务项目不 rename**（N 个成员挤一个名字，各用容器名；要短名 pin container_name）。容器内验证：`getent hosts <服务名>` → `+PONG`。
- **坑**：本机 daemon.json 无 registry-mirrors 且宿主在 fake-ip 网络下，Docker Hub 直连常 EOF（apt 同理换过 aliyun 源）——所以有 mirror 检测提示（compose up 的 pull 同样受影响）；docker daemon 挂 → health 仍 200（`dockerStatus` 1.5s 快败）、面板 reachable:false 降级、hosts 应用静默跳过；compose 文件坏了 down 会失败——deleteService 回退裸 `docker rm -f`，apply 的校验前置挡住坏的写盘。
- **前端**：两层分工——侧栏「docker 服务」分区（`ContainerList.vue` 底部环境区：与系统容器同形态同状态语言的卡片——色条=按服务名 hash 的身份色（`containerColor` 同一机制），非 running=灰条+整卡降亮度，无圆点；分区头与容器分区头同款（图标+计数，无状态点），整行点击展开/收起，`mysandbox:svc-cards-open` 记忆，收起时显示摘要文案（不可达红字）；卡片右键收详情（服务抽屉）/连接命令/代理地址/启停重启，点卡片进服务终端（与容器同交互，见「宿主终端」节的服务终端）；分区头 ＋ 直开创建对话框（App 挂独立 `ServiceCreateDialog`，不拉抽屉——创建入口只开表单）、Inbox = 收编外部容器（`ContainerList` 自挂 `AdoptServiceDialog`，TermSessionsDialog 同模式，成功 toast+即时刷侧栏））+ `ServicesPanel` 服务抽屉（右侧滑入的**单服务详情**，抽屉内不放列表——侧栏卡片即切换器，`initialSelect` 变化即跟随；裸用 reka 原语自绘而非 ui/dialog 的居中 DialogContent；信息分层防心智过载：名称/状态/操作/连接命令+IP 常开，「凭据与详情」「配置（compose.yaml）」「日志」折叠默认收，配置页 = `CodeEditor`（Monaco 壳，Ctrl+S=应用）+ 未保存/待应用 chip + 应用/构建并应用按钮，无底账的旧版服务出「迁移」入口，日志懒加载、展开才 3s 跟刷；创建任务=顶部横幅仅进行中/失败/取消可见（点开看日志/取消），完成自动选中新服务并重载配置页；新建入口在抽屉头部 ＋；抽屉 3s 轮询服务+任务，外部启停（docker CLI 等）也即时反映）。创建走 `ServiceCreateDialog`（预设表单/自定义镜像；shadcn-vue Select（reka-ui portal）——**别用原生 `<select>`**，强制 dark 下 OS 自绘弹层白底违和；提交拿 jobId 即关窗）。完成通知：`lib/serviceJobs.ts` 的 `trackServiceJobs`（模块级 Map 记上次 state，只有「见过 running 落到终态」才 toast——两个轮询器喂它天然去重，首拉不误报）+ 全局 `<Toaster>`（vue-sonner，`ui/sonner/Sonner.vue` 硬编码 dark，无 next-themes）。侧栏服务分区自适应轮询（闲时 5s / 有任务 3s），抽屉操作经 ServicesPanel 'changed' → App `svcVersion` 计数 → ContainerList watch 即时跟刷，任务进行中分区头摘要显示「N 个服务任务进行中…」。SSE（`streamOp`）现在只有 base 在用。侧栏三分区（系统容器/应用容器/终端）统一交互语言：分区头整行收展（各记 `mysandbox:{ct,svc,term}-cards-open`）+ 卡片拖拽排序（桌面 only，`mysandbox:{ct,svc,ssh}-order` 存 localStorage——查看偏好不进 sidecar，同 tab 布局约定）+ 应用容器/终端区展开体高度可拖（顶部细把手 pointer capture，`mysandbox:{svc,term}-h`）。
- **宿主 docker 直用（dockerApi，默认关）**：容器内免装 docker、直用宿主 dockerd——`server/dockerApi.ts` 进程内 TCP→docker.sock 透传桥（绑网关 IP:2375，EADDRNOTAVAIL 退避重试，失败非致命，cli.ts 装配）。容器侧配套全随 `dockerApi.enabled` 开关：hosts 尾块注入 `host.docker.internal → 网关`（`currentSvcLines`，域名钉死不随 ipPool 变）；`DOCKER_HOST=tcp://host.docker.internal:2375` 由 engine `attachArgs` 每次 exec 注入 + `scripts/zshrc` 条件导出兜底（tmux 老 server 的 shell 吃不到 exec env）；容器里只要客户端二进制（模板 step docker-cli，静态包只取 `docker`，不装 docker.io——那带 daemon）。安全：docker = 宿主 root 级能力，ufw INPUT 只放 LXC 网段（firewall.ts），services 网段不给；桥随 mysandbox 进程存活。改网段后 hosts 行随 hosts-sync 追平，无需动容器配置。

### Web 代理——「面板外访问容器/服务的端口」

`server/proxy.ts`：容器/服务在自管私网里，外部设备只能摸到宿主——把出口收进面板（同一监听端口、同一 token）。**两条门面一套核心**：vhost 门面（`Host: <name>-<port>.<基域名>`，由 fastify `rewriteUrl` 改写成规范子路径）+ 子路径门面（`/proxy/<c|s>/<name>/<port>/…` 兜底）。详版设计/实测记录在 `docs/web-proxy.md`——碰代理先读它。要点：

- **rewriteUrl 同时覆盖 HTTP 与 WS upgrade**：@fastify/websocket 的 upgrade 经 `fastify.routing` 分发，而 `fastify.routing` 就是包了 rewriteUrl 的 handler（fastify.js `wrapRouting`）——不要自己挂 upgrade 监听。白名单未命中原样放行（基域名裸访问 = 控制台，靠这点天然兜住）。
- **白名单是精确集合不放网段**（受管容器 IP ∪ 服务 IP；网段含 `.1` 宿主副 IP，放网段=SSRF 跳板指回宿主）。缓存 TTL 3s，rewriteUrl 同步只读、过期后台刷（去重于 inflight），启动预热。
- **cookie 鉴权：cookie 仅在 `/proxy` 门面被承认**（`/api`、`/ws` 维持 header/query-only——被代理页面的 JS 拿 cookie 打不进控制台 API），本体 `Path=/`（vhost 门面的页面路径任意，Path 限 /proxy 的话浏览器根本不随行）；`/api/auth/session` 对**每个候选基域**各发一份 Domain cookie（本机 mysandbox.test、远程 tailscale 域名各自种上）。转发上游前剥 cookie 与 `x-sandbox-token`。SameSite=Strict。
- **双口径平级，不做互转**：`IP:端口` 与 `域名:端口` 都是一等访问形式，服务端不重定向。前端端口点击跟随控制台口径（`lib/proxy.ts` 的 `originIpish`）：IP/localhost 打开控制台 → 直连容器/服务 `IP:端口`（代理上线前的原形式，无 cookie 依赖；`mysandbox open` 深链恒走此口径）；经基域名打开 → vhost/subpath 代理。
- **reply-from 的坑**：body 靠封装作用域内 catch-all content-type parser 透传原始流（在 scope 内注册，别污染全实例）；undici `bodyTimeout: 0` 保长 SSE；Host 默认被改成上游、要 rewriteRequestHeaders 改回来；错误包成 `FST_REPLY_FROM_*`、原始 code 在 `error.cause`；query 不用自己拼（source 不带时自动取原 req.url）。Set-Cookie 的 Path 要收编进代理前缀，否则多应用同名 cookie 在 `/` 互相覆盖。
- WS 是同路由全声明式 `handler` + `wsHandler` 双挂（wsHandler 类型只在 RouteOptions 上）；基域名 auto = 候选序 `mysandbox.test`（固定好记，**需宿主侧 DNS 应答**——本机 mihomo hosts 已配；`.local` 无公共 DNS 且 mDNS 不做泛解析，跨设备不通）→ LAN sslip → tailscale sslip，**前端逐个探测择优、全败降级子路径**（lib/proxy.ts probeBase，no-cors 打 `msbprobe.<base>/api/health`）；有自有域名优先自有。
- 前端 URL 拼装在 `lib/proxy.ts` 单例（`serviceUrl` + `directUrl`），ContainerList 端口点击与 ServicesPanel 自定义服务「打开」都走它；域名口径下端口条目附「直连 IP:端口」第二打开方式（`directOpenExtra`——IP 口径主点击已是直连不重复给，map 行/无 IP 不给）；服务预设（postgres 等）端口非 HTTP 不给「打开」。
- **TLS（`listen.tls`）**：自签名本地 CA + 泛域名叶子（`server/tls.ts`，STATE_DIR/tls/ 持久化；SAN=代理基域名+全部本机 IPv4，临期 30d/SAN 变则重签，CA 永不变）。信任导入走 `~/.pki/nssdb`（Chromium **不读** /etc/ssl；导入后要重启浏览器）或系统库；下载入口 `/tls-ca.crt`。CLI/undici 加载同一份 ca.crt；前端 scheme 全随 `location.protocol`。

### 宿主终端

- **宿主终端**（`hostTerminal.ts`）：与容器终端同协议同语义（**真 tmux 语义**：会话只被显式 kill 或 shell 退出终结，无任何定时清理——「只要服务还在，用户开的会话就活着」；kill 帧、activeCount 多窗口），但 PTY 由本进程管理：宿主 tmux 专用 socket `-L mysandbox-host`、会话 `mysandbox-host-<termId>`，`script(1)` 提供 PTY，`stty -F <pts>` 驱动 resize（tmux 3.4 的 `refresh-client` 不支持 -x/-y）。已知坑（都在注释里）：spawn script 必须 `SHELL=/bin/sh`（zsh 会把 `=mysandbox-host-xxx` 做 =word 展开）；node 退出时 `process.on('exit')` 同步 SIGKILL 全部 script 子进程（tsx 热重启每次触发）；**tmux server 必须经 `systemd-run --user --scope` 拉起在 mysandbox.service cgroup 之外**（service 单元形态会让毫秒级退出的 `new-session -d` client 完成单元 → systemd 清空 cgroup → 刚 fork 的 server 陪葬；scope 只要不监督进程、有活进程即保持）。会话 cwd = 宿主 home。前端 `ContainerList.vue` 侧栏底部「终端」区首项「本机」，`TermGroup.kind='host'`（containerId 哨兵 `__host__`，修剪/OSC/FilePanel 均豁免；同区挂 SSH 主机条目，见下）。
- **服务终端**（同文件 `/ws/service-terminal`，handler 双模式共享 attach 机制）：docker 服务容器里没有 tmux，会话本体 = 同一宿主 socket 上的 tmux 窗口命令 `docker exec -it -e MYSANDBOX_TERM=<termId> <name> <shell>`（连接前查运行态、容器内 bash→sh 解析；docker CLI 随 client tty SIGWINCH 自动 resize）。会话名 `mysandbox-svc-<termId>`，**服务名存会话选项 `@svc`**（⚠️ 必须会话级 `set-option -t "=会话:"`——`-s` 是 server 级选项且 `-t` 被静默忽略，实测所有会话读到同一个值，会话对话框会归错组/进错容器；名字可含 `-` 与 termId 拼接切不开，listServiceSessions 走格式串直读）。跨 mysandbox 重启存活同宿主终端；不参与无输出提醒扫描（activity 的 host 扫描前缀不含 svc）。前端 `TermGroup.kind='service'`（containerId=服务名，tab 色条沿用名字 hash 色），服务卡片点击即进终端（与容器同交互）、⋯ 详情开服务抽屉；会话对话框可找回/接入（`/api/terminal-sessions/service/:termId`）。
- **SSH 主机终端**（`sshTerminal.ts`，`/ws/ssh-terminal` + `/api/ssh/targets*`）：远程主机只是**终端的延伸，不是被管理对象**——无 OSC 深链/活动扫描，不进批量操作/hosts/`mysandbox status`（这条守住产品概念，给远程主机加"管理"能力之前先想清楚）；文件面板是刻意保留的例外（见下「SSH 文件端点」）。会话本体在**远端** tmux 专用 socket `-L mysandbox-ssh`（会话 `mysandbox-ssh-<termId>`），PTY 链 = script(1)（本机，children/childTty/applyTtySize 复用 hostTerminal 导出件）→ `ssh -t` → 远端 attach；远端 server 无 cgroup 归属问题，不需要 systemd-run。目标存 **sidecar state.json**（`sshTargets`，UI 可增删、不碰用户手改的 config.yaml），凭据全走宿主 ssh（keys/agent/`~/.ssh/config` 别名），零新增存储；后台命令 BatchMode 快败，密码认证目标由 attach 的 `new-session -A` 兜底交互建会话（设置缺席的可接受降级）。实测坑（都在注释里）：① `execFile('ssh', argv)` 的 argv **不能**再带首位 `ssh`（重复后远端主机名变字面量 `"ssh"` 被 DNS 解析到 fake-ip）；② 经 ssh 的 argv 由**远端登录 shell** 解析——tmux target 的 `=名字` 要 `shq()` 单引号裹（zsh =word 展开）、`-F` 格式串（含换行与 `|`）同理，否则扫描恒空；③ `ssh` 带远端命令时**不自动申请远端 pty**（本机 stdin 是 tty 也不行），attach 必须 `-t`；④ `set-titles-string` 的 `#T` 裸词在远端 shell 开头即注释，必须引号。前端 `TermGroup.kind='ssh'`（containerId=`ssh:`+目标名，api.ts `sshGroupId`/`sshTargetName` 前缀隔离撞名；侧栏终端区「本机 + SSH 主机」与应用容器同款卡片语言，SshTargetsDialog 管理），会话对话框可找回/接入（`/api/terminal-sessions/ssh/:name/:termId`）。
- **SSH 文件端点**（`sshFiles.ts`，`/api/ssh/:name/*` + 通道 `sshChannel.ts`）：SSH 主机的文件面板，与容器/宿主/服务四足鼎立全量对齐（列目录/读写/建删/下载/git 套件/resolve/cwd，脚本同源 files.ts/serviceFiles.ts、解析单源 gitpanel.ts）。前端约定：ssh 组 containerId 本体（`ssh:`+目标名）即文件目标 id，`filesBase` 切 `/api/ssh/<name>/*`。通道 = 宿主 ssh（BatchMode 快败，与终端同权限面不新增越权）；**argv 全部经 sshChannel 的真转义 `shq()` 单引号包裹**（HTTP 传来的路径可含引号/空格，与 sshTerminal 白名单值的裸 shq 不同源）——ssh 把 argv 拼成命令串交**远端登录 shell** 解析是注入面的总闸。exit 255 = ssh 传输失败 → 502 `ssh_unreachable`；非 Linux 远端（macOS/BSD 的 `stat -c` 缺失会静默列空）由 `requireRemoteLinux`（uname 一次探测按目标缓存）明确 400；密码认证目标文件面板快败（交互输密码只在终端 attach 有意义）。cwd/resolve 天然成立：会话在远端 tmux，`pane_current_path` 即远端真实路径（list-panes 直查，`=` 精确匹配）。跨面板复制 `/api/files/copy` 支持 `ssh:` 侧（tar 经 ssh 进出，远端 /tmp 临时目录 + 远端 mv；unpack 走 `sshSpawnIn`——stdin 必须管道收 tar 流，与下载用的 `sshSpawn` 分立）。唯一不可用的是 OSC 深链——远端没有 mysandbox 种子。
- **服务文件端点**（`serviceFiles.ts`，`/api/services/:name/*`）：服务终端的文件面板与容器/宿主全量对齐（列目录/读写/建删/下载/git 套件/resolve，脚本同源 files.ts、解析单源 gitpanel.ts，全部走 `docker exec`）。前端约定：服务组的**文件目标 id = `'s:'+服务名`**（`api.ts` `filesBase` 哨兵分发，与 termSessionKey 的 `s:` 同约定；组 containerId 本体仍是真名，只有文件目标在边界处加前缀）。cwd 关键差异：服务终端 tmux 在宿主、pane 跑的是 docker exec 客户端，`pane_current_path` 是宿主路径——建会话时 `-e MYSANDBOX_TERM=<termId>` 注入标记，/cwd 进容器扫 `/proc/*/environ` 找「带标记且父进程不带标记」的直启 shell 读 `/proc/<pid>/cwd`（老会话无标记 → 404 占位，重开 tab 即有；git 127 = 镜像没 git 按非仓库返回）。跨面板复制 `/api/files/copy` 支持 `s:` 侧（tar 经 docker exec 进出，容器内 /tmp 临时目录 + mv 落位）。唯一不可用的是 OSC 深链（`mysandbox open`/OSC 7677）——服务容器没有 mysandbox 种子。

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
- 容器 zsh 是 oh-my-zsh 基座（`/usr/share/oh-my-zsh`，模板脚本 clone 后须 `chmod g-w,o-w`——compaudit 拒 group/other 可写目录）：history/menu select 补全/ls 颜色/git 别名（`gst`/`gd`/`glo`；注意 `gl` 是 git pull）omz 自带，`scripts/zshrc` 只补 omz 没有的（`ll`/`la`、两个 apt 插件：autosuggestions + syntax-highlighting，**omz 不含这两个**、终端动态标题钩子——preexec/precmd 发 OSC 2（执行命令/空闲路径），web tab 标签链路依赖：tmux `set-titles on`+`'#T'`（terminal.ts/hostTerminal.ts attach 时设）转发给前端 onTitleChange；omz termsupport 在 tmux 内发的 `\ek` 实测改不了 pane title）。老容器 `~/.zshrc` 是首启 seed 的持久化副本不会被覆盖——换新配置要手工从 `/etc/skel-home/.zshrc` 重拷。
