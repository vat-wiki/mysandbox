# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

mysandbox：本地 dev 容器的网页控制台。后端 fastify + dockerode 直连 `/var/run/docker.sock`；前端 Vue 3 + Vite + Tailwind v4（shadcn-vue 风格，reka-ui）。注释与文档均用中文，新代码保持一致。

## 常用命令

```bash
npm install                # 后端依赖
npm -C web install         # 前端依赖（独立 package.json，无 workspace）

npm run dev                # 后端 tsx watch，监听 127.0.0.1:7321
npm -C web run dev         # 前端 vite dev（5173，/api 与 /ws 代理到 7321）
npm run typecheck          # 后端 tsc --noEmit
npm -C web run build       # 前端 vue-tsc -b && vite build（类型检查只在这里）
npm run build              # 全量：tsc -> dist/ + vite -> web/dist/
node dist/server/cli.js    # 跑产物验证
```

没有测试框架；改动后验证方式是 `npm run typecheck` + `npm -C web run build` + 实际起服务走一遍流程。

CLI 子命令：`mysandbox [--port] [--host]`，`mysandbox image build|pull|push|status`，`mysandbox open <路径>`。日志级别 `MYSANDBOX_LOG_LEVEL=debug`。

## 安全模型（改动前必读）

服务直连宿主 `docker.sock`，拿到 token 等于宿主 root。因此：

- 只监听 `127.0.0.1`（默认）；非 localhost 监听时 CLI 必须打印警告。
- 所有 `/api/*` 与 `/ws/*`（除 `/api/health`）经 `server/auth.ts` 的 token 鉴权 hook；新路由注册在 `routes.ts` / `image.ts` / `terminal.ts` 即自动被覆盖，不要绕过。
- sidecar 文件（state.json、hosts.txt、config.yaml）权限 `0600`。

## 架构

### server/（NodeNext ESM，import 要带 `.js` 后缀）

请求流：`cli.ts`（入口/参数/config 加载）→ `index.ts buildServer()`（websocket + static + 鉴权 hook + 错误处理）→ 路由四块：`routes.ts`（REST）、`image.ts`（镜像 build/pull/push）、`terminal.ts`（`/ws/terminal`，docker exec PTY）、`hostTerminal.ts`（`/ws/host-terminal` + `/api/host-terminal/cwd`，宿主 PTY）。

关键设计：

- **dockerode 单例与容器操作**在 `docker.ts`；创建/删除在 `lifecycle.ts`（IP 分配 + data 目录预建 + 固定 IP），IP 池计算在 `network.ts`。
- **受管理容器的判定**：在配置的网络上，或带 mysandbox 标签。标签不可变，所以易变元数据（displayName、adopted、tags 等）走 **sidecar JSON**（`state.ts`，存 XDG data 目录，容器名作 key）。adopt 外部容器只写 sidecar，不动 docker 对象。
- **批量操作**（git 身份 / ssh reseed / claude -p / 任意命令）在 `batch.ts`，用 p-limit 并发，底层 exec 走 `docker.ts` 的 execRun。
- **hosts**：`hosts.ts` 是全局 hosts 的单一事实源（routes 和 lifecycle 都 import）。自定义内容存 `hosts.txt` sidecar 纯文本；宿主 `/etc/hosts` 实时读取不缓存。
- **错误处理**：抛 `errors.ts` 的 `HttpError`（带 code/status），`wrapDocker` 把 dockerode 404 映射为 `not_found`。
- **配置**：`config.ts` 从 `config.default.yaml` 读默认 + `~/.config/mysandbox/config.yaml` 覆盖，首启生成随机 token。
- **容器内 mysandbox 命令**（`container-cli.ts`）：脚本由宿主种子写入 `dataRoot/<name>/.local/bin/mysandbox`（建容器时 + 启动扫描，幂等缺失才写）。web 终端（`terminal.ts`）注入 `MYSANDBOX_WEB` 标记——exec 的 Env 到不了 tmux server 起的 shell，所以挂 tmux 全局环境（`set-environment -g`），同时开 `allow-passthrough`（否则 tmux 吞掉未知 OSC）。命令运行时探测标记，web 下打印 OSC 7677（tmux 下 DCS passthrough 包裹），`Terminal.vue` 注册 OSC handler 捕获后冒泡 `ContainerList.vue` 定位文件面板/开编辑器（与 CLI `mysandbox open` 深链共用 `locateContainerPath`）。非 web 环境只打提示。

### 镜像契约

创建容器假设镜像满足（`image/` 的 Dockerfile 是参考实现，构建上下文随包发布）：uid:gid `1000:1000`（home `/home/dev`）、`/usr/local/bin/entrypoint.sh` 首启 seed（缺才写，不覆盖预写配置）、`sleep infinity` 常驻。容器 home 挂 `dataRoot/<name>:/home/dev`；宿主 `~/.ssh` 只读挂 `/mnt/host/.ssh`。改 entrypoint 行为时保持「缺失才写」语义。镜像不在本地时返回清晰错误提示 `image build/pull`，不让 docker 抛 NotFound。

### 镜像目录外部化与宿主终端

- **imageDir 配置**：`image.ts findImageContext(cfg)` 优先用 `cfg.imageDir`（外部目录，须绝对路径、支持 `~`，启动时 cli.ts fail-fast 校验），空则回内置 `image/` 双候选定位。内置目录走文件白名单（零回归），外部目录走 `listContextFiles` 递归枚举（跳 `.git`/`.DS_Store` 等；`.dockerignore` 由 dockerode 按相对路径应用）。`imageStatus` 的 `context/contextError` 独立于 `exists` 计算——App 轮询不能因 context 出错变 500。
- **宿主终端**（`hostTerminal.ts`）：与容器终端同协议同语义（60s 宽限、kill 帧、activeCount 多窗口），但 PTY 由本进程管理：宿主 tmux 专用 socket `-L mysandbox-host`、会话 `h-<termId>`，`script(1)` 提供 PTY，`stty -F <pts>` 驱动 resize（tmux 3.4 的 `refresh-client` 不支持 -x/-y）。已知坑（都在注释里）：spawn script 必须 `SHELL=/bin/sh`（zsh 会把 `=h-xxx` 做 =word 展开）；node 退出时 `process.on('exit')` 同步 SIGKILL 全部 script 子进程（tsx 热重启每次触发）；启动清扫对无 client 会话重挂宽限而非直接杀（保刷新重连语义）。会话 cwd = 镜像构建上下文（不可用回落 `~` 不拒连）。前端 `ContainerList.vue` 侧栏顶部固定「宿主」条目，`TermGroup.kind='host'`（containerId 哨兵 `__host__`，修剪/OSC/FilePanel 均豁免）。

### web/（Vue 3 + Vite + Tailwind v4）

- UI 组件库走 **shadcn-vue**（reka-ui 底座），源码拷贝在 `src/components/ui/`。有 `.claude/skills/shadcn-vue` 技能：优先 `npx shadcn-vue@latest search` 找现成组件、用语义色（`bg-primary`）不用裸色值。
- 业务组件在 `src/components/`（ContainerList、Terminal、BatchDialog 等），API 封装在 `src/lib/api.ts`。
- 终端：xterm + fit/web-links/webgl 插件，WebSocket 到 `/ws/terminal`（容器）或 `/ws/host-terminal`（宿主，`Terminal.vue` 的 `host` prop 切换）。
- **Monaco 是离线精简接法**（见 `vite.config.ts` 注释与 `src/lib/monaco.ts`）：只引 `editor.api`（通过 vite alias 深路径绕过 exports map），自定义词法高亮，worker 用相对路径 `?worker`，不引 `editor.main`。给 web 加 Monaco 相关功能时沿用此方案，不要引全量。
- dev 模式 vite 代理 `/api` `/ws` 到 7321；build 后 `web/dist` 由后端 `@fastify/static` 同源服务，无 CORS——部署形态决定了前后端接口无需处理跨域。

## 环境备注

- 仓库不是 git（本地开发中）。
- 跑 mysandbox 的用户须在 `docker` 组。
- 容器内 `ls` 无颜色的成因是 zsh 没有 ls alias（`image/zshrc.docker` 已补 `alias ls='ls --color=auto'`），不是 coreutils 9.4 的问题——实测容器内 `ls --color=auto` 正常输出 ANSI 颜色码。老容器的 `~/.zshrc` 是首启 seed 的持久化副本，不会被新镜像覆盖，需手工从 `/etc/skel-home/.zshrc` 重新拷或自行补 alias。
