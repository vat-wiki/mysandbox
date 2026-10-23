# docker 服务层——「容器旁边的数据库们」

docker 引擎移除后 docker 的新角色：**配套服务层**（界面名词：**应用容器**——与「系统容器」对仗，运行时迁移方案见 [`docs/migrations/podman-migration.md`](../migrations/podman-migration.md)）。mysandbox 在宿主 docker 上起单容器服务（postgres/redis/mysql/自定义），挂在与 LXC 互通的 docker 网络（`cfg.services.network`，默认 `mysandbox-lan`，桥钉 `br-mysandbox`），固定 IP + 命名卷；LXC 容器按服务名直连（hosts 自动注入，跨桥互通见 [containers.md](containers.md)）。**服务网络自持**：`ensureServiceNetwork` 在缺失时按服务池隐含的 /24 自动重建（status 自愈 + 创建兜底），别手工建网络——手工建会落到 docker 默认池，与 LXC 网段不通。

## compose 底账（v2 根模型，`server/serviceCompose.ts`）

一服务 = `~/.mysandbox/compose/<名>/compose.yaml`（目录 0700/文件 0600，env 含密码）。**文件是唯一配置真相**：创建 = 生成首版文件 + `compose up`；改配置 = 编辑文件 + 应用（面板配置页或终端手改，等价——面板不持有第二份配置状态）；删除 = `compose down` + 删卷（按需）+ 删目录。

- 文件形状实测验证过 compose v5：顶层 `name:` = 项目名，service key/container_name 同名；网络与卷 `external: true`（compose 不加 `<project>_` 前缀、down 不删 external 卷——保住 `mysandbox-svc-<名>` 命名与「删服务才许删卷」边界；external 卷须在 up 前 `ensureVolume`）。
- **yaml 发射是手写的**（JSON 引号值，YAML 是 JSON 超集）——本机 js-yaml 5.2.3 的 `dump` 把一切字符串打成 `>-` 折叠块，没法读。写入前必经 `compose config --quiet` 校验（坏文件不落盘，否则 delete 的 down 也会解析失败卡死删除）。
- **漂移检测** = 容器 label `com.docker.compose.config-hash`（最后一次 up 的 hash）vs `compose config --hash <service>`（当前文件 hash），同算法逐字节可比；hash 只在抽屉配置页懒算（spawn 有成本，不进 3s 轮询列表）。
- 改配置语义：追新镜像 = 文件里改 image 版本 + 应用；本地 build 迭代 = `构建并应用`（`up -d --build`）；`up -d` 幂等收敛，没变化的 up 无事发生。**旧版 update/rebuild 任务链已退役**（声明式底账下没有「按原形状重建」的概念空间）。

## 模块归属

`server/docker.ts`（docker CLI 客户端：execFile/spawn 数组参数、`--format '{{json .}}'` 解析、label 过滤、卷操作、`docker events` NDJSON 订阅）+ `server/serviceCompose.ts`（compose 文件层：生成/校验/读写/hash/up/down）+ `server/services.ts`（预设/编排/路由，对标 `base.ts`）+ `server/jobs.ts`（后台任务注册表）。**不经过 engine 抽象**——`Engine` 接口是容器生命周期形状，服务是另一种生命周期；业务层只 import engine/index.js 的约定限于容器引擎。

## 目录注册表（agent 接口，1 目录 = 1 项目 = N 服务）

`compose/<名>/` 目录本身是服务清单——agent/用户直接放一份 compose.yaml（顶层 `name:` = 目录名）+ `docker compose up -d`，面板即出现该服务。compose 文件原生多服务：单服务 = N=1 特例（行为同旧版），多服务项目 = **一张卡锚在入口服务**（自动选带发布端口的，可在抽屉「项目成员」里换），其余成员折叠展示——「加入列表」升格独立卡（name = 容器名）、「设为入口」换锚（`POST /:name/stack`，meta 懒创建并从文件补水）。listServices 目录 ∪ 容器双源扫描（容器经 compose project label 命中目录；成员按 service label 分桶）。创建对话框已退役（保留 `POST /api/services` API 与 presets 供 agent 调用）。

## 创建/应用/接管都是后台任务

kind `create`/`apply`/`adopt`，不是 SSE：`POST /api/services` 快校验（`prepareServiceCreate`：校验/查重/IP 分配，失败回 4xx 内联显示）+ **同步预占名称与 IP**（`serviceNameExists` 查不到「还没建容器」的进行中任务，不锁名会双双通过查重）→ 立即返回 `{jobId}`；写文件/建卷/`compose up` 在 `jobs.ts` 的进程内任务里跑（`runServiceCreate`/`runServiceApply`/`runServiceAdopt`）。

- 任务 = 内存 Map + 环形日志（400 行）+ 终态保留 20 个，**刻意不持久化**（进程重启即丢，重试近乎免费）。
- 路由：`GET /api/services/jobs?tail=`（tail=0 极小 payload）、`GET .../jobs/:id`（全量日志）、`POST .../jobs/:id/cancel`。
- **compose up 全程可取消**（SIGKILL CLI；半途状态由下一次 up 幂等收敛——声明式底账消解了旧「取消必须落在 rm 之前」的时序枷锁）。
- 配置页 = `GET /api/services/:name/config`（视图含 yaml/path/hash/appliedHash/drift/readonly；adopted 栈 = 原文件只读展示，编辑/应用归原编排方）+ `POST .../apply`（body yaml；校验写盘在路由同步段 400 回显，up 进 job）。jobs.ts 不运行时 import services.ts（编排以 thunk 传入，防循环依赖）。
- **compose up 的流式输出**（`serviceCompose.ts composeUp`）：输出已是人话行（Pulling/Created/Started）直接进任务日志；**两级超时**沿用：`cfg.services.pullTimeoutMs`（默认 30min 硬顶，现为 compose up 硬顶）+ 5min 无输出看门狗（硬编码，TLS 卡死的 pull 完全静默）；daemon 没配 `registry-mirrors` 时前端 amber 提示保留（`registryMirrors()` 读 `docker info`，60s TTL）。外部栈（收编）的 409 边界：无删除/无配置应用（生命周期归原编排方），只有「取消收编」。

## 管理边界 = 目录注册表 ∪ label（单点判定在 `findServiceTarget`）

受管判定 = compose 目录（自有项目 ∪ 外部栈 stub）∪ `mysandbox.managed-by=mysandbox` + `mysandbox.kind=service` 的 label 集 ∪ compose project label ∈ 目录名集。docker **不能给既有容器后补 label**，所以列表/判定都是一次无过滤 `ps -a` 在 JS 分区再并集。未收编的外部容器（dener-* 等）依然**结构性**进不来列表、操作必 404（文件面板/peer exec/代理/复制全走 `serviceMeta.ts findServiceTarget` 这一个函数——新判定点别再自写双源）。

- 策展元数据在每项目 `compose/<名>/meta.json`（0600）；API 回**全量 env 值**（含密码，真相在 compose 文件）并附现成连接命令——token = 宿主完整权限，鉴权边界在 token 上收住，UI 直接展示连接凭据。**job 视图不携带 env**（只 name/image/ip）。

## 收编外部容器（`adoptService`）

routes：`GET /api/services/adoptables`、`POST /api/services/adopt`，body 带 `takeover`/`stack`。两种形态按容器来源分流：

- **裸容器（docker run 起家）→ 接管式收编（takeover:true，必须）**：`inspectContainerShape` + `inspectImageDefaults` 复刻「操作者加的形状」（env 减镜像默认、entrypoint/command 仅与镜像默认不同才写、端口/named+匿名卷/healthcheck/restart/原自定义网络原样保留——tl-db 挂 tl-test 网不能丢；host 网络模式写 `network_mode: host` 不进服务网络）生成 compose 底账 → rm 裸容器 → compose up（后台 job，重建中断/可写层丢失由前端确认框挑明；真不能丢可写层的先 docker commit 固化成镜像再收编）——收编后与自建服务无差别（label+底账管理）。**只读收编单容器已退役**（docker 不能后补 label，无底账单容器收编后与外部容器无法区分，凭证问题无解——「不能重建」不成立，见上）。
- **compose 栈（多容器项目）→ 栈级只读收编（stack:true 或命中 project label 自动走）**：一行收编整个项目——全体成员接入服务网络、stub 目录只有 `meta.json`（`external: {file(从容器 label `com.docker.compose.project.config_files` 拿，零猜测), workdir}` + `members[]`（容器名/IP/入口/升格记账——compose down 后容器没了 project label 派生不出缺席成员，IP 是 connect --ip 给的停机后 network inspect 看不见））、**单入口展示**（入口 = 有发布端口的成员，抽屉「项目成员」可换锚/「加入列表」升格）；启停走 `docker compose -f <原文件> start/stop/restart`（管理不拥有），配置页原文件只读展示，删除 409，取消收编 = 全体成员摘网 + 删 stub 目录。收编名限定 `/^[a-z0-9][a-z0-9_-]{0,62}$/`。
- adoptables 三源分组（裸容器行 ∪ compose 栈行 ∪ 已收编排除；running 优先，Exited 噪声靠「显示已停止」开关；目录注册表项目的成员排除在外——已是服务）。
- 事件自愈：`healAdopted` 对 stub 成员逐容器重连（ip 回写 meta.json members）；`destroy` 后 60s 确认**全体成员**无重建（按 compose project label 扫，重建成员有原 label）才删 stub 目录；目录注册表服务的启停追平靠 composeProject 命中 compose 目录判定（事件 Attributes 自带全部 label）。
- 前端：侧栏分区头 Inbox 与抽屉头部 Inbox 双入口 → `AdoptServiceDialog`（接管带 confirmName 确认；成功 toast + 即时刷侧栏）；栈卡片「项目成员」折叠区管入口/升格；侧栏卡片「收编」Badge 常驻（只读形态）、右键菜单无删除/改配置。

## IP 池

`cfg.services.ipPool`（默认 10.88.0.200–240，docker IPAM 动态分配从 .2 顺排天然隔离）。占用 = 运行中网络端点 ∪ compose 文件的 `ipv4_address` ∪ 外部栈 stub 的 members IP（meta.json）∪ reserved ∪ **进行中任务预占的 IP**（`jobs.ts` 的 reservedIps 并进 `servicePoolView`）——`network inspect` 只列 running 端点，**停机服务的 IP 必须靠文件/记账兜底**否则二次分配。收编容器的 IP 是多网络容器中 **mysandbox-lan 上的那个**（`containerNetIp(name, network)`，`containerIpamIp` 遍历全网络可能先命中 compose 网的静态 IP）。

## 服务发现 = hosts 尾部服务块

`hosts.ts` 的 `composeHostsContent(base, serviceBlockLines(...))` 是唯一组合点，`hosts-sync.ts` 的 `applyServicesBlock`（读-改-写，幂等无需 hash 记账）覆盖事件/启动/services 全部触发点；`docker events`（start/die/destroy，无 label 过滤、回调按 managed/目录命中（含外部栈 stub）过滤）+ 2s trailing debounce 驱动外部启停追平。服务端点 = 目录集 + label 集（`listServiceEndpoints(cfg, dirs)`，目录注册表容器无我们的 label 靠 project 命中）；hosts 行名字规则：单服务项目容器名 ≠ 项目名时 rename 成项目名（用户连接的名字），**多服务项目不 rename**（N 个成员挤一个名字，各用容器名；要短名 pin container_name）。容器内验证：`getent hosts <服务名>` → `+PONG`。

## 已知坑

- 本机 daemon.json 无 registry-mirrors 且宿主在 fake-ip 网络下，Docker Hub 直连常 EOF（apt 同理换过 aliyun 源）——所以有 mirror 检测提示（compose up 的 pull 同样受影响）。
- docker daemon 挂 → health 仍 200（`dockerStatus` 1.5s 快败）、面板 reachable:false 降级、hosts 应用静默跳过。
- compose 文件坏了 down 会失败——deleteService 回退裸 `docker rm -f`，apply 的校验前置挡住坏的写盘。

## 前端

两层分工——侧栏「docker 服务」分区（`ContainerList.vue` 底部环境区：与系统容器同形态同状态语言的卡片——色条=按服务名 hash 的身份色（`containerColor` 同一机制），非 running=灰条+整卡降亮度，无圆点；分区头与容器分区头同款（图标+计数，无状态点），整行点击展开/收起，`mysandbox:svc-cards-open` 记忆，收起时显示摘要文案（不可达红字）；卡片点击/右键/长按弹动作菜单（三端同一份：终端收首项），菜单收详情（服务抽屉）/连接命令/代理地址/启停重启，终端进服务终端（与容器同交互，见 [terminals.md](terminals.md)）；分区头 ＋ 直开创建对话框（App 挂独立 `ServiceCreateDialog`，不拉抽屉——创建入口只开表单）、Inbox = 收编外部容器（`ContainerList` 自挂 `AdoptServiceDialog`，TermSessionsDialog 同模式，成功 toast+即时刷侧栏））+ `ServicesPanel` 服务抽屉（右侧滑入的**单服务详情**，抽屉内不放列表——侧栏卡片即切换器，`initialSelect` 变化即跟随；裸用 reka 原语自绘而非 ui/dialog 的居中 DialogContent；信息分层防心智过载：名称/状态/操作/连接命令+IP 常开，「凭据与详情」「配置（compose.yaml）」「日志」折叠默认收，配置页 = `CodeEditor`（Monaco 壳，Ctrl+S=应用）+ 未保存/待应用 chip + 应用/构建并应用按钮，日志懒加载、展开才 3s 跟刷；创建任务=顶部横幅仅进行中/失败/取消可见（点开看日志/取消），完成自动选中新服务并重载配置页；新建入口在抽屉头部 ＋；抽屉 3s 轮询服务+任务，外部启停（docker CLI 等）也即时反映）。

- 创建走 `ServiceCreateDialog`（预设表单/自定义镜像；shadcn-vue Select（reka-ui portal）——**别用原生 `<select>`**，强制 dark 下 OS 自绘弹层白底违和；提交拿 jobId 即关窗）。
- 完成通知：`lib/serviceJobs.ts` 的 `trackServiceJobs`（模块级 Map 记上次 state，只有「见过 running 落到终态」才 toast——两个轮询器喂它天然去重，首拉不误报）+ 全局 `<Toaster>`（vue-sonner，`ui/sonner/Sonner.vue` 硬编码 dark，无 next-themes）。
- 侧栏服务分区自适应轮询（闲时 5s / 有任务 3s），抽屉操作经 ServicesPanel 'changed' → App `svcVersion` 计数 → ContainerList watch 即时跟刷，任务进行中分区头摘要显示「N 个服务任务进行中…」。SSE（`streamOp`）现在只有 base 在用。
- 侧栏三分区（系统容器/应用容器/终端）统一交互语言：分区头整行收展（各记 `mysandbox:{ct,svc,term}-cards-open`）+ 卡片拖拽排序（桌面 only，`mysandbox:{ct,svc,ssh}-order` 存 localStorage——查看偏好不进 sidecar，同 tab 布局约定）+ 应用容器/终端区展开体高度可拖（顶部细把手 pointer capture，`mysandbox:{svc,term}-h`）。

## 宿主 docker 直用（dockerApi，默认关）

容器内免装 docker、直用宿主 dockerd——`server/dockerApi.ts` 进程内 TCP→docker.sock 透传桥（绑网关 IP:2375，EADDRNOTAVAIL 退避重试，失败非致命，cli.ts 装配）。容器侧配套全随 `dockerApi.enabled` 开关：

- hosts 尾块注入 `host.docker.internal → 网关`（`currentSvcLines`，域名钉死不随 ipPool 变）。
- `DOCKER_HOST=tcp://host.docker.internal:2375` 由 engine `attachArgs` 每次 exec 注入 + `scripts/zshrc` 条件导出兜底（tmux 老 server 的 shell 吃不到 exec env）；容器里只要客户端二进制（模板 step docker-cli，静态包只取 `docker`，不装 docker.io——那带 daemon）。
- 安全：docker = 宿主 root 级能力（见 [security.md](security.md)），自管网段全端口互信下 services 网段同样可达；桥随 mysandbox 进程存活。改网段后 hosts 行随 hosts-sync 追平，无需动容器配置。
