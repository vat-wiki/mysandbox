#!/usr/bin/env bash
# mysandbox 一键安装（唯一需要 sudo 的一步）。
#
#   cd mysandbox && sudo ./scripts/install.sh          # 仓库即安装位置
#   sudo ./scripts/install.sh --user alice             # 指定属主用户（默认 SUDO_USER）
#   sudo ./scripts/install.sh --subnet 10.89.10.0/24   # 自定义容器网段（嵌套部署等场景，
#                                                      # 须与外层网桥网段不同，否则 ARP 冲突）
#   sudo ./scripts/install.sh --uninstall              # 反操作（保留容器/config/模板数据）
#
# 分界哲学：需要特权的操作全部收敛成独立 system unit（net/firewall/interop），由 systemd
# 而非 sudoers 界定边界；mysandbox 服务本体以普通用户跑（unprivileged LXC 的 cgroup 委派
# 要求 + 安全模型，见 README 安全须知）。所以本脚本做完后，运行时全程无 root。
#
# 幂等：所有步骤可重复跑（已存在则跳过或等价覆盖）；仓库 unit 改动后重跑即可同步到 /etc。
#
# 系统级步骤（root）：
#   1. apt 装 lxc uidmap lxcfs iptables zstd（apt 系发行版限定）
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

usage() { sed -n '2,14p' "$0"; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --user)     TARGET_USER="$2"; shift 2 ;;
    --bridge)   BRIDGE="$2"; shift 2 ;;
    --subnet)   SUBNET="$2"; shift 2 ;;
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

# 网段格式检查：只支持 /24（unit/防火墙/池前缀推导都按 /24 简化）。
case "$SUBNET" in
  *.0/24) : ;;
  *) die "网段须为 /24 形态（a.b.c.0/24）: $SUBNET" ;;
esac
case "${SUBNET%/*}" in
  *[!0-9.]*) die "无效网段: $SUBNET（格式 a.b.c.0/24）" ;;
esac

# ---------- 前置检查 ----------
[ "$(id -u)" = 0 ] || die "请用 sudo 运行（这是整个安装里唯一需要 root 的一步）"
[ -n "$TARGET_USER" ] || die "推导不出目标用户——sudo 环境下运行，或显式 --user <name>"
id "$TARGET_USER" >/dev/null 2>&1 || die "用户 $TARGET_USER 不存在"
command -v apt-get >/dev/null 2>&1 || die "仅支持 apt 系发行版（LXC 5.0.x 按 Ubuntu/Debian 开发）"

TARGET_UID="$(id -u "$TARGET_USER")"
TARGET_GID="$(id -g "$TARGET_USER")"
TARGET_HOME="$(getent passwd "$TARGET_USER" | cut -d: -f6)"
TARGET_SHELL="$(getent passwd "$TARGET_USER" | cut -d: -f7)"
# D1 直通（容器 dev=1000 → 宿主属主）靠 default.conf 里的单条 idmap 落在宿主真实 uid/gid 上。
# 宿主 uid/gid 若落在 subuid 段自身（100000–165535）会与其它映射行重叠，lxc-start 直接拒绝——
# 正常系统到不了这个区间，守卫一下防极端配置（uid_max 被调高的机器）。
for _v in "$TARGET_UID" "$TARGET_GID"; do
  if [ "$_v" -ge 100000 ] && [ "$_v" -le 165535 ]; then
    die "属主 uid/gid $_v 落在 subuid 段（100000–165535）内，无法生成 idmap——请换属主用户"
  fi
done
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
  for u in mysandbox-net mysandbox-docker-interop mysandbox-firewall mysandbox-console; do
    systemctl disable --now "$u.service" "$u.socket" 2>/dev/null || true
    rm -f "$UNIT_DIR/$u.service" "$UNIT_DIR/$u.socket"
  done
  rm -f "$TARGET_HOME/.config/systemd/user/mysandbox.service"
  systemctl daemon-reload
  as_user systemctl --user daemon-reload 2>/dev/null || true
  log "已卸载。保留：容器（~/.local/share/lxc）、mysandbox 数据（~/.mysandbox）。"
  log "彻底清除请手工删上述目录 + /etc/subuid /etc/subgid 里的 ${TARGET_USER}:100000 行。"
  exit 0
fi

# ---------- 系统级 ----------
log "1/8 apt 包（lxc uidmap lxcfs iptables zstd）"
MISSING=""
for p in lxc uidmap lxcfs iptables zstd; do
  # zstd：base export 的 tar --zstd 必需——精简环境（嵌套/容器内）默认没有，缺了导出直接挂。
  dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"
done
if [ -n "$MISSING" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y $MISSING >/dev/null
else
  log "   已齐，跳过"
fi

log "2/8 subuid/subgid（unprivileged 容器的 uid 映射段）"
for f in /etc/subuid /etc/subgid; do
  if grep -q "^${TARGET_USER}:" "$f" 2>/dev/null; then
    # 已有条目的起点必须与 default.conf 的 idmap 对齐（100000）——起点错位则 lxc-start 必败。
    _got="$(grep "^${TARGET_USER}:" "$f" | head -n1 | cut -d: -f2)"
    [ "$_got" = "100000" ] || die "$f 里 ${TARGET_USER} 的映射段起点是 $_got（需 100000）。若曾手工配过其它起点，需按它重写 ~/.config/lxc/default.conf 的 idmap"
  else
    echo "${TARGET_USER}:100000:65536" >> "$f"
  fi
done

log "3/8 lxc-usernet + 用户级 default.conf"
LXC_USERNET=/etc/lxc/lxc-usernet
touch "$LXC_USERNET"
if grep -qE "^${TARGET_USER}[[:space:]]+veth[[:space:]]+" "$LXC_USERNET"; then
  sed -i -E "s|^(${TARGET_USER}[[:space:]]+veth[[:space:]]+).*|\1${BRIDGE} 20|" "$LXC_USERNET"
else
  echo "${TARGET_USER} veth ${BRIDGE} 20" >> "$LXC_USERNET"
fi
# 用户级 default.conf：base import / 模板克隆的 idmap 源头（无它建出的容器无 uid 映射，
# unprivileged 环境下 lxc-start 必败）。缺失才生成——已有配置尊重不动。
# idmap 语义 = D1 契约：容器 root→100000 段、dev(1000) 直通宿主属主用户（TARGET_UID/GID
# 不写死 1000——属主 uid 非 1000 的机器上，写死会让容器 home 的宿主侧属主落到别人/不存在的
# uid，D1 直通全链路断裂。仅新生成时生效，已有 default.conf 尊重不动）。
LXC_DEF="$TARGET_HOME/.config/lxc/default.conf"
if [ ! -f "$LXC_DEF" ]; then
  mkdir -p "$TARGET_HOME/.config/lxc"
  cat > "$LXC_DEF" <<EOF
# mysandbox unprivileged LXC 默认配置（scripts/install.sh 生成）。
lxc.idmap = u 0 100000 1000
lxc.idmap = g 0 100000 1000
lxc.idmap = u 1000 ${TARGET_UID} 1
lxc.idmap = g 1000 ${TARGET_GID} 1
lxc.idmap = u 1001 101001 64535
lxc.idmap = g 1001 101001 64535

lxc.net.0.type = veth
lxc.net.0.link = ${BRIDGE}
lxc.net.0.flags = up
EOF
  chown -R "$TARGET_USER:" "$TARGET_HOME/.config/lxc"
fi

# sshSource 前置：首启 config 会把 ~/.ssh 填进 sshSource（容器只读挂 /mnt/host/.ssh），
# 目录不存在时建容器会因 mount 死路径直接 start 失败——这里保证它存在。
TARGET_SSH="$TARGET_HOME/.ssh"
if [ ! -d "$TARGET_SSH" ]; then
  mkdir -p "$TARGET_SSH"
  chmod 700 "$TARGET_SSH"
  chown "$TARGET_USER:" "$TARGET_SSH"
fi

# 自定义网段 → 首启 config 对齐：config.default.yaml 的 ipPool 是写死的默认段，--subnet
# 装出来的环境若不覆盖，首启生成的池就在错误网段上（建容器分到不可达 IP）。
# 只在 config **尚不存在**时写（已有 config 尊重不动，末尾探活后有不一致提醒）；
# 故意只写 ipPool 一项——缺的 token/peerToken 由首启补生成并全量写回（config.ts）。
CFG_SEED="$TARGET_HOME/.mysandbox/config.yaml"
if [ "$SUBNET_PREFIX" != "10.88.10" ] && [ ! -f "$CFG_SEED" ]; then
  log "3.5/8 config 预置（ipPool 对齐自定义网段 $SUBNET）"
  mkdir -p "$TARGET_HOME/.mysandbox"
  cat > "$CFG_SEED" <<EOF
# scripts/install.sh --subnet $SUBNET 生成：仅覆盖 ipPool，其余字段首启按 default 生成。
ipPool:
  from: ${SUBNET_PREFIX}.20
  to: ${SUBNET_PREFIX}.250
  reserved:
    - ${SUBNET_PREFIX}.1
    - ${SUBNET_PREFIX}.2
EOF
  chown -R "$TARGET_USER:" "$TARGET_HOME/.mysandbox"
  chmod 600 "$CFG_SEED"
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
# npm install 恒跑（幂等）：残缺的 node_modules（上次 install 中断）靠它自愈补齐，
# 已完整时只花几秒——「目录存在就跳过」会把残缺件带进 build（npm 会把中断残留误判
# 成 up to date）。web/ 是独立 package.json（无 workspace），依赖必须单独装。
# 差网络（DNS 抖动/CDN 超时）下重试 3 次——实测偶发 EAI_AGAIN/ETIMEDOUT，重试即过。
for sub in . web; do
  # 全产物已在（重跑同步 unit 的典型场景）则整体跳过构建段：省时，也避开 npm 网络
  # 抖动把一次纯同步卡死。任一产物缺失才进入 npm install 恒跑（自愈残缺件）。
  if [ -d "$MS_DIR/node_modules" ] && [ -d "$MS_DIR/web/node_modules" ] && \
     [ -f "$MS_DIR/dist/server/cli.js" ] && [ -f "$MS_DIR/web/dist/index.html" ]; then
    log "   产物齐全，跳过构建段"
    break
  fi
  ok=0
  for attempt in 1 2 3; do
    if as_user_login "cd '$MS_DIR/$sub' && npm install --no-audit --no-fund" >/dev/null; then
      ok=1; break
    fi
    warn "npm install 失败（$sub，第 $attempt 次）——重试"
    sleep 3
  done
  [ "$ok" = 1 ] || die "npm install 失败（$sub；网络/registry？国内网络可试: npm config set registry https://registry.npmmirror.com）"
done
if [ "$REBUILD" = 1 ] || [ ! -f "$MS_DIR/dist/server/cli.js" ] || [ ! -f "$MS_DIR/web/dist/index.html" ]; then
  as_user_login "cd '$MS_DIR' && npm run build" >/dev/null || die "npm run build 失败"
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

log "6/8 system unit（net / firewall / docker-interop / console）"
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

log "6.5/8 网关 DNS 监听（$GW:53，容器 resolved 的上游）"
# 容器静态 IP 无 DHCP，systemd-resolved 的唯一上游 = 网关副 IP:53（lxc-template.sh 的 dns 步
# 依赖它）。全新宿主上没人应答这个端口——由 resolved 的 DNSStubListenerExtra 补上。
# 已有应答方则不动（mihomo/dnsmasq 等自配 DNS 的场景尊重现状）；网桥没起来（net unit 失败）
# 时跳过——IP 不存在监听也绑不上。
if ip -4 addr show dev "$BRIDGE" 2>/dev/null | grep -qw "$GW" \
   && timeout 2 bash -c "exec 3<>/dev/tcp/$GW/53" 2>/dev/null; then
  log "   已有应答方，跳过"
elif ip -4 addr show dev "$BRIDGE" 2>/dev/null | grep -qw "$GW"; then
  mkdir -p /etc/systemd/resolved.conf.d
  cat > /etc/systemd/resolved.conf.d/mysandbox-dns.conf <<EOF
# scripts/install.sh 生成：容器（静态 IP 无 DHCP）以网关 IP 作为上游 DNS。
[Resolve]
DNSStubListenerExtra=$GW:53
EOF
  systemctl restart systemd-resolved 2>/dev/null \
    || warn "systemd-resolved 重启失败——容器 DNS 可能不可用，检查 /etc/systemd/resolved.conf.d/mysandbox-dns.conf"
  log "   已写 DNSStubListenerExtra=$GW:53"
else
  warn "网桥 $BRIDGE 未就位（mysandbox-net 启动失败？）——跳过 DNS 监听配置"
fi

log "7/8 linger（用户级 systemd 常驻）"
loginctl enable-linger "$TARGET_USER" 2>/dev/null || true

log "8/8 user service（mysandbox 本体）"
# mkdir -p 会把缺失的父目录建成 root 属主（.config 原本不存在时）——devtest 的服务
# 首启要往 ~/.mysandbox 写 config，属主残留 root 就是 EACCES crash 循环。
# 三个层级全部 chown（已属目标用户时幂等无害）。
mkdir -p "$TARGET_HOME/.config/systemd/user"
chown "$TARGET_USER:" "$TARGET_HOME/.config" "$TARGET_HOME/.config/systemd" "$TARGET_HOME/.config/systemd/user"
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
# 上次 crash 循环后 unit 处于 failed 态——不清掉 enable --now 拉不起来（幂等重跑场景）。
as_user systemctl --user reset-failed mysandbox.service 2>/dev/null || true
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
CFG="$TARGET_HOME/.mysandbox/config.yaml"
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

# ---------- 端口免带门面（443 socket 激活）----------
# 443 是特权端口而 mysandbox 是无特权 user service（user unit 拿不到 CAP_NET_BIND_SERVICE，
# 实测 exit 218）。socket unit 由 root systemd 持被动监听 fd（空闲零进程），
# systemd-socket-proxyd 字节级透传到 mysandbox listen（TLS 由 mysandbox 终结，本体零改动）。
# 透传目标复用上面的 LISTEN_HOST/LISTEN_PORT（host auto 已按 _auto_host 解析）。
# 外部网段访问 443 走 config firewall.allow（自管网段 blanket 天然覆盖）。
if [ -f "$SELF_DIR/mysandbox-console.socket" ]; then
  log "8.5/8 端口免带门面（443 → $LISTEN_HOST:$LISTEN_PORT）"
  fill_unit "$SELF_DIR/mysandbox-console.socket" "$UNIT_DIR/mysandbox-console.socket"
  sed -e "s|__MSB_DIR__|$MS_DIR|g" \
      -e "s|__MSB_USER__|$TARGET_USER|g" \
      -e "s|__MSB_NODE__|$NODE|g" \
      -e "s|__MSB_BRIDGE__|$BRIDGE|g" \
      -e "s|__MSB_SUBNET__|$SUBNET|g" \
      -e "s|__MSB_GW__|$GW|g" \
      -e "s|__MSB_CONSOLE_TARGET__|${LISTEN_HOST}:${LISTEN_PORT}|g" \
      "$SELF_DIR/mysandbox-console.service" > "$UNIT_DIR/mysandbox-console.service"
  systemctl daemon-reload
  systemctl enable mysandbox-console.socket >/dev/null
  systemctl start mysandbox-console.socket || warn "mysandbox-console.socket 启动失败（443 被占？）——systemctl status mysandbox-console.socket 排查"
  log "   免端口访问: https://mysandbox.test/（需基域名 DNS 应答，本机 mihomo hosts / 外部各自配）"
fi

# config 已存在且 ipPool 前缀与 unit 网段不一致时提醒（unit 网关是容器网段的 .1）。
if [ -f "$CFG" ] && ! grep -qE "from: ${SUBNET_PREFIX}\." "$CFG"; then
  warn "config.yaml 的 ipPool 前缀与 unit 网段（$SUBNET）不一致——容器网关/NAT 会错位"
  warn "对齐方式：改 config.yaml 的 ipPool 后 sudo systemctl restart mysandbox-firewall；或重跑 sudo $0 --subnet <a.b.c.0/24>（全新机可用）"
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
