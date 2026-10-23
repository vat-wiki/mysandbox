# 终端体系：容器/宿主/服务/SSH 四侧终端、msmux、文件面板与会话找回

容器内契约与种子机制的源头见 [containers.md](containers.md)；docker 服务层见 [services.md](services.md)。

## 容器内 mysandbox 命令（`container-cli.ts`）

脚本由宿主种子写入 `<lxcpath>/<name>/rootfs/home/dev/.local/bin/mysandbox`（建容器时 + 启动扫描；种子语义是**内容变就覆盖**的自更新，不是缺才写——脚本升级/peer 换配置靠它刷进存量容器）。

- **OSC 深链**：web 终端（`terminal.ts`）注入 `MYSANDBOX_WEB` 标记——exec 的 Env 到不了 tmux server 起的 shell，所以挂 tmux 全局环境（`set-environment -g`），同时开 `allow-passthrough`（否则 tmux 吞掉未知 OSC）。命令运行时探测标记，web 下打印 OSC 7677（tmux 下 DCS passthrough 包裹），`Terminal.vue` 注册 OSC handler 捕获后冒泡 `ContainerList.vue` 定位文件面板/开编辑器（与 CLI `mysandbox open` 深链共用 `locateContainerPath`）。非 web 环境只打提示。
- **图片粘贴双口径**：① 路径粘贴（兜底）——前端拦 paste 事件，图片经文件端点 `encoding:'base64'` 通道（12MB 上限，四足端点对齐）落盘 `~/.claude-pastes/` 后粘绝对路径；② **剪贴板桥**（100% 原生体验）——容器终端 Ctrl+V 时前端把图片 canvas 统一转 PNG 推 `/api/terminal-clipboard`（`terminalClipboard.ts` 单槽暂存 120s TTL）+ 查 `GET /api/containers/:id/fg`（tmux `pane_current_command` + shim 在位探测，2.5s 轮询缓存）→ 前台是非 shell 的 CLI 才转发裸 `\x16`，CLI 自己调 xclip/wl-paste **shim**（`clipShim.ts` 种子三件套进 `~/.local/bin` PATH 首位，经 peer `GET /clipboard` 取图；调用链语义逐字对本机 claude 二进制 strings 核实：TARGETS 探测 → `-t image/png -o` 取图）→ CC 输入框内联 `[Image #1]`。前台是 shell（^V 会变 quoted-insert）或桥任何一环失败 → 落回路径粘贴，粘贴不因桥而丢。只对容器终端成立——宿主/服务/SSH 没有种子机制（宿主终端里 CC 读宿主自己的剪贴板）。

## 文件面板四足鼎立

容器 `files.ts`（`/api/files/*`，execRun）、宿主 `hostFiles.ts`（node:fs 直操作，前端以 `__host__` 哨兵切端点）、服务 `serviceFiles.ts`（`'s:'+名`）、SSH `sshFiles.ts`（`'ssh:'+名`）——路由形状/2MB 上限/mtime 乐观锁一比对齐，`api.ts` 的 `filesBase` 哨兵分发让 `FilePanel`/`FileEditorDialog` 零改动换端点。

- **cd 跟随**：shell 集成发 OSC 7 直达文件面板（回车事件即时检查），1s cwd 轮询降级为兜底；pane 落焦即切换跟随目标，切组按组记忆恢复。
- **Git 独立视图**：目录路径行下切「文件 / Git」，Git 占满整列，内分「变更 / 历史」；历史走 `git/history`（四端同协议，解析单源 `gitpanel.ts`），按当前/任选分支分页读提交。

## peer exec（容器间命令互通，`server/peer.ts`）

`mysandbox exec <目标> -- 命令`，目标 `host | c:<容器名> | s:<服务名> | 裸名`（先 LXC 后服务）。

- 宿主 CLI 进程内直调（不需要服务在跑）；容器内 CLI 转发给种子写入的 `~/.config/mysandbox/peer-exec.mjs`（node 客户端，凭据在同目录 `peer.json`，0600）。宿主代为执行：LXC 走 `execRun`（默认 dev）、服务走 `docker exec`（label 边界）、host 直接 spawn。
- 迷你 HTTP 绑网关 IP:7331（dockerApi.ts 同款 EADDRNOTAVAIL 退避、随进程存活、失败非致命）；凭据是独立 `peerToken`（config 生成，与主 token 分离），ufw 由自管网段 blanket 覆盖（信任模型见 [security.md](security.md)，services 网段同样可调）。每次 exec 记审计日志。

## msmux（自有终端复用器，`mux/`）

`mux/` 是从零开发的 tmux 替代品，不是 tmux 适配层：目标侧跑静态 Rust 二进制，守 PTY + VT 屏幕模型，客户端断开后会话保留；agent 模式主动回连 mysandbox，无需目标暴露入站端口。只复刻会话语义（attach/detach、多客户端、resize、scrollback、capture、kill/rename），**不**复刻 tmux 的键位/pane/status bar。

- **构建**：`mux/README.md`；`npm run build:mux`（musl linker 缺省 `musl-gcc`，可用 `CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER` 覆盖）；静态产物约 4.7MB。
- **回连端点**：`server/muxAgent.ts` 的 `/ws/mux-agent`。config 的 `muxToken` 是**宿主 master，不下发**；每个目标用 `muxAgentToken(cfg,target)` 派生的 HMAC token，目标之间不能互相冒充。全局 auth hook 对该精确路径豁免，路由在 upgrade 前自校验。
- **容器/服务回连桥**：`server/muxBridge.ts` 绑网关 IP:`mux.agentPort`（默认 7333），裸 TCP 透传到本机控制台端口；主服务仍可只监听 127.0.0.1。SSH 远端需显式给可达 url。
- **分发**：`server/muxDeploy.ts` 的 `POST /api/mux/deploy`（owner），目标语法 `host | c:<容器> | s:<服务/项目> | ssh:<SSH 目标>`。host 写持久 systemd user unit；LXC 先把 unit 源落到 dev 可写目录，再由容器 root 安装 `/etc/systemd/system`（容器重启自启）；服务走 `docker cp` + `docker exec -d`（arbitrary 镜像没有统一 init，暂不保证自启）；SSH 走 `sshFeed` + `nohup`。token 一律落目标侧 0600 文件，避免出现在进程命令行。CLI 等价入口：`mysandbox mux deploy <target> [--url ...]` / `mysandbox mux agents`（走运行中服务的 HTTP API——agent 在线表在服务进程内，不能由一次性进程直判）。
- **浏览器桥**：`/ws/mux-terminal`（owner）转发到 agent，协议保持 Terminal.vue 的 binary stdin / 文本控制帧形状；`GET /api/mux/agents` 看已连接目标。控制请求带 id、响应按 id 关联，事件帧（title/cwd/foreground/exit）不带 id。
- **会话找回与活动监测已接 msmux**：`/api/terminal-sessions` 把在线 agent 的 daemon `list` 结果按 `backend:'msmux'` 并入（同 termId 时覆盖 tmux 行），结束走 `DELETE /api/terminal-sessions/mux/:termId?target=`（按 agent 转发 kill）；activity.ts 对 msmux 用 daemon 的 `last_seq` 判断输出变化，detach 期间也有效。
- **前端**：`web/src/lib/mux.ts` 默认 `auto`——目标 agent 在线才走 msmux，否则原样回退 tmux；`?mux=1|0` 临时覆盖，偏好键 `mysandbox:terminal-backend`。设置 →「终端后端」（`MuxPanel.vue`）可切 tri-state、看在线 agent、逐个目标部署；`MuxDeployDialog.vue` 负责 SSH 回连地址输入与 6s 回连结果。
- **会话可靠性**：host agent 必须活在本服务 cgroup 外（systemd user unit）；capture 依赖 `vt100` 的 scrollback，不能只回放原始 PTY 字节；重连用 `resume=1` 只回最近 2000 行，浏览器按锚点拼 `history-delta`。
- **安全**：派生 token = 对应目标的终端权限（agent 可创建 shell）。轮换 `muxToken` 会让全部目标旧 token 失效，重新部署即可。

## 宿主终端（`hostTerminal.ts`）

与容器终端同协议同语义（**真 tmux 语义**：会话只被显式 kill 或 shell 退出终结，无任何定时清理——「只要服务还在，用户开的会话就活着」；kill 帧、activeCount 多窗口），但 PTY 由本进程管理：宿主 tmux 专用 socket `-L mysandbox-host`、会话 `mysandbox-host-<termId>`，`script(1)` 提供 PTY，`stty -F <pts>` 驱动 resize（tmux 3.4 的 `refresh-client` 不支持 -x/-y）。

已知坑（都在注释里）：spawn script 必须 `SHELL=/bin/sh`（zsh 会把 `=mysandbox-host-xxx` 做 =word 展开）；node 退出时 `process.on('exit')` 同步 SIGKILL 全部 script 子进程（tsx 热重启每次触发）；**tmux server 必须经 `systemd-run --user --scope` 拉起在 mysandbox.service cgroup 之外**（service 单元形态会让毫秒级退出的 `new-session -d` client 完成单元 → systemd 清空 cgroup → 刚 fork 的 server 陪葬；scope 只要不监督进程、有活进程即保持）。会话 cwd = 宿主 home。前端 `ContainerList.vue` 侧栏底部「终端」区首项「本机」，`TermGroup.kind='host'`（containerId 哨兵 `__host__`，修剪/OSC/FilePanel 均豁免；同区挂 SSH 主机条目，见下）。

## 服务终端（同文件 `/ws/service-terminal`，handler 双模式共享 attach 机制）

docker 服务容器里没有 tmux，会话本体 = 同一宿主 socket 上的 tmux 窗口命令 `docker exec -it -e MYSANDBOX_TERM=<termId> <name> <shell>`（连接前查运行态、容器内 bash→sh 解析；docker CLI 随 client tty SIGWINCH 自动 resize）。会话名 `mysandbox-svc-<termId>`，**服务名存会话选项 `@svc`**（⚠️ 必须会话级 `set-option -t "=会话:"`——`-s` 是 server 级选项且 `-t` 被静默忽略，实测所有会话读到同一个值，会话对话框会归错组/进错容器；名字可含 `-` 与 termId 拼接切不开，listServiceSessions 走格式串直读）。跨 mysandbox 重启存活同宿主终端；不参与无输出提醒扫描（activity 的 host 扫描前缀不含 svc）。前端 `TermGroup.kind='service'`（containerId=服务名，tab 色条沿用名字 hash 色），服务卡片点击弹动作菜单（与容器同交互，终端在菜单首项）、菜单「详情」开服务抽屉；会话对话框可找回/接入（`/api/terminal-sessions/service/:termId`）。

## SSH 主机终端（`sshTerminal.ts`，`/ws/ssh-terminal` + `/api/ssh/targets*`）

远程主机只是**终端的延伸，不是被管理对象**——无 OSC 深链/活动扫描，不进批量操作/hosts/`mysandbox status`（这条守住产品概念，给远程主机加"管理"能力之前先想清楚）；文件面板是刻意保留的例外（见下「SSH 文件端点」）。

- 会话本体在**远端** tmux 专用 socket `-L mysandbox-ssh`（会话 `mysandbox-ssh-<termId>`），PTY 链 = script(1)（本机，children/childTty/applyTtySize 复用 hostTerminal 导出件）→ `ssh -t` → 远端 attach；远端 server 无 cgroup 归属问题，不需要 systemd-run。
- **远端 tmux 不是硬前提**（2026-10-20 起）：has-session 报 command not found → 会话层整体降级为直连 shell（裸 ssh + pty，无远端命令）——终端照用，断开即结束，无持久会话/历史回填/cwd 继承/会话找回；装上 tmux 下连自动恢复完整语义（对方机器装不了 tmux 时 SSH 主机仍可用）。
- 目标存 **sidecar state.json**（`sshTargets`，UI 可增删改——改密/端口/备注走 PUT，不碰用户手改的 config.yaml），凭据缺省全走宿主 ssh（keys/agent/`~/.ssh/config` 别名）；可选存密码（同文件 0600，API 响应永不回明文只给 hasPassword），宿主有 sshpass 时后台与 attach 都经 `sshpass -e` 自动应答（`sshAuthSpec` 剥 BatchMode、SSHPASS 走 env）；没存密码/没装 sshpass 时后台命令 BatchMode 快败，密码认证目标由 attach 的 `new-session -A` 兜底交互建会话（设置缺席的可接受降级）。
- 实测坑（都在注释里）：① `execFile('ssh', argv)` 的 argv **不能**再带首位 `ssh`（重复后远端主机名变字面量 `"ssh"` 被 DNS 解析到 fake-ip）；② 经 ssh 的 argv 由**远端登录 shell** 解析——tmux target 的 `=名字` 要 `shq()` 单引号裹（zsh =word 展开）、`-F` 格式串（含换行与 `|`）同理，否则扫描恒空；③ `ssh` 带远端命令时**不自动申请远端 pty**（本机 stdin 是 tty 也不行），attach 必须 `-t`；④ `set-titles-string` 的 `#T` 裸词在远端 shell 开头即注释，必须引号。
- 前端 `TermGroup.kind='ssh'`（containerId=`ssh:`+目标名，api.ts `sshGroupId`/`sshTargetName` 前缀隔离撞名；侧栏终端区「本机 + SSH 主机」与应用容器同款卡片语言 + 同款右键/长按动作清单，SshTargetsDialog 管理含编辑），会话对话框可找回/接入（`/api/terminal-sessions/ssh/:name/:termId`）。

## SSH 文件端点（`sshFiles.ts`，`/api/ssh/:name/*` + 通道 `sshChannel.ts`）

SSH 主机的文件面板，与容器/宿主/服务四足鼎立全量对齐（列目录/读写/建删/下载/git 套件/resolve/cwd，脚本同源 files.ts/serviceFiles.ts、解析单源 gitpanel.ts）。前端约定：ssh 组 containerId 本体（`ssh:`+目标名）即文件目标 id，`filesBase` 切 `/api/ssh/<name>/*`。

- 通道 = 宿主 ssh（BatchMode 快败，与终端同权限面不新增越权）；**argv 全部经 sshChannel 的真转义 `shq()` 单引号包裹**（HTTP 传来的路径可含引号/空格，与 sshTerminal 白名单值的裸 shq 不同源）——ssh 把 argv 拼成命令串交**远端登录 shell** 解析是注入面的总闸。
- exit 255 = ssh 传输失败 → 502 `ssh_unreachable`；非 Linux 远端（macOS/BSD 的 `stat -c` 缺失会静默列空）由 `requireRemoteLinux`（uname 一次探测按目标缓存）明确 400；密码认证目标文件面板快败（交互输密码只在终端 attach 有意义）。
- cwd/resolve 天然成立：会话在远端 tmux，`pane_current_path` 即远端真实路径（list-panes 直查，`=` 精确匹配）。
- 跨面板复制 `/api/files/copy` 支持 `ssh:` 侧（tar 经 ssh 进出，远端 /tmp 临时目录 + 远端 mv；unpack 走 `sshSpawnIn`——stdin 必须管道收 tar 流，与下载用的 `sshSpawn` 分立）。
- 唯一不可用的是 OSC 深链——远端没有 mysandbox 种子。

## 服务文件端点（`serviceFiles.ts`，`/api/services/:name/*`）

服务终端的文件面板与容器/宿主全量对齐（列目录/读写/建删/下载/git 套件/resolve，脚本同源 files.ts、解析单源 gitpanel.ts，全部走 `docker exec`）。前端约定：服务组的**文件目标 id = `'s:'+服务名`**（`api.ts` `filesBase` 哨兵分发，与 termSessionKey 的 `s:` 同约定；组 containerId 本体仍是真名，只有文件目标在边界处加前缀）。

- cwd 关键差异：服务终端 tmux 在宿主、pane 跑的是 docker exec 客户端，`pane_current_path` 是宿主路径——建会话时 `-e MYSANDBOX_TERM=<termId>` 注入标记，/cwd 进容器扫 `/proc/*/environ` 找「带标记且父进程不带标记」的直启 shell 读 `/proc/<pid>/cwd`（老会话无标记 → 404 占位，重开 tab 即有；git 127 = 镜像没 git 按非仓库返回）。
- 跨面板复制 `/api/files/copy` 支持 `s:` 侧（tar 经 docker exec 进出，容器内 /tmp 临时目录 + mv 落位）。
- 唯一不可用的是 OSC 深链（`mysandbox open`/OSC 7677）——服务容器没有 mysandbox 种子。

## 终端会话隐藏与跨窗口找回

- tab 布局（含隐藏列表）是**各浏览器自己的 localStorage 状态**（`mysandbox:term-tabs-v4` / `mysandbox:term-hidden`），不是服务端状态——换浏览器/窗口 tab 就「没了」。但会话本体（tmux）在服务端活着，所以找回走**服务端扫描**：`GET /api/terminal-sessions`（routes.ts 组合）并发扫全部运行中容器 + 宿主 socket（`listContainerSessions`/`listHostSessions`，allSettled 单容器失败按 0 会话降级），`DELETE /api/terminal-sessions/{host|container}/...` 结束孤儿会话。`termSessionKey`（api.ts）是两侧共用的去重 key：本窗口可见+隐藏组占用的 termId 不进远端列表。
- **tab 右键「隐藏」≠ ✕**：隐藏 = 组从 `groups` 挪进 `hiddenGroups`（Terminal 卸载 → WS 断 = 纯 detach，会话保留）；✕ = kill 帧（真杀）。恢复时 seq 撞号取可见+隐藏 max+1。
- **接入远端会话 = 复用 termId 建组**：后端 `new-session -A` 按 `mysandbox-<短id>-<termId>` 命中即 attach 回原会话（现场全保留）。跨窗口拿不回原分屏树（那是对方窗口的 localStorage），多会话「全部接入」合并成一个 ≤4 块的分屏组。UI 主体在 `TermSessionList.vue`（扫描/分组/接入/结束/隐藏组恢复，三处共用：侧栏终端区尾部块、rail「所有终端」分区浮层、对话框）；`TermSessionsDialog.vue` 只剩对话框壳（本机/SSH 卡片右键「全部终端会话」、手机切换器、popout 顶栏入口）。挂载即扫一轮、无轮询（扫描是跨容器 exec 风暴），刷新走手动。
- kill 扫描/结束都要 `tmux -t =<精确名>`（tmux 的 -t 默认前缀/通配匹配，见 terminal.ts 里 reapOrphanClients 的教训注释）。

## 终端活动监测（`server/activity.ts`）

「agent 干完活/等输入提醒」的服务端底座——周期扫全部运行中容器+宿主 socket 的 tmux 会话，取尾部输出 hash + history_size 判安静；「用户在不在看」刻意由前端判（可见 tab 是 v-show 常驻，tmux session_attached ≠ 在看）。状态不持久化（同 jobs.ts 取舍）。

- **agent 精准提醒**（`server/agentNotify.ts`，`terminal.agentNotify` 开关）在本底座之上：往各 home（宿主+受管容器+模板）落 agent CLI 的回调配置（claude hooks Stop/Notification、codex 顶层 notify、opencode/pi 薄壳插件文件），hook 经种子脚本 `agent-notify.mjs`（container-cli.ts 种子、peer.json 带 `self`=容器名）反查 `$TMUX_PANE` 会话名后 POST peer `/notify`；服务端记 waiting/agentSeen 两张进程内表随 `/api/terminal-activity` 下发——有 waiting 的组前端精准挂标（浏览器通知同发），**收到过 notify 的会话整体退出输出启发式**（agent 会话 TUI 重绘正是误报主源）；扫到输出变化清 waiting（25s 宽限防「hook 在渲染后才触发」的秒杀竞态）。claude hooks 条目/codex notify 键的所有权判据 = 含 `agent-notify.mjs` 特征，用户自己的配置零接触；codex notify 是 exec 直调不经 shell，必须绝对路径。
- **Web Push 站外推送**（`server/push.ts` + `web/public/service-worker.js` + `web/src/lib/pushNotify.ts`）：waiting 落表即经系统推送通道下发（页面没开/移动端冻结也照收——in-page `new Notification` 依赖页面活着，后台 tab 降频/冻结下先天残废）；VAPID 密钥与订阅底账在 `~/.mysandbox/push.json`（0600，原子写），端点失效（404/410）发送时顺带清账；「在看」抑制 = 控制台页面可见期间前端向 `/api/push/watching` 心跳（10s 一拍、服务端 30s TTL），**任何一台设备的控制台可见都不推**（用户在场，琥珀标足够），心跳同时重置去重（同会话 waiting 只推一次，`noteOutput`/心跳重置，防用户不在时每回合轰炸）；只推 agent 精准信号不推「无输出」启发式（推手机太吵）；通知点击 = SW 带 `?focusTerm=kind|cid|termId` 深链或对已开窗口 postMessage，ContainerList 落到对应组（含隐藏组恢复）。
