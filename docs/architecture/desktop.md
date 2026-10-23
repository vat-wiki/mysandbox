# 容器桌面与 code-server

## 容器桌面（`desktop.ts`）

浏览器查看/操作容器内 XFCE 桌面。容器内栈：Xvfb（`:10`，尺寸取自 query `w/h`）+ x11vnc（`:5901 -nopw`，仅容器内监听）+ startxfce4，全 dev 用户 + **setsid nohup**（lxc-attach 会话退出杀普通子进程）——关窗/重启 mysandbox 都不影响，容器重启后下次连接重起。

- **两条 WS 路由是刻意拆开的**：`/ws/desktop`（控制流，文本帧 JSON：progress/ready/error，承载 ensureDesktop 的安装/启动进度）与 `/ws/desktop-vnc`（RFB 纯二进制透传 `net.connect(容器IP, 5901)`）。不能合并——noVNC 的 Websock 只消费二进制 RFB，混进文本进度帧会破坏协议流。RFB 流 WS 关闭只 destroy TCP，不动容器内桌面。
- **按需 ensure**（照 terminal.ts 的 tmuxReady 模式）：模块级 Set 缓存 + 实测探测（pgrep Xvfb + /dev/tcp 5901）双确认；没装包则 sed 换源 aliyun + `apt install xvfb x11vnc xfce4 xfce4-terminal dbus-x11`（timeoutMs 10min，模板已预装时秒过）。
- **前端 noVNC 的三个坑**（都已有对策，改动前先看 `vite.config.ts`/`DesktopDialog.vue` 注释）：包的 exports 字段是非法形状（字符串）→ vite alias 直指磁盘 `core/rfb.js`（同 Monaco 手法）；rfb.js 有 top-level await → build target es2022；noVNC 在 canvas mousedown 时往 body 挂全屏鼠标捕获层（z-index 10000）→ **reka-ui Dialog 会把它当 outside 点击而关窗**，DialogContent 已 `@pointer-down-outside.prevent`，且组件卸载要手动 `remove()` 该层（disconnect 不回收）。
- Dialog 窗口可拖边缘/四角改大小（8 向手柄，`startResize`），右上角按钮/双击标题栏铺满；尺寸持久化 localStorage、位置不持久（默认居中，拖动后锚定左上角——`!translate-x-0` class 压居中 translate，**不能用 inline transform**：reka-ui 动画结束会清 inline style）。分辨率固定于连接时（`resizeSession: false`，Xvfb 屏幕尺寸不动态改）；`scaleViewport: true` 让 canvas 等比缩放适配窗口。

## code-server（浏览器版 VS Code，`server/codeserver.ts`，`POST /api/containers/:id/code-server` SSE）

照 desktop.ts 的按需 ensure 模式——探测（pgrep + HTTP 实测，**curl 必须 `-L`**：记住上次工作区后裸 `/` 302 到 `/?folder=…`，固定等 200 会卡到超时）双确认 → 缺装装（npm 全局，registry 在本部署网络比 coder 官方 install.sh 稳）→ `setsid nohup` 起（dev 用户）→ 就绪轮询。

- `--auth none`：代理口径必先过 cookie 鉴权、直连口径暴露面 = 自管网段（ufw 外部网段默认全拒，见 [security.md](security.md)），不新增暴露。监听端口 `CODE_SERVER_PORT = 7332`（7321/7331/7332 同族；容器各网络命名空间互不冲突，故不可配）。打开走前端 `serviceUrl('c', name, 7332, ip)`（与端口点击同口径，见 [web-proxy.md](web-proxy.md)）。
- 入口 = 容器右键菜单「Code Server」+ 文件面板工具栏按钮（带 `?folder=` 当前目录），进度进 toast（与桌面 Dialog 的进度形态不同：这里无 Dialog，装完即开新标签页）。
- **闲置自动停**（`startCodeServerIdleSweeper`，`cfg.codeServer.idleStopMinutes` 默认 30，0=常驻）：进程在用的唯一可靠信号是 7332 的 ESTABLISHED 连接（浏览器开着才有 workbench websocket）——sweep 每 5min 一拍（activity.ts 同形态：inFlight 防重入 + unref），对每台运行中容器一次 exec 读 `/proc/net/tcp(6)`（状态 01、本地端口十六进制 1CA4=7332）数连接；连接 >0 刷新 `lastSeen`、首见 0 连接只记基线（起服务到开 tab 有间隙），超时 `pkill`（TERM+KILL）。磁盘安装保留，下次打开 ensure 秒级重起；lastSeen 进程内不持久化（重启后重新计时，最多多宽限一拍）。
