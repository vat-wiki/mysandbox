# podman 迁移方案——「应用容器」运行时从 docker 迁到 podman

状态：**设计稿，未实施**。界面名词已先行改为「应用容器」（与实现解耦，本文沿用）。
服务层现状见 CLAUDE.md「docker 服务层」；本文回答三件事：rootless 为什么碰不得固定 IP、
两条可行路线各自长什么样、一期（rootful CLI 平移）具体怎么做。

## 0. 背景与动机

- 现状：docker（rootful，daemon + CLI），服务层 = 单容器应用（postgres/redis/mysql/自定义），
  固定 IP（10.88.0.200–240）挂在自管桥网 `mysandbox-lan`（br-mysandbox）上，与 LXC 桥
  `mysandbox0`（10.88.10.0/24）经宿主路由互通；LXC 容器经 hosts 注入按服务名直连（`psql -h pg`）。
- 动机（用户）：去 docker 化（daemon 单点、iptables 反复改写、生态偏好 podman）。
- 非目标：多机编排、rootless 优先于互通性、K8s。

## 1. 为什么 rootless 与「固定 IP 直连」冲突（原理）

rootless podman 的容器跑在**用户 namespace 的独立网络栈**里，出网靠 pasta/slirp4netns
做**用户态 NAT**。关键事实：宿主上不存在容器网络的桥接口——docker 的 `br-mysandbox`
是宿主真实 L2 设备（firewall/路由都摸得到），rootless 的桥只存在于 netns 内部：

- 容器 IP 是 netns 私有地址，宿主与其它 netns（LXC 容器）均无路由可达 → 「LXC 直连服务 IP」不成立；
- `--ip` 静态分配依附宿主 L2 桥，rootless 没有载体；
- macvlan/macvtap 需要在宿主建接口（CAP_NET_ADMIN），rootless 不可行。

结论：**rootless 下「服务有自己的固定 IP、LXC 跨桥直连」必须放弃**，没有绕法。

## 2. rootless 替代模型（若坚持 rootless）

保留「按名直连」的**形**，换掉「按 IP 直连」的**实**：

- 每个应用容器把端口**发布到宿主**，且绑定在 mysandbox0 的网关 IP 上
  （`podman run -p 10.88.10.1:15432:5432`，rootlessport/pasta 支持绑指定 host IP）；
- hosts 注入改为：`pg → 10.88.10.1`（服务名 → 网关 IP，不再是每服务唯一 IP）；
- 连接串形态不变（`psql -h pg` 默认端口直通），但**同镜像多实例需要端口池**
  （第二个 postgres 得是 15432→5432，`psql -h pg2 -p 15432`）。

代价：

| 项 | 影响 |
|---|---|
| 端口池管理 | 新增一层分配/回收（现 IP 池逻辑平移改写），连接串不再统一 5432 |
| 用户态 NAT 性能 | 所有 LXC↔应用容器流量过 pasta/rootlessport，数据库大流量场景有损耗 |
| 暴露面 | 端口在宿主 mysandbox0 IP 上监听，ufw 需按端口池放行（现在整桥 ACCEPT 一条） |
| IP 视图 | 侧栏/抽屉的「IP 复制」语义变化（变成网关 IP，多服务雷同） |
| 卷/存储 | rootless 卷在用户 storage 下，属主映射到宿主子 uid——数据目录权限模型变化 |

判定：rootless 是**网络模型重设计**（服务发现、IP 池、防火墙、抽屉信息架构全动），
不是运行时替换。除非「无 root」本身是硬需求，否则不推荐。

## 3. 推荐路线：rootful podman 一期（CLI 兼容平移）

rootful podman（netavark，桥网络）语义与 docker 接近，固定 IP/桥/互通全保留，
无 daemon（去单点）。一期**不**做 quadlet，生命周期继续走 CLI。

### 3.1 宿主前置

- 安装 podman（rootful，`storage_driver=overlay`）、确认 `netavark`；
- leon 免密：sudoers 精确放行 `/usr/bin/podman`（token 本就等价宿主 leon 权限，
  安全模型不变，见 CLAUDE.md；备选：rootful `podman.socket` 的 Docker 兼容 REST
  API `/run/podman/podman.sock`，但 leon 侧授权要额外配置，一期不做）；
- `ip_forward` 与 ufw 的桥转发规则（见 3.5）。

### 3.2 runtime 抽象（代码结构）

- `server/docker.ts` → `server/runtime.ts`（或保留文件名内部换实现）：所有 `docker` 前缀
  收敛为一个 `runtimeCmd()`（`cfg.runtime.command`，默认 `docker`，迁 podman 时 `sudo -n podman`）；
- `cfg.runtime`：`{ kind: 'docker' | 'podman', command: string[] }`，health 下发
  `runtimeStatus`（版本/可达性），前端文案已解耦（「运行时 xx.x」）；
- 散落的硬编码收口：hostTerminal.ts 的 `docker inspect/exec`（服务终端）、services.ts、
  jobs.ts、hosts.ts 事件订阅；
- 事件订阅做**格式适配器**：docker NDJSON（`status`/`Actor.Attributes`）vs podman
  events JSON（`Status`/`Name`/`Type`）——hosts-sync 只消费容器 start/die/destroy 三事件，
  适配面小。

### 3.3 命令兼容矩阵（一期逐条核对）

| 用途 | docker 现状 | podman rootful | 差异处理 |
|---|---|---|---|
| 列表/过滤 | `ps -a --filter label=… --format '{{json .}}'` | 同构 | 无 |
| 状态 | `inspect -f '{{.State.Running}}'` | 同构 | 无 |
| 创建 | `create --network --ip --label -v -e …` | `--ip` 需 netavark 桥网络 | 参数名核对 |
| 网络 | `network create --subnet --gateway -o bridge.name=br-mysandbox` | `--opt interface_name=br-mysandbox` | 选项键不同 |
| 事件 | `events --format '{{json .}}'` + filter | 同形式，字段名不同 | 适配器 |
| exec/终端 | `exec -it` | 同构 | 无 |
| 日志/卷/pull | 同构 | 同构 | 无 |
| info/mirrors | `docker info` 读 registry-mirrors | `registries.conf`（podman 无该字段） | 提示逻辑改读配置文件/降级隐藏 |

### 3.4 重启策略（一期与二期的分界）

- 一期：`--restart=always` + `podman-restart.service`（开机拉起）。**运行中崩溃自愈
  的语义与 docker 不完全等价**（podman 无常驻 daemon 监听），实测不足再进二期；
- 二期（quadlet）：每应用容器生成 systemd 用户/系统单元（`.container`），启停/自愈/
  开机全部交给 systemd——与 mysandbox 现有风格（lxc-start 套 systemd-run）同调，
  事件仍经 `podman events`。二期是纯增强，不阻塞一期。

### 3.5 网络与防火墙（风险最高，必须实机验证）

- 现状三个 docker 专属 hack：raw 表隔离规则压制（docker 29 每次容器 start 重写）、
  DOCKER-USER 链 ACCEPT、ufw before.rules 桥放行；
- netavark（rootful 默认 iptables 驱动）会写自己的 FORWARD/隔离规则，与 docker 的
  机制不同，**三个 hack 全部作废**；
- 首选实验：`podman network create --opt firewall_driver=none …`——netavark 不碰
  iptables，宿主转发交给内核 `ip_forward` + ufw（`ufw route allow in on br-mysandbox`、
  宿主↔桥 INPUT 规则并入 `mysandbox-firewall.service` 的计算），与 mysandbox0 的治理
  方式对齐，可能反而更干净；
- 验证清单：LXC→服务 IP 直连、服务→LXC 回程、服务出网（apt/pull）、宿主→服务、
  mysandbox 重启后 bridge/容器恢复、防火墙规则幂等。

### 3.6 数据迁移（pg/pg2）

docker 命名卷在 `/var/lib/docker/volumes/<name>/_data`，podman 在
`/var/lib/containers/storage/volumes/<name>/_data`，不能直接采用。步骤（每服务）：

1. `docker stop <name>`；`podman volume create mysandbox-svc-<name>`；
2. `sudo cp -a /var/lib/docker/volumes/mysandbox-svc-<name>/_data/. \
   /var/lib/containers/storage/volumes/mysandbox-svc-<name>/_data/`（属主保持；
   或者起一次性特权容器双向挂载 `cp -a`，免手拷权限坑）；
3. 在 runtime 抽象下用 podman 重建容器（同名、同 IP、同标签），起服务、
   容器内 `getent hosts <服务名>` + `psql -h pg` 实测；
4. 观察 24h 后 `docker rm` 旧容器、docker volume 保留 7 天再清。

### 3.7 回滚

runtime 是配置项：`cfg.runtime.kind` 切回 docker + 重启 mysandbox 即回滚（迁移期
两套二进制并存，容器/volume 各归各的存储目录，互不污染）。改名后的 UI 文案两态通用。

## 4. 实验验证清单（先试水，半天）

1. 装 rootful podman，`podman network create --subnet 10.88.0.0/24 --gateway 10.88.0.1 --opt interface_name=br-mysandbox --opt firewall_driver=none mysandbox-lan`；
2. `podman run -d --name pg-t --network mysandbox-lan:ip=10.88.0.201 -e POSTGRES_PASSWORD=x postgres:17`；
3. 宿主 `ping 10.88.0.201`、LXC 容器内 `getent hosts` 手工注入后 `psql -h 10.88.0.201`；
4. `podman exec -it pg-t bash`（终端链路）、`podman events --format '{{json .}}'` 起停各一次（字段核对）；
5. ufw route 规则手插后重复 3；重启宿主看容器是否自动恢复（podman-restart.service）。

全绿 → 按第 3 节实施；卡在 3/5 → 网络模型成本重估，回到本文再议。

## 5. 待拍板

- rootless 的替代模型（第 2 节）是否彻底出局（推荐出局）；
- 免密方式：sudoers 放行 podman（推荐）vs Docker 兼容 REST socket；
- 二期 quadlet 是否立项（推荐一期落地后再说）。
