# mysandbox

<!-- TODO: 补两张截图/一段 GIF——①容器列表+网页终端 ②文件面板/桌面。UI 产品第一屏说服力主要靠这个。 -->

**浏览器里的 AI 开发容器机**。在一台 Linux 宿主机上跑一摞互相隔离的 dev 容器（每个跑一个
claude / codex / opencode …），终端、文件编辑、git、桌面、端口出口全收进同一个网页面板。
后端管理 **unprivileged LXC 系统容器**（真 systemd init、固定 IP），前端 Vue 3 + shadcn 风格。

> 适合「一台宿主机长期跑一堆 AI coding 容器，又懒得每次手敲 `lxc-attach`」的场景——
> 面板外只用 docker 起数据库，不用 lxc，也不用本工具。

## 为什么用它

- **秒级开新容器**：填名称 / IP / git 身份，克隆模板即得——zsh、node、AI CLI、tmux 已就位。
- **终端关不掉**：会话本体在服务端 tmux 里，关浏览器、重启 mysandbox 都不丢，换窗口可找回。
- **四处文件面板一个形态**：容器 / 宿主 / docker 服务 / SSH 主机，目录树 + Monaco 编辑器 +
  上传下载 + git 可视化，面板间跨复制。
- **AI 环境集中分发**：技能库 + 模型网关（provider 凭据）一处配置，铺到本机与全部容器。
- **端口不出私网**：容器/服务端口经面板的 web 代理访问，一个监听端口、一套 token。
- **无 root 运行**：mysandbox 以普通用户跑 systemd user service；容器 unprivileged
  （容器 root → 宿主 uid 100000），需要特权的操作收敛成独立系统单元。
- Windows 也支持：WSL2 引擎（一个「容器」= 一个 WSL2 发行版实例），见下文安装。

## 快速开始（Linux）

```bash
git clone <repo> mysandbox && cd mysandbox
sudo ./scripts/install.sh        # 唯一需要 sudo 的一步：装 LXC 工具链、建桥、注册 systemd 自启、构建
sudo -u $USER scripts/lxc-template.sh ms-template   # 制作模板容器（10–20 分钟，一次性）
```

然后浏览器打开 `http://127.0.0.1:7321`，粘贴 token 登录（首启打印一次，
看 `journalctl --user -u mysandbox` 或 `mysandbox logs`）。

> 有现成模板包的话可跳过制作脚本：`mysandbox base import <path>`（tar.zst，
> 由 `mysandbox base export` 打出）。

运行前提：Linux + node ≥ 20；`install.sh` 会自动配好其余全部（subuid/subgid、网桥、
防火墙、linger）。docker 可选——装了才有「应用容器」（postgres/redis 等配套服务）。

### Windows（WSL2 引擎）

Windows 上不用 LXC，日常操作由 `scripts/win/mysandbox.ps1` 包办，只需系统自带组件：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\win\mysandbox.ps1 install   # 注册登录自启 + 自愈
powershell -ExecutionPolicy Bypass -File scripts\win\mysandbox.ps1 status
```

动作：`install | uninstall | start | stop | restart | status | update | logs`。
注意：WSL2 引擎下 docker 服务层 / peer / 代理尚未移植，属预期现象。

## ⚠️ 安全须知（先读再用）

容器内 uid 1000 直通宿主属主用户，且服务能读写宿主 `~/.ssh`、开宿主终端——
**谁能调用这个服务 + 知道 token，就等于拿到了你的宿主用户账号**。

- **只监听 `127.0.0.1`**（默认；非 localhost 监听会打印警告）。远程访问走 tailscale 等
  受控网络，不要裸暴露到局域网/公网。
- **token 即密码**：首启随机生成、写入 `~/.mysandbox/config.yaml`（0600）。别提交、别截图外发。

> 把它当成「能用浏览器登录的宿主用户 shell」，按这个敏感度对待。

## 功能一览

- **容器生命周期**：列出/新建/启停/重启/改名/删除受管容器（删除需输容器名确认）；外部已有
  容器可「adopt」纳入管理（只登记元数据，不重建）。
- **网页终端**：多标签、自适应尺寸、链接可点；多窗口「隐藏/找回」；另含**宿主终端**与
  **SSH 主机终端**（远端 tmux 承载，跨重启存活）。
- **文件面板与编辑器**：见上「为什么用它」；`mysandbox open <路径>` 或容器内敲
  `mysandbox` 可从终端直达（OSC 深链）。
- **批量配置**：多选容器后并发执行 git 身份 / SSH 重 seed / Claude `-p` / 任意命令。
- **docker 配套服务**（「应用容器」）：compose 文件是唯一配置真相，固定 IP + 按服务名直连
  （hosts 自动注入），数据在命名卷，长操作都是可取消的后台任务。
- **Web 代理**：容器/服务端口经 `<名>-<端口>.<基域名>` 域名门面或 `/proxy/...` 子路径访问；
  可开自签 TLS、systemd socket 激活做到 `https://mysandbox.test/` 免带端口。详见
  `docs/web-proxy.md`。
- **AI 工具**：技能中心（库 → 按规则分发到本机+全部容器，项目克隆跟铺）+ AI 网关
  （provider × 绑定，落盘 claude/codex/opencode/pi 各自配置文件，幂等不碰用户其余配置）。
- **容器桌面**：浏览器里看/操作容器内 XFCE 桌面（noVNC），首次自动装栈，关窗不杀桌面。
- **IP 池**：固定 IP 分配防漂移，池视图可视化已用/空闲/保留。
- **`mysandbox status`**：宿主全部资产总览（容器/模板/服务/终端会话），只读、不需要服务在跑。

CLI：

```
mysandbox [--port 7321] [--host 127.0.0.1]
mysandbox base <status|clone|export|import>   # 模板容器管理
mysandbox exec <目标> -- <命令>               # host | c:<容器> | s:<服务> | 裸名（免 ssh）
mysandbox targets | open | skills | status | firewall print | logs   # 其余子命令 --help
```

## 配置

全部自有数据收在 `~/.mysandbox/`（config、compose 底账、技能库、日志、TLS 证书），备份/搬机
拷走整个目录即可。用户配置 `~/.mysandbox/config.yaml` 首启生成，字段见 `config.default.yaml`
（监听地址、模板名、网桥、IP 池、git 身份、代理基域名等）。

模板治理：

```bash
scripts/lxc-template.sh <容器名>              # 从零制作（download 装系统 + 装环境）
mysandbox base clone --from <容器> [--force]  # 把调好的现有容器固化成模板
mysandbox base export [<path>]                # 打包 tar.zst（分发形态）
mysandbox base status                         # 在不在、STOPPED 与否、大小
```

克隆要求模板 STOPPED（`lxc-copy` 对运行中的源静默失败）。模板需满足的容器契约
（uid 1000 `dev`、seed 规则等）以 `scripts/lxc-template.sh` 为参考实现。

## 开发

```bash
npm install && npm -C web install   # 前后端独立 package.json
npm run dev                         # 后端 tsx watch（⚠️ 裸 shell 下 lxc-start 会失败，跑产物见下）
npm -C web run dev                  # 前端 vite dev，/api /ws 代理到 7321
npm run typecheck && npm run build  # 验证（前端类型检查在 build 里）
node dist/server/cli.js             # 跑产物（LXC 引擎下开发期建议用这个或 systemctl --user start mysandbox）
```

架构与设计约定见 `AGENTS.md`（后端 fastify，业务层只 import `server/engine/` 的引擎抽象）；
引擎相关的实测记录在 `docs/`（lxc 迁移 / WSL2 / web 代理）。

## License

MIT
