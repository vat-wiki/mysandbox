# WSL2 引擎迁移设计（LXC → Windows）

> 状态：**设计已定，实现完成度见文末「阶段」；标注「实测」的结论才可信，其余是待验证假设。**
> 动机：让整套 mysandbox 方案能在 Windows 上运行。Linux 上没有 LXC 对等物（Windows
> 自带容器是应用容器不是系统容器），WSL2 是唯一「带真 systemd 的 Linux 环境 + 宿主直读
> rootfs + 一模板多实例」三者全占的形态，且与现有 engine 抽象的映射几乎一一对应。
> 用户有可达的 Windows 机器用于实测（2026-09-20 确认）。

## 动机

- mysandbox 后端跑 Windows 原生 node，容器 = WSL2 发行版实例；docker 服务层沿用
  Docker Desktop（本线之外）。
- engine 抽象（`server/engine/types.ts`）当初就是为「第二引擎」设计的——差异经
  `EngineCaps` 出口，业务层不撒 if。本轮验证这个设计是否成立。

## 选型结论（已定）

**WSL2 发行版实例作为系统容器**，不选的：
- Incus/LXD 装在 WSL VM 里：语义保真但嵌套 VM，丢掉「宿主直读 rootfs」一半巧劲。
- Multipass / 轻量 Hyper-V：每实例完整 VM，attach/速度/文件直通全面劣于 WSL2。
- Windows 自带容器（windows container）：无 Linux 用户态，不成立。

## 关键设计决策

### D1 容器 = WSL2 发行版实例（已定，待实测）

`wsl --import <名> <installDir> <tarball>` 落地，一模板多实例。installDir 统一收在
`~/.mysandbox/wsl/<名>/`（单根哲学的 Windows 落点，与 config/state/logs 同根；
ext4.vhdx 就在这个目录下）。`wsl --unregister` = 删容器连数据（对应 D4 dataInside）。

- 模板克隆：优先 `--export/--import --vhd`（块拷贝，秒级），feature-detect（`wsl --help`
  含 `--vhd`）；降级 tar 全量导出导入（分钟级）。**export/import 的 `--vhd` 旗标位置
  待实测**（MS 文档给的是尾部 `[--vhd]`）。
- 导出/导入前 `wsl --terminate` 源（WSL 对 running 源 export 不像 lxc-copy 那样静默
  失败，但停了再导一致性有保障；terminate 代价低——9P 访问会自动再拉起）。
- 名字校验沿用 LXC 的 `NAME_RE`（比 wsl 自身约束严，换引擎不放宽——路径拼接与跨引擎
  口径一致）。

### D2 管理判定 = 安装簿 mysandbox.json（已定，取代 LXC config 标记行）

LXC 用容器 config 里的 `MYSANDBOX_MANAGED` 行；WSL2 发行版没有「config 文件」可写。
**不往 rootfs 里放标记文件**——`\\wsl.localhost` 读取会自动启动发行版，扫描/查重/IP 池
这种高频路径不能有「看一眼就把停机容器拉起来」的副作用。

判定 = installDir 内的纯文件 `<installDir>/mysandbox.json`（managed/assignedIp/createdAt/
source）。优点：普通文件、0 fork、不引导发行版、与 LXC sidecar 同哲学。缺点：随发行版
export 不走（tar 只含 rootfs）——与 LXC 侧 sidecar 元数据（state.json 按名记）同级别的
限制，接受。

### D3 home 直通 = `\\wsl.localhost\<名>\`（已定，待实测 9P 权限映射）

Windows 侧 node fs 经 UNC 路径直读直写发行版 rootfs：rootfsPath = `\\wsl.localhost\<名>`、
hostHomePath = `\\wsl.localhost\<名>\home\dev`。skillSync/aiconfig 的「宿主直写容器 home」
整条路线**零改动**成立（9P 把 Windows 用户映射到发行版默认用户）。

已知坑（待实测钉死）：
- `\\wsl.localhost` 访问会**自动启动**已停发行版（readTemplateHosts 的基座 hosts 预览
  因此接受引导副作用；高频路径一律走安装簿，见 D2）。
- 文件创建的属主映射、POSIX 权限位、混合分隔符路径（业务层拼 `rootfs + '/etc/hosts'`）
  在 Windows fs API 下的行为。
- 非 Windows 平台（Linux 开发机）rootfsPath/hostHomePath 返回 null，调用方已有降级。

### D4 数据模型（已定）

同 LXC：home 在发行版 rootfs 内，`wsl --unregister` 连数据一起删，`deleteManaged` 的
「输名确认」语义不变（`dataInsideContainer: true`）。

### D5 网络：IP 权威 = 运行时，记账 IP = 安装簿（已定，与 LXC 的最大分歧）

- `caps.ipAuthority: 'runtime'`（LXC 是 `'config'`）：WSL2 NAT 网段动态、每实例 IP
  随 VM 重启漂移，**没有静态 IP 可配**。
- `CreateSpec.ip` 降级为「记账 IP」：create 时写进安装簿 mysandbox.json，IP 池
  （network.ts allocate）继续按它去重，UI/hosts 记账不断。
- 运行中的容器读真实 IP（`wsl -d <名> --exec hostname -I`，每次 inspect 现查）；
  停机的显示记账 IP（与 LXC「停机显示 config 静态 IP」同一 UX）。
- hosts 服务块照写（容器内 /etc/hosts 是真文件），**但 docker 服务的可达性归 Docker
  Desktop 移植线**（服务发布端口经 localhost/网关，容器内 10.88.0.x 直连在 Windows
  不成立）——不在本线解决。
- gatewayOf / cfg.network（桥设备名）对 wsl2 无意义，消费方经 engine/caps 分流。

### D6 PTY = ConPTY（node-pty）（已定，待实测）

`wsl.exe` 管道模式下 Linux 侧拿不到 tty，tmux 起不来。execStream 用 node-pty 的
ConPTY spawn `wsl.exe -d <名> -u <user> --exec …`，resize 走 `pty.resize`（不再需要
script(1)/stty 那套）。node-pty 放 optionalDependencies + createRequire 懒加载——
没装时终端报人话错误，其余功能不受牵连；Linux 上它走 forkpty，mock 测试也能用。

### D7 wsl.exe 管理命令输出是 UTF-16LE（已知坑，待实测确认版本差异）

`wsl --list/--version` 等管理命令输出 UTF-16LE（有时带 BOM 有时不带）；`--exec` 透传的
Linux 进程输出是原样字节。解码器：BOM `FF FE` → utf16le；无 BOM 但偶数位大量 `\0`
→ utf16le；否则 utf8。行尾 `\r` 一律剥。

### D8 生命周期（已定）

- start：`wsl -d <名> --exec true`（阻塞到发行版起来），幂等（已在 running 直接返回，
  对齐 LXC start 幂等约定）。无 systemd-run 等价物——发行版 VM 生命周期归 WSL 服务管，
  mysandbox 重启不牵连（比 LXC 少一整层约束）。
- stop：`wsl --terminate`；幂等。
- rename：无原语 → export→import 新名→unregister 旧名，liveRename=false 必须先停。
- 事件：无 monitor 原语 → 5s 轮询 `--list --running` diff 出 start/stop
  （LXC 侧是 lxc-monitor 行流；订阅方按 action 过滤的接口不变）。

### D9 exec 形态（已定，待实测）

- execRun/execFeed/execSpawn：`wsl.exe -d <名> -u <user> --exec env HOME=… LANG=… …
  /bin/sh -c 'cd … || cd /; exec "$@"' sh <Cmd…>`。`--exec` 不经默认 shell（argv 直传，
  注入面与 lxc-attach 同级）；cwd 兜底与 LXC 同款 sh 包装。
- User 映射：调用方传的是 LXC 口径（'root'/'root:root'/'1000:1000'/缺省）。映射
  root/0→root、dev/1000→dev、纯数字原样传、未知落 dev。gid 无对应旗标（跟随 user），
  丢弃——现有调用方 gid 均与 uid 配套。
- execSpawn 二进制直通（tar 下载）：管道模式下 wsl.exe 对 Linux 进程 stdout 应为
  原样字节，**待实测**（若 CRLF 改写则下载路由全体退化，这是必须钉死的点）。

### D10 基座（已定，待实测）

baseKind 'template'、baseActions 同四件，语义对齐：

- create/import：`wsl --import ms-template <installDir> <tarball|vhdx>`——喂现成的
  WSL 发行版包（Ubuntu cloud-images rootfs tar / `wsl --export` 产物）。
  **Windows 版模板制作脚本（装 zsh/node/claude/omz 全家桶）未写**，是本轮之外最大的
  后续工程；在此之前 base create 只能落「裸发行版 + seed」。
- clone：export 模板 → import 新容器（vhd 优先）。
- export：`wsl --export` → `.tar`/`.vhdx`（LXC 是 tar.zst；归档格式分引擎，扩展名
  即口径）。
- ready 语义：LXC「必须 STOPPED」（lxc-copy 静默失败）；WSL2 我们自动 terminate 后
  导，**ready = exists**，notReady 不再需要。

### D11 基座名/模板名的引擎化（已定）

`cfg.lxc.template` 被业务层直接消费（hosts-sync dropTemplate、lifecycle source 记账、
aiconfig allTargets、status 模板段）——加 `Engine.baseName(cfg)`（lxc→cfg.lxc.template、
wsl2→cfg.wsl.template），四处全部改走它。config 加 `engine`（lxc|wsl2）与 `wsl.template`
两键。`cfg.network`/gatewayOf 对 wsl2 保留但不消费。

## engine 接口变化

- `Engine.name: 'lxc' | 'wsl2'`。
- `EngineCaps` + `ipAuthority: 'config' | 'runtime'`（前端 caps.ts/api.ts 同步加类型，
  DEFAULTS 取 'config'）。
- Engine + `baseSize(cfg)`（base.ts 的 /api/base/size 从动态 import lxc 实现改走接口；
  wsl2 = stat 模板 ext4.vhdx）+ `baseName(cfg)`。
- 新增 `server/engine/wsl2.ts`；`getEngine(cfg)` 按 `cfg.engine` 分流。
- 顺手修三处「绕过 engine/index 单入口」违例：status.ts（模板段）、base.ts（size）、
  network.ts（assignedIps 走 getEngine）。

## 测试策略

- 本机（Linux）：`scripts/mock-wsl.mjs` 模拟 wsl.exe 的 CLI 面（--list/--import/
  --export/--terminate/--unregister/-d --exec，输出按 UTF-16LE 编码以校验 D7 解码器），
  `MYSANDBOX_WSL_BIN` 指向它即可在 Linux 上跑通 wsl2 引擎的编排/解析/幂等逻辑。
  此环境只能验证**我们自己写的代码**，WSL 真实行为全是假设。
- Windows 实测（用户有可达机器），清单见下节。

## 开放验证点（Windows 实测清单）

1. `--vhd` 旗标位置与版本要求（export/import 两种）；无 --vhd 的降级路径。
2. `wsl --import` 对 installDir 的要求（需已存在？空目录？）。
3. 9P：混合分隔符路径、创建文件属主/权限位映射、`\\wsl.localhost` 自动启动行为与时机。
4. `--exec` argv 直传完整性（路径含空格/引号）；`-u` 对纯数字 uid 的接受度。
5. execSpawn 管道 stdout 是否字节直通（tar 下载）——D9 必须钉死的点。
6. ConPTY：tmux attach、OSC 透传（OSC 7/7677 深链依赖）、resize 链路。
7. UTF-16 解码：本机 wsl.exe 实际输出有无 BOM、`--list` 在零发行版时的退出码与输出。
8. Windows 版模板制作脚本（P1 后续工程）。
9. docker 服务层/peer/dockerApi/防火墙（ufw→netsh）——独立移植线，见下。

## 波及面与阶段

- P1（本轮）：engine/wsl2.ts 全量实现 + config engine/wsl 两键 + getEngine 分流 +
  baseName/baseSize/ipAuthority 接口化 + 三处单入口违例修复 + 前端 caps/engine 类型 +
  mock-wsl 冒烟。LXC 路径行为零变化（回归验证：Linux 上 typecheck/build + 起服务走通
  容器生命周期）。
- P2（待 Windows 实测）：上节 1–7 逐条钉死，错了回写本文档。
- P3（后续工程）：Windows 模板制作脚本；docker 服务层（Docker Desktop）、peer、
  dockerApi、防火墙/netsh、desktop 栈（WSLg vs noVNC）的移植评估。
- 回退：`engine: lxc` 即回 LXC，wsl2 代码不装载（getEngine 分流）。

## 补记

- 2026-09-20 初版设计 + P1 实现。
