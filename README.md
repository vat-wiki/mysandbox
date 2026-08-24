# mysandbox

本地开发容器（dev container）的网页控制台：从浏览器直接开终端、批量改 git/ssh、自由创建删除容器。
后端用 dockerode 直连 `docker.sock`，不再依赖 `docker compose` 运行时；前端 Vue 3 + shadcn 风格。

> 适合「一台宿主机上长期跑一堆 AI coding 容器（claude / codex / opencode / hermes …），又懒得每次手敲 `docker exec`」的场景。

---

## ⚠️ 安全须知（先读再用）

mysandbox 直连宿主 `docker.sock`。**谁能调用这个服务 + 知道 token，就等于拿到了宿主的 root** —— 可以任意创建容器、挂载任意目录、`--privileged` 提权。

因此默认且强烈建议：

- **只监听 `127.0.0.1`**（默认）。不要为了「方便」绑 `0.0.0.0` 暴露到局域网，除非你清楚后果。CLI 在监听非 localhost 时会打印警告。
- **token 即密码**。首启随机生成、写进 `~/.config/mysandbox/config.yaml`（权限 `0600`），首次启动会打印一次。别提交、别截图外发。
- 运行 mysandbox 的用户必须在 `docker` 组（或有权访问 `docker.sock`）。

> 一句话：把它当成「能用浏览器登录的宿主 root shell」，按这个敏感度对待。

---

## 功能

- **容器列表 / 生命周期**：列出受管理容器（在你配置的网络上 或 带 mysandbox 标签），启动 / 停止 / 重启 / 重命名 / 删除。
- **网页终端**：浏览器里直接 `zsh`（或任意 shell）进容器，支持多标签、自适应尺寸、链接可点。
- **批量配置**（多选容器后）：
  - **Git 身份** —— 批量 `git config --global user.name/email`。
  - **SSH** —— 从宿主 `~/.ssh` 重新 seed，或追加公钥到 `authorized_keys`。
  - **Claude `-p`** —— 对每个容器非交互跑 prompt 并收敛输出（带超时）。
  - **通用命令** —— `sh -c <任意>`，并发执行、逐容器看 stdout/stderr/exitCode。
- **创建 / 删除**：指定名称 / IP / 端口映射 / git 身份即可新建并启动；删除可附带清理 home 数据（需二次确认容器名）。
- **纳入管理（adopt）**：把外部已有容器登记进面板（只写 sidecar 元数据，不重建、不打标签），之后即可对它做生命周期 / 终端 / 批量。
- **IP 池**：固定 IP 分配（避免容器重建后 IP 漂移），池视图可视化已用 / 空闲 / 保留地址。

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
>> mysandbox 0.1.0  docker 29.4.1 (api 1.54)
>> web UI:  http://127.0.0.1:7321
>> first run — config written: ~/.config/mysandbox/config.yaml
>> token:   <48-hex>
```

浏览器打开 `http://127.0.0.1:7321`，粘贴 token 登录。

CLI 选项：

```
mysandbox [--port 7321] [--host 127.0.0.1] [-V|--version] [-h|--help]
```

环境变量：`MYSANDBOX_LOG_LEVEL=debug|info|warn|error`（默认 `info`）。

## 在浏览器打开容器文件

两个入口，殊途同归（深链 `#open?c=&p=&k=`，文件进编辑器、目录进文件面板）：

- **容器内**（推荐）：在 mysandbox 的**网页终端**里敲

  ```bash
  mysandbox            # 打开当前目录（文件面板定位到 $PWD）
  mysandbox <路径>     # 目录 -> 文件面板；文件 -> Monaco 编辑器
  ```

  命令由宿主种子写入 `~/.local/bin/mysandbox`（建容器时 + 服务启动扫描，幂等），通过 OSC 转义序列与页面联动——容器无需联网、无需 token。在宿主 `docker exec` / ssh 直连的终端里运行只会打印提示，不产生乱码。adopted 外部容器没有宿主可见的 data 目录，无此命令。

- **宿主侧**：

  ```bash
  mysandbox open <path> [--container <name>]
  ```

  在浏览器打开容器文件（编辑器）或目录（文件面板）。容器可按 `--container` 指定，或从宿主 cwd 位于 `dataRoot/<容器名>/` 下自动推断。一次性命令，需 mysandbox 服务在运行。

---

## 配置

用户配置：`~/.config/mysandbox/config.yaml`（首启生成，权限 `0600`）。字段见随包 `config.default.yaml`，摘录：

```yaml
listen:
  host: 127.0.0.1     # ⚠️ 改成非 localhost 会触发启动警告
  port: 7321
docker:
  socketPath: /var/run/docker.sock
image: dev            # 新建容器所用镜像（不满足「镜像契约」就 `mysandbox image build` 一下）
registry: ""          # push/pull 的远程仓库（host/path）；空=不配
imageTag: latest      # push/pull 的 tag
network: dev-lan      # 受管理网络
dataRoot: ""          # 容器 home 宿主目录；空= ~/.local/share/mysandbox/data
sshSource: ""         # 宿主 ~/.ssh 源；空= 当前用户 ~/.ssh
claudeSettingsTemplate: ""  # 空=不挂载
ipPool:
  from: 10.88.0.20
  to: 10.88.0.250
  reserved: [10.88.0.1, 10.88.0.2]
restartPolicy: unless-stopped
git:
  name: dev
  email: dev@local
ui:
  defaultShell: zsh
token: <auto>         # 首启随机生成，勿手改
```

状态文件（sidecar 元数据）：`~/.local/share/mysandbox/state.json`。

---

## 镜像管理

mysandbox 自带 `image/` 构建上下文（Dockerfile + entrypoint.sh + zshrc），内置镜像生命周期命令：

```bash
mysandbox image build [--tag <name>] [--no-cache]   # 从 image/ 构建，打 tag = image（默认 dev）
mysandbox image pull [<ref>]                          # 拉 ${registry}:${imageTag}，retag 成 image
mysandbox image push [<ref>]                          # 把 image tag 成 ${registry}:${imageTag} 后推
mysandbox image status                                # image 本地是否存在 + inspect 摘要
```

- `build` 与 `pull` 对称：两者落地后本地都有名为 `image` 的可用镜像，新建容器即可用。
- `push` 是 `pull` 的逆：发布到 registry。私有 registry 鉴权取自 `~/.docker/config.json`（即 `docker login` 的结果）；credsStore（osxkeychain 等）不被解析，遇到请先 `docker login`。
- `ref` 省略时默认 `${registry}:${imageTag}`（见配置）；两者都没配则报错。
- 同样走 HTTP：`GET /api/image`、`POST /api/image/build|pull|push`（鉴权同其它 `/api/*`）。

镜像构建上下文随包发布（`package.json` 的 `files` 含 `image`），所以 `npm install -g mysandbox` 后开箱即 `image build`。

### 外部镜像目录（imageDir）

想用自己的 Dockerfile 演进基础镜像时，把构建上下文放到外部目录、在 `~/.config/mysandbox/config.yaml` 配置：

```yaml
imageDir: ~/my-mysandbox-image   # 支持 ~；须绝对路径。留空 = 用随包 image/
```

- 外部目录递归打包（自动跳过 `.git`/`.DS_Store` 等垃圾；`.dockerignore` 照常生效），须含 `Dockerfile`。
- 配置后 web 端与 `mysandbox image status` 显示当前上下文路径；目录不存在启动即报错退出。
- 宿主终端（见下）默认也开在这个目录下。

## 宿主终端

侧栏顶部固定「宿主」条目：开一个由 server 自己管理 PTY 的宿主 shell（不走 docker exec），默认 cwd = 镜像构建上下文目录——在网页里直接改 Dockerfile、跑 `docker build` 调试镜像。交互形态与容器终端一致（tmux 会话保留：断开 60s 内刷新重连恢复；点 ✕ 真杀）。

实现：宿主 tmux 走专用 socket `-L mysandbox-host`（不碰你自己的 tmux server），`script(1)` 提供 PTY。仅支持 Linux。⚠️ 安全上注意：token 本就等价宿主 root（docker.sock），宿主终端不扩大权限面，只是把宿主 shell 摆上了 UI——不要把服务暴露到非受控网络。

## 镜像契约

mysandbox 创建容器时假设镜像满足（内置 `image/` 的 Dockerfile 已是满足该契约的参考实现）：

- 存在非 root 用户 uid:gid `1000:1000`（home `/home/dev`）。
- 有 `/usr/local/bin/entrypoint.sh`，负责首启 seed（`.zshrc` / `.gitconfig` / `.ssh` / `.claude` 等），并在缺失时才写（所以预写配置不会被覆盖）。
- 预装你需要的 CLI（claude / codex / gh …），`Cmd` 默认 `sleep infinity` 常驻。

创建容器前会做镜像就绪检查：`image` 本地缺失时返回清晰错误（提示 `image build` 或 `image pull`），不再让 docker 抛看不懂的 NotFound。

容器 home 以 `dataRoot/<name>:/home/dev` 挂载；宿主 `~/.ssh` 以只读挂到 `/mnt/host/.ssh` 供 seed 与批量 reseed。

---

## 开发

```bash
git clone <repo> && cd mysandbox
npm install                # 后端依赖
npm -C web install         # 前端依赖

npm run dev                # 后端 tsx watch（端口 7321）
npm -C web run dev         # 前端 vite dev（代理 /api /ws 到 7321）

npm run build              # tsc -> dist/ + vite -> web/dist/（产物可直接 node 运行）
node dist/server/cli.js    # 跑产物验证
```

仓库结构：

```
server/        TypeScript 后端（fastify + dockerode）
  cli.ts         入口 / 参数
  config.ts      XDG 配置加载 + token 注入
  docker.ts      dockerode 单例 / 列表 / 生命周期 / execRun
  lifecycle.ts   创建（IP 分配 + data 预建 + 固定 IP）/ 删除
  network.ts     IP 池
  batch.ts       批量 git/ssh/claude/exec（p-limit 并发）
  terminal.ts    /ws/terminal（docker exec PTY）
  routes.ts      REST 路由
  state.ts       sidecar 元数据
web/           Vue 3 + Vite + Tailwind v4 前端
config.default.yaml   随包默认配置
```

---

## License

MIT
