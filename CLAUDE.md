# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

mysandbox：本地 dev 容器的网页控制台。后端 fastify，**双引擎**（docker 经 dockerode 直连 `/var/run/docker.sock`；LXC 经 `lxc-*` 命令行，unprivileged 系统容器）；前端 Vue 3 + Vite + Tailwind v4（shadcn-vue 风格，reka-ui）。注释与文档均用中文，新代码保持一致。

引擎由 `cfg.engine`（`docker` | `lxc`）选，业务层只 import `server/engine/index.js`。LXC 迁移的设计与实测记录在 `docs/lxc-migration.md`——碰引擎相关的东西先读它。

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

CLI 子命令：`mysandbox [--port] [--host]`，`mysandbox base <动作>`（基座操作，`mysandbox image` 是同一命令的别名；动作集合随引擎，见下「基座」），`mysandbox open <路径>`。日志级别 `MYSANDBOX_LOG_LEVEL=debug`。

LXC 引擎的模板制作：`scripts/lxc-template.sh <容器名>`（取代 Dockerfile，见下「引擎与容器契约」）。

## 安全模型（改动前必读）

**拿到 token 等于拿到宿主的高权限能力**，两个引擎都成立，只是路径不同：

- docker 引擎直连 `docker.sock` → 等于宿主 **root**（docker daemon 是 root，容器可挂任意宿主路径）。
- LXC 引擎跑 unprivileged 容器（容器 root → 宿主 uid 100000），拿不到宿主 root；但**容器内 uid 1000 直通宿主 `leon`**（D1），且服务能读写宿主 `~/.ssh`、跑宿主终端（`/ws/host-terminal`）→ 等于宿主 **leon 用户**的完整权限。

所以无论哪个引擎，约束不变：

- 只监听 `127.0.0.1`（默认）；非 localhost 监听时 CLI 必须打印警告。
- 所有 `/api/*` 与 `/ws/*`（除 `/api/health`）经 `server/auth.ts` 的 token 鉴权 hook；新路由注册在 `routes.ts` / `base.ts` / `terminal.ts` / `hostTerminal.ts` 即自动被覆盖，不要绕过。
- sidecar 文件（state.json、hosts.txt、config.yaml）权限 `0600`。
- `/api/health` 免鉴权，所以它只暴露版本/引擎连通性/`caps`——**不要往里加容器名、路径、配置值**。

## 架构

### server/（NodeNext ESM，import 要带 `.js` 后缀）

请求流：`cli.ts`（入口/参数/config 加载）→ `index.ts buildServer()`（websocket + static + 鉴权 hook + 错误处理）→ 路由四块：`routes.ts`（REST）、`base.ts`（`/api/base*`，基座操作 + `mysandbox base` CLI）、`terminal.ts`（`/ws/terminal`，容器 PTY）、`hostTerminal.ts`（`/ws/host-terminal` + `/api/host-terminal/cwd`，宿主 PTY）。SSE 进度流的公共实现在 `sse.ts`。

关键设计：

- **引擎抽象**在 `server/engine/`：`types.ts` 定接口 + `EngineCaps`，`docker.ts` / `lxc.ts` 两个实现，`index.ts` 是消费方唯一 import 点（`getEngine(cfg)` + 一堆便捷转发）。业务层不写 `cfg.engine === 'lxc'` 分支，**判 `engine.caps`**（见下）。
- 创建/删除在 `lifecycle.ts`（IP 分配 + home 种子 + 初始 hosts），引擎特定的建容器动作在各自 engine 的 `create()` 里。IP 池计算在 `network.ts`——`assignedIps` **同时查两个引擎**，因为两者共用同一座网桥，过渡期不合并会撞 IP。
- **受管理容器的判定**：在配置的网络上，或带 mysandbox 标记（docker 是 label `mysandbox.managed-by`；LXC 没有 label，用 config 里的 `lxc.environment = MYSANDBOX_MANAGED=true` 纯文本行，可 diff 可手改）。标记不可变，所以易变元数据（displayName、adopted、tags 等）走 **sidecar JSON**（`state.ts`，存 XDG data 目录，容器名作 key）。adopt 外部容器只写 sidecar，不动容器对象。
- **批量操作**（git 身份 / ssh reseed / claude -p / 任意命令）在 `batch.ts`，用 p-limit 并发，底层走 engine 的 `execRun`。
- **hosts**：`hosts.ts` 是全局 hosts 的单一事实源（routes 和 lifecycle 都 import）。自定义内容存 `hosts.txt` sidecar 纯文本；宿主 `/etc/hosts` 实时读取不缓存。
- **错误处理**：抛 `errors.ts` 的 `HttpError`（带 code/status），`wrapDocker` 把 dockerode 404 映射为 `not_found`。
- **配置**：`config.ts` 从 `config.default.yaml` 读默认 + `~/.config/mysandbox/config.yaml` 覆盖，首启生成随机 token。
- **容器内 mysandbox 命令**（`container-cli.ts`）：脚本由宿主种子写入 `engine.hostHomePath(cfg,name)/.local/bin/mysandbox`（docker 是 `dataRoot/<name>`，LXC 是 `<lxcpath>/<name>/rootfs/home/dev`）（建容器时 + 启动扫描，幂等缺失才写）。web 终端（`terminal.ts`）注入 `MYSANDBOX_WEB` 标记——exec 的 Env 到不了 tmux server 起的 shell，所以挂 tmux 全局环境（`set-environment -g`），同时开 `allow-passthrough`（否则 tmux 吞掉未知 OSC）。命令运行时探测标记，web 下打印 OSC 7677（tmux 下 DCS passthrough 包裹），`Terminal.vue` 注册 OSC handler 捕获后冒泡 `ContainerList.vue` 定位文件面板/开编辑器（与 CLI `mysandbox open` 深链共用 `locateContainerPath`）。非 web 环境只打提示。

### 基座（base）——「新容器从哪儿来」的引擎无关说法

docker 是镜像、LXC 是模板容器，但前端只需要三个答案：基座 ready 了吗、有哪些动作、进度如何。
这三件事跨引擎同构，**只有动作集合不同，而它已经声明在 `caps.baseActions` 里**。所以只有一套东西：

- 路由 `base.ts`：`GET /api/base`（`BaseStatus`）、`GET /api/base/size`、`POST /api/base/:action`（SSE 进度）。
  准入在路由层查 `caps.baseActions`，不支持的动作回 400 并列出支持的——不让底层抛 500。
- 实现分居各引擎：docker 走 `image.ts`（build/pull/push，dockerode 流），LXC 走 `engine/template.ts`（clone/export/import）。
- web：`BasePanel.vue` 按 `hasBaseAction()` 决定渲染哪些按钮，按 `caps.baseLabel` 决定文案叫「镜像」还是「模板」。
- `BaseStatus` 的 `exists` 与 `ready` **是两件事**：LXC 模板可以「在，但在跑」，而 `lxc-copy` 对运行中的源静默失败，
  所以状态里就得让用户去 stop。引擎特有的展示字段塞 `detail: Record<string,string>`，加字段不用改前端类型。
- `/api/image*` 已删且**不留兼容别名**（唯一消费方是同版本一起发布的自家 web）；CLI 的 `mysandbox image` 保留为别名。

LXC 基座操作的硬约束（`engine/template.ts` 文件头有详版）：**整 rootfs 遍历（du/tar）必须在 `lxc-usernsexec` 里跑**，
idmap 参数取自该容器 config 自己的 `lxc.idmap` 行（不能硬编码、不能给一条宽 map），tar 必须 `--numeric-owner`。
且 **ns 内创建的文件宿主用户连删都删不掉**（属主是 uid 100000），所以归档必须由宿主进程 `createWriteStream` 落盘、
让 ns 里的 tar 写 stdout。import 的 idmap 取**宿主** `~/.config/lxc/default.conf`（包可能来自 subuid 段不同的机器）。

### 引擎与容器契约

两个引擎共享同一份**容器内契约**：uid:gid `1000:1000`（用户名 `dev`，home `/home/dev`）、zsh/git/tmux/node/AI CLI 就位、`/etc/skel-home/.zshrc` 作首启模板、宿主 `~/.ssh` 只读可见于 `/mnt/host/.ssh`。差别只在「谁来满足它」与「谁来 seed」：

| | docker | LXC |
|---|---|---|
| 容器来源 | 镜像（`image/Dockerfile` 参考实现，上下文随包发布） | 模板容器 + `lxc-copy` 克隆（`scripts/lxc-template.sh` 制作） |
| PID 1 | `sleep infinity` + tini（`Init: true`） | 发行版自己的 systemd（真系统容器） |
| home | bind mount `dataRoot/<name>:/home/dev` | 在 rootfs 内 `<lxcpath>/<name>/rootfs/home/dev` |
| 首启 seed | 镜像内 `entrypoint.sh`，每次起容器跑（幂等、缺才写） | 引擎 `create()` 里 attach 进去跑一次 `seedHome()`（同样缺才写） |
| 不满足前置时 | 镜像不在本地 → 提示 `image build/pull`，不让 docker 抛 NotFound | 模板不存在/未 STOPPED → 明确报错（`lxc-copy` 对运行中的源**静默失败**，exit 1 无输出） |

改 seed 行为时两边都要保持「**缺失才写**」语义——用户改过的 `~/.zshrc`、`~/.gitconfig` 绝不覆盖。

**`EngineCaps`（`engine/types.ts`）是引擎差异的唯一出口**，业务层与 web 都判它，不判引擎名：

- `dataInsideContainer`（LXC true）：home 在 rootfs 内 → 删容器必连数据一起删。`deleteManaged` 据此把「输容器名确认」从「勾了 deleteData 时」升级为**无条件**；`DeleteContainerDialog.vue` 相应换成说明文案而非一个留不住数据的假选项。
- `liveRename`（LXC false）：改名前必须先停容器，`rename` 抛 `conflict`。
- `portMappings`（LXC false）：固定 IP 直连，`createContainer` 拒绝 portMappings，`CreateDialog.vue` 整块隐藏。
- `baseKind`（`image`|`template`）+ `baseActions`：见上「基座」。

caps 经 `/api/health` 下发，前端存在 `web/src/lib/caps.ts` 单例（默认取 docker 语义，health 未回来时按老行为渲染）。**加引擎差异时先在这里加一项 cap**，别在业务层撒 if。

### LXC 引擎的运行环境约束（`engine/lxc.ts` 文件头有详版）

- mysandbox **必须以 systemd user service 形态跑**（cgroup 委派）。`lxc-attach` 可直接 spawn（继承 cgroup），但 `lxc-start` 必须进独立瞬态单元（`systemd-run --user --unit=mysandbox-<name> ... lxc-start -n <name> -F`），否则重启 mysandbox 会连带杀掉所有容器。
- LXC veth 挂在 docker 的 dev-lan 网桥上（`br-*`）→ 跨引擎同网段互通（实测双向 TCP + 宿主可达）。
- 静态 IP 无 DHCP → 容器内 systemd-resolved 没有上游 DNS，模板必须写 `/etc/systemd/resolved.conf.d/mysandbox.conf`（模板脚本已做）。
- `lxc-attach -u/-g` **只吃数字**，而调用方传的 User 混着名字（`'root'`/`'root:root'`/`'1000:1000'`）——`parseUser` 负责映射，改它时小心：早前 `Number('root')` → NaN 落回 1000，导致「以 root 写 /etc/hosts」静默变成 dev 身份、Permission denied。
- `scripts/lxc-template.sh` 里给容器喂脚本必须走 **stdin**（`bash -s`）而非 `bash -c "<脚本>"`：systemd-run 会先展开自己的 `${VAR}` 规格符，把脚本里的 `${ARCH}` 吃成空串。
- **liblxc 不认 XDG 变量**：lxcpath 与 default.conf 路径在 liblxc 里硬编码成 `$HOME/.local/share/lxc` / `$HOME/.config/lxc`。所以 `lxcPath()` 与 `readDefaultConf()` 用 `homedir()`，**不能**用 `xdgDataHome()`/`xdgConfigHome()`——设了 XDG_* 的环境下会与 `lxc-*` 命令看的路径分叉（我们说容器不存在，`lxc-ls` 说存在）。
- `start` 对已在跑的容器必须幂等（`create()` 已经把容器起来了）：撞同名瞬态单元会报 `already loaded`，把「本来就好着」变成 500。

### imageDir 与宿主终端

- **imageDir 配置**（docker 引擎）：`image.ts findImageContext(cfg)` 优先用 `cfg.imageDir`（外部目录，须绝对路径、支持 `~`，启动时 cli.ts fail-fast 校验），空则回内置 `image/` 双候选定位。内置目录走文件白名单（零回归），外部目录走 `listContextFiles` 递归枚举（跳 `.git`/`.DS_Store` 等；`.dockerignore` 由 dockerode 按相对路径应用）。`BaseStatus` 的 `context/contextError` 独立于 `exists` 计算——App 轮询不能因 context 出错变 500。（LXC 侧 `context` 是模板制作脚本 `scripts/lxc-template.sh` 的路径。）
- **宿主终端**（`hostTerminal.ts`）：与容器终端同协议同语义（60s 宽限、kill 帧、activeCount 多窗口），但 PTY 由本进程管理：宿主 tmux 专用 socket `-L mysandbox-host`、会话 `h-<termId>`，`script(1)` 提供 PTY，`stty -F <pts>` 驱动 resize（tmux 3.4 的 `refresh-client` 不支持 -x/-y）。已知坑（都在注释里）：spawn script 必须 `SHELL=/bin/sh`（zsh 会把 `=h-xxx` 做 =word 展开）；node 退出时 `process.on('exit')` 同步 SIGKILL 全部 script 子进程（tsx 热重启每次触发）；启动清扫对无 client 会话重挂宽限而非直接杀（保刷新重连语义）。会话 cwd = 镜像构建上下文（不可用回落 `~` 不拒连）。前端 `ContainerList.vue` 侧栏顶部固定「宿主」条目，`TermGroup.kind='host'`（containerId 哨兵 `__host__`，修剪/OSC/FilePanel 均豁免）。

### web/（Vue 3 + Vite + Tailwind v4）

- UI 组件库走 **shadcn-vue**（reka-ui 底座），源码拷贝在 `src/components/ui/`。有 `.claude/skills/shadcn-vue` 技能：优先 `npx shadcn-vue@latest search` 找现成组件、用语义色（`bg-primary`）不用裸色值。
- 业务组件在 `src/components/`（ContainerList、Terminal、BatchDialog 等），API 封装在 `src/lib/api.ts`。
- 终端：xterm + fit/web-links/webgl 插件，WebSocket 到 `/ws/terminal`（容器）或 `/ws/host-terminal`（宿主，`Terminal.vue` 的 `host` prop 切换）。
- **Monaco 是离线精简接法**（见 `vite.config.ts` 注释与 `src/lib/monaco.ts`）：只引 `editor.api`（通过 vite alias 深路径绕过 exports map），自定义词法高亮，worker 用相对路径 `?worker`，不引 `editor.main`。给 web 加 Monaco 相关功能时沿用此方案，不要引全量。
- dev 模式 vite 代理 `/api` `/ws` 到 7321；build 后 `web/dist` 由后端 `@fastify/static` 同源服务，无 CORS——部署形态决定了前后端接口无需处理跨域。

## 环境备注

- 跑 mysandbox 的用户须在 `docker` 组（docker 引擎）；LXC 引擎需 `/etc/subuid`/`subgid` 有 `leon:100000:65536`、且 mysandbox 以 systemd user service 跑。
- LXC 版本是 apt 的 **5.0.3**（刻意不用源码编译的 7.0）。容器落 `~/.local/share/lxc/<name>/`。
- 容器内 `ls` 无颜色的成因是 zsh 没有 ls alias（`image/zshrc.docker` 已补 `alias ls='ls --color=auto'`），不是 coreutils 9.4 的问题——实测容器内 `ls --color=auto` 正常输出 ANSI 颜色码。老容器的 `~/.zshrc` 是首启 seed 的持久化副本，不会被新镜像覆盖，需手工从 `/etc/skel-home/.zshrc` 重新拷或自行补 alias。
