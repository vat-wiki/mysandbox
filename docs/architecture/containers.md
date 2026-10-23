# 系统容器：基座、容器契约与 LXC 运行约束

设计与实测记录在 [`docs/migrations/lxc-migration.md`](../migrations/lxc-migration.md)——碰引擎相关的东西先读它。unprivileged LXC、unprivileged WSL2 两引擎共用 `Engine` 抽象（见 [overview.md](overview.md)）。

## 基座（base）——「新容器从哪儿来」

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

## 容器契约

容器内契约：uid:gid `1000:1000`（用户名 `dev`，home `/home/dev`）、zsh/git/tmux/node/AI CLI 就位、
sshd 就位（`/etc/ssh/sshd_config.d/mysandbox.conf`：密钥只进 + `/mnt/host/.ssh/authorized_keys` 作第二授权源；host key 由 create() 逐容器重生成；宿主 `~/.ssh/config.d/mysandbox` 有 `sb-<容器名>` 别名，`server/sshConfigSync.ts` 在 create/delete/adopt/rename 时同步——VS Code Remote-SSH 即开即连）、
`/etc/skel-home/.zshrc` 作首启模板、宿主 `~/.ssh` 只读可见于 `/mnt/host/.ssh`、
`/etc/systemd/resolved.conf.d/mysandbox.conf` 配上游 DNS（静态 IP 无 DHCP）、
`fontconfig` + `fonts-noto-cjk` 中文字体（桌面/容器内 GUI 渲染中文；fc-list 必须在——只装字体包不装 fontconfig 工具，zh 查询恒 0）、
全局技能目录是两处独立实体副本（**无软链**）：`~/.agents/skills`（canonical，规则锚它）+ `~/.claude/skills`（孪生跟铺，内容由 skillSync 保持一致，各记一份清单）；分发遇软链落点跳过防穿透。

- 容器来源：模板容器 + `lxc-copy` 克隆（`scripts/lxc-template.sh` 制作）。
- PID 1：发行版自己的 systemd（真系统容器）。
- home：在 rootfs 内 `<lxcpath>/<name>/rootfs/home/dev`（宿主可直读直写——D1 uid 直通）。
- 首启 seed：引擎 `create()` 里 attach 进去跑一次 `seedHome()`（**缺才写**——用户改过的 `~/.zshrc`、`~/.gitconfig` 绝不覆盖）。
- 模板不存在/未 STOPPED → 明确报错（`lxc-copy` 对运行中的源**静默失败**，exit 1 无输出）。

## EngineCaps——引擎差异的唯一出口

`EngineCaps`（`engine/types.ts`）是引擎差异的唯一出口，业务层与 web 都判它：

- `dataInsideContainer`（true）：home 在 rootfs 内 → 删容器必连数据一起删，`deleteManaged` 无条件要求「输容器名确认」；`DeleteContainerDialog.vue` 是说明文案而非留不住数据的假选项。
- `liveRename`（false）：改名前必须先停容器，`rename` 抛 `conflict`。
- `portMappings`（false）：固定 IP 直连，`CreateDialog.vue` 无端口映射块。
- `baseKind`（`template`）+ `baseActions`：见上「基座」。

caps 经 `/api/health` 下发，前端存在 `web/src/lib/caps.ts` 单例（默认值取 LXC 语义）。**引擎差异想表达时先在这里加一项 cap**，别在业务层撒 if。

## LXC 引擎的运行环境约束（`engine/lxc.ts` 文件头有详版）

- mysandbox **必须以 systemd user service 形态跑**（cgroup 委派）。`lxc-attach` 可直接 spawn（继承 cgroup），但 `lxc-start` 必须进独立瞬态单元（`systemd-run --user --unit=mysandbox-<name> ... lxc-start -n <name> -F`），否则重启 mysandbox 会连带杀掉所有容器。
- LXC veth 挂在 **mysandbox 自有网桥 `mysandbox0`** 上（`cfg.network` 直接配桥设备名；桥由系统 unit `mysandbox-net.service` 建：桥 + 网关副 IP `<ipPool 前缀>.1` + 网段出网 MASQUERADE，**不依赖 docker**）。容器网段 10.88.10.0/24 与 docker 服务网段 10.88.0.0/24 分桥、经宿主路由互通。防火墙放行**全部自管**，别手敲 ufw：FORWARD 层三处——`mysandbox-docker-interop.service` 的 raw 表 ACCEPT（**docker 29 会在每次服务容器 start 时重写 `-t raw -A -d <服务IP> ! -i <桥> DROP` 隔离规则，删了会回来，必须 -I 1 恒压其上**）、同 unit 的 DOCKER-USER 链 ACCEPT、ufw before.rules 的 `-i mysandbox0 ACCEPT`（ufw 默认 routed deny；`mysandbox-firewall.service` 会补一条等价的 `ufw route allow in on mysandbox0`，before.rules 那条留着无害）；INPUT 层（容器 → 宿主服务）由 `mysandbox-firewall.service`（`scripts/mysandbox-firewall.sh` + `server/firewall.ts` 的 `mysandbox firewall print`）按 config 计算应用——信任模型：自管网段（LXC/services）各一条全端口 blanket（DNS 53/dockerApi 2375/peer 7331/console 7321、宿主其余自有端口都 ride 在其上），幂等、只增不删，外部网段特例（热点等）配 `firewall.allow`（port 缺省=全端口），config 变更后 `sudo systemctl restart mysandbox-firewall`。ufw status 有坑：**裸 `ufw status` 的 INPUT 行是 `ALLOW` 单列没有 `IN`**（verbose/numbered 才有），按行解析判定已存在规则时要用 verbose。`/etc/lxc/lxc-usernet` 按桥名放行 `leon veth mysandbox0`。历史：2026-09 前挂在 docker 的 dev-lan 桥（br-<hash>）上，见 [`docs/migrations/lxc-migration.md`](../migrations/lxc-migration.md) 补记。
- 静态 IP 无 DHCP → 容器内 systemd-resolved 没有上游 DNS，模板必须写 `/etc/systemd/resolved.conf.d/mysandbox.conf`（模板脚本已做）。
- `lxc-attach -u/-g` **只吃数字**，而调用方传的 User 混着名字（`'root'`/`'root:root'`/`'1000:1000'`）——`parseUser` 负责映射，改它时小心：早前 `Number('root')` → NaN 落回 1000，导致「以 root 写 /etc/hosts」静默变成 dev 身份、Permission denied。
- `scripts/lxc-template.sh` 里给容器喂脚本必须走 **stdin**（`bash -s`）而非 `bash -c "<脚本>"`：systemd-run 会先展开自己的 `${VAR}` 规格符，把脚本里的 `${ARCH}` 吃成空串。
- **liblxc 不认 XDG 变量**：lxcpath 与 default.conf 路径在 liblxc 里硬编码成 `$HOME/.local/share/lxc` / `$HOME/.config/lxc`。所以 `lxcPath()` 与 `readDefaultConf()` 用 `homedir()`，**不能**用 `xdgDataHome()`/`xdgConfigHome()`——设了 XDG_* 的环境下会与 `lxc-*` 命令看的路径分叉（我们说容器不存在，`lxc-ls` 说存在）。
- `start` 对已在跑的容器必须幂等（`create()` 已经把容器起来了）：撞同名瞬态单元会报 `already loaded`，把「本来就好着」变成 500。
- **克隆必须重新随机化网络身份**：`lxc-copy` 连 `/etc/machine-id` 一起拷，而容器内 udev 的 `MACAddressPolicy=persistent` 按 machine-id 哈希 MAC → 不处理的话所有容器同 MAC，同桥 fdb 摆动、容器间 ARP 永远达不成（宿主→容器却正常，极具迷惑性）。`create()` 里两步固化：config 写死随机 `lxc.net.0.hwaddr` + `lxc-usernsexec` truncate rootfs 的 machine-id（systemd 首启重生）。改 create 的网络段落时别把这两步弄丢。
