# mysandbox 文档（wiki 入口）

本目录是项目的**唯一详细文档区**（wiki 结构）。根目录 `AGENTS.md` 只保留代理干活必须常驻上下文的内容（简介、常用命令、Git 工作流、安全红线）——设计细节、实测坑、迁移记录全在这里，按主题速查。

## 架构与设计（architecture/）

| 文档 | 内容 | 什么时候读 |
| --- | --- | --- |
| [overview.md](architecture/overview.md) | 请求流、路由模块地图、引擎抽象、缓存/指标/配置等横切设计 | 了解代码结构、动 server/ 之前 |
| [security.md](architecture/security.md) | 安全模型、ufw 信任模型、受限账户 | **改动前必读** |
| [containers.md](architecture/containers.md) | 系统容器：基座/模板、容器契约、EngineCaps、LXC 运行约束与网络防火墙 | 碰 `server/engine/`、lifecycle、模板 |
| [services.md](architecture/services.md) | docker 服务层：compose 底账、目录注册表、后台任务、收编、IP 池、hosts 服务发现 | 碰 `server/docker*`/`service*`/`jobs.ts` |
| [terminals.md](architecture/terminals.md) | 终端体系：四侧终端、msmux、文件面板四足、peer exec、会话找回、活动监测与推送 | 碰终端/文件面板/剪贴板/msmux |
| [desktop.md](architecture/desktop.md) | 容器桌面（noVNC）与 code-server | 碰 desktop/codeserver |
| [web-proxy.md](architecture/web-proxy.md) | Web 代理：门面、鉴权、TLS、socket 激活、泛解析 | **碰代理先读它** |
| [ai-skills.md](architecture/ai-skills.md) | AI 工具与技能中心：模型供应商×绑定、技能库分发、TestLens | 碰 `aiconfig`/`skillSync`/`skills.ts` |
| [web.md](architecture/web.md) | web/ 前端约定：shadcn-vue、弱网轮询、Monaco 接法、版本号 | 改 `web/` 之前 |

## 迁移与专项记录（migrations/）

| 文档 | 内容 |
| --- | --- |
| [lxc-migration.md](migrations/lxc-migration.md) | LXC 引擎设计与实测记录（D/P 编号决策）——碰引擎先读 |
| [wsl2-migration.md](migrations/wsl2-migration.md) | WSL2 引擎设计（D5 记账等）——改 `engine/wsl2.ts` 前先读 |
| [podman-migration.md](migrations/podman-migration.md) | docker 服务层的 podman 迁移方案 |

## 笔记（notes/）

| 文档 | 内容 |
| --- | --- |
| [mobile-navigation.md](notes/mobile-navigation.md) | 移动端底部导航的信息架构与交互规则 |

截图在 `screenshots/`（README 引用）。

## 维护规则（代理必守）

- **每次功能/行为变化都要同步对应文档**：改了哪个模块，就更新本目录对应主题页（必要时加新页并登记到上面两张表 + 更新 `AGENTS.md` 的文档区速查）。
- 注释与文档均用中文。
- 文档结构即 wiki：`architecture/`（活的架构）、`migrations/`（一次性迁移与实测记录）、`notes/`（设计笔记）；新主题先想清楚归哪类，别往根目录堆文件。
- 代码注释里的文档引用一律写相对仓库根的路径（如 `docs/architecture/terminals.md`），移动文件时全局搜旧路径。
- 本文件是唯一导航入口；「什么时候读什么」的口径以这里为准。
