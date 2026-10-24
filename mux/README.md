# msmux — mysandbox 的可携带终端复用器

`msmux` 是 mysandbox 从零开发的 tmux 替代品。目标不是复刻 tmux 的窗口/pane/键位，
而是复刻它真正被依赖的**会话语义**：

- 客户端断开后 shell 继续跑
- 重新 attach 时恢复已渲染屏幕与 scrollback
- 多客户端同时 attach、各自 resize
- 列会话、读标题/cwd/前台进程、kill/rename
- 目标侧可执行文件主动回连 mysandbox，不需要暴露入站端口

当前状态：可运行的 MVP。宿主机/容器/服务/SSH 的目标分发、按目标派生凭据与前端
`auto` 切换已接入；在线 agent 的会话与输出活动已并入 `/api/terminal-sessions` 和
`/api/terminal-activity`，不再依赖 tmux 扫描。

## 构建

需要 Rust 工具链。静态 musl 版本：

```bash
rustup target add x86_64-unknown-linux-musl
sudo apt-get install -y musl-tools
npm run build:mux
# 等价于（linker 可用 CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER 覆盖）：
# CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc \
#   cargo build --manifest-path mux/Cargo.toml --release \
#   --target x86_64-unknown-linux-musl
```

产物：`mux/target/x86_64-unknown-linux-musl/release/msmux`（约 4.7MB，static-pie）。
`npm run build` 会在产物已存在时自动拷贝到 `dist/bin/msmux`；`npm publish` 前会先构建
静态二进制。部署解析顺序：`MSMUX_BINARY` → `dist/bin/msmux` → 源码树 target 产物。

## 本地使用

```bash
# 前台守护
msmux daemon

# 新会话；缺省使用 $SHELL
msmux new mysandbox-abcd-1234
msmux new build -- sh -c 'make; sleep 30'

# 查看 / 导出 / 结束
msmux ls
msmux capture mysandbox-abcd-1234 --ansi
msmux kill mysandbox-abcd-1234

# attach；Ctrl-] 本地 detach，会话保留
msmux attach mysandbox-abcd-1234
```

socket 缺省在 `$XDG_RUNTIME_DIR/msmux/msmux.sock`，没有 XDG 时落在
`/tmp/msmux-<uid>.sock`，权限 0600。

## 回连 mysandbox

目标侧：

```bash
msmux agent \
  --url ws://<mysandbox-host>:7321/ws/mux-agent \
  --token-file ~/.config/msmux/agent.token \
  --target <目标名>
```

`--token` 仍可用，但部署路径一律用 `--token-file`，避免 token 出现在 `ps` 命令行。
目标 token **不是** config 里的 `muxToken` 主凭据，而是 `HMAC(muxToken, target)` 派生值；
一个目标的 token 只能注册它自己的 target。

终端后端没有配置项：host / LXC / SSH 目标默认走 msmux（agent 不在线或二进制陈旧由
服务端连接时自动部署/升级兜底，见「自动分发」）；docker 服务目标恒走 tmux。
URL `?mux=0|1` 可整页临时覆盖；「用 tmux 打开终端」保留为显式退路。

### 自动分发

owner 调 `POST /api/mux/deploy`（主 token），body：`{"target":"host"}` 或
`{"target":"c:<容器>"}` / `{"target":"s:<服务>"}` / `{"target":"ssh:<目标>","url":"wss://..."}`。
接口会上传静态二进制、写目标侧 0600 token、拉起 agent，并等待最多 6s 确认回连。
CLI 等价入口：`mysandbox mux deploy <target> [--url ...]`、`mysandbox mux agents`。

- host：`~/.mysandbox/mux/msmux` + 持久 systemd user unit（宿主重启自启）；
- LXC：写 rootfs 的 `~/.local/bin/msmux`，并安装 `/etc/systemd/system/msmux-agent.service`
  （容器重启自启）；
- 服务容器：`docker cp` 到 `/tmp/mysandbox-msmux` + `docker exec -d`；
- SSH：`sshFeed` 上传到远端 `~/.local/bin/msmux` + `nohup`。

容器/服务走网关 IP:7333 的回连桥（`server/muxBridge.ts` → 本机控制台端口）。SSH 远端
必须显式给 `url`。

mysandbox 侧：

- `GET /api/mux/agents`：已连接目标列表（owner token）
- `GET|PUT /api/mux/backend`：服务端默认终端后端（owner token）
- `GET /api/mux/agents/:target/sessions`：目标上的会话列表
- `WS /ws/mux-terminal?target=&name=&termId=&cols=&rows=&shell=&create=&resume=`
  - 浏览器→服务端：二进制帧是 stdin；文本帧 `{type:'resize'|'detach'|'kill'}`
  - 服务端→浏览器：二进制帧是终端输出；文本帧
    `{type:'history'|'history-delta'|'title'|'cwd'|'foreground'|'exit'|'error'}`

浏览器桥会把 `title` / `cwd` / `foreground` 事件原样转发给现有终端面板：`cwd`
驱动文件面板跟随、pane 头部与分屏继承；`foreground` 驱动图片粘贴桥的前台命令
判断（剪贴板桥可用性仍由宿主代查 shim）。`/ws/mux-agent` 只认 `muxToken`，不认
主 token / peerToken；`/ws/mux-terminal` 仍走控制台主 token 且要求 owner。

agent hello 上报 mysandbox 构建版本（`/api/mux/agents` 返回 `appVersion`）。升级由
「连接时自动部署」承担：agent 在线但部署记录的 sha256 ≠ 当前二进制（或无记录时
`app_version` 落后/缺失）→ 连接时当场重部署，daemon 会话保留。

## 协议

控制面 JSON，数据面二进制。一帧 = kind 字节 + payload；Unix socket 外层用 4 字节长度前缀，
WebSocket 直接用二进制消息。

```text
kind 1 (JSON): {"type":"new"|"list"|"attach"|"resize"|"detach"|"capture"|"kill"|"rename"|"ping", "id"?:n, ...}
kind 2 (DATA): sid(u32 BE) + raw bytes
kind 3 (PING)
```

控制请求可带 monotonic `id`，控制响应原样回带；title/cwd/foreground/exit 是事件帧，不带 id。
老客户端不带 id 仍可用。

`attach` 返回已渲染历史（base64）和 `last_seq`。实时输出只发送 `seq > last_seq` 的增量，
避免 attach 瞬间重复写入。`resume=true` 时只回最近 2000 行，浏览器按锚点拼
`history-delta`，断线窗口内错过的输出原位补齐。

## 目标侧部署注意

- 宿主进程不能挂在 `mysandbox.service` 的 cgroup 里；自动分发用独立 systemd user
  unit，否则服务重启会连带杀掉会话。
- 容器：直接把静态二进制写进 rootfs / `docker cp`，以目标用户启动。
- SSH：`scp` 到 `~/.local/bin/msmux` 后启动 agent。
- 目标无需安装 tmux、node 或其它运行时。

## 当前限制

- 每个会话只有一个 pane；没有窗口/pane 布局与 tmux 键位。
- agent 只支持系统信任库验证的 `wss://`；自签 CA / 跳过校验尚未做。
- agent 断开期间无法发现它名下的会话（daemon 仍活着，重新回连后即可恢复）。
- 应用容器与 SSH 目标的 agent 暂不保证自启（重启后 agent 不回来）；LXC/SSH 目标由
  控制台「连接时自动部署」兜底（`mux.autoDeploy`，见 docs/architecture/terminals.md），
  应用容器目标保持 CLI 手动部署。
- 初次 attach 仍是完整屏幕 + scrollback 回放；目标端没有 tmux 的 pane 布局能力。
- `cwd` / 前台进程在 PTY 输出驱动下实时补发；无输出期间不轮询，attach 时仍先给一次快照。
- 仅 Unix；Windows ConPTY 版本未做。

## 下一步

1. 应用容器 / SSH 目标侧自启动（LXC 与宿主已由 systemd 托管）。
2. tmux 键位/窗口布局兼容层。

已评估不做：muxToken 轮换与一次性 enrollment。派生 token 落目标侧 0600 文件，能读到它
的人本来就已有该目标的完整权限，泄露不构成提权；换 token 的修复路径由「连接时自动
部署」自愈（重新连一次目标即重新部署），个位数目标手动重部署也只是 CLI 一条命令，
为此做 enrollment 协议不成比例。
