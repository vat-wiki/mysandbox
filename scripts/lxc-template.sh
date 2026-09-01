#!/usr/bin/env bash
# LXC 模板容器制作脚本（engine: lxc 时取代 image/Dockerfile）。
#
# 用法（在宿主上跑，容器必须已启动）：
#   scripts/lxc-template.sh <容器名>            # 默认 ms-template
#
# 与 Dockerfile 的关系：同一份镜像契约，换了执行形态。
#   Dockerfile 是「分层构建 + 每层 RUN」，LXC 这边是「一个跑起来的容器里跑一遍脚本」，
#   产物直接留在 rootfs 里，之后 lxc-copy 克隆。所以：
#   - 没有层缓存，改脚本要整跑（约 10–20 分钟，绝大部分在 apt + npm）。
#   - 幂等：每步都先探测再装，重复跑只补缺的（这是替代层缓存的手段）。
#   - Dockerfile 的 USER 切换在这里没有对应物——本脚本全程 root（lxc-attach 进去就是 root）。
#
# 与 Dockerfile 的**刻意差异**（都是 LXC 形态的必然结果，不是遗漏）：
#   1) systemd 真的在跑（LXC 是系统容器），所以不需要 tini/PID1 那一套；docker 侧
#      entrypoint.sh 的「首启 seed」语义在这里由 mysandbox 建容器时 + 容器内首次开终端保证。
#   2) 静态 IP 没有 DHCP → systemd-resolved 没有上游 DNS，必须写 resolved.conf.d（下面 step dns）。
#      这一步在 docker 侧不存在（docker 有内建 DNS）。
#   3) noble 的 download 模板自带 `ubuntu` 用户占着 uid 1000，契约要的是 `dev`：
#      用 usermod -l 改名而非删了重建（rootfs 里已有该 uid 的文件，重建会留下孤儿属主）。
#   4) chromium / playwright 暂不装（体积大且容器内 headless 需要额外验证）——需要时在容器里
#      自己 `npx playwright install`，或往本脚本补一个 step。
#
# 跑完记得 `lxc-stop -n <容器名>`：lxc-copy 对运行中的源会**静默失败**（exit 1、无输出）。
set -euo pipefail

NAME="${1:-ms-template}"
NODE_VERSION="${NODE_VERSION:-24.19.0}"
GH_VERSION="${GH_VERSION:-2.97.0}"

# 把脚本喂进容器跑。
#
# ⚠️ 脚本必须经 **stdin** 给 `bash -s`，不能写成 `bash -c "<脚本>"`：systemd-run 把命令行
# 当 unit 的 ExecStart，systemd 会先展开自己的 `${VAR}` 规格符——脚本里的 `${ARCH}` 会被
# systemd 吃成空串（实测踩到：node 下载 URL 的 ${ARCH} 消失 → 404）。走 stdin 则整段脚本
# 不经 systemd 解析，`$` 全部留给 bash。宿主侧的值用位置参数传（$1/$2…），不要靠插值。
#
# 另外 lxc-attach 必须在自己的 transient unit 里跑：systemd user manager 委派的 cgroup 下，
# 裸 shell 起的 lxc-attach 无权把进程挪进目标 cgroup（实测 Permission denied）。
# 和 server/engine/lxc.ts 的约束同源，那边由 mysandbox 自己的 unit 满足。
attsh() {
  systemd-run --user --pipe --wait --collect --quiet \
    lxc-attach -n "$NAME" --clear-env -- bash -euo pipefail -s "$@"
}

step() { printf '\n=== %s ===\n' "$1" >&2; }

state=$(lxc-info -n "$NAME" -s 2>/dev/null | awk '{print $2}' || true)
if [ "$state" != "RUNNING" ]; then
  echo "容器 $NAME 未在运行（当前 ${state:-不存在}）。先起来：" >&2
  echo "  systemd-run --user --unit=prep-$NAME --collect --property=KillMode=mixed lxc-start -n $NAME -F" >&2
  exit 1
fi

# ---------- dns：静态 IP 无 DHCP，resolved 没有上游 ----------
# 网关 10.88.10.1 是宿主在网桥上的副 IP（见 docs/lxc-migration.md P8）。
step dns
attsh <<'EOS'
mkdir -p /etc/systemd/resolved.conf.d
cat > /etc/systemd/resolved.conf.d/mysandbox.conf <<CONF
[Resolve]
DNS=10.88.10.1 114.114.114.114
CONF
systemctl restart systemd-resolved
getent hosts archive.ubuntu.com >/dev/null || { echo "DNS 仍不可用" >&2; exit 1; }
EOS

# ---------- dev 用户：uid 1000 必须叫 dev（与宿主 leon 对齐，见 D1）----------
step user
attsh <<'EOS'
if id dev >/dev/null 2>&1; then
  echo "dev 已存在，跳过"
elif id -nu 1000 >/dev/null 2>&1; then
  # noble 自带 ubuntu 占 1000：改名 + 搬 home（-m），不删重建（避免孤儿属主）
  old=$(id -nu 1000)
  pkill -u 1000 || true
  usermod -l dev -d /home/dev -m "$old"
  groupmod -n dev "$(id -ng 1000)"
else
  groupadd -g 1000 dev && useradd -m -u 1000 -g 1000 dev
fi
# shell 后面装完 zsh 再设（此刻 /usr/bin/zsh 可能还不存在，chsh 会拒）
# sudo 免密：容器是一次性沙盒，dev 需要能自己 apt 装东西
echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev
chmod 440 /etc/sudoers.d/dev
EOS

# ---------- apt 基础包（对齐 Dockerfile 第一层）----------
# 源先换 aliyun：官方源被 fake-ip DNS 污染（198.18.x → clash/mihomo），容器直连拉不动；
# aliyun 实测直连可达（见 docs）。幂等：已是 aliyun 则 sed 无命中、不改动。
step apt
attsh <<'EOS'
export DEBIAN_FRONTEND=noninteractive
sed -i "s|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; s|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g" /etc/apt/sources.list
apt-get update
apt-get install -y --no-install-recommends \
  zsh git openssh-client ca-certificates jq curl less vim-tiny xz-utils tzdata tmux \
  zsh-autosuggestions zsh-syntax-highlighting \
  python3 make g++ sudo bsdutils locales \
  xvfb x11vnc xfce4 xfce4-terminal dbus-x11 \
  fontconfig fonts-noto-cjk
# fontconfig + fonts-noto-cjk：桌面/容器内 GUI 的中文渲染（终端是浏览器渲染不依赖它，但 XFCE 桌面、
# 文件管理器、容器内起的应用没有 CJK 字体全是豆腐块）。fontconfig 要显式写：fonts-noto-cjk 只
# Depends 到 libfontconfig1 库，不带 fc-list/fc-cache 工具（存量 service 容器实测踩到：字体文件在、
# fc-list 没有，zh 查询恒 0）。--no-install-recommends 下只装正体不装 extra，体积 ~100MB 可接受。
# locale：容器内进程必须跑在有效 UTF-8 charmap 下——mysandbox exec 链路 --clear-env 后只带
# LANG=C.UTF-8 进来（engine/lxc.ts attachArgs），模板侧保证它有效；zh_CN 一并生成给用户手工切换。
# 不生成的话 C.UTF-8 虽是 glibc 内置、但 zh_CN 缺失会让切 locale 的尝试报 "Cannot set LC_*"。
locale-gen en_US.UTF-8 zh_CN.UTF-8
update-locale LANG=C.UTF-8
ln -sf /usr/share/zoneinfo/Asia/Singapore /etc/localtime
echo Asia/Singapore > /etc/timezone
rm -rf /var/lib/apt/lists/*
chsh -s /usr/bin/zsh dev
EOS

# ---------- oh-my-zsh：zsh 框架（apt 无包，git clone 系统级装到 /usr/share）----------
# 不用官方 install.sh：它装到 $HOME、还会改写 zshrc/chsh——模板要的是 root 持有、随 rootfs 克隆。
# 幂等：已在位即跳过；模板是冻结快照，不 git 追新（zshrc 里也关了 omz 自动更新）。
# zsh-autosuggestions / zsh-syntax-highlighting 仍是上面的 apt 包——omz 不含这两个，删不得。
# ⚠️ git clone 建的目录是 775：omz 的 compaudit 对 group/other 可写目录拒载补全（实测报
# Insecure completion-dependent directories）——clone 后必须 chmod g-w,o-w。
step omz
attsh <<'EOS'
if [ -f /usr/share/oh-my-zsh/oh-my-zsh.sh ]; then
  echo "oh-my-zsh 已在位，跳过 clone"
else
  for _ in 1 2 3; do   # GitHub 偶发抖动，对齐 node/gh 步的重试策略
    git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /usr/share/oh-my-zsh && break
    sleep 3
  done
fi
rm -rf /usr/share/oh-my-zsh/.git        # 冻结快照不留 .git（omz compdump 元数据退化为无 rev，跨启动稳定）
chmod -R g-w,o-w /usr/share/oh-my-zsh
test -f /usr/share/oh-my-zsh/oh-my-zsh.sh
EOS

# ---------- node（官方 tarball 到 /usr/local，对齐 Dockerfile）----------
step node
attsh "$NODE_VERSION" <<'EOS'
want=$1
if command -v node >/dev/null 2>&1 && [ "$(node -v)" = "v$want" ]; then
  echo "node v$want 已在位"
else
  ARCH=$(case "$(dpkg --print-architecture)" in amd64) echo x64 ;; arm64) echo arm64 ;; *) exit 1 ;; esac)
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
    "https://nodejs.org/dist/v${want}/node-v${want}-linux-${ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1
  corepack enable
fi
node -v && npm -v
EOS

# ---------- AI CLI（npm 全局，对齐 Dockerfile）----------
# --ignore-scripts 的理由同 Dockerfile：pi 的 postinstall 在非交互下等 stdin 会挂住。
step ai-cli
attsh <<'EOS'
export HOME=/tmp
npm install -g --ignore-scripts \
  @openai/codex@latest \
  opencode-ai@latest \
  openclaw@latest \
  @earendil-works/pi-coding-agent@latest
npm install -g @anthropic-ai/claude-code@latest
# opencode 的 postinstall 手动补跑（--ignore-scripts 把它也跳了，留下 placeholder 报错脚本）
cd /usr/local/lib/node_modules/opencode-ai && node postinstall.mjs
! grep -qa "postinstall script was not run" bin/opencode.exe
bin/opencode.exe --version
rm -rf /tmp/.npm /tmp/.cache
EOS

# ---------- gh ----------
step gh
attsh "$GH_VERSION" <<'EOS'
want=$1
if command -v gh >/dev/null 2>&1; then
  gh --version | head -1
else
  ARCH=$(case "$(dpkg --print-architecture)" in amd64) echo amd64 ;; arm64) echo arm64 ;; *) exit 1 ;; esac)
  curl -fsSL --retry 5 --retry-delay 3 --retry-all-errors \
    "https://github.com/cli/cli/releases/download/v${want}/gh_${want}_linux_${ARCH}.tar.gz" -o /tmp/gh.tgz
  tar -xzf /tmp/gh.tgz -C /usr/local --strip-components=1 "gh_${want}_linux_${ARCH}"
  rm -f /tmp/gh.tgz
  gh --version | head -1
fi
EOS

# ---------- skel-home：首启 seed 模板（对齐 Dockerfile 的 /etc/skel-home）----------
# zshrc 从宿主的 scripts/zshrc 拷进去——同一份文件两个引擎共用，别分叉。
step skel
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
if [ -f "$here/scripts/zshrc" ]; then
  # 经 base64 走位置参数，免去 quoting 与「宿主路径在容器内不可见」的问题
  attsh "$(base64 -w0 < "$here/scripts/zshrc")" <<'EOS'
mkdir -p /etc/skel-home
printf %s "$1" | base64 -d > /etc/skel-home/.zshrc
EOS
else
  echo "warn: $here/scripts/zshrc 不存在，跳过 zshrc 模板" >&2
  attsh <<'EOS'
mkdir -p /etc/skel-home
EOS
fi

# ---------- 收尾自检：契约项逐条断言 ----------
step verify
attsh <<'EOS'
fail=0
chk() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }
chk "uid 1000 = dev"      '[ "$(id -nu 1000)" = dev ]'
chk "home /home/dev"      '[ -d /home/dev ]'
chk "dev shell = zsh"     'getent passwd dev | grep -q zsh'
chk "zsh"                 'command -v zsh'
chk "tmux"                'command -v tmux'
chk "git"                 'command -v git'
chk "script(1)"           'command -v script'
chk "node"                'command -v node'
chk "claude"              'command -v claude'
chk "gh"                  'command -v gh'
chk "sudo 免密"           '[ -f /etc/sudoers.d/dev ]'
chk "skel zshrc"          '[ -f /etc/skel-home/.zshrc ]'
chk "oh-my-zsh"           '[ -f /usr/share/oh-my-zsh/oh-my-zsh.sh ]'
chk "ghost 建议插件"      '[ -f /usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh ]'
chk "语法高亮插件"        '[ -f /usr/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh ]'
chk "中文字体"            'fc-list :lang=zh | grep -q .'
chk "DNS"                 'getent hosts github.com'
[ $fail -eq 0 ] || { echo "模板契约未满足" >&2; exit 1; }
EOS

cat >&2 <<EOF

模板 $NAME 就绪。接着做两件事：
  1) lxc-stop -n $NAME          # lxc-copy 对运行中的源静默失败，必须先停
  2) 在 ~/.config/mysandbox/config.yaml 里设 engine: lxc 与 lxc.template: $NAME
EOF
