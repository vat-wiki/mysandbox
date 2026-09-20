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
- Windows 实测（用户有可达机器），清单见下节。两个常驻脚本（Windows 上跑，前置
  `npm run build:server`）：
  - `scripts/wsl2-windows-probe.mjs` —— 真实 `wsl.exe` 输出探针（`--version` / `--help` /
    `--list` 三态），打原始字节 + `decodeWsl` 结果，用来盯 D7 与 #1，输出落同目录 `*.log`。
  - `scripts/wsl2-lifecycle-probe.mjs <base-tarball>` —— 端到端跑引擎 API（基座导入 →
    克隆建容器（顺带判 vhd 快慢路径）→ 列表/inspect → execRun argv 直传 → 9P 读写 →
    `execSpawn` 字节直通 → `execStream` PTY → start/stop 幂等 → 删除 + IP 记账回收），
    逐条对照本节清单，末尾打印 PASS/FAIL 汇总。

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
- 2026-09-20 Windows 实测首轮（**未走完**，实机为用户的 Windows 机器）。已确认 / 已修的：

  - **机器状态（不依赖 wsl.exe 的探测）**：WSL 已装且可用形态正常——`C:\Windows\System32\wsl.exe`
    与 `C:\Program Files\WSL\` 都在，`HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`
    存在、`DefaultVersion=2`、`~/.wslconfig` 有 `[wsl2]` 段。但**已注册发行版数 = 0**
    （Lxss 子键 0 个）——即这台机器**连模板都还没有**，实测清单 1–7 在导入一个基座包之前
    无从谈起（D10 的「base create 只能落裸发行版 + seed」正是这条路径）。
  - **HEAD 本身编译不过（已加占位解开）**：`server/hosts-sync.ts:20` 引用
    `./cluster.js`，而 `server/cluster.ts` 从未进入任何提交（`git log --all -- server/cluster.ts`
    为空）。提交信息自己写了「工作树里 cluster/wireguard 线的在途改动未动未提交」——选择性
    暂存把 hosts-sync 的这一处 import 带进了 WSL2 这笔提交，落库的却是断链。干净 clone 该提交
    `tsc` 必报 TS2307。已补 `server/cluster.ts`（占位：`peerServiceEndpoints` 返空数组，
    语义 = 无集群 → 无 peer 服务行，与调用点的 try/catch 降级一致）；集群线落地时用真实
    实现整体替换即可，调用点零改动。**这条与 WSL2 无关，是提交纪律问题，值得单独复盘。**
  - **D7 的错误归因缺陷（已修，本次实测的最大收获）**：`runWsl` 的 catch 写的是
    `err.stderr ? decodeWsl(err.stderr) : err.message`——但 spawn 失败（ENOENT/EINVAL/EPERM）
    时 `err.stderr` 是**存在的空 Buffer**，truthy，于是永远选中空串，真正的失败原因
    （`spawn wsl.exe EPERM` 之类）被整条吞掉；`status()` 再把「没拿到任何东西」固定成一句
    `wsl.exe not found or WSL not installed`。实测用两个替身固化验证：不存在的 bin →
    `wsl.exe not usable (ENOENT)`，被安全策略拦的 bin → `wsl.exe not usable (EPERM)`。
    `status()` 刻意只回**类别**不回原始文本——它经 `/api/health` 免鉴权下发，原始 spawn
    错误含完整可执行路径，撞 CLAUDE.md 的 health 约束。
  - **未验证项（本轮的真实阻塞）**：本机 `wsl.exe` 的 spawn 被程序黑名单拦截（EPERM，
    与 `reg.exe` 同一机制同一类别），因此 `status / listManaged / inspect / create /
    base*` 全部未能实测；`cli.ts` 的启动前 `engine.status()` 检查一票否决，**服务直接
    exit 1、UI 起不来**——这条链本身是对的（引擎不可达就别起），但意味着「engine: wsl2
    但 wsl.exe 不可用」时 mysandbox 完全不可用，没有降级形态。
  - **mock 测试策略的隐含前提**：`MYSANDBOX_WSL_BIN=scripts/mock-wsl.mjs` 在 **Windows 上
    用不了**——node 的 spawn 不执行 `.mjs`（无 shebang 解释，Windows 不认），`.cmd` 垫片在
    Node ≥20 直接 `EINVAL`（隐式 cmd 包装已被移除）。mock 只在 Linux 有效。本节「测试策略」
    原文就是这么界定的，这里显式记一笔，免得下次在 Windows 上白试一遍。
  - **Windows 侧纯逻辑已验通过（不依赖 wsl.exe 调用）**：`caps.ipAuthority='runtime'`；
    `baseName(cfg)===cfg.wsl.template`；`rootfsPath`/`hostHomePath` 出
    `\\wsl.localhost\<名>` / `…\home\dev`（D3 的 UNC 分支在 win32 下成立）；`decodeWsl`
    三分支正确（带 BOM utf16le、无 BOM 零字节启发、utf8 直通）；`assertName` 拒绝脏名
    （空格 / `../` / 非 ASCII / 空串）；`assignedIps` 对空安装簿返空集；`node-pty` 可解析
    （D6 的 ConPTY 终端前提具备）。
  - **服务本体在 Windows 上立得住（本轮唯一的完整通过项）**：绕开 `cli.ts` 的引擎前置门，
    用**真实 config（`engine: wsl2`）**直接 `buildServer(cfg)` + `listen` —— 前端产物
    （`/` 回 `web/dist/index.html`）、`/favicon.svg`、鉴权 hook（无 token 401 / 有 token 200）、
    `/api/ssh/targets`、`/api/terminal-activity` 全部正常；docker 缺失只落一条 warn
    （`docker ps failed: no output`）不致命。即「Windows 上跑整套方案」的**非引擎部分已通**。
  - 附注：`buildServer` 自己会经代理白名单预热 / 活动轮询摸到引擎（实测该路径也 spawn 了
    wsl.exe，被拦后**优雅降级、不影响启动**）——所以引擎不可达时 `cli.ts` 的前置门不是唯一
    接触点，但除了那道门以外都能降级。
  - **黑名单无法用「沙箱提权」绕**：已实测在无沙箱隔离下执行仍是同一句
    `PROGRAM BLOCKED BY SECURITY POLICY`——它是独立于沙箱的**程序黑名单**，只能在
    安全中心 → 命令安全 → 程序黑名单 里移除，命令层无解。
  - 下一轮要从这里继续：先把 `wsl.exe` 从安全策略的程序黑名单放行，再喂一个基座包
    （`wsl --import ms-template <installDir> <rootfs.tar>` 等价路径 = `POST /api/base/create`
    带 `path`），然后才谈得上逐条钉死清单 1–7。

- 2026-09-20 Windows 实测第二轮（**走通了**；首轮的两个阻塞——`wsl.exe` 被程序黑名单拦、
  没有发行版——都已解除）。实机环境：WSL **2.3.11.0**、内核 6.6.36.3-1、
  Windows 10.0.26100.8875；基座用 **Alpine minirootfs 3.20.3**（3.4MB 包）导入，
  容器契约要求的 `dev`(uid 1000) 手工补建（Windows 版模板脚本仍是缺的，见 #8）。
  验证方式：直接调 `engine/index.js` 的引擎 API 跑全流程（脚本 `scripts/wsl2-lifecycle-probe.mjs`，
  Windows 侧 CLI 输出探针是 `scripts/wsl2-windows-probe.mjs`），**ALL PASS**。逐条落实「开放验证点」：

  - **#7 UTF-16 解码（已修，首轮猜错的那条）**：管理命令输出**一律不带 BOM**（首轮 mock
    总带 BOM，与真实不符）。原来的「前 256 字节内奇数位零 > 1/4」启发式在**短且全 CJK**
    的输出上失配——实测 `--list --running` 零发行版时输出「没有正在运行的分发。\r\n」
    共 24 字节、奇数位只有 2 个零，判据不成立 → 被当 UTF-8 解成乱码。已改为
    **奇偶零字节对比**（UTF-16LE 的 NUL 只落奇数位；`hostname -I` 那种纯 ASCII 进程输出
    两边都 0 → 走 UTF-8），实测三个分支全部正确。
  - **零发行版形态（原文猜错，已改注释）**：`--list --quiet` = **exit 0 + 空输出**（无提示语）；
    带中文提示语且 **exit -1** 的是 `--verbose` / `--running`（这两个函数只读 stdout、忽略
    ok，无碍）。原注释「零发行版时 exit 非零并输出提示语」对 `--quiet` 不成立。
  - **#1 `--vhd` 探测（已修，严重）**：`wsl --help` 的退出码是 **-1**（实测 4294967295），
    而 `runWsl` 走 execFile → 非零退出即 reject → `ok=false`。原写法 `vhdCache = r.ok && …`
    让 **`--vhd` 恒被判不支持**，模板克隆永远退化成 tar 全量导出。已改为只看输出文本
    （连输出都没有才当不可用，且不缓存）。
  - **★ 新发现的硬约束（D1 需要修正表述）**：`wsl --export --vhd` **要求 WSL2 轻量 VM 处于
    停止状态**。只要 VM 还在跑（任一发行版启动后它会存活一段时间，而 `--terminate <发行版>`
    只停发行版、不停 VM），`ext4.vhdx` 被 VM 持有，导出报
    **`Wsl/Service/ERROR_SHARING_VIOLATION`**（实测 rc=127、stderr 为空，所以早期实现还会
    把它显示成 "unknown error"）。`wsl --shutdown` 之后同一命令立刻成功（68MB vhdx）。
    而 tar 导出在 VM 运行时可用。因此：**vhd 只是「VM 正好冷着」时的加速，不是默认路径**，
    已把 `cloneDistro` / `base export` 都改成「vhd 失败即降级 tar」（实测两条路都跑通；
    显式给了 `.vhdx` 路径时不偷偷换格式，直接把真因抛出去）。刻意**不**用 `wsl --shutdown`
    清场——那是全 VM 级操作，会把用户正在跑的所有发行版一起杀掉，违背 D8 的边界。
    → 「秒级块拷贝 vs 分钟级 tar」这句要改成「vhd 命中时秒级；命中不了走 tar」。
  - **#2 `--import` 对 installDir 的要求**：先 `mkdir` 是必要的（引擎已做）。实测导入
    Alpine minirootfs（3.4MB tar.gz）数秒完成，落地 68MB `ext4.vhdx`。
  - **#3 9P（实测通过，但有一个真问题）**：`\\wsl.localhost\<名>` 读写**字节一致** ✓，
    `rootfsPath`/`hostHomePath` 形态正确 ✓。**但宿主侧（Windows）创建的文件在容器内是
    `root:root 644`**——不是 D3 说的「映射到发行版默认用户」，而是映射到 **root**
    （`wsl --import` 出来的发行版默认用户就是 root）。这对容器契约是实打实的问题：
    经 UNC 落进 `/home/dev` 的文件属主是 root，`dev` 改不动 → **skillSync / aiconfig 的
    「宿主直写 rootfs」整条路线在 wsl2 上会产出 root 属主文件**（LXC 上 D1 的 uid 直通
    让属主天然正确，wsl2 没有这个保证）。待解：模板里用 `/etc/wsl.conf` 的 `[user] default=dev`
    统一默认用户，或这些写入路径改走 `execRun`。**这是 wsl2 与 LXC 的一个新的语义分歧。**
  - **#4 `--exec` argv 直传**：通过。含空格、双引号、单引号的混合参数（`a b` / `c"d` / `e'f`）
    原样到达 ✓；`User` 映射（缺省→dev、`root`→root、纯数字原样）✓；`WorkingDir` 生效 ✓。
  - **#5 `execSpawn` 管道 stdout 字节直通（「必须钉死」的点）**：**通过**。构造含
    `0x00 / 0x0d / 0x0a / 0x0d0a / 0xff / 0xfe / 0x7f` 的 12 字节文件，`cat` 出来
    **逐字节一致，没有被 CRLF 改写也没有编码破坏** → tar 下载 / 二进制传输路线成立。
  - **#6 PTY（ConPTY）**：通过。node-pty 的 `execStream` 拿到输出，且 **OSC 序列原样透传**
    （流里出现 `ESC ] 0 ; C:\WINDOWS\SYSTEM32\wsl.exe BEL`）——深链/标题链路依赖的
    OSC 透传前提成立。**顺带实证了「不能复用 PTY 传二进制」的设计理由**：PTY 把 `\n`
    改写成了 `\r\n`（`PTY-OK\r\n`），所以 `execSpawn` 走独立管道是必须的，不是洁癖。
  - **PTY 的一个 Windows 坑（新记）**：node-pty 的 `conpty_console_list_agent` 在
    **没有可附加控制台**的上下文里（非交互 shell 启动的 node 进程）会
    `Error: AttachConsole failed` 抛栈并退出——它在 `kill()` 时被 spawn 出来做进程树枚举，
    所以受影响的是「终端关闭时的进程树清理」。实测该子进程崩溃**没有**带崩宿主，
    其余断言照常通过；但清理可靠性待观察（从用户自己的交互终端启动时应无此问题）。
  - **D5 取运行 IP：两条命令 + 一个 WSL 的 PATH 陷阱（已修）**。原实现只有
    `hostname -I` 一条，而 BusyBox 的 hostname **不认 `-I`**（实测 Alpine：
    `unrecognized option: I`）→ 精简发行版上运行中容器 `ip` 恒为 null。已改成两层：
    ① `hostname -I`（GNU/inetutils，标准发行版）→ ② `ip -4 -o addr show scope global`
    （busybox / iproute2 都有）。实测 Alpine 上取到 `172.29.240.144` ✓。三处必须记住：
    - **两条都要经 `sh -c` 跑，不能直调命令**：**`wsl --exec <cmd>` 对首个参数不做完整
      PATH 查找**——实测 `/bin`、`/usr/bin` 下的（sh / hostname / env）能找到，
      `/sbin`、`/usr/sbin` 下的（**ip / ifconfig**）直接
      `WSL ERROR: CreateProcessCommon:500: execvpe(ip) failed: No such file or directory`，
      哪怕 PATH 变量里明明有 `/sbin`（`--exec env` 打印可见）、shell 内 `command -v ip`
      也能解析。经 shell 则用 shell 自己的 PATH，正常。（引擎主执行路径不受影响——它本来
      就走 `/bin/sh -c 'exec "$@"'`；只有 `distroIp` 原先是直调命令。）
    - **必须排除 `lo`**：WSL 把 DNS 代理绑在 lo 上且标成 `scope global`
      （实测 `lo inet 10.255.255.254/32 … scope global lo`），naive 取第一个会拿到它。
    - **不回退记账 IP**（这里收回「回退记账值」的初版建议）：wsl2 的记账 IP 是 LXC 时代的
      产物——真实 IP 是 NAT 动态的，记账值（如 `10.88.10.20`）**在 Windows 上根本不可达**，
      回退等于给前端一个点了必失败的端口。两条都拿不到就显示「—」。
  - **peer API 在 Windows 绑不上（属 peer 独立移植线）**：`gatewayOf(cfg)` 按 LXC 桥设计
    返回 `10.88.10.1`，Windows 无此地址 → 日志持续 `peer api: gateway IP not up yet, retrying`
    （退避重试、非致命）。同理 `cfg.network`（桥名）在 wsl2 无意义。
  - **日志标签 bug（已修）**：`hosts-sync` / `aiconfig` / `skillSync` 三处订阅成功日志硬编码
    `{ engine: 'lxc' }`，在 wsl2 下把真实引擎名写错、误导排查。已改 `getEngine(cfg).name`。
  - **走通的清单（引擎 API 级）**：`status`（版本串解码正确）、`baseStatus`（`ready=exists`，
    D10 成立）、`baseSize`（读 `ext4.vhdx` 大小）、`runBaseAction import/export`、
    `create`（vhd 克隆 **0.9–2.5s**）、`listManaged`、`inspect`、`execRun`/`execFeed`/
    `execSpawn`/`execStream`、`start`/`stop` **幂等**、停机回退记账 IP、
    `remove`（unregister + 记账回收）、`subscribeEvents`（5s 轮询）。
    HTTP 层：`/api/health` → `engine=wsl2`、`engineStatus.reachable=true`、
    `caps.ipAuthority='runtime'` 全部正确；`/api/containers` → `[]`；`/api/base` →
    `exists:false`；`/` → 200 前端产物。
  - **仍未做**：#8 Windows 版模板制作脚本（本轮只能「裸发行版 + 手工建 dev 用户」；
    正式模板还需要 zsh/node/AI CLI/omz/skel-home 全套，以及 `/etc/wsl.conf` 的默认用户）；
    #9 docker 服务层 / peer / dockerApi / 防火墙（netsh）的移植。另外服务层日志里
    `services event sync: subscribed` 在无 docker 时是 1s 级重连循环（噪声，非 wsl2 特有）。

