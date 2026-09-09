#!/usr/bin/env bash
# mysandbox 一键安装（唯一需要 sudo 的一步）。
#
#   cd mysandbox && sudo ./scripts/install.sh          # 仓库即安装位置
#   sudo ./scripts/install.sh --user alice             # 指定属主用户（默认 SUDO_USER）
#   sudo ./scripts/install.sh --uninstall              # 反操作（保留容器/config/模板数据）
#
# 分界哲学：需要特权的操作全部收敛成独立 system unit（net/firewall/interop），由 systemd
# 而非 sudoers 界定边界；mysandbox 服务本体以普通用户跑（unprivileged LXC 的 cgroup 委派
# 要求 + 安全模型，见 README 安全须知）。所以本脚本做完后，运行时全程无 root。
#
# 幂等：所有步骤可重复跑（已存在则跳过或等价覆盖）；仓库 unit 改动后重跑即可同步到 /etc。
#
# 系统级步骤（root）：
#   1. apt 装 lxc uidmap lxcfs iptables（apt 系发行版限定）
#   2. /etc/subuid + /etc/subgid 追加 <user>:100000:65536
#   3. /etc/lxc/lxc-usernet 放行 <user> veth <bridge>
#   4. 落盘三个 system unit（scripts/*.service 占位符填充）+ enable --now
#   5. loginctl enable-linger（用户级 systemd 常驻）
# 用户级步骤（runuser 切回属主，无需 root）：
#   6. npm install（node_modules 缺失时）+ npm run build（dist 缺失或 --rebuild）
#   7. 写 ~/.config/systemd/user/mysandbox.service（ExecStart 用 node 绝对路径——
#      user manager 不继承交互 shell 的 PATH，fnm/nvm 的 node 必须写死）
#   8. systemctl --user enable --now mysandbox + /api/health 探活
set -euo pipefail

# ---------- 参数 ----------
TARGET_USER="${SUDO_USER:-}"
BRIDGE="mysandbox0"
SUBNET="10.88.10.0/24"        # 与 config.default.yaml 的 ipPool 前缀一致；要改网段须三处对齐（本参数、config 覆盖、防火墙）
REBUILD=0
UNINSTALL=0

usage() { sed -n '2,12p' "$0"; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --user)     TARGET_USER="$2"; shift 2 ;;
    --bridge)   BRIDGE="$2"; shift 2 ;;
    --rebuild)  REBUILD=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)  usage 0 ;;
    *) echo "未知参数: $1" >&2; usage 1 ;;
  esac
done

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
MS_DIR="$(cd "$SELF_DIR/.." && pwd)"

log()  { printf '>> %s\n' "$*"; }
warn() { printf '>> ⚠️  %s\n' "$*" >&2; }
die()  { printf '>> ✗ %s\n' "$*" >&2; exit 1; }

# ---------- 前置检查 ----------
[ "$(id -u)" = 0 ] || die "请用 sudo 运行（这是整个安装里唯一需要 root 的一步）"
[ -n "$TARGET_USER" ] || die "推导不出目标用户——sudo 环境下运行，或显式 --user <name>"
id "$TARGET_USER" >/dev/null 2>&1 || die "用户 $TARGET_USER 不存在"
command -v apt-get >/dev/null 2>&1 || die "仅支持 apt 系发行版（LXC 5.0.x 按 Ubuntu/Debian 开发）"

TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_SHELL="$(getent passwd "$TARGET_USER" | cut -d: -f7)"
SUBNET_PREFIX="${SUBNET%.*}"

# 以目标用户身份跑命令（-l 加载其 profile：fnm/nvm 的 PATH 都挂在里面）。
as_user() { runuser -u "$TARGET_USER" -- env HOME="$TARGET_HOME" XDG_RUNTIME_DIR="/run/user/$TARGET_UID" "$@"; }
as_user_login() { as_user "$TARGET_SHELL" -lc "$*"; }

GW="${SUBNET_PREFIX}.1"
UNIT_DIR=/etc/systemd/system

# ---------- 卸载 ----------
if [ "$UNINSTALL" = 1 ]; then
  log "卸载 mysandbox 系统组件（容器/config/模板数据保留）"
  as_user systemctl --user disable --now mysandbox.service 2>/dev/null || true
  for u in mysandbox-net mysandbox-docker-interop mysandbox-firewall; do
    systemctl disable --now "$u.service" 2>/dev/null || true
    rm -f "$UNIT_DIR/$u.service"
  done
  rm -f "$TARGET_HOME/.config/systemd/user/mysandbox.service"
  systemctl daemon-reload
  as_user systemctl --user daemon-reload 2>/dev/null || true
  log "已卸载。保留：容器（~/.local/share/lxc）、config（~/.config/mysandbox）、state（~/.local/share/mysandbox）。"
  log "彻底清除请手工删上述目录 + /etc/subuid /etc/subgid 里的 ${TARGET_USER}:100000 行。"
  exit 0
fi

# ---------- 系统级 ----------
log "1/8 apt 包（lxc uidmap lxcfs iptables）"
MISSING=""
for p in lxc uidmap lxcfs iptables; do
  dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y $MISSING >/dev/null
else
  log "   已齐，跳过"
fi

log "2/8 subuid/subgid（unprivileged 容器的 uid 映射段）"
for f in /etc/subuid /etc/subgid; do
  grep -q "^${TARGET_USER}:" "$f" 2>/dev/null || echo "${TARGET_USER}:100000:65536" >> "$f"
done

log "3/8 lxc-usernet（veth 配额）"
LXC_USERNET=/etc/lxc/lxc-usernet
touch "$LXC_USERNET"
if grep -qE "^${TARGET_USER}[[:space:]]+veth[[:space:]]+" "$LXC_USERNET"; then
  sed -i -E "s|^(${TARGET_USER}[[:space:]]+veth[[:space:]]+).*|\1${BRIDGE} 20|" "$LXC_USERNET"
else
  echo "${TARGET_USER} veth ${BRIDGE} 20" >> "$LXC_USERNET"
fi

log "4/8 node 探测（属主 shell）"
# fnm 的 aliases/default 是稳定指针（升级不断链）——命中时保留 symlink 原样不 readlink：
# exec 时内核跟随 symlink 当下指向，default 切到新版本后 unit 依然有效；解析成具名
# node-versions 路径反而会在 fnm 清理旧版本后断链。
NODE=""
_c="$TARGET_HOME/.local/share/fnm/aliases/default/bin/node"
if [ -x "$_c" ]; then
  NODE="$_c"
else
  # 交互式 shell（-lic）才加载 .zshrc/.bashrc——fnm/nvm 的 PATH 挂在交互 rc 里，
  # login 非交互（-lc）拿不到。rc 有杂音时取最后一行。
  NODE="$(as_user "$TARGET_SHELL" -lic 'command -v node' 2>/dev/null | tail -n1 || true)"
  if [ -z "$NODE" ]; then
    # rc 未配时的常见位置直查（nvm 最新版 / 系统级）
    for c in /usr/local/bin/node /usr/bin/node "$TARGET_HOME"/.nvm/versions/node/*/bin/node; do
      [ -x "$c" ] && { NODE="$c"; break; }
    done
  fi
  [ -n "$NODE" ] && NODE="$(readlink -f "$NODE")"
fi
[ -n "$NODE" ] || die "属主用户 shell 里找不到 node（先装 node 20+，fnm/nvm 用户确认 rc 里初始化了）"
log "   node: $NODE"

log "5/8 构建（npm install + npm run build）"
if [ ! -d "$MS_DIR/node_modules" ]; then
  as_user_login "cd '$MS_DIR' && npm install" >/dev/null
else
  log "   node_modules 已在，跳过 install"
fi
if [ "$REBUILD" = 1 ] || [ ! -f "$MS_DIR/dist/server/cli.js" ]; then
  as_user_login "cd '$MS_DIR' && npm run build" >/dev/null
else
  log "   dist 已在（--rebuild 可强制重建），跳过 build"
fi

fill_unit() { # $1=仓库 unit  $2=落盘路径
  sed -e "s|__MSB_DIR__|$MS_DIR|g" \
      -e "s|__MSB_USER__|$TARGET_USER|g" \
      -e "s|__MSB_NODE__|$NODE|g" \
      -e "s|__MSB_BRIDGE__|$BRIDGE|g" \
      -e "s|__MSB_SUBNET__|$SUBNET|g" \
      -e "s|__MSB_GW__|$GW|g" "$1" > "$2"
}

log "6/8 system unit（net / firewall / docker-interop）"
fill_unit "$SELF_DIR/mysandbox-net.service" "$UNIT_DIR/mysandbox-net.service"
fill_unit "$SELF_DIR/mysandbox-firewall.service" "$UNIT_DIR/mysandbox-firewall.service"
systemctl daemon-reload
systemctl enable mysandbox-net.service mysandbox-firewall.service >/dev/null
systemctl start mysandbox-net.service || warn "mysandbox-net 启动失败——systemctl status mysandbox-net 排查"
systemctl start mysandbox-firewall.service || warn "mysandbox-firewall 启动失败——systemctl status mysandbox-firewall 排查"
if command -v docker >/dev/null 2>&1 && systemctl list-unit-files docker.service >/dev/null 2>&1; then
  fill_unit "$SELF_DIR/mysandbox-docker-interop.service" "$UNIT_DIR/mysandbox-docker-interop.service"
  systemctl daemon-reload
  systemctl enable mysandbox-docker-interop.service >/dev/null
  systemctl start mysandbox-docker-interop.service || warn "mysandbox-docker-interop 启动失败——systemctl status 排查"
else
  warn "docker 未安装——跳过 mysandbox-docker-interop（装 docker 后重跑本脚本补上）"
fi

log "7/8 linger（用户级 systemd 常驻）"
loginctl enable-linger "$TARGET_USER" 2>/dev/null || true

log "8/8 user service（mysandbox 本体）"
mkdir -p "$TARGET_HOME/.config/systemd/user"
cat > "$TARGET_HOME/.config/systemd/user/mysandbox.service" <<EOF
[Unit]
Description=mysandbox web console (LXC engine)
# LXC 引擎要求 mysandbox 跑在 systemd user manager 里（cgroup 委派），
# 见 docs/lxc-migration.md「LXC 命令必须在 systemd user manager 环境跑」。
# 由 scripts/install.sh 生成——改 ExecStart/WorkingDirectory 请重跑 install.sh。

[Service]
Type=simple
ExecStart=$NODE $MS_DIR/dist/server/cli.js
WorkingDirectory=$MS_DIR
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
chown -R "$TARGET_USER:" "$TARGET_HOME/.config/systemd/user"
# linger 刚开时 user manager 可能还没起，等 /run/user/<uid> 就位（最多 10s）。
for _ in $(seq 1 10); do
  [ -d "/run/user/$TARGET_UID" ] && break
  sleep 1
done
[ -d "/run/user/$TARGET_UID" ] || die "/run/user/$TARGET_UID 未就位——请登录一次该用户后重跑"
as_user systemctl --user daemon-reload
as_user systemctl --user enable --now mysandbox.service >/dev/null 2>&1 || {
  as_user systemctl --user enable mysandbox.service >/dev/null
  as_user systemctl --user restart mysandbox.service
}

# ---------- 探活 + 收尾 ----------
# listen 形态按 config 实际值探。host auto 的解析镜像 cli.ts resolveAutoHost：
# /proc/net/route 主表默认路由接口（destination 00000000）的第一个 global IPv4——
# 不能用 `ip route get`，clash TUN 类工具会以策略路由截走 src 给出 fake-ip 段。
_auto_host() {
  local ifname ip
  ifname="$(awk '$2 == "00000000" { print $1; exit }' /proc/net/route 2>/dev/null)"
  if [ -n "$ifname" ]; then
    ip="$(ip -4 -o addr show dev "$ifname" scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
  fi
  [ -n "$ip" ] || ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
  printf '%s' "${ip:-127.0.0.1}"
}
CFG="$TARGET_HOME/.config/mysandbox/config.yaml"
LISTEN_PORT=7321; LISTEN_HOST=127.0.0.1; LISTEN_TLS=0
if [ -f "$CFG" ]; then
  LISTEN_PORT="$(grep -E '^[[:space:]]*port:' "$CFG" | head -n1 | awk '{print $2}' | grep -oE '[0-9]+' || echo 7321)"
  _h="$(grep -E '^[[:space:]]*host:' "$CFG" | head -n1 | awk '{print $2}' | tr -d '\042\047' || true)"
  case "${_h:-}" in
    auto) LISTEN_HOST="$(_auto_host)" ;;
    ""|localhost) LISTEN_HOST=127.0.0.1 ;;
    *) LISTEN_HOST="$_h" ;;
  esac
  grep -E '^[[:space:]]*tls:' "$CFG" | head -n1 | grep -q true && LISTEN_TLS=1
fi
SCHEME=http; CURL_OPTS=()
[ "$LISTEN_TLS" = 1 ] && { SCHEME=https; CURL_OPTS=(-k); }

log "探活 $SCHEME://$LISTEN_HOST:$LISTEN_PORT/api/health"
HEALTH=""
# 绑具体 IP 时 127.0.0.1 不通、绑 127.0.0.1 时外网 IP 也不通——两个候选都试。
for _t in "$LISTEN_HOST" 127.0.0.1; do
  for _ in $(seq 1 5); do
    HEALTH="$(curl -fsS --max-time 2 "${CURL_OPTS[@]}" "$SCHEME://$_t:$LISTEN_PORT/api/health" 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break 2
    sleep 1
  done
done
[ -n "$HEALTH" ] && log "   ok: $HEALTH" || warn "服务未在 10s 内应答——journalctl --user -u mysandbox 看日志"

# config 已存在且 ipPool 前缀与 unit 网段不一致时提醒（unit 网关是容器网段的 .1）。
if [ -f "$CFG" ] && ! grep -qE "from: ${SUBNET_PREFIX}\." "$CFG"; then
  warn "config.yaml 的 ipPool 前缀与 unit 网段（$SUBNET）不一致——容器网关/NAT 会错位，请对齐后 sudo systemctl restart mysandbox-firewall"
fi

cat <<EOF

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  mysandbox 安装完成
  访问:    $SCHEME://$LISTEN_HOST:$LISTEN_PORT（token 见首启输出：journalctl --user -u mysandbox | grep token）
  模板:    还没有容器模板——
             sudo -u $TARGET_USER $MS_DIR/scripts/lxc-template.sh ms-template   # 10-20 分钟
           或从既有包恢复: mysandbox base import <path>
  安全:    token = 宿主 $TARGET_USER 账号权限，勿外发；远程访问用 Tailscale 等私网，勿直接绑公网
  防火墙:  改过 config（网段/端口）后: sudo systemctl restart mysandbox-firewall
  卸载:    sudo $MS_DIR/scripts/install.sh --uninstall
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EOF
