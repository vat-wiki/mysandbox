# Git 中心（内网 bare 仓库托管）

侧边栏底行的 Git 中心入口，提供一个「只有仓库」的内网 GitHub：仓库落在产品单一根 `~/.mysandbox/repos/<name>.git`（`server/config.ts` 的 `REPOS_DIR`），与 `ai/`、`logs/`、`tls/` 同级；无账号、无组织、无权限、无 Issue/PR。能连到 mysandbox 端口的人都能 clone/push。

实现集中在 `server/gitCenter.ts`（CLI 装配见 `server/index.ts`），前端是 `web/src/components/GitCenterPanel.vue` + `pageRoutes` 的 `git-center`（桌面右侧非模态抽屉 / 手机全宽整页）。抽屉不遮罩、不锁焦点、外部点击不自动关，终端在仓库面板开着时仍可用；X / Esc 关闭。

## 两个面，鉴权刻意分开

| 面 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| Smart HTTP | `/git/<name>.git/*` | **无**（不进 `index.ts` 的 token hook） | 标准 git clone/push/fetch |
| 管理 / 浏览 | `/api/git-center/*` | 现有 token hook（owner；受限账户 deny-by-default） | 建仓/删仓/文件树/文件/README/历史/diff |

`/git/*` 不在 `/api/`、`/ws/`、`/proxy/` 前缀内，全局 hook 对未带凭证的非这些前缀请求本就放行（见 `server/index.ts` 的 onRequest 末尾），所以不需要为它开任何后门或改 hook。这是有意的安全取舍：**拿到网络可达性 = 拿到仓库读写权**，但仓库文件只是 `~/.mysandbox/repos` 下的普通数据，不给宿主 shell（区别于主 token 等价宿主属主用户，见 [security.md](security.md)）。服务默认只绑 `127.0.0.1`；要内网访问需 `--host` 并接受 CLI 告警，权限边界由网络层（ufw 等）承担。

## Smart HTTP 的实现方式

直接把请求转成 CGI 环境交给 `git http-backend`，让 git 自己处理 advertise-refs、upload-pack、receive-pack、pack 协商与 dumb 端点；比手写四个端点完整。关键环境：

- `GIT_PROJECT_ROOT=<repos 根>`、`GIT_HTTP_EXPORT_ALL=1`（免 `git-daemon-export-ok`）
- `PATH_INFO=/<name>.git/<剩余路径>`、`REQUEST_METHOD`、`QUERY_STRING`
- POST 的 `CONTENT_TYPE` / `CONTENT_LENGTH`；请求体由 Fastify 的自定义 MIME 解析器以 Buffer 交给 handler

响应是「CGI 头 + 空行 + body」：`reply.hijack()` 后从 stdout 流里切出头部（取 `Status:` 作状态码、透传 git 的 Content-Type/Cache-Control，丢掉 Content-Length/Transfer-Encoding），余下裸流直接 write 给客户端——pack 可能很大，不做整包缓冲。仓库建好时写入 `http.receivepack=true` / `http.uploadpack=true`，否则匿名 push 会被拒。

路径入口先做防御：第一段必须 `*.git`，名字按 `REPO_NAME_RE` 校验（拒绝 `..`、绝对路径段、超长），仓库不存在直接 404，之后才 spawn git。

## 管理 / 浏览 API

| 端点 | 作用 |
| --- | --- |
| `GET /api/git-center/repos` | 仓库列表（名称/描述/最近提交时间/是否空仓） |
| `POST /api/git-center/repos` | 建裸仓（`--initial-branch=main` + receivepack 配置 + description） |
| `DELETE /api/git-center/repos/:name` | 删仓（前端要求输入仓库名确认） |
| `GET /api/git-center/repos/:name` | 默认分支、分支/标签、提交数、最近提交 |
| `GET .../tree?ref=&path=` | `git ls-tree -z --long`，目录树（`-z` 抗特殊文件名） |
| `GET .../file?ref=&path=` | `git show <ref>:<path>`；二进制只报大小，文本上限 512KB |
| `GET .../commits?ref=&limit=&skip=` | 复用 `gitpanel.parseHistoryLog` 的格式与解析 |
| `GET .../diff?to=&from=` | `git diff --numstat` + patch；`from` 缺省为父提交，首提交用空树 |

所有子进程都是 `execFile('git', [...数组参数])`，没有 shell 拼接；路径参数复用 `gitpanel.ts` 的 `assertGitRelPath` / `assertBranchName`。大 blob 用 spawn 流式截断（到上限即 kill），不靠 `maxBuffer` 事后兜底。

## 前端

`GitCenterPanel.vue`：仓库列表 → 新建/删除 → 仓库详情。详情页有四个标签：代码（目录面包屑 + README 渲染 + 文件查看）、提交（点提交进 diff）、分支/标签（点击切 ref）、变更对比（numstat + 着色 patch）。README 渲染复用 `marked` + `DOMPurify`（与 `MarkdownView.vue` 同一套，但不走它的容器文件下载管线——仓库 blob 由 `/api/git-center/*/file` 提供）。clone 地址由 `location.origin` 拼出，不落后端配置，vhost/TLS 门面下自动跟着访问域名走。

仓库名为 64 字符内的 `字母/数字/._-`，API 接受带或不带 `.git` 后缀，磁盘上统一 `<name>.git`。空仓库首次 clone 后本地分支名跟随客户端 `init.defaultBranch`，可能与裸仓的 `main` 不同——此时 `git push -u origin HEAD:main` 即可。

分支/标签切换用 shadcn `Select`（reka portal），不用原生 `<select>`——原生弹层由 OS 自绘，深色主题下白底违和（同 `BasePanel` 的既有约定）。

## 同步到 GitHub

仓库详情有「同步到 GitHub」按钮，新建表单也可勾「创建后立即设置 GitHub 同步」。表单填 `owner/repo`（或完整 GitHub URL）+ PAT，可选「不存在时自动创建」和「私有」。后端两个端点：

| 端点 | 作用 |
| --- | --- |
| `GET /api/git-center/repos/:name/github` | 读上次同步目标（无则 `meta: null`） |
| `POST /api/git-center/repos/:name/github` | 建仓（可选）+ `git push --mirror` 全量镜像 |

设计要点：

- **PAT 不落盘、不进命令行**：push 时经 `GIT_CONFIG_COUNT=1` / `GIT_CONFIG_KEY_0=http.https://github.com/.extraheader` / `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic base64(x-access-token:<PAT>)` 注入，remote URL 仍是干净的 `https://github.com/owner/repo.git`。`repos/.github.json`（0600）只记 `owner/repo/lastSyncAt`，前端据此预填。
- **自动建仓**：先 `GET /api.github.com/user` 判断 owner 是自己还是组织，再走 `POST /user/repos` 或 `POST /orgs/:owner/repos`；`422 already exists` 视为成功继续 push（可能手工建过）。默认私有，取消勾选则公开。
- **失败可诊断**：GitHub API 的非 2xx 把 response `message` 原话回前端；push 失败把 git stderr 原话回前端（`github_push_failed`）。受保护分支、PAT 权限不足等由 GitHub 侧拒绝并原样呈现。
- **推送是 mirror**（强推全部 ref），GitHub 侧已有同分支历史时以本地裸仓为准。PAT 每次输入、不复用。

