# mysandbox 引擎迁移:docker → LXC

状态:进行中(2026-08 起)。基线 commit `18dd953`(docker 版现状快照)。

## 动机

mysandbox 的产品理念是「方便开发者使用多个**开发运行容器**」。docker 的核心概念(无状态、易失、镜像即真相)与这个理念偏移,人们在用 docker 时会时时感到「它不是一个系统容器」。代码里为弥合这个偏移留下的补丁:

- `Cmd: sleep infinity` + docker-init(tini)假 init —— 容器不是一台开机的机器
- label 不可变 → sidecar JSON 兜底元数据
- ExtraHosts 只在 create 时生效,重启即丢新条目
- 镜像契约靠 Dockerfile 分层 + registry,重且远
- 端口映射 NAT 与「固定 IP 直连」的既有模型错位

LXC 系统容器(完整发行版 + 真 init + 私有 rootfs)与「pet 容器」理念直接对齐。

## 选型结论

**裸 LXC(apt 版,当前 5.0.3)**,不是 Incus/LXD:

- mysandbox 已自建 state/hosts/provisioning/批量/终端整套 pet 语义,engine 只需提供「机器」。
- 无常驻 daemon,全部状态是纯文本 config 文件(可 git、可 diff、可手改)。
- Incus 的 REST API/镜像服务器/快照是给「想在这层做产品」的人的,我们都在上层做完了。
- 用的 CLI 面十年未变 ABI,apt 版由发行版托管安全更新。

版本决策:宿主 Ubuntu 24.04 apt 只有 5.0.3;7.0 需源码编译(/usr/local、无自动安全更新)。命令面两者一致,选 apt(用户已确认)。

## 关键设计决策

### D1 权限模型:unprivileged + uid-map 例外(已定)

```
# 容器 uid → 宿主 uid 映射(root→100000,1000 直通 leon):
lxc.idmap = u 0 100000 1000
lxc.idmap = g 0 100000 1000
lxc.idmap = u 1000 1000 1      # 容器 dev(1000) == 宿主 leon(1000)
lxc.idmap = g 1000 1000 1
lxc.idmap = u 1001 101001 64535
lxc.idmap = g 1001 101001 64535
```

- 容器 root = 宿主 uid 100000(非 root),mysandbox 全程无需 sudo。
- 容器 `/home/dev` 内的文件宿主侧就是 leon 属主:`files.ts` 宿主直读、`seedContainerCli` 种子零权限摩擦。
- `/etc/subuid` 已有 `leon:100000:65536`,无需改。
- 对比 privileged:rootfs 变 root 属主,每个操作过 sudo,工程上更差。安全上 unprivileged 严格更优。

### D2 网络:复用现有 docker 网桥(已定)

`dev-lan` = `br-f0cc7d98dca0`(10.88.0.0/24,网关 10.88.0.1),8 台 docker 容器在跑。LXC veth 直接挂同一座桥:

```ini
lxc.net.0.type = veth
lxc.net.0.link = br-f0cc7d98dca0
lxc.net.0.flags = up
lxc.net.0.ipv4.address = 10.88.0.x/24
lxc.net.0.ipv4.gateway = 10.88.0.1
```

- ipPool(10.88.0.20–250)**原样保留**;LXC 静态 IP 比 docker IPAM 更直接(config 写了就是)。
- 新旧容器同 LAN 互通 → **迁移逐台滚**,dener 全家先留在 docker,新容器走 LXC,engine list 聚合两源,UI 一个列表。
- unprivileged 挂别人的桥需 setuid helper:`/etc/lxc/lxc-user-nic` 放行 `leon veth br-f0cc7d98dca0 <count>`(一次性宿主准备)。

### D3 镜像 = 模板容器(已定)

Dockerfile 契约翻译成「手工调好的 dev 模板容器」:

| Dockerfile 契约 | 模板容器对应 |
|---|---|
| ubuntu:24.04 基底(同宿主 glibc) | 同,download 模板装 ubuntu 24.04 |
| 不跑 systemd,tini 假 init | **systemd 真 init**,开机即完整系统 |
| uid 1000 dev 用户 + zsh | 同(useradd -u 1000 dev;unprivileged 下 uid 映射直通 leon) |
| apt 包(zsh/git/tmux/playwright deps/编译链) | 同一套 apt 装 |
| node tarball /usr/local + corepack | 同 |
| playwright chromium /opt/ms-playwright | 同 |
| 五个 AI CLI npm 全局 + hermes + gh | 同(模板内手工跑一遍,产物留在 rootfs) |
| /etc/skel-home/.zshrc 模板 | 同,首启 seed 语义保留 |
| entrypoint.sh 首启 seed(缺才写) | systemd oneshot 服务跑同款 seed 脚本,幂等语义不变 |
| `mysandbox image build` | `mysandbox template clone`(lxc-copy,秒级) |
| push/pull registry | tar 导出/导入(可选,后置) |

模板建一次,之后全部 `lxc-copy` 克隆。home **在 rootfs 内**(D4)。

### D4 home 在 rootfs 内(已定)

- 「独立完整的系统」→ 容器自包含,克隆/迁移带走一切。
- dir 存储后端下 rootfs 就是宿主目录(`~/.local/share/lxc/<name>/rootfs`),宿主直读方案不变,基座从 `dataRoot/<name>` 换到 rootfs 路径。
- 不是为了隔离,是为了完整;uid 直通(D1)保住直读。

### D5 managed 判定:config 标记 + sidecar

label 不存在了。受管理容器 = LXC config 里有 `mysandbox.managed = true` 标记(纯文本,随时可改,概念上比 label 干净)+ sidecar JSON 照旧做易变元数据。adopt 外部容器:往其 config 追加标记,不动别的。

## engine 接口(迁移路径)

`docker.ts` 消费面提炼为接口,docker 实现挂接口后,**迁移期两个 engine 共存**,list 聚合,跑顺后删 docker 实现:

```
server/engine/
  types.ts    # Engine 接口:list / start / stop / restart / rename / remove /
              #          inspect / execRun / execFeed / execStream / status
  docker.ts   # 现 docker.ts 原样迁入
  lxc.ts      # lxc-ls/info + config 读写 + lxc-attach exec + script(1) PTY(复用 hostTerminal 方案)
  index.ts    # engine 选择/聚合
```

## 宿主一次性准备(已全部执行,2026-08-24)

1. ✅ `sudo apt install lxc uidmap lxcfs strace`(lxcfs 必装:提供 lxc.mount.hook)。
2. ✅ `~/.config/lxc/default.conf`:D1 的 idmap + D2 的 veth 网桥(br-f0cc7d98dca0)。
3. ✅ `/etc/lxc/lxc-usernet`(注意:是 lxc-usernet 不是 lxc-user-nic):`leon veth br-f0cc7d98dca0 20`。
4. ✅ `/etc/sysctl.d/60-mysandbox-lxc.conf`:`kernel.apparmor_restrict_unprivileged_userns = 0`(Ubuntu 23.10+ 默认拦 unprivileged userns,不放连 unshare 都失败)。
5. ~~cgroup2 委派~~ **P4 实测证明不需要**:`sudo mkdir /sys/fs/cgroup/lxc` + chown 那套(以及容器 config 里的 `lxc.cgroup.dir = lxc`)是「在裸 shell 里跑 lxc-start」逼出来的补丁。只要命令从 systemd user manager 环境发出(mysandbox 作为 user service 跑),容器 cgroup 自然落在已委派的 `user@1000.service/app.slice/...` 下,全程无需 sudo、重启不失效。**这条比原方案简单,且没有「重启后要重新 sudo 建目录」的坑。**
6. ✅ `sudo systemctl enable --now lxcfs`(重启后要活)。
7. ✅ 验证:`lxc-create -t download -- -d ubuntu -r noble -a amd64`(注意用 `noble`,不能用 `24.04`——索引里没有这个别名)→ systemd 完整开机 → `lxc-attach` 可用 → 静态 IP 10.88.0.50/24 + gw 10.88.0.1 → ping 通网关、DNS、**docker 容器 10.88.0.21(跨引擎同 LAN 互通验证成功)**。

### 关键运行约束(踩坑全录,写 engine 时必读)

- **LXC 命令必须在 systemd user manager 环境跑**。裸 shell(SSH/terminal session)落在 `session-<n>.scope`(root 属主)→ `lxc-start` 报 `cgroup.threads is not writable`、`lxc-attach` 报 `cgroup_attach_move_into_leaf: Permission denied`。**解法:mysandbox 必须以 systemd user service 形态运行**(`systemctl --user` + linger)。`engine/lxc.ts` 的 `status()` 显式校验 `XDG_RUNTIME_DIR` 并报这条,因为部署错了的表象是「容器建好了但秒退」,极难查。
- **P4 实测细分了「怎么发命令」**(设计阶段没料到,是本阶段最重要的发现):
  - `lxc-attach` **直接 spawn 即可**——子进程继承 mysandbox 服务的 cgroup,已在委派环境内。不需要 `systemd-run` 包装(每次 exec 包一层瞬态单元会慢且脏)。
  - `lxc-start` **必须放进独立瞬态单元**:`systemd-run --user --unit=mysandbox-<name> --collect --property=KillMode=mixed lxc-start -n <name> -F`。直接 spawn 的话容器进程挂在 mysandbox 自己的服务 cgroup 下,**mysandbox 一重启 systemd 就连带清杀所有容器**(实测:`systemd-run --wait` 包装下容器随包装单元退出而死)。放进 `mysandbox-<name>.service` 后容器与服务生命周期解耦。
  - `lxc-start` 默认前台阻塞(不是 daemon),所以是 `-F` + 单元常驻,不是 `-d`。
  - `systemd-run --user` 可以从 user service 内部再调(XDG_RUNTIME_DIR/DBUS 都在),嵌套无问题。
- **`lxc.apparmor.profile = unconfined` 必须写进容器 config**:Ubuntu 的 `lxc-container-default-cgns` profile 不允许 systemd 挂 cgroup2([lxc#4402](https://github.com/lxc/lxc/issues/4402),上游 2026-04 才修完 profile;unprivileged+userns 下交还内核管控,不牺牲安全)。
- 调试教训:systemd 在 strace/fork 下跑会走 telinit 分支报误导性错误(`Can't run system mode unless PID 1`);真实 PID 1 下失败是静默 exit 255,只有 dmesg 里的 AppArmor DENIED 与 `cgroup.threads not writable` 两条真线索。
- 容器内网络:静态 IP 由 `lxc.net.0.ipv4.address/gateway` 配置(LXC 启动时生效)。**静态 IP 无 DHCP → systemd-resolved 没有上游 DNS**,容器内域名全解析失败(apt 直接不可用)。模板必须写 `/etc/systemd/resolved.conf.d/mysandbox.conf`:`[Resolve]` + `DNS=10.88.0.1 114.114.114.114`(实测有效)。
- 已知无害噪音:`sys-kernel-config.mount`/`sys-kernel-debug.mount` failed(userns 下预期),`systemctl is-system-running` 显示 degraded 属正常。
- download 模板的 ubuntu noble 自带 `ubuntu` 用户占 uid 1000,模板契约要的是 `dev`:`usermod -l dev -d /home/dev -m ubuntu && groupmod -n dev ubuntu`。

## 开放验证点(PoC 已回答)

- ✅ ~~unprivileged 容器 bind mount `~/.ssh`~~ — 推迟到模板制作阶段验证(uid 直通已理论保证)。
- ✅ `lxc-attach` 可用(`--clear-env` + `--` 分隔参数;P4 起由 engine 直接 spawn)。
- ✅ systemd 完整开机(journald/udevd/resolved 全部起来了)。
- ✅ 静态 IP + 网关 + 与 docker 容器互通(同 br-f0cc7d98dca0 桥)。
- ✅ **宿主直读 home(D1 核心假设)**:容器内以 uid 1000 写的文件,宿主侧 `ls -l` 属主就是 `leon`,`cat` 无需 sudo。`files.ts` 的宿主直读方案成立,基座换成 `<lxcpath>/<name>/rootfs/home/dev`。
- ✅ **tmux 持久会话 + PTY**:`script(1)` 包 `lxc-attach` 给出真 pty,往返/resize(`stty -F` 落到子进程 pts)/`MYSANDBOX_WEB` 经 tmux 全局环境注入/detach 后会话存活 —— 与 docker 引擎语义一致。
- ✅ **克隆**:`lxc-copy` 冷克隆约 0.9s(dir 后端,rootfs 复制)。
  - **勘误**(P5 实测 diff 源/克隆 config):`lxc-copy` **已经**帮你改好 `lxc.rootfs.path` 与 `lxc.uts.name`,
    只有静态 IP(`lxc.net.0.ipv4.address`)会与源撞、需要 lifecycle 改写。本文档早前写「uts.name 也要手改」是错的。
  - ⚠️ **`lxc-copy` 对运行中的源静默失败**:exit 1 且 stderr **完全为空**(在 `systemd-run --user --pipe` 下
    复现,排除 cgroup 环境因素)。所以 `create()` 必须自己前置检查模板存在 + STOPPED,并给人话错误,
    否则用户只会看到「建容器失败,原因不明」。
- ⏳ ssh 挂载(`~/.ssh` 只读进容器)— 模板制作阶段。

## 波及面与阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 基线 | git init + 提交 | ✅ `18dd953` |
| P1 设计 | 本文档 | ✅ |
| P2 宿主 | 上面清单 + 模板 PoC | ✅ attach 进容器、systemd 真开机、跨引擎互通 |
| P3 engine | 接口抽取,docker 挂接口后 | ✅ `247c61f`+`P3` typecheck 绿、行为零变化(起服务实测 list/start/batch) |
| P4 lxc engine | `engine/lxc.ts` 全函数 + `cfg.engine` 切换 | ✅ 全方法对活容器实测(见 commit) |
| P5 业务层 | lifecycle/files/terminal/batch 适配 + `EngineCaps` | ✅ 端到端实测通过(见下「P5 实测结论」) |
| P6 模板层 | image.ts 收缩 + web 模板页 | clone/export/import |
| P7 收尾 | 全流程 + CLAUDE.md 更新 | 端到端 + 文档反映现实 |

### P5 待解决的具体点(P4 实测暴露)

- ✅ **克隆后改写 config**:只需改 IP(源 IP 会撞);`rootfs.path`/`uts.name` 由 `lxc-copy` 自己搞定。
- ✅ **`deleteData` 语义**:引入 `EngineCaps`(`server/engine/types.ts`)声明引擎能力,业务层与 web 判能力而非判引擎名。
  - `dataInsideContainer`:LXC 为 true。`deleteManaged` 据此把「输容器名确认」从「勾了删数据时」升级为**无条件**——
    数据反正会没,所以不给假选项,但也绝不静默删。docker 侧行为零变化。
  - `liveRename` / `portMappings`:LXC 均为 false。前者由 `rename` 抛 `conflict` 要求先停;后者 `createContainer` 直接拒绝,
    web 的端口映射输入框整块隐藏(固定 IP 直连,映射概念不存在)。
  - caps 经 `/api/health` 下发,前端存在 `web/src/lib/caps.ts` 单例(默认取 docker 语义,health 未回来时按老行为渲染)。
- 模板契约的两个固定步骤(P4 手工验证过,P6 写进模板制作脚本):`usermod -l dev` 改 uid 1000 用户名;写 `resolved.conf.d/mysandbox.conf` 配 DNS。

### P5 实测结论

engine: lxc 下走真 HTTP API 全流程验证(模板 `ms-template`,容器 `lx1`/`lxnet`):

- ✅ **建容器** ~8s(克隆 2.8G rootfs + 起 systemd + seed)。IP 自动分配 10.88.0.22、hostname 正确、`managed=true`。
- ✅ **home seed**:`.zshrc`/`.gitconfig`/`.ssh`(从只读挂载拷)/`.claude*` 全部到位;`~/.local/bin/mysandbox` 已种。
- ✅ **宿主直读 home**(D1):`<lxcpath>/lx1/rootfs/home/dev` 属主 `leon`,无 sudo 可读写。
- ✅ **文件面板** 列目录/读/写(含中文内容往返)、`/api/containers/:id/cwd` 跟随 tmux pane。
- ✅ **终端** WS:tmux 会话 `ms-lx1-<termId>`、zsh 以 dev 跑、状态栏/ANSI/prompt 正常。
- ✅ **批量** exec/git/hosts-apply;hosts 事件订阅(lxc-monitor)在容器 start 后自动重刷。
- ✅ **caps 守卫**:运行中改名 → 409;删除缺/错 `confirmName` → 400;正确则 `dataRemoved:true`、rootfs 与 sidecar 一起清干净、无残留 systemd unit。
- ✅ **跨引擎互通**(D2):LXC↔docker 容器双向 TCP 通、宿主可达 LXC、LXC 出外网 + DNS 正常。
- ✅ **docker 引擎零回归**:同一份代码切回 `engine: docker`,列表/exec/文件面板/IP 池照旧。
- ⚠️ **IP 池必须合并两引擎**:共用网桥,`network.ts assignedIps` 改为同时查 docker network 与各 LXC config,否则过渡期撞 IP。

踩坑(已修,细节在代码注释):
- `parseUser` 只做 `Number()` → `'root'` 变 NaN 落回 1000,「以 root 写 /etc/hosts」静默变 dev 身份 → Permission denied。`lxc-attach -u/-g` 只吃数字,必须自己映射名字。
- LXC 没有 entrypoint 钩子(PID 1 是发行版 systemd),首启 seed 改由 `create()` attach 进去跑一次 `seedHome()`。
- 模板脚本给容器喂脚本必须走 stdin(`bash -s`):`systemd-run` 会先展开 `${VAR}`,把脚本里的 `${ARCH}` 吃空 → node 下载 404。
- `~/.ssh` 只读挂载在 unprivileged LXC 下可用:`lxc.mount.entry = <src> mnt/host/.ssh none bind,ro,create=dir 0 0`(挂载点相对 rootfs)。

## 回退

git 基线在手;P3 是零行为变化重构,P2–P6 任何一步不满意 `git checkout` 回 docker 形态。dener 全家不迁移,直到 LXC 路径跑顺。
