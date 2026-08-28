# mysandbox

本地开发容器（dev container）的网页控制台：从浏览器直接开终端、批量改 git/ssh、自由创建删除容器。
后端管理 **unprivileged LXC 系统容器**（真 systemd init、固定 IP），前端 Vue 3 + shadcn 风格。

> 适合「一台宿主机上长期跑一堆 AI coding 容器（claude / codex / opencode / hermes …），又懒得每次手敲 `lxc-attach`」的场景。

---

## ⚠️ 安全须知（先读再用）

mysandbox 跑 unprivileged LXC 容器（容器 root → 宿主 uid 100000），拿不到宿主 root；
但**容器内 uid 1000 直通宿主当前用户**，且服务能读写宿主 `~/.ssh`、开宿主终端（`/ws/host-terminal`）
——**谁能调用这个服务 + 知道 token，就等于拿到了你的宿主用户账号**。

因此默认且强烈建议：

- **只监听 `127.0.0.1`**（默认）。不要为了「方便」绑 `0.0.0.0` 暴露到局域网，除非你清楚后果。CLI 在监听非 localhost 时会打印警告。
- **token 即密码**。首启随机生成、写进 `~/.config/mysandbox/config.yaml`（权限 `0600`），首次启动会打印一次。别提交、别截图外发。

> 一句话：把它当成「能用浏览器登录的宿主用户 shell」，按这个敏感度对待。

---

## 运行前提

- `/etc/subuid` / `/etc/subgid` 有 `<user>:100000:65536`（unprivileged 容器的 uid 映射段）。
- **mysandbox 必须以 systemd user service 形态运行**（cgroup 委派；裸 shell 里 `lxc-start` 会因 cgroup 权限失败）：
  `systemctl --user enable --now mysandbox` + `loginctl enable-linger <user>`。
- LXC 工具链：`apt install lxc uidmap lxcfs`（本仓按 LXC 5.0.x 开发）。
- 一座宿主网桥 + 网关 IP：容器 veth 挂到 `network` 配置的桥上，网关 = `<ipPool 前缀>.1`
  （宿主在桥上的副 IP，参考 `mysandbox-bridge-subnet.service` 的做法）。

## 功能

- **容器列表 / 生命周期**：列出受管理容器（config 带 mysandbox 标记 或 挂在配置的网桥上），启动 / 停止 / 重启 / 重命名（须先停）/ 删除。
- **网页终端**：浏览器里直接 `zsh`（或任意 shell）进容器，支持多标签、自适应尺寸、链接可点。
- **批量配置**（多选容器后）：
  - **Git 身份** —— 批量 `git config --global user.name/email`。
  - **SSH** —— 从宿主 `~/.ssh` 重新 seed，或追加公钥到 `authorized_keys`。
  - **Claude `-p`** —— 对每个容器非交互跑 prompt 并收敛输出（带超时）。
  - **通用命令** —— `sh -c <任意>`，并发执行、逐容器看 stdout/stderr/exitCode。
- **创建 / 删除**：指定名称 / IP / git 身份即可新建并启动（克隆模板，秒级）；删除连数据一起（home 在容器 rootfs 内），需输入容器名确认。
- **纳入管理（adopt）**：把外部已有容器登记进面板（只写 sidecar 元数据，不重建、不打标记），之后即可对它做生命周期 / 终端 / 批量。
- **IP 池**：固定 IP 分配（避免容器重建后 IP 漂移），池视图可视化已用 / 空闲 / 保留地址。
- **docker 配套服务**：在宿主 docker 上起单容器服务（postgres/redis/mysql/自定义镜像），固定 IP 挂在与容器同座的网桥——**容器内按服务名直连**（hosts 自动注入，如 `psql -h pg`、`redis-cli -h cache`），不发布端口到宿主。管理面板：启停 / 日志 / 删除（留卷或连卷删）。
- **容器桌面**：浏览器里直接查看/操作 LXC 容器内的 XFCE 桌面（容器内 Xvfb + x11vnc，经 mysandbox 的 WS 代理转发 RFB，前端 noVNC 渲染）。首次打开自动装桌面栈并启动，之后秒连复用；关掉窗口不杀桌面（下次打开接着用）。

---

## 安装与运行

```bash
# 全局安装（发布后）
npm install -g mysandbox
mysandbox

# 或一次性
npx mysandbox
```

首次启动会在终端打印一次 token 和访问地址：

```
>> mysandbox 0.1.0  lxc 5.0.3
>> web UI:  http://127.0.0.1:7321
>> first run — config written: ~/.config/mysandbox/config.yaml
>> token:   <48-hex>
```

浏览器打开 `http://127.0.0.1:7321`，粘贴 token 登录。

CLI 选项：

```
mysandbox [--port 7321] [--host 127.0.0.1] [-V|--version] [-h|--help]
mysandbox base <status|clone|export|import>    # 模板容器管理（image 是历史别名）
mysandbox open <path> [--container <name>]
```

环境变量：`MYSANDBOX_LOG_LEVEL=debug|info|warn|error`（默认 `info`）。

## 在浏览器打开容器文件

两个入口，殊途同归（深链 `#open?c=&p=&k=`，文件进编辑器、目录进文件面板）：

- **容器内**（推荐）：在 mysandbox 的**网页终端**里敲

  ```bash
  mysandbox            # 打开当前目录（文件面板定位到 $PWD）
  mysandbox <路径>     # 目录 -> 文件面板；文件 -> Monaco 编辑器
  ```

  命令由宿主种子写入 `~/.local/bin/mysandbox`（建容器时 + 服务启动扫描，幂等），通过 OSC 转义序列与页面联动——容器无需联网、无需 token。在 ssh 直连宿主的终端里运行只会打印提示，不产生乱码。

- **宿主侧**：

  ```bash
  mysandbox open <path> [--container <name>]
  ```

  在浏览器打开容器文件（编辑器）或目录（文件面板）。容器可按 `--container` 指定，或从宿主 cwd 位于容器 home 下自动推断。一次性命令，需 mysandbox 服务在运行。

---

## 配置

用户配置：`~/.config/mysandbox/config.yaml`（首启生成，权限 `0600`）。字段见随包 `config.default.yaml`，摘录：

```yaml
listen:
  host: 127.0.0.1     # ⚠️ 改成非 localhost 会触发启动警告
  port: 7321
lxc:
  template: ms-template   # 新建容器 = lxc-copy 克隆它（须 STOPPED）
network: br-f0cc7d98dca0  # 容器 veth 挂的宿主网桥设备名
sshSource: ""         # 宿主 ~/.ssh 源；空= 当前用户 ~/.ssh（只读进容器 /mnt/host/.ssh）
claudeSettingsTemplate: ""  # 空=不挂载
ipPool:
  from: 10.88.10.20
  to: 10.88.10.250
  reserved: [10.88.10.1, 10.88.10.2]
git:
  name: dev
  email: dev@local
ui:
  defaultShell: zsh
token: <auto>         # 首启随机生成，勿手改
```

状态文件（sidecar 元数据）：`~/.local/share/mysandbox/state.json`。

---

## 模板管理（基座）

新建容器 = `lxc-copy` 克隆模板容器。模板的制作与治理：

```bash
scripts/lxc-template.sh <容器名>   # 从零制作模板（download 装系统 + 装环境 + 契约定型）
mysandbox base clone --from <容器> [--force]   # 把调好的现有容器固化成模板
mysandbox base export [<path>]                # 模板打包 tar.zst（分发形态）
mysandbox base import <path> [--force]        # 从包恢复模板
mysandbox base status                          # 模板在不在、STOPPED 与否、大小
```

- 克隆要求模板处于 STOPPED（`lxc-copy` 对运行中的源静默失败）——`status` 会明确提示。
- export/import 的硬约束（userns 属主、idmap 来源）见 `server/engine/template.ts` 文件头。

## docker 配套服务

LXC 容器用到的数据库/缓存等服务，由 mysandbox 在宿主 docker 上统一起与管理（header「服务」徽标进面板）：

- **单容器服务**：预设 postgres / redis / mysql（表单只问密码等必填项）或任意自定义镜像 + env + 命令。
- **固定 IP、不发布端口**：服务挂在与 LXC 同座的 docker 网络（默认 `dev-lan`），从服务池 `10.88.0.200–240` 分配静态 IP。容器内**按服务名直连**——mysandbox 把 `服务名 IP` 自动注入所有容器 hosts（服务增删/启停时自动追平，容器重启不丢）。
- **数据持久**：每服务一个命名卷 `mysandbox-svc-<名>`；删除默认留卷（同名重建数据还在），「连数据删」需输入服务名确认。
- **管理边界**：mysandbox 只管理自己创建的服务（docker label 标记），宿主上其他容器（如 compose 起的）永不触碰。密码等 env 值只存本地 sidecar（`0600`），API 不回传。
- docker 不可达时面板降级提示（容器管理不受影响），`/api/health` 的 `services.available` 反映可用性。

## 宿主终端

侧栏顶部固定「宿主」条目：开一个由 server 自己管理 PTY 的宿主 shell（cwd = 宿主 home）。
交互形态与容器终端一致（tmux 会话保留：断开 60s 内刷新重连恢复；点 ✕ 真杀）。

实现：宿主 tmux 走专用 socket `-L mysandbox-host`（不碰你自己的 tmux server），`script(1)` 提供 PTY。仅支持 Linux。⚠️ 安全上注意：token 本就等价宿主用户（uid 1000 直通），宿主终端不扩大权限面，只是把宿主 shell 摆上了 UI——不要把服务暴露到非受控网络。

## 容器桌面

容器行菜单「桌面」（running 时可见）：浏览器里直接查看并操作容器内的 XFCE 桌面。

- **形态**：容器内 Xvfb（虚拟屏 `:10`）+ XFCE + x11vnc（`-nopw`，仅容器内可达）；RFB 流经 mysandbox 的 WS 代理（`/ws/desktop-vnc`，token 鉴权与终端一致）到前端 noVNC canvas。不暴露容器端口到宿主。
- **按需启动**：首次打开时若桌面栈没在跑，自动装包（模板已预装的秒过）并启动，进度实时显示；已起过则直连秒开。栈用 dev 用户跑、`setsid` 脱离会话——**关窗不杀桌面、mysandbox 重启不影响**；容器重启后下次打开自动重起。
- **窗口与分辨率**：弹窗可拖边缘/四角调整大小，右上角按钮或双击标题栏铺满整个窗口（尺寸会记住，下次打开沿用）。分辨率在连接时定（clamp 640×480–2560×1600），窗口缩放只等比缩放画面、不重设远端屏幕。

## 容器契约

mysandbox 创建容器时假设模板满足（`scripts/lxc-template.sh` 已是满足该契约的参考实现）：

- uid:gid `1000:1000` 用户名 `dev`（home `/home/dev`；uid 1000 与宿主用户直通，home 宿主可直接读写）。
- `/etc/skel-home/.zshrc` 作为首启 seed 模板；seed 由引擎在建容器时执行一次（**缺失才写**，用户改过的配置不会被覆盖）。
- 预装你需要的 CLI（claude / codex / gh …）、zsh / git / tmux / node；zsh 体验是 oh-my-zsh 基座（git 别名、history、补全、ls 颜色）+ 幽灵建议/语法高亮两个插件。
- `/etc/systemd/resolved.conf.d/mysandbox.conf` 配上游 DNS（静态 IP 无 DHCP）。
- 宿主 `~/.ssh` 只读挂到 `/mnt/host/.ssh` 供 seed 与批量 reseed。

---

## 开发

```bash
git clone <repo> && cd mysandbox
npm install                # 后端依赖
npm -C web install         # 前端依赖

npm run dev                # 后端 tsx watch（端口 7321，--host auto 绑本机默认路由 IPv4）
npm -C web run dev         # 前端 vite dev（代理 /api /ws 到 7321）

npm run build              # tsc -> dist/ + vite -> web/dist/（产物可直接 node 运行）
node dist/server/cli.js    # 跑产物验证
```

> 注意：`npm run dev`（tsx watch）是裸 shell 进程，LXC 引擎下 `lxc-start` 会因 cgroup 委派失败——
> 开发时用 `node dist/server/cli.js` 或直接 `systemctl --user start mysandbox` 跑产物。

仓库结构：

```
server/        TypeScript 后端（fastify + lxc-* CLI）
  cli.ts         入口 / 参数
  config.ts      XDG 配置加载 + token 注入
  engine/        引擎层：types.ts 接口 + lxc.ts 实现 + template.ts（模板克隆/导出导入）
  lifecycle.ts   创建（IP 分配 + 首启 seed + hosts）/ 删除
  network.ts     IP 池 + 网关计算
  batch.ts       批量 git/ssh/claude/exec（p-limit 并发）
  terminal.ts    /ws/terminal（lxc-attach PTY）
  hostTerminal.ts /ws/host-terminal（宿主 PTY）
  routes.ts      REST 路由
  base.ts        /api/base*（模板操作）+ CLI base 命令
  docker.ts      docker CLI 客户端（服务层用，label 过滤）
  services.ts    /api/services*（配套服务：预设/编排/路由）
  hosts-sync.ts  hosts 自动应用（含服务发现注入）
  state.ts       sidecar 元数据
web/           Vue 3 + Vite + Tailwind v4 前端
config.default.yaml   随包默认配置
scripts/lxc-template.sh  模板制作脚本
```

---

## License

MIT
