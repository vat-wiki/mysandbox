# 终端体系：容器/宿主/服务/SSH 四侧终端、msmux、文件面板与会话找回

容器内契约与种子机制的源头见 [containers.md](containers.md)；docker 服务层见 [services.md](services.md)。

## 容器内 mysandbox 命令（`container-cli.ts`）

脚本由宿主种子写入 `<lxcpath>/<name>/rootfs/home/dev/.local/bin/mysandbox`（建容器时 + 启动扫描；种子语义是**内容变就覆盖**的自更新，不是缺才写——脚本升级/peer 换配置靠它刷进存量容器）。

- **OSC 深链**：web 终端（`terminal.ts`）注入 `MYSANDBOX_WEB` 标记——exec 的 Env 到不了 tmux server 起的 shell，所以挂 tmux 全局环境（`set-environment -g`），同时开 `allow-passthrough`（否则 tmux 吞掉未知 OSC）。命令运行时探测标记，web 下打印 OSC 7677（tmux 下 DCS passthrough 包裹），`composables/useTermLinks.ts` 注册 OSC handler 捕获后冒泡 `ContainerList.vue` 定位文件面板/开编辑器（与 CLI `mysandbox open` 深链共用 `locateContainerPath`）。非 web 环境只打提示。
- **图片粘贴双口径**：① 路径粘贴（兜底）——前端拦 paste 事件，图片经文件端点 `encoding:'base64'` 通道（12MB 上限，四足端点对齐）落盘 `~/.claude-pastes/` 后粘绝对路径；② **剪贴板桥**（100% 原生体验）——容器终端 Ctrl+V 时前端把图片 canvas 统一转 PNG 推 `/api/terminal-clipboard`（`terminalClipboard.ts` 单槽暂存 120s TTL）+ 查 `GET /api/containers/:id/fg`（tmux `pane_current_command` + shim 在位探测，2.5s 轮询缓存）→ 前台是非 shell 的 CLI 才转发裸 `\x16`，CLI 自己调 xclip/wl-paste **shim**（`clipShim.ts` 种子三件套进 `~/.local/bin` PATH 首位，经 peer `GET /clipboard` 取图；调用链语义逐字对本机 claude 二进制 strings 核实：TARGETS 探测 → `-t image/png -o` 取图）→ CC 输入框内联 `[Image #1]`。前台是 shell（^V 会变 quoted-insert）或桥任何一环失败 → 落回路径粘贴，粘贴不因桥而丢。只对容器终端成立——宿主/服务/SSH 没有种子机制（宿主终端里 CC 读宿主自己的剪贴板）。

## 文件面板四足鼎立

容器 `files.ts`（`/api/files/*`，execRun）、宿主 `hostFiles.ts`（node:fs 直操作，前端以 `__host__` 哨兵切端点）、服务 `serviceFiles.ts`（`'s:'+名`）、SSH `sshFiles.ts`（`'ssh:'+名`）——路由形状/2MB 上限/mtime 乐观锁一比对齐，`api.ts` 的 `filesBase` 哨兵分发让 `FilePanel`/`FileEditorDialog` 零改动换端点。

- **cd 跟随**：三层来源（快→慢）——OSC 7 事件直达、回车后 250ms nudge、5s 轮询兜底。pane 落焦即切换跟随目标，切组按组记忆恢复；刷新恢复多 pane 的挂载聚焦连发取**最后一个**（实际持有 DOM 焦点的 pane），不能按首 pane 跟（mux 下各 pane cwd 独立，跟错 pane 表现为「面板动不动跳 home」）。
- **msmux 会话的 cwd 数据源**：`/api/containers/:id/cwd` 与 `/api/host-terminal/cwd` 都**先问 agent 元数据**（daemon 的前台进程 cwd），老 tmux 会话回落 `pane_current_path`。只查 tmux 的话 mux 会话恒 404——跟随退化成「只靠 OSC 7」，面板打开空白、切 pane 后不再恢复（2026-10-26 修）。相对路径链接的基准目录同源：容器 `/resolve` 用 agent cwd 兜底、宿主 `/resolve` 同理，否则 mux 模式下 Ctrl+点击相对路径恒 404。
- **刷新不暂停跟随**：面板把当前路径 replace 进 `?path=`（自写，非用户深链），挂载恢复路径时不能走 `locate()` 的「暂停跟随」分支——否则刷新一次就永久停在「已暂停跟随终端目录」黄条，表现为跟随功能时灵时不灵。
- **Git 独立视图**：目录路径行下切「文件 / Git」，Git 占满整列，内分「变更 / 历史」；历史走 `git/history`（四端同协议，解析单源 `gitpanel.ts`），按当前/任选分支分页读提交。

## peer exec（容器间命令互通，`server/peer.ts`）

`mysandbox exec <目标> -- 命令`，目标 `host | c:<容器名> | s:<服务名> | 裸名`（先 LXC 后服务）。

- 宿主 CLI 进程内直调（不需要服务在跑）；容器内 CLI 转发给种子写入的 `~/.config/mysandbox/peer-exec.mjs`（node 客户端，凭据在同目录 `peer.json`，0600）。宿主代为执行：LXC 走 `execRun`（默认 dev）、服务走 `docker exec`（label 边界）、host 直接 spawn。
- 迷你 HTTP 绑网关 IP:7331（dockerApi.ts 同款 EADDRNOTAVAIL 退避、随进程存活、失败非致命）；凭据是独立 `peerToken`（config 生成，与主 token 分离），ufw 由自管网段 blanket 覆盖（信任模型见 [security.md](security.md)，services 网段同样可调）。每次 exec 记审计日志。

## msmux（自有终端复用器，`mux/`）

`mux/` 是从零开发的 tmux 替代品，不是 tmux 适配层：目标侧跑静态 Rust 二进制，守 PTY + VT 屏幕模型，客户端断开后会话保留；agent 模式主动回连 mysandbox，无需目标暴露入站端口。只复刻会话语义（attach/detach、多客户端、resize、scrollback、capture、kill/rename），**不**复刻 tmux 的键位/pane/status bar。

**会话宿主与 agent 是两个进程**：daemon（`msmux daemon`）持有 Manager（PTY + 屏幕模型），agent（`msmux agent`）只做 WS ↔ 本地 Unix socket 的帧转发。这样重部署/升级/agent 崩溃重启只断控制通道，会话本体不受牵连——此前 daemon 内嵌在 agent 进程里，systemd 按 cgroup 重启 agent 会把正在跑的 shell 一起带走。

- **构建**：`mux/README.md`；`npm run build:mux`（musl linker 缺省 `musl-gcc`，可用 `CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER` 覆盖）；静态产物约 4.7MB。
- **版本与升级**：`npm run build:mux` 把根 `package.json` 的版本注入二进制，hello 由 daemon 上报 `app_version`；`GET /api/mux/agents` 返回 `appVersion`（= 正在跑的 daemon 版本，agent 只转发）。升级由**连接时自动部署**承担（见下），没有手动升级 UI。升级只换磁盘上的二进制并重启 agent：daemon 用 `systemctl start`（已是 active 时 no-op）保持不动，会话因此保留；老 daemon 继续跑旧二进制，等下次 daemon 重启自然换新。
- **回连端点**：`server/muxAgent.ts` 的 `/ws/mux-agent`。config 的 `muxToken` 是**宿主 master，不下发**；每个目标用 `muxAgentToken(cfg,target)` 派生的 HMAC token，目标之间不能互相冒充。全局 auth hook 对该精确路径豁免，路由在 upgrade 前自校验。
- **容器/服务回连桥**：`server/muxBridge.ts` 绑网关 IP:`mux.agentPort`（默认 7333），裸 TCP 透传到本机控制台端口；主服务仍可只监听 127.0.0.1。SSH 远端需显式给可达 url。
- **分发**：`server/muxDeploy.ts` 的 `POST /api/mux/deploy`（owner），目标语法 `host | c:<容器> | s:<服务/项目> | ssh:<SSH 目标>`。每个目标装**两个**常驻进程：会话宿主 `msmux daemon` + 回连 `msmux agent`。host 与 LXC 各写持久 systemd unit（agent 的 unit `Wants`/`After` daemon；LXC 先把 unit 源落到 dev 可写目录，再由容器 root 安装 `/etc/systemd/system`，容器重启自启）；服务走 `docker cp` + `docker exec -d`（arbitrary 镜像没有统一 init，暂不保证自启）；SSH 走 `sshFeed` + `nohup`（daemon 已在跑就不再起第二个）。部署顺序固定为「停 agent → `start` daemon（不 restart）→ 重启 agent」：老版本 agent 内嵌 daemon 会占着 socket，必须先让位；迁移完成后再部署就不会杀会话。token 一律落目标侧 0600 文件，避免出现在进程命令行。CLI 等价入口：`mysandbox mux deploy <target> [--url ...]` / `mysandbox mux agents`（走运行中服务的 HTTP API——agent 在线表在服务进程内，不能由一次性进程直判）。
- **连接时自动部署与升级**（`mux.autoDeploy`，默认开；host/LXC/SSH 目标）：`/ws/mux-terminal` 对 agent **不在线**的目标：先等 3s 重连宽限窗（agent 侧每 2s 重试回连，服务重启等瞬断自愈），仍不在线就走 `autoDeployMuxAgent`（muxDeploy.ts）送二进制拉起 agent，成功后照常 attach；失败发 error 帧关连接（前端照常显示）。对 agent **在线但二进制陈旧**的目标（部署记录 `muxDeploys.<target>.sha256` ≠ 当前要部署的二进制；无记录的老部署回退比 `app_version` 与控制台版本，没上报版本也算旧）：先问一次 `list`，**目标上还有活会话就跳过本次升级**（旧部署 agent 重启会连带杀掉 cgroup 里的会话；等终端都关掉后的下次连接再升），没有活会话才重部署替换。SSH 目标的回连 url 复用**上次成功部署的记录**（state.json `muxDeploys.<target>.url`，每次部署成功都连 sha256 一起落账）；没有记录时报错引导走 CLI 手动部署一次——控制台只听 127.0.0.1，远端可达地址（如 cloudflared 隧道）只有用户知道，推导不出来。docker 服务目标不参与（服务短命，终端恒走 tmux）。muxToken 轮换/换机的修复路径由此自愈，无需 enrollment 协议（评估结论写进 mux/README.md：派生 token 泄露不构成提权——能读到 0600 token 文件的人本来就已有该目标的完整权限）。
- **浏览器桥**：`/ws/mux-terminal`（owner）转发到 agent，协议保持 Terminal.vue 的 binary stdin / 文本控制帧形状；`GET /api/mux/agents` 看已连接目标。控制请求带 id、响应按 id 关联，事件帧（title/cwd/foreground/exit）不带 id。agent 缺失/会话名非法时服务端**先发 `{type:'error'}` 文本帧再关连接**——只发 close 的话 close code 到不了页面 onclose 参数，用户只能看到无来由的「已断开 (1011)」；error/exit 帧前端在终端里红/灰字回显（`composables/useTermSocket.ts` onmessage）。**attach 数据拆分**：首次 attach 的 `Attached.history` 只含 scrollback，当前屏（`state_formatted`）由 daemon 紧跟应答作为该连接首个 Data 帧下发（`daemon.rs`）——前端把 history 推进 scrollback 后视口为空，屏幕画在空视口上，与 tmux 的整屏重绘同构；混进 history 会被前端回填尾部的 rows×CRLF 一并推进 scrollback，视口剩全空白（实测复现过）。resume 增量路径不变（组合格式尾部含当前屏）。**注册窗口丢帧**（实测坑）：attach 应答与首屏 Data 帧背靠背写出、常落同一 TCP 段，而 ws 库对同段多帧同步连发 `message` 事件（`allowSynchronousEvents` 默认 true）——`channels.set(sid)` 在微任务里还没跑，首屏帧按 sid 找不到通道就被丢，浏览器只收到空 history（alt screen 应用如 claude 的 scrollback 恒空）→ 刷新后随机黑屏；两终端背靠背 attach 时同段合并概率大增、高发。修法：桥对未注册 sid 的 Data 帧暂存 `pendingData`（5s 时间戳修剪），attachChannel 注册后、history/modes/title JSON 发完同步补发——顺序保真（history → 暂存帧 → 实时帧）。
- **本地 socket 归 daemon**：`$XDG_RUNTIME_DIR/msmux/msmux.sock`（无 XDG → `/tmp/msmux-<uid>.sock`）由常驻 daemon 绑定，回连断开期间目标侧 `msmux ls/kill/attach` 照常可用。agent（`mux/src/agent.rs`）只连这个 socket 转发帧，连不上时兜底 `setsid` 拉起一个 daemon——正式部署由独立 unit/nohup 承担，这条兜底只服务手动运行 agent 的场景（systemd 下兜底进程仍落在 agent 的 cgroup 里，重启会一起走）。
- **会话找回与活动监测已接 msmux（tmux 式查询时枚举）**：`/api/terminal-sessions` 对每个 msmux 目标**查询时现场问源头**，不维护缓存清单——agent 在线走 daemon `list`（sendAndWait），agent 离线/服务重启空窗走 `listOfflineTargetSessions`（muxAgent.ts）：经既有 exec 通道（host 直跑 `~/.mysandbox/mux/msmux`、LXC `execRun`、SSH `sshExec`）跑 `msmux ls --json`（容器内 `env -u XDG_RUNTIME_DIR` 落 /tmp socket），靠常驻 daemon 的本地 socket（见上；agent 只是转发层，断开/重启都不影响它）枚举仍活着的会话；单目标失败按 0 会话降级（实测容器停止后 0.4s 返回、不拖累其它源）。活动监测（activity.ts）与文件面板（files.ts）**只枚举在线 agent**——每 5s/2.5s 一拍的轮询起 lxc exec/ssh exec 太重，离线枚举只服务用户主动发起的找回查询。行按 `backend:'msmux'` 并入（同 termId 时覆盖 tmux 行），会话名过滤 `/^mysandbox-([A-Za-z0-9_-]{4,64})$/`（测试残留等不掺和）；结束走 `DELETE /api/terminal-sessions/mux/:termId?target=`（agent 在线转发 kill，离线走同款 exec 通道 `msmux kill` 兜底）；activity.ts 对 msmux 用 daemon 的 `last_seq` 判断输出变化，detach 期间也有效。
- **前端**：`web/src/lib/mux.ts` 按 target 种类取默认——host / `c:` / `ssh:` 走 msmux（agent 不在线/版本旧由服务端连接时自动部署兜底），`s:`（docker 服务）恒走 tmux；`?mux=1|0` 整页临时覆盖。桌面右键菜单/手机动作面板的主项是「打开终端」（按上述默认），「用 tmux 打开终端」保留为显式退路（msmux 故障时用）。终端后端没有配置项（`mux.backend` 已随设置页 `MuxPanel.vue`/`MuxDeployDialog.vue` 删除，旧 config.yaml 里的 `mux.backend` 键读入时被 schema 静默丢弃）；手动部署只剩 CLI（`mysandbox mux deploy`，SSH 首次部署与 docker 服务用）。选 msmux 但目标最终没 agent = 服务端发 error 帧，前端不做可用性探测。stdin 在 WS 打开到首帧（history/输出/error）到达前**暂存**（`pendingInput`，2s 兜底 flush）——attach 握手窗口（含自动部署耗时的窗口）内敲的键不丢；连接不在 OPEN（重连空窗：旧 socket CLOSING、新 socket 未建 / CONNECTING）也一律入队（上限 512 段），**任何路径都不丢键**——手机回前台自愈、agent 断连重连的窗口里敲的键随新连接补发；onopen 后向父组件 emit `backend`，pane 头部显示紫色 `mux` 徽标区分 msmux 终端。
- **重连静默**：`recoverOnReturn`（回前台/聚焦/网络恢复/交互兜底）与断线覆盖条的重连都走 `reconnect(quiet=true)`——不写「连接/已断开」横幅（lost 徽标 + 重连条已表达状态，手机上每次回前台刷两三行横幅会把 scrollback 刷花）；`ws.onerror` 不写横幅（后面必跟 onclose）。意外断线的「已断开 (code)」横幅**延迟 1.5s 落笔**：快速自愈重连直接取消（重连成功后回滚末尾躺着「已断开 (1006)」会被当成还断着）；横幅已写出的慢重连由 onopen 补一行「已重连」闭环。自愈重连不程序性 focus（触摸设备会弹软键盘）。agent 重连会连带关掉浏览器 mux 通道（1012），此机制让这种断连对用户近乎无感。服务端对「agent 被新连接替换」补了 `msmux agent replaced` 日志（旧 socket close 守卫静默跳过 disconnect，曾是排查盲区）。
- **触屏滚动与鼠标上报**：触摸滚动接管（`setupTouchScroll`）普通缓冲只滚本地 scrollback；备用屏（全屏 TUI）+ 应用开了鼠标上报时，触摸位移转成 SGR 滚轮序列（`ESC[<64/65;col;rowM`）发给 PTY 由应用自己滚——claude 实测开启 `?1000h/?1003h/?1006h`，桌面滚轮由 xterm 自动转发，手机上没有这条转换就完全滚不动。应用未开鼠标上报时保持 no-op。**attach 模式回放**：altWheel 的两个前提（备用屏 + 鼠标上报）浏览器端 xterm 必须自己看到——msmux 的 `state_formatted()` 快照只回放 input 模式（鼠标/括号粘贴，vt100 `write_input_mode_formatted` 自带），**不回放备用屏 `?1049h`**（vt100 把它当屏幕状态）——attach 到已运行的 claude 时 xterm 停在普通缓冲，触摸滚动判不出条件、完全没法滚（实测复现过；claude 在 attach 之后才启动则原始字节直通，所以此前实测没暴露）。修法：daemon 首次 attach 把 `?1049h`（按 `alternate_screen()`）拼在首屏 Data 帧最前；resume 不带 `?1049`（xterm 已在备用屏时重收会清屏且无人重绘），input 模式经 `Attached.modes` 字段由服务端桥转 `{type:'modes'}` 控制帧补发（幂等，覆盖 delta 锚点逻辑丢尾部的情况）。
- **手机软键盘 = 真实让位（resize），不是整盒平移**（v0.12.0 改；键盘态归 `composables/useVirtualKeyboard.ts` 全局单例，每实例的让位归 `usePhoneToolbar.ts`；**改这块后按 [notes/mobile-keyboard-qa.md](../notes/mobile-keyboard-qa.md) 在真机过 12 条用例**）：键盘弹起时缩终端盒子（`kbInset` 抬内层 `bottom` → ResizeObserver → `refit` → `exec.resize`），rows 跟着可见高度走，备用屏 TUI（claude/codex）拿到的窗口尺寸与可见区一致，光标行/输入框恒在屏内。旧的「盒子不动 + 内层整盒上移」结构上过不去：备用屏没有回滚缓冲，平移切掉的 frame 上半部分滚不回来。
  - **降噪四件套**（目标 = 每次开合最多一次 resize，且那一次不刺眼。真机实测 Honor YAL-AL10 / Android 10 + 华为浏览器：开 → 一次 44×16、关 → 一次 44×35、收起来 0.5s 再点回来 → **零次**）：① 量化（键盘高度差 < 48px 不重建尺寸，吞掉候选栏/预测栏抖动）；② 非对称（开键盘等动画 settle 80ms 后让位，**收键盘延迟 900ms** 才撑回，窗口内重新聚焦则取消——「收起来看一眼再点回来」零 resize）；③ 遮罩（`kbMask` 尺寸变化时盖黑 260ms，把 xterm reflow + TUI 整帧重绘藏在后面淡出）；④ **PTY 侧去抖+去重**（`Terminal.vue` 的 `onResize` 140ms 去抖，且尺寸与上次已发的一致就不发——xterm 每次 `resize()` 都 fire `onResize`，键盘让位那一拍会连着 fit 两三次，每次都送 `exec.resize` = SIGWINCH + 应用整帧重绘）。
  - **两种浏览器键盘模式**（真机都验过）：① 视觉视口模式（iOS Safari / **Chrome 155** 默认，`interactive-widget=resizes-visual`）：布局不动（`innerHeight` 642 不变）、`vv` 变矮（364），判据 `innerHeight - vv.height - vv.offsetTop`；② **布局视口模式**（Android `adjustResize`，**华为浏览器 17.9.2 / Chromium 132** 实测如此，且它**忽略** `interactive-widget`）：`innerHeight` 与 `vv` 同步缩（587→365），差值恒 0，改用「无键盘基线 − 当前 `innerHeight`」识别（基线取历史 max，`iw ≤ 768` 才认，防桌面拖窗误判），命中时置 `layoutMode`。②模式下浏览器逐帧缩布局、逼着终端 refit，所以 `ContainerList` 在 `layoutMode && kbRaw` 期间把终端组容器**钉回开键盘前量到的高度**（`kbPanelStyle`，200ms 去抖测量 + 键盘在场时不改写基准；多出来的部分落在键盘后面被 app 根裁剪）——容器不动 = 不 refit，让位完全交回 `kbInset`。①模式布局没动，**不钉**（钉了只会引入地址栏伸缩带来的无谓漂移）。
  - **两个键盘信号**：`kbRaw`（立即态，工具条显隐 + 底栏 `MobileBottomNav` 收起 + 容器钉高用，要跟手）与 `kbOpen`/`kbTopAtOpen`（稳定态+量化，让位用）。让位量按「键盘顶（含工具条）压住终端盒多少」量（`rect.bottom - (kbTopAtOpen - toolbarHeight - 6)`），上限 = 盒高 − 120px（留足可见行；注意②模式下 `rect` 含键盘后面那段，不能用比例）；分屏时上方 pane 量出 0 自然不参与，焦点搬到别的终端 pane 立刻交还让位权。键盘开合的最终几何不一定再派发事件（实测键盘收起后没有最后一拍），`kbRaw` 一翻转就补两次定时重测（320/820ms）。
  - **根容器空白区点击 = 交回焦点**（`Terminal.vue` `onRootPointerDown`，仅触摸设备）：让位后 xterm 盒子只占工具条上方，下面那片黑属于 root 不属于 xterm——不收键盘的延迟窗口里点在那里原本没反应。
  - **不走 `interactive-widget=resizes-content`**：那会让 `innerHeight` 跟着缩、键盘探测判据归零；iOS Safari 也不支持该 meta，两端统一按 visualViewport 自己让位（`index.html` 里显式写 `resizes-visual` 只是给默认值不同的壳一个机会，华为浏览器实测忽略）。
- **手机工具条显隐是「键盘态 + 本实例持焦」双闸**（逻辑归属 `composables/usePhoneToolbar.ts`，Teleport 到 body 的 `z-[80]` 覆盖层）：`kbRaw`（`window.visualViewport` 差值 ≤120 视为键盘关闭）是全局信号，而终端组件按组/分屏**多实例常驻**（`v-show` 切换、Teleport 不受源组件 v-show 约束）——没有焦点闸（`termFocused`，容器 focusin/focusout + 下一拍 `activeElement` 核实），所有实例的工具条会随键盘弹起同时显形、精确叠放，tap 被 DOM 末尾实例通吃：那多半不是眼前终端，其 WS 已 `detachWs()`，快捷键全部进 `pendingInput` 无声黑洞，而软键盘字母走聚焦实例照常——表现即「字母能进、快捷键全灭、桌面正常」（2026-10 实测定位）。同一条归属规则也管让位：后台实例 root display:none（rect 全 0）本就算不出让位量，分屏时只有被键盘压住的持焦 pane 让位。按钮交互约定：全部 `@pointerdown.prevent`（点按钮不抢 textarea 焦点，防软键盘闪收 + composition 吞字），seq 键走 click、repeat 键/粘滞修饰走 pointerdown。
- **工具条配置 = 一个入口、两个平级分区**（v0.13.0 重整；`ToolbarSettingsDialog.vue`，数据 `lib/termToolbar.ts` 单键 `mysandbox:term-toolbar-v3`）：『按键』管工具条按钮（chip 拖拽调序 / 候选池追加 / 自定义转义序列 / 物理键盘录制，一页 14 键）；『指令』管「指令」面板条目（label + cmd，拖左侧手柄调序、增删改、重名拒绝）。「指令」面板（`QuickCmdsSheet.vue`）**只负责运行**，右上「配置」跳回设置的指令 tab——运行态（点 = 执行）与配置态（点 = 编辑）不再靠「管理」开关切换。工具条按钮只放按键，文本类动作统一进指令列表；v3 之前的三份数据（v2 工具条含快捷短语、`mysandbox:term-quick-cmds`、v1 `mysandbox:term-quick-snippets`）首次加载时并入指令——快捷短语与指令语义相同（发送文本 + 回车），不再维护两套模型。
- **关闭会话（tab ✕）一律走 HTTP，不依赖终端 WS**：`web/src/lib/api.ts` 的 `killTermSessionByTerm` 按 target 打 `/api/terminal-sessions/mux/<termId>?target=…`（agent 离线时服务端经 exec 通道兜底），失败再回落 tmux 同款端点。以前靠 Terminal 组件在 WS 上发 `{type:'kill'}`，而后台 tab 的 socket 早已 `detachWs()`、建连窗口里还没有 socket —— 这两种最常见的情况下 kill 帧根本发不出去，关掉的会话会一直挂在「终端会话」里（`Terminal.kill()` 现在只负责断自己的 socket）。`msmux` 的 kill 是 **SIGHUP → 2s 宽限 → SIGKILL**（shell 进程组 + `tcgetpgrp` 前台进程组）：只发 HUP 时 `trap "" HUP`、nohup 包装器等会让会话变成永远杀不掉的幽灵（实测复现，单测 `kill_escalates_when_hup_ignored` 守着）。
- **attach 期间收到 kill 的竞态**：`/ws/mux-terminal` 在 agent 探测/自动部署**之前**就挂上 message 监听并记 `killRequested` 墓碑——kill 早到时不 create（否则部署窗口里关掉的 tab 会在目标侧凭空造一条会话），attach 完成后才到的 kill 则立刻回收刚建的会话。浏览器在 attach 期间断开（刷新/切走）只补 detach，按语义保留会话。同一会话可被多个窗口接入：`agent.channels` 是 `sid → Set<通道>`，一个窗口关闭不会把另一个窗口的通道删掉。
- **输出积压自愈**：daemon 的广播缓冲被打爆（`Lagged`）时不再 `break`（那会让终端静默冻结但 socket 还开着），改为按 vt100 模型原地重绘（`Session::resync`：`3J` 清 scrollback + 重放历史 + 当前屏；备用屏只重进 alt screen），锚点推到当前 `seq` 后继续收增量。
- **会话可靠性**：host daemon/agent 必须活在本服务 cgroup 外（独立 systemd user unit）；capture 依赖 `vt100` 的 scrollback，不能只回放原始 PTY 字节；重连用 `resume=1` 只回最近 2000 行，浏览器按锚点拼 `history-delta`。
- **安全**：派生 token = 对应目标的终端权限（agent 可创建 shell）。轮换 `muxToken` 会让全部目标旧 token 失效；host/LXC/SSH 目标下次连接时自动重部署自愈，SSH/docker 服务目标手动重新部署一次即可。

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
