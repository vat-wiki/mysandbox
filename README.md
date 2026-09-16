# mysandbox

本地开发容器（dev container）的网页控制台：浏览器里开终端 / 浏览编辑文件、批量改 git/ssh、
自由创建删除容器，外加 docker 配套服务、AI 技能与网关配置的分发、面板外访问容器端口的 web 代理。
后端管理 **unprivileged LXC 系统容器**（真 systemd init、固定 IP），前端 Vue 3 + shadcn 风格。

> 适合「一台宿主机上长期跑一堆 AI coding 容器（claude / codex / opencode / hermes …），又懒得每次手敲 `lxc-attach`」的场景。

---

## ⚠️ 安全须知（先读再用）

mysandbox 跑 unprivileged LXC 容器（容器 root → 宿主 uid 100000），拿不到宿主 root；
但**容器内 uid 1000 直通宿主当前用户**，且服务能读写宿主 `~/.ssh`、开宿主终端（`/ws/host-terminal`）
——**谁能调用这个服务 + 知道 token，就等于拿到了你的宿主用户账号**。

因此默认且强烈建议：

- **只监听 `127.0.0.1`**（默认）。不要为了「方便」绑 `0.0.0.0` 暴露到局域网，除非你清楚后果。CLI 在监听非 localhost 时会打印警告。
- **token 即密码**。首启随机生成、写进 `~/.mysandbox/config.yaml`（权限 `0600`），首次启动会打印一次。别提交、别截图外发。

> 一句话：把它当成「能用浏览器登录的宿主用户 shell」，按这个敏感度对待。

---

## 运行前提

> 下面的前提 `install.sh` 会全部自动配好——本节供手工安装 / 逐条审计用。

- `/etc/subuid` / `/etc/subgid` 有 `<user>:100000:65536`（unprivileged 容器的 uid 映射段）。
- **mysandbox 必须以 systemd user service 形态运行**（cgroup 委派；裸 shell 里 `lxc-start` 会因 cgroup 权限失败）：
  `systemctl --user enable --now mysandbox` + `loginctl enable-linger <user>`。
- LXC 工具链：`apt install lxc uidmap lxcfs iptables zstd`（本仓按 LXC 5.0.x 开发；zstd 是 base export 的 tar --zstd 必需）。
- 一座宿主网桥 + 网关 IP：容器 veth 挂到 `network` 配置的桥上（自有桥 `mysandbox0`，参考
  `mysandbox-net.service`：桥 + 网关副 IP + 出网 MASQUERADE），网关 = `<ipPool 前缀>.1`。
  与 docker 服务网段互通需 `mysandbox-docker-interop.service`（DOCKER-USER 放行）+ ufw 转发 ACCEPT。
- 防火墙（ufw）放行自管：宿主 ↔ 容器 ↔ docker 服务三方互通所需的 ufw 规则由
  `mysandbox-firewall.service` 按 config 计算应用（幂等、只增不删；详见 `server/firewall.ts`，
  `mysandbox firewall print` 可预览期望规则）。

## 功能

- **容器生命周期**：列出受管理容器（config 带 mysandbox 标记 或 挂在配置的网桥上），启动 / 停止 / 重启 / 重命名（须先停）/ 删除；指定名称 / IP / git 身份即可新建（克隆模板，秒级），删除连数据一起、需输入容器名确认。
- **网页终端**：浏览器里直接 `zsh`（或任意 shell）进容器，多标签、自适应尺寸、链接可点；会话本体在服务端 tmux 里——关浏览器、重启 mysandbox 都不丢，跨浏览器窗口可找回接入。
- **文件面板与编辑器**：容器 / 宿主 / docker 服务 / SSH 主机四处同形态——目录树 + Monaco 编辑器（未保存提示、Ctrl+S）、上传下载、跨面板复制、git 状态/暂存/提交/撤销可视化。
- **批量配置**（多选容器后）：git 身份、SSH 重 seed / 追加公钥、Claude `-p` 非交互 prompt、任意 `sh -c` 命令（并发执行、逐容器看结果）。
- **纳入管理（adopt）**：把外部已有容器登记进面板（只写 sidecar 元数据，不重建、不打标记），之后即可对它做生命周期 / 终端 / 批量。
- **IP 池**：固定 IP 分配（避免容器重建后 IP 漂移），池视图可视化已用 / 空闲 / 保留地址。
- **docker 配套服务**：compose 底账管理数据库/缓存等服务，容器内按服务名直连（详见下文）。
- **Web 代理**：面板外经基域名访问容器/服务的 HTTP 端口（详见下文）。
- **AI 工具**：技能中心（技能库分发到本机 + 全部容器）+ AI 网关（provider/绑定统一落盘 claude/codex/opencode/pi 配置）（详见下文）。
- **容器桌面**：浏览器里直接查看/操作 LXC 容器内的 XFCE 桌面（容器内 Xvfb + x11vnc，经 mysandbox 的 WS 代理转发 RFB，前端 noVNC 渲染）。首次打开自动装桌面栈并启动，之后秒连复用；关窗不杀桌面（下次打开接着用）。

---

## 安装与运行

### 一键安装（唯一需要 sudo 的一步）

```bash
git clone <repo> mysandbox && cd mysandbox
sudo ./scripts/install.sh        # --user <name> 指定属主（默认 SUDO_USER）；--uninstall 反操作
```

之后运行时**全程无 root**。脚本幂等可重跑（仓库 unit 改动后重跑即同步到 /etc）。它做的事：

| 层 | 步骤 |
|---|---|
| 系统级（root） | apt 装 `lxc uidmap lxcfs iptables zstd`；`/etc/subuid`+`/etc/subgid` 追加 `<user>:100000:65536`；`/etc/lxc/lxc-usernet` 放行 veth；落盘三个 system unit（`mysandbox-net` 建桥+网关+MASQUERADE、`mysandbox-firewall` 应用 ufw 规则、`mysandbox-docker-interop` 跨桥放行，docker 缺失时跳过）；网关 `IP:53` 无应答方时落 `DNSStubListenerExtra`（容器 resolved 的上游，自配 DNS 的机器自动跳过）；生成用户级 `default.conf`（idmap 按属主 uid/gid，宿主用户不必是 uid 1000）；`loginctl enable-linger` |
| 用户级（runuser 切回） | `npm install` + `npm run build`（缺才做，`--rebuild` 强制）；写 `~/.config/systemd/user/mysandbox.service`（ExecStart 用 node 绝对路径——user manager 不继承交互 shell 的 PATH）；`systemctl --user enable --now` |

> 安全模型的关键：需要特权的操作全部收敛成**独立 system unit**（由 systemd 而非 sudoers 界定边界），
> mysandbox 服务本体以普通用户跑——这是 unprivileged LXC 的 cgroup 委派要求，也是 token 泄露
> 爆炸半径的上限（宿主用户而非整机 root，见「安全须知」）。

### 首次启动

服务装完即起（`systemctl --user status mysandbox` 查看）。首次启动打印一次 token：

```
>> mysandbox 0.1.0  lxc 5.0.3
>> web UI:  http://127.0.0.1:7321
>> first run — config written: ~/.mysandbox/config.yaml
>> token:   <48-hex>
```

浏览器打开访问地址（探活失败的看 `journalctl --user -u mysandbox`），粘贴 token 登录。

还差一步——**制作模板容器**（新建容器 = 克隆它，跑完记得 stop）：

```bash
sudo -u <user> scripts/lxc-template.sh ms-template   # 10-20 分钟（apt + npm 为主）
# 或从既有包恢复: mysandbox base import <path>
```

### 手动安装（逐条审计用）

不想跑脚本的话，上表的每一步都可以手工做——unit 模板在 `scripts/*.service`（占位符
`__MSB_DIR__`/`__MSB_USER__`/`__MSB_NODE__`/`__MSB_BRIDGE__`/`__MSB_SUBNET__`/`__MSB_GW__`，
sed 填充后放 `/etc/systemd/system/`），user unit 形状见上表/`scripts/install.sh` 第 8 步。
核心约束只有四条：cgroup 委派（服务必须在 user manager 里）、subuid/subgid 映射段、
桥 + 网关 IP + MASQUERADE（`mysandbox-net.service` 的职责）、容器上游 DNS（网关 IP:53
要有应答方——resolved 的 `DNSStubListenerExtra` 或自配 DNS 服务）。

CLI 选项：

```
mysandbox [--port 7321] [--host 127.0.0.1] [-V|--version] [-h|--help]
mysandbox base <status|clone|export|import>    # 模板容器管理（image 是历史别名）
mysandbox exec <目标> -- <命令>     # 容器间命令互通：host | c:<容器> | s:<服务> | 裸名（免 ssh）
mysandbox targets                  # 列 exec 可达目标
mysandbox open <path> [--container <name>]
mysandbox skills [sync|update|ls]  # 技能分发：同步 / 从来源更新库技能 / 列表
mysandbox status [--json]          # 宿主资产总览（只读，不需要服务在跑）
mysandbox firewall print           # 预览期望的 ufw 放行规则（免 root）
mysandbox logs [N] [--raw]         # 服务日志尾部（读落盘文件，不需要服务在跑）
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

用户配置：`~/.mysandbox/config.yaml`（首启生成，权限 `0600`；旧 XDG 路径首启自动迁移）。字段见随包 `config.default.yaml`，摘录：

```yaml
listen:
  host: 127.0.0.1     # ⚠️ 改成非 localhost 会触发启动警告
  port: 7321
lxc:
  template: ms-template   # 新建容器 = lxc-copy 克隆它（须 STOPPED）
network: mysandbox0  # 容器 veth 挂的宿主网桥设备名（mysandbox-net.service 自建）
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

状态文件（sidecar 元数据）：`~/.mysandbox/state.json`——mysandbox 自有数据单一根都在 `~/.mysandbox/`（config、compose 底账、ai/、logs/、tls/），备份/搬机拷走整个目录即可。

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

LXC 容器用到的数据库/缓存等服务，由 mysandbox 在宿主 docker 上统一起与管理（侧栏「应用容器」分区，与系统容器同款卡片交互；点卡片进服务终端，⋯ 开服务抽屉）：

- **compose 底账，文件是唯一配置真相**：一服务 = `~/.mysandbox/compose/<名>/compose.yaml`。创建/改配置/删除全以文件为准——抽屉配置页改的是它，终端手改再点「应用」等价（Monaco 编辑 + Ctrl+S，`up -d` 幂等收敛）；容器实际跑的与文件有漂移时配置页可见。
- **目录注册表（agent 友好）**：`compose/<名>/` 目录本身就是服务清单——放一份 compose.yaml（顶层 `name:` = 目录名）+ `docker compose up -d`，面板即出现该服务；原生多服务 compose 项目整栈一张卡（锚在带发布端口的成员上，其余成员折叠管理）。
- **收编外部容器**：侧栏 Inbox 入口。裸容器（`docker run` 起家）可「接管式收编」——按现状生成 compose 底账后重建，之后可删可改；已归其它编排管的 compose 栈可只读收编（启停走原编排方，所有权不抢）。
- **固定 IP、不发布端口**：服务挂在与 LXC 互通的 docker 网络（默认 `mysandbox-lan`），从服务池分配静态 IP。容器内**按服务名直连**——mysandbox 把 `服务名 IP` 自动注入所有容器 hosts（服务增删/启停自动追平，容器重启不丢），如 `psql -h pg`。
- **服务终端与文件面板**：服务容器里跑 shell（宿主 tmux 窗口承载，跨 mysandbox 重启存活），文件面板/编辑器与容器终端同形态。
- **数据持久**：每服务一个命名卷 `mysandbox-svc-<名>`；删除默认留卷（同名重建数据还在），「连数据删」需输入服务名确认。
- **长操作都是后台任务**：创建/应用/迁移/收编提交即返回 jobId，面板看流式日志、可取消，完成弹 toast；面板外用 `docker compose` 改动也会被事件追平。
- **管理边界**：未收编的外部容器结构性进不了列表、操作必 404；docker 不可达时面板降级提示（容器管理不受影响）。

## Web 代理

容器/服务在自管私网里，外部设备只能摸到宿主——把出口收进面板（同监听端口、同一 token）：

- **域名门面**：`http://<名>-<端口>.<基域名>:<port>`（cookie 会话）+ `/proxy/...` 子路径兜底。基域名 auto = 本地域 → LAN sslip → tailscale sslip 逐个探测择优、全败自动降级子路径；自有泛解析域名配 `proxy.vhost` 最稳。
- **双口径平级**：从 `IP:7321` 打开控制台 → 端口点击直连 `IP:端口`（无 cookie 依赖）；从基域名打开 → 走代理。服务端不重定向、不强制任何一方。
- **TLS**：`listen.tls: true` 开自签 HTTPS（本地 CA + 泛域名叶子证书，持久化在 `~/.mysandbox/tls/`）。浏览器信任一次即可：控制台 `/tls-ca.crt` 下载导入（Chromium 走 NSS 库 `~/.pki/nssdb`，导入后重启浏览器）。
- **端口免带门面（可选）**：`https://mysandbox.test/`（443 是 https 默认口，不带 `:7321`）。443 是特权端口而 mysandbox 是无特权 user service（user unit 拿不到 `CAP_NET_BIND_SERVICE`），所以走 systemd socket 激活：root 的 systemd 持被动监听 fd（空闲零进程），连接进来拉起 `systemd-socket-proxyd` 字节级透传到 mysandbox 的 listen 端口——TLS/WS/cookie 全原样，mysandbox 本体零改动零提权。双 unit 模板在 `scripts/mysandbox-console.{socket,service}`（install.sh 按 config listen 落盘启用；不要了 `sudo systemctl disable --now mysandbox-console.socket` 即退回带端口口径）。基域名需要 DNS 应答（本机 mihomo hosts / 外部各自配）；外部网段访问 443 加 `firewall.allow` 条目。

## AI 工具（技能中心 + AI 网关）

面板「AI 工具」板块管两件事，都自动铺到本机 + 全部受管容器——宿主直写 rootfs，**容器不必在跑**，CLI 下次启动即生效：

- **技能中心**：技能库是唯一真相源（`~/.mysandbox/ai/skills/`），安装规则决定哪些技能装到哪（全局 = 本机 + 全部受管容器；或指定项目目录，项目克隆到哪技能跟到哪）。服务启动 / 库变动 watch / 新建容器自动追平，也可面板「立即同步」或 `mysandbox skills sync`。库内技能是入库时刻的快照，更新 = 显式动作（面板「更新」/ `mysandbox skills update`）。
- **AI 网关**：provider 库（N 个 OpenAI/Anthropic 兼容网关的凭据与端点）× 绑定（claude / codex / opencode / pi 各用哪些 provider）。改 key 面板重推即全局生效；落盘幂等（JSON 只深改本方案的键、TOML/zshrc 用锚点块整块替换），不碰用户其余配置。本机是真实环境，只有显式目标覆盖才写。

## 终端（本机 + SSH 主机）

侧栏底部「终端」区：**本机**条目开一个由 server 自己管理 PTY 的宿主 shell（cwd = 宿主 home）；
下方可添加 **SSH 主机**，直接进远程主机的终端。交互形态与容器终端一致（tmux 会话保留：
断开 60s 内刷新重连恢复；点 ✕ 真杀）。

- **本机**：宿主 tmux 走专用 socket `-L mysandbox-host`（不碰你自己的 tmux server），`script(1)` 提供 PTY。仅支持 Linux。
- **SSH 主机**：会话本体在**远端** tmux 的专用 socket `-L mysandbox-ssh` 上，跨本机/远端重启存活；凭据全走本机 ssh（密钥 / agent / `~/.ssh/config` 别名含跳板机），面板只存「怎么连」不存密码。远程主机只是终端的延伸，**不是被管理对象**——文件面板是刻意保留的唯一例外（浏览/编辑/git），没有批量操作、hosts 注入这些容器能力。
- **会话找回**：tab 布局是各浏览器自己的 localStorage，但会话本体在服务端 tmux 活着——终端栏的归档图标可扫出全部存活会话，跨窗口/跨浏览器一键接入（现场全保留）；tab 右键「隐藏」只是收起（会话保留），点 ✕ 才是真杀。
- ⚠️ 安全上注意：token 本就等价宿主用户（uid 1000 直通），本机与 SSH 终端都不扩大权限面（拿着 token 本就能 ssh 到任何可达主机）——不要把服务暴露到非受控网络。

## 容器桌面

容器行菜单「桌面」（running 时可见）：浏览器里直接查看并操作容器内的 XFCE 桌面。

- **形态**：容器内 Xvfb（虚拟屏 `:10`）+ XFCE + x11vnc（`-nopw`，仅容器内可达）；RFB 流经 mysandbox 的 WS 代理（`/ws/desktop-vnc`，token 鉴权与终端一致）到前端 noVNC canvas。不暴露容器端口到宿主。
- **按需启动**：首次打开时若桌面栈没在跑，自动装包（模板已预装的秒过）并启动，进度实时显示；已起过则直连秒开。栈用 dev 用户跑、`setsid` 脱离会话——**关窗不杀桌面、mysandbox 重启不影响**；容器重启后下次打开自动重起。
- **窗口与分辨率**：弹窗可拖边缘/四角调整大小，右上角按钮或双击标题栏铺满整个窗口（尺寸会记住，下次打开沿用）。分辨率在连接时定（clamp 640×480–2560×1600），窗口缩放只等比缩放画面、不重设远端屏幕。

## 容器契约

mysandbox 创建容器时假设模板满足（`scripts/lxc-template.sh` 已是满足该契约的参考实现）：

- uid:gid `1000:1000` 用户名 `dev`（home `/home/dev`；经 idmap 直通宿主**属主用户**——install.sh 按属主 uid/gid 生成映射，宿主用户不必是 uid 1000，home 宿主可直接读写）。
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
  sshTerminal.ts /ws/ssh-terminal（SSH 主机终端，目标存 sidecar）
  proxy.ts / tls.ts   Web 代理（vhost + 子路径门面）与自签 TLS
                      （443 端口免带门面 = systemd socket 激活透传，scripts/mysandbox-console.*）
  skillSync.ts / aiconfig.ts   技能分发 / AI 网关落盘（宿主直写 rootfs）
  routes.ts      REST 路由
  base.ts        /api/base*（模板操作）+ CLI base 命令
  docker.ts      docker CLI 客户端（服务层用，label 过滤）
  services.ts    /api/services*（配套服务：预设/编排/路由）
   hosts-sync.ts  hosts 自动应用（含服务发现注入）
   firewall.ts    宿主 ufw 放行规则计算（mysandbox firewall print）
   state.ts       sidecar 元数据
web/           Vue 3 + Vite + Tailwind v4 前端
config.default.yaml   随包默认配置
scripts/lxc-template.sh  模板制作脚本
scripts/mysandbox-firewall.sh(.service)  ufw 放行应用脚本 + 系统单元
```

---

## License

MIT
