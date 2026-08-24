# 开发容器 —— 在 home 里跑 Claude Code / Codex / OpenCode（仓库自己 clone 进 ~/）。复用到别的项目：cp -r 本目录即可（镜像 dev 通用，无项目专属配置）。
#
# 基底故意选 ubuntu:24.04（与宿主机同款 glibc 2.39）：apt 装的 zsh / git 与宿主机同版本。
# 五个 AI CLI（claude / codex / opencode / openclaw / hermes）直接预装进镜像（npm 全局 / 官方 install.sh），
# 不再挂宿主包；它们的全局配置各容器独立持久化（见 entrypoint）。ssh key 由 compose 运行时只读挂入。
#
# 不跑 systemd：容器全程以 dev（uid 1000，与宿主 leon 对齐）运行；PID 1 = docker-init（tini，
# 由 compose `init: true` 注入），负责信号转发 + 回收僵尸，entrypoint.sh → CMD 全部 dev 身份，whoami=dev。
# 需要定时/调度时用 agent 自带的 scheduler（Claude Code 内置 CronCreate / `club listen` 轮询等），
# 不依赖系统 cron / systemd timer。
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Singapore \
    LANG=C.UTF-8 \
    HOME=/home/dev \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    PATH=/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# 核心：zsh、git、ssh 客户端（git clone 用）、jq（settings 处理）、tzdata（时区）、curl。
# tmux：网页终端会话持久化——docker exec 跑 `tmux new-session -A`，浏览器刷新重连同一活 shell
# （历史/在跑进程都在），扛到容器重启为止。镜像没装时 mysandbox 会在首次开终端按需 root apt 装。
# zsh-autosuggestions / zsh-syntax-highlighting：zshrc.docker 末尾按路径 source（缺失静默跳过），
# 替代 oh-my-zsh——免 git clone、零框架、启动快。
# 不装 systemd / cron：容器全程以 dev 运行、无 root，调度交给 agent 自带 scheduler。
# python3/make/g++：native addon 编译工具链（如 better-sqlite3 的 node-gyp）。
# 时区直接装成 Asia/Singapore（不靠运行时映射 localtime/timezone）：装 tzdata + 设 /etc/localtime、
# /etc/timezone，配合 ENV TZ 让 date/日志都是 SGT。DEBIAN_FRONTEND=noninteractive 避免 tzdata 装时交互。
RUN apt-get update && apt-get install -y --no-install-recommends \
        zsh git openssh-client ca-certificates jq curl less vim-tiny xz-utils tzdata tmux \
        zsh-autosuggestions zsh-syntax-highlighting \
        python3 make g++ \
    && ln -sf /usr/share/zoneinfo/Asia/Singapore /etc/localtime \
    && echo Asia/Singapore > /etc/timezone \
    && rm -rf /var/lib/apt/lists/*

# node 运行时：club 前后端 + claude/codex 都跑在 node 上。用官方 tarball 装到 /usr/local（不动 apt 源、
# 层干净、版本精确可控），大版本对齐宿主 fnm 的 v24；corepack 随 node 自带，enable 后
# pnpm/yarn 按需自动取版本（club 若在 package.json 声明 packageManager，corepack 会自动用对应版本）。
# 解压用 tar -xJ，依赖上面 apt 一起装的 xz-utils。
ARG NODE_VERSION=24.15.0
RUN ARCH=$(case "$(dpkg --print-architecture)" in amd64) echo x64 ;; arm64) echo arm64 ;; *) exit 1 ;; esac) \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
 && corepack enable

# chromium 无头浏览器：系统依赖（libglib/libnss3/libgbm/libpango…）+ 浏览器本体一起在这一层装齐。
# 浏览器装到镜像内 /opt/ms-playwright（ENV PLAYWRIGHT_BROWSERS_PATH 指过去）——刻意不进 home：home 现在是
# per-container 持久化挂载，浏览器若进 ~/.cache 会被 bind 覆盖、且每个容器各存一份；放 /opt 则多容器共享
# 同一镜像层、零重复占用，runtime 靠 ENV 自动找到。版本对齐 playwright@1.61.1（chromium revision 1228）。
# 版本以 ARG 暴露（默认 1.61.1）；要钉死/升版用 --build-arg PLAYWRIGHT_VERSION=x.y.z 覆盖。
# 本层同时全局装 playwright CLI（提供 `playwright` 命令，容器内可直接 `playwright codegen/open` 等），
# bin 进 /usr/local/bin（已在 PATH）。
# HOME=/tmp：root 下跑 npx/npm，cache 落 /tmp，不污染 /home/dev/.npm（否则 dev 用户后续 npx 因 root-owned
# cache 而 EACCES）。chmod a+rX 确保 dev 可读可执行。装完清临时 cache + apt lists。
ARG PLAYWRIGHT_VERSION=1.61.1
RUN HOME=/tmp npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium \
    && HOME=/tmp npx -y playwright@${PLAYWRIGHT_VERSION} install chromium \
    && HOME=/tmp npm install -g playwright@${PLAYWRIGHT_VERSION} \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/* /tmp/.npm /tmp/.cache

# dev 用户 uid 1000（与宿主 leon 一致）：宿主的 .ssh 是 600/700 仅 owner 可读，必须 uid 对上才能读。
# ubuntu:24.04 自带 ubuntu 用户占着 1000，删掉重建为 dev。
RUN userdel -r ubuntu 2>/dev/null; \
    groupdel ubuntu 2>/dev/null; \
    groupadd -g 1000 dev && useradd -m -u 1000 -g 1000 -s /usr/bin/zsh dev

# 工作目录 = home（/home/dev 由上面 useradd -m 建好）。home 由 compose 按 service 挂各自的
# ./data/<service>（per-container 持久化 + 隔离）；进容器即落在 ~，仓库自己 clone 进 ~/。
WORKDIR /home/dev
USER root

# —— 五个 AI CLI 预装：claude / codex / opencode（npm 全局）+ openclaw（npm 全局）+ pi（npm 全局）+ hermes（官方 install.sh）——
# 版本「跟 node 一样甩出来」：以 ARG 暴露（默认 latest，每次构建取最新；要钉死某版用
# --build-arg CLAUDE_VERSION=x.y.z 覆盖）。放在重层（playwright chromium）之后、项目层（club-cli）之前：
# 换版本只重建本层及之后，不破坏 playwright 等重层的 BuildKit 缓存。entrypoint 启动时会打印实际版本。
ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
ARG OPENCODE_VERSION=latest
ARG OPENCLAW_VERSION=latest
ARG PI_VERSION=latest
USER root
# 五个 AI CLI 走 npm 全局（跟 node 一样以 ARG 暴露版本，默认 latest）：
#   claude    @anthropic-ai/claude-code（自包含 native ELF）
#   codex     @openai/codex（JS wrapper）
#   opencode  opencode-ai（native ELF；靠 npm 平台 optionalDependencies 自动取对应平台包，无需手动判 ARCH）
#   openclaw  openclaw（npm 全局）
#   pi        @earendil-works/pi-coding-agent（bin=pi，见 README）
# bin 都进 /usr/local/bin（已在 PATH）。HOME=/tmp 同上，避免 root 把 npm cache 写进 /home/dev/.npm 污染权限。
# --ignore-scripts：pi 的 postinstall 在非交互（docker build 管道输入、无 TTY）下会卡住等待输入，
# 故全局加 --ignore-scripts 跳过所有包的生命周期脚本；其余四个包皆为预编译/自包含，不依赖 postinstall，
# 跳过无副作用。
RUN HOME=/tmp npm install -g --ignore-scripts \
        @openai/codex@${CODEX_VERSION} \
        opencode-ai@${OPENCODE_VERSION} \
        openclaw@${OPENCLAW_VERSION} \
        @earendil-works/pi-coding-agent@${PI_VERSION} \
    && HOME=/tmp npm install -g @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && rm -rf /tmp/.npm /tmp/.cache

# opencode 的 postinstall 手动补跑：上面的 --ignore-scripts（为绕 pi 交互 postinstall）把它也跳过了，
# 留下的是 placeholder 报错脚本（`opencode` 一跑就报 "postinstall script was not run"）。
# opencode 靠 postinstall 从 optionalDependencies 挑平台包（avx2/baseline/musl 判定）把真二进制
# 拷进 bin/。npm 装 optionalDependencies 时不跑脚本但包已就位，postinstall 只做本地拷贝（离线、
# 无交互），单独补跑安全。跑完 test 断言真二进制在位（loud fail，防悄悄退化回 placeholder）。
RUN cd /usr/local/lib/node_modules/opencode-ai && node postinstall.mjs \
    && ! grep -qa 'postinstall script was not run' bin/opencode.exe \
    && bin/opencode.exe --version

# Hermes Agent（Nous Research）：官方 install.sh 装器（git clone + uv 虚拟环境 + python 3.11 + ripgrep + ffmpeg + node v22）。
# 走 root-mode FHS 布局：代码 /usr/local/lib/hermes-agent/，bin /usr/local/bin/hermes（与 node/npm/bin 同层）。
# 容器已有 node/npm/ripgrep（playwright 装器自带 node v22、ripgrep 可 apt 装），install.sh 会自动检测并跳过已有依赖。
# curl / xz-utils 已在第一层 apt 装齐（install.sh 前置条件）。git 也在第一层装齐。
# --skip-browser：容器内 Playwright 浏览器已预装在 /opt/ms-playwright，hermes 不需要再装一份 Chromium；
# install.sh 在 TTY 缺失（管道输入）时自动走非交互模式，无需额外标志。
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --skip-browser \
    && rm -rf /root/.cache

# GitHub CLI（gh）：官方预编译 tarball 装到 /usr/local（与 node/bin 同层），bin 进 /usr/local/bin（已在 PATH）。
# 刻意不走 npm（gh 非 npm 包）也不加 apt 源（避免改源引入副作用、保持层干净）--下 tarball 解压只取 bin/gh +
# share/man、share/doc，符合「层干净、版本精确可控」的约定。版本钉死在 ARG（tarball 路径含具体版本号、
# 无法用裸 latest，升版改 --build-arg GH_VERSION=x.y.z）；架构沿用上方 node 层同款 dpkg 判定。
# 架构沿用上方 node 层同款 dpkg 判定。
# --retry：本机出网对 github.com / astral.sh 间歇性 SSL_ERROR_SYSCALL（实测同一 URL 手动 10/10 成功，
# 构建时却随机断），裸 curl 一次失败即整层重建白费。retry-all-errors 才覆盖连接层错误（默认 --retry
# 只重试超时和 5xx，不含 SSL_connect 失败）。
ARG GH_VERSION=2.97.0
RUN ARCH=$(case "$(dpkg --print-architecture)" in amd64) echo amd64 ;; arm64) echo arm64 ;; *) exit 1 ;; esac) \
 && curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" \
    -o /tmp/gh.tgz \
 && tar -xzf /tmp/gh.tgz -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_${ARCH}" \
 && rm -f /tmp/gh.tgz \
 && gh --version | head -1

USER dev

# —— 项目专属层（复用到别的项目时：把这层换成你自己的全局 CLI，或整段删掉）——
# club CLI（npm 包 club-cli，提供 `club` 命令，entrypoint 里 club login 等用到，登录态落 ~/.club）。
# 全局装到 node 所在的 /usr/local（bin 进 /usr/local/bin，已在 PATH），@latest 取最新版。
# 装 club-cli 需写 /usr/local，故临时切 root，装完切回 dev（保持容器以 dev 启动）；
# HOME=/tmp 同上，避免 root 把 npm cache 写进 /home/dev/.npm 污染 dev 用户权限。
# 装完立刻 chown 给 dev：club-cli 是本项目自有工具（新版本频繁、需容器内热更新 npm i -g club-cli@latest），
# npm 升级要把旧包目录 rename 挪开，需要对该目录有写权限——若留 root 属主，dev 跑 npm i -g 会 EACCES。
# node_modules 与 /usr/local/bin 本就 dev 属主（node 官方 tarball 目录 uid=1000），故只 chown 包目录即可，
# bin 软链 /usr/local/bin/club 虽 root 属主但父目录 dev 可写、npm 替换无碍。claude/codex/opencode 不改，
# 保持 root 属主 = 钉死在镜像、只能重建升级（与 club-cli 的「可热更」刻意区分）。
USER root
RUN HOME=/tmp npm install -g club-cli@latest \
    && chown -R dev:dev /usr/local/lib/node_modules/club-cli \
    && rm -rf /tmp/.npm /tmp/.cache
USER dev

# —— @playwright/cli（提供 `playwright-cli` 命令）——
# 注意：它和上面的 `playwright` 是两个不同的命令/包，别混了——`playwright`（playwright@1.61.1）管
# 浏览器本体/codegen，匹配预装的 chromium 1228；`playwright-cli`（@playwright/cli）是 workspace
# 脚手架 + 真实截图工作流（club 仓库 .gitignore 排除的 `.playwright-cli/` 即它的产物；qa 用它初始化 skill）。
# 刻意单独成层、放 club-cli 之后：本层很轻（脚手架工具），升版只重建本层 + 尾部 COPY，不破坏上面
# chromium / AI CLI 等重层缓存。@playwright/cli 会自带一份 playwright 依赖（当前 1.62.0-alpha），
# 但浏览器仍走 /opt/ms-playwright（PLAYWRIGHT_BROWSERS_PATH），首次截图若 revision 不匹配会自补。
ARG PW_CLI_VERSION=latest
USER root
RUN HOME=/tmp npm install -g @playwright/cli@${PW_CLI_VERSION} \
    && rm -rf /tmp/.npm /tmp/.cache
# 预生成 playwright-cli 的 Claude skill 作 skel 模板：build 时一次性跑 `playwright-cli install --skills
# claude`，产物（SKILL.md + references/）落 /etc/skel-home/.claude/skills/playwright-cli（镜像内、非 home，
# 不被运行时 bind 覆盖），entrypoint 首启再拷进各容器 ~/.claude/skills。playwright-cli install 在非交互下
# 写完文件会挂起等 stdin，故 </dev/null 让其干净退出 + timeout 兜底；skill 走 cwd 相对（"Workspace
# initialized at <cwd>"），故 cd /etc/skel-home。test 断言模板真生成出来，失败则 build 报错（loud fail）。
RUN mkdir -p /etc/skel-home && cd /etc/skel-home \
    && { timeout 60 playwright-cli install --skills claude </dev/null >/dev/null 2>&1 || true; } \
    && test -d /etc/skel-home/.claude/skills/playwright-cli \
    && rm -rf /etc/skel-home/.playwright
# 装 playwright-cli 默认浏览器 chrome：`playwright-cli open` 默认走 channel 'chrome'（系统 Google Chrome，
# /opt/google/chrome/chrome），镜像里只有 Playwright 自带的 chromium（1232），故不装会报
# "Chromium distribution 'chrome' is not found"。用 playwright-cli 自带 install-browser 装（版本匹配其
# bundled playwright-core 1.62.0-alpha；走 apt 装 google-chrome-stable + 系统库 libgtk-3 等，故 --with-deps）。
# 装到系统路径 /opt/google/chrome/chrome（非 /opt/ms-playwright）。install-browser 同样写完会挂起等 stdin，
# 故 </dev/null + timeout 兜底；test 断言 chrome 可执行。单独成层保上面重层缓存。
RUN timeout 600 playwright-cli install-browser chrome --with-deps </dev/null >/dev/null 2>&1 || true \
    && test -x /opt/google/chrome/chrome

# —— 容器内配置（entrypoint / zshrc 模板）：刻意放最后——这俩文件改得最频繁，放尾部使改动只重建
# 这层 COPY，不破坏上面 chromium / CLI 等重层的 BuildKit 缓存。zshrc 作模板放 /etc/skel-home/（不进 home，
# 避免 bind 挂覆盖），entrypoint 首启拷进各容器持久化的 ~/.zshrc、之后各容器自管。
COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY zshrc.docker /etc/skel-home/.zshrc

# 镜像默认用户 = dev（uid 1000，与宿主 leon 对齐）：compose exec / docker run 不指定 --user 时落到 dev，
# entrypoint 也以 dev 跑（PID 1 经 docker-init/tini 转发信号），whoami=dev，运行时全程无 root。
# 构建期间的 USER root 仅为 npm 全局装包写 /usr/local，不影响运行时身份；最后切回 dev 收尾。
USER dev

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sleep", "infinity"]
