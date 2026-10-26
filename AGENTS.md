# AGENTS.md

本文件是**跨工具通用**的代理指南（AGENTS.md 标准）：给在本仓库里干活的 AI 编码代理看
（Claude Code / Codex / opencode / pi …）。Claude Code 走同目录的 `CLAUDE.md`，那里只有
一行 `@AGENTS.md` 导入 + Claude 专属补充——**通用约定一律写本文件，别在两处分叉**。

mysandbox：本地 dev 容器的网页控制台。后端 fastify，管理 **unprivileged LXC 系统容器**（经 `lxc-*` 命令行）；前端 Vue 3 + Vite + Tailwind v4（shadcn-vue 风格，reka-ui）。注释与文档均用中文，新代码保持一致。

业务层只 import `server/engine/index.js`，不直接碰 `engine/lxc.ts`（**此约定限于容器引擎**——docker 服务层经 `server/docker.ts` 自持 docker 访问，不经过 engine）。

## 文档区（docs/）

**docs/ 是唯一详细文档区**（wiki 结构，入口 [`docs/index.md`](docs/index.md)）：架构设计在 `docs/architecture/`、迁移与实测记录在 `docs/migrations/`、设计笔记在 `docs/notes/`。本文件只留代理必须常驻上下文的内容，细节全在 docs——**动手前按主题读对应文档**：

| 要碰的东西 | 先读 |
| --- | --- |
| `server/engine/`、lifecycle、模板/基座 | [containers.md](docs/architecture/containers.md)（+ [migrations/lxc-migration.md](docs/migrations/lxc-migration.md)） |
| `server/docker*`/`service*`/`jobs.ts`（应用容器） | [services.md](docs/architecture/services.md) |
| 终端/文件面板/msmux/SSH/剪贴板/活动提醒 | [terminals.md](docs/architecture/terminals.md)（+ [notes/mobile-keyboard-qa.md](docs/notes/mobile-keyboard-qa.md) 手机软键盘真机验收） |
| Web 代理（`proxy.ts`/`facade.ts`/`lib/proxy.ts`） | [web-proxy.md](docs/architecture/web-proxy.md) |
| `aiconfig`/`skillSync`/技能库/TestLens | [ai-skills.md](docs/architecture/ai-skills.md) |
| desktop/code-server | [desktop.md](docs/architecture/desktop.md) |
| `web/` 前端 | [web.md](docs/architecture/web.md) |
| 横切设计（路由/缓存/指标/配置） | [overview.md](docs/architecture/overview.md) |

**每次功能/行为变化都要同步对应文档**（改了哪个模块就更新对应主题页；新主题先想清楚归 architecture/migrations/notes 哪类，并登记进 `docs/index.md` 与上表）。

## 常用命令

```bash
npm install                # 后端依赖
npm -C web install         # 前端依赖（独立 package.json，无 workspace）

npm run dev                # 后端 tsx watch，监听 7321（--host auto 绑本机默认路由 IPv4；⚠️ 裸 shell 下 lxc-start 会失败，见下）
npm -C web run dev         # 前端 vite dev（5173，/api 与 /ws 代理到 7321）
npm run typecheck          # 后端 tsc --noEmit
npm -C web run build       # 前端 vue-tsc -b && vite build（类型检查只在这里）
npm run build              # 全量：tsc -> dist/ + vite -> web/dist/
node dist/server/cli.js    # 跑产物验证
```

没有测试框架；改动后验证方式是 `npm run typecheck` + `npm -C web run build` + 实际起服务走一遍流程。

CLI 子命令：`mysandbox [--port] [--host]`，`mysandbox base <动作>`（模板操作：status/clone/export/import，`mysandbox image` 是历史别名），`mysandbox status`（宿主上全部 mysandbox 资产总览：容器/模板/docker 服务与卷/宿主终端会话/瞬态单元/sidecar，只读、各段独立降级、不需要服务在跑），`mysandbox firewall print`（按 config 算出期望 ufw 规则，`server/firewall.ts`，免 root），`mysandbox logs [N] [--raw]`（服务日志尾部，读落盘文件，不需要服务在跑），`mysandbox open <路径>`，`mysandbox exec <目标> -- 命令`（peer，见 [terminals.md](docs/architecture/terminals.md)），`mysandbox targets`（SSH 目标清单管理），`mysandbox skills ls|update`（技能库清单/显式更新，见 [ai-skills.md](docs/architecture/ai-skills.md)），`mysandbox mux deploy|agents`（见 [terminals.md](docs/architecture/terminals.md)）。日志级别 `MYSANDBOX_LOG_LEVEL=debug`。日志双路：journald（`journalctl --user -u mysandbox`，已持久化）+ 按天文件 `~/.mysandbox/logs/mysandbox-<date>.log`（JSON 行，`server/logger.ts` multistream，留 14 天；文件名带日期、换档不 rename，跨进程追加安全）。

模板制作：`scripts/lxc-template.sh <容器名>`。

## Git 工作流

每次更改完成后（typecheck/build 验证通过），必须本地合入 `main` 分支并推送到远端（`origin/main`）。改动不留未提交状态、不滞留在旁支分支。

**提交前 bump 版本号**：改根 `package.json` 的 `version`（默认 patch 一档；成块的功能/行为变更升 minor）。界面版本号（侧栏品牌块 / 手机终端切换 sheet）与 `/api/health` 都读它，漏 bump 界面就停在旧版本号；同一 commit 带上，别攒。

## 安全模型（红线，详版见 [security.md](docs/architecture/security.md)）

**拿到 token 等于拿到宿主属主用户的完整权限**（容器内 uid 1000 直通宿主属主用户——D1，详见 [security.md](docs/architecture/security.md)）。红线不变：

- 只监听 `127.0.0.1`（默认）；非 localhost 监听时 CLI 必须打印警告。
- 所有 `/api/*` 与 `/ws/*`（除 `/api/health`）经 `server/auth.ts` 的 token 鉴权 hook；新路由注册在路由模块即自动被覆盖，**不要绕过**。`/proxy/*` 也在 hook 内且额外收 cookie。
- sidecar 文件（state.json、config.yaml）权限 `0600`。
- `/api/health` 免鉴权，所以它只暴露版本/引擎连通性/`caps`——**不要往里加容器名、路径、配置值**。
- ufw 信任模型：自管网段（LXC/services）= 完全可信（INPUT 全端口 blanket），隔离对象只有外部网段（`firewall.allow` 逐端口放行）；验证防火墙要用**宿主自有端口**，别拿 docker-proxy 发布的容器端口测。
- 受限账户：主 token 之外可开容器白名单账户（仅终端+文件面板），身份解析与 deny-by-default 收口在 `index.ts` 鉴权 hook——新增 owner 路由默认对账户关闭，失败方向安全。

## 环境备注

- LXC 引擎需 `/etc/subuid`/`subgid` 有 `leon:100000:65536`、且 mysandbox 以 systemd user service 跑（linger 开着）。运行环境约束（systemd-run、网桥/防火墙、machine-id 随机化等坑）见 [containers.md](docs/architecture/containers.md)。
- LXC 版本是 apt 的 **5.0.3**（刻意不用源码编译的 7.0）。容器落 `~/.local/share/lxc/<name>/`。
- docker 服务层需 leon 在 `docker` 组（免 sudo 走 CLI）+ docker 服务网络 `mysandbox-lan`（自持：缺失按服务池网段自动重建；手工建会落到 docker 默认池与 LXC 网段不通）。group 成员资格在 systemd user manager 启动时快照——后加组要 `systemctl --user daemon-restart`。
- 容器 zsh 是 oh-my-zsh 基座（`/usr/share/oh-my-zsh`，模板脚本 clone 后须 `chmod g-w,o-w`——compaudit 拒 group/other 可写目录）：omz 自带的别手搓，`scripts/zshrc` 只补 omz 没有的（`ll`/`la`、autosuggestions + syntax-highlighting 插件、OSC 2 动态标题钩子——web tab 标签链路依赖）。老容器 `~/.zshrc` 是首启 seed 的持久化副本不会被覆盖——换新配置要手工从 `/etc/skel-home/.zshrc` 重拷。


## 额外验收要求

每轮开发完成后，请以「UI 走查 / 视觉验收」角色，基于本轮需求或设计稿，对提供的界面截图进行视觉验证。
检查：布局对齐、间距、颜色、字体、图标、组件状态（默认/悬停/聚焦/禁用/加载/错误）、弹窗遮罩层级、文本溢出与空态、响应式、与设计稿一致性、是否引入回归问题。
输出：按 P0/P1/P2 列出问题（位置 + 现象 + 期望 + 修复建议），不确定标“需人工确认”。最后给结论：通过 / 有条件通过 / 不通过，并列出优先修复项。
