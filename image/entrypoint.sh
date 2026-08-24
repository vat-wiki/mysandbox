#!/usr/bin/env bash
# 容器启动入口（dev 模式，无 systemd / 无 root）：
#   0) docker-init（tini，由 compose `init: true` 注入）做 PID 1：信号转发 + 回收僵尸
#   1) entrypoint 以 dev 身份执行 home seed（首启从镜像模板补 ~/.zshrc / claude settings / ssh key 等）
#   2) exec 到 CMD（默认 sleep infinity，常驻容器供 compose exec 进来）
#
# 调度 / 定时任务：交给 agent 自带的 scheduler（如 Claude Code 的 CronCreate、`club listen` 轮询），
# 不依赖系统 cron / systemd timer——所以本入口也不拉起任何 daemon。
set -euo pipefail

cd /home/dev || { echo ">> home 不可写" >&2; exit 1; }

# ---------- ~/.zshrc：首启从模板 seed ----------
if [ ! -f "$HOME/.zshrc" ] && [ -f /etc/skel-home/.zshrc ]; then
  cp /etc/skel-home/.zshrc "$HOME/.zshrc"
fi

# ---------- claude 规范位置兜底 ----------
mkdir -p "$HOME/.local/bin"
[ -e "$HOME/.local/bin/claude" ] || ln -s /usr/local/bin/claude "$HOME/.local/bin/claude"

# ---------- claude 全局配置：首启 seed ----------
mkdir -p "$HOME/.claude"
[ -e "$HOME/.claude.json" ] || printf '%s' '{}' > "$HOME/.claude.json"
if [ ! -f "$HOME/.claude/settings.json" ] && [ -f /mnt/claude-settings.template ]; then
  cp /mnt/claude-settings.template "$HOME/.claude/settings.json"
fi

# ---------- playwright-cli skill：首启从镜像模板 seed ----------
if [ ! -d "$HOME/.claude/skills/playwright-cli" ] && [ -d /etc/skel-home/.claude/skills/playwright-cli ]; then
  mkdir -p "$HOME/.claude/skills"
  cp -a /etc/skel-home/.claude/skills/playwright-cli "$HOME/.claude/skills/"
fi

# ---------- 从宿主机 seed ssh key（只读 -> 可写副本） ----------
if [ -d /mnt/host/.ssh ] && [ ! -d "$HOME/.ssh" ]; then
  cp -a /mnt/host/.ssh "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  chmod 600 "$HOME/.ssh"/id_* 2>/dev/null || true
fi
if [ -f "$HOME/.ssh/known_hosts" ] && ! ssh-keygen -F github.com -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1; then
  ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
fi

# ---------- git 身份 + ~/.gitconfig（仅缺失时写一次）----------
: "${GIT_AUTHOR_NAME:=leon}"
: "${GIT_AUTHOR_EMAIL:=leon@vat-wiki.local}"
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
if [ ! -f "$HOME/.gitconfig" ]; then
  cat > "$HOME/.gitconfig" <<EOF
[user]
    name = $GIT_AUTHOR_NAME
    email = $GIT_AUTHOR_EMAIL
[init]
    defaultBranch = main
EOF
fi

# ---------- 版本一览 ----------
echo ">> node $(node -v) / npm $(npm -v)"
echo ">> claude $(claude --version 2>/dev/null | head -1 || echo '?') · codex $(codex --version 2>/dev/null | head -1 || echo '?') · opencode $(opencode --version 2>/dev/null | head -1 || echo '?') · pi $(pi --version 2>/dev/null | head -1 || echo '?') · hermes $(hermes --version 2>/dev/null | head -1 || echo '?') · openclaw $(openclaw --version 2>/dev/null | head -1 || echo '?') · gh $(gh --version 2>/dev/null | head -1 || echo '?')"

# ---------- exec 主进程 ----------
exec "${@:-zsh}"
