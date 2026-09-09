#!/bin/sh
# mysandbox 宿主防火墙放行（root）。三方互通（宿主 ↔ LXC ↔ docker 服务）里 ufw 管的两摊——
# 容器访问宿主服务（INPUT）与 LXC 桥 route 放行——由本脚本按 config 落地，不再手敲 ufw。
# 由 systemd 单元 scripts/mysandbox-firewall.service 开机调用；config 的防火墙相关配置
# （listen / ipPool / services / firewall.allow）变更后手工 `sudo systemctl restart mysandbox-firewall`。
#
# 期望规则由 `mysandbox firewall print` 按 config 计算（server/firewall.ts——配置与默认值的
# 唯一真源在 TS，这里只做 ufw 落地）。语义：幂等（ufw status 里已有同 spec+from 就跳过）、
# 只增不删（手敲的历史规则不会被回收；要清理请手工 ufw delete）。
#
# print 输出行（tab 分隔）：
#   input<TAB><port/proto|any><TAB><来源网段><TAB><comment>
#   route<TAB><桥设备名><TAB><comment>
set -u

# 部署参数：优先读 unit 注入的环境变量（mysandbox-firewall.service 的 Environment=，
# install.sh 按实际安装位置填充）；缺省时自行推导兜底（仓库形态：脚本所在目录的上级即安装目录）。
MS_DIR="${MS_DIR:-$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)}"
MS_USER="${MS_USER:-$(stat -c '%U' "$MS_DIR" 2>/dev/null || true)}"
# NODE 兜底：以属主用户**交互式** shell 探测（fnm/nvm 的 PATH 挂在交互 rc 里，-lc 拿不到）。
if [ -z "${NODE:-}" ] && [ -n "$MS_USER" ]; then
  USR_SHELL="$(getent passwd "$MS_USER" | cut -d: -f7)"
  NODE="$(runuser -u "$MS_USER" -- "${USR_SHELL:-/bin/sh}" -lic 'command -v node' 2>/dev/null | tail -n1 || true)"
fi
[ -n "$MS_USER" ] || { echo ">> mysandbox-firewall: 推导不出 MS_USER（unit 环境变量缺失？）" >&2; exit 1; }
[ -n "$NODE" ] || { echo ">> mysandbox-firewall: 推导不出 node 路径（先跑 scripts/install.sh）" >&2; exit 1; }

[ "$(id -u)" = 0 ] || { echo ">> mysandbox-firewall: 需要 root（ufw）" >&2; exit 1; }
command -v ufw >/dev/null 2>&1 || { echo ">> mysandbox-firewall: ufw 未安装，跳过" >&2; exit 0; }
# LC_ALL=C：锁输出语言（中文 locale 下 "Status: inactive" 会变 "状态：未激活"，下面的
# inactive 检测会失效）。用 verbose 而非裸 status——裸 status 的 INPUT 行是 `ALLOW` 单列
# （没有 IN），verbose/numbered 才是 `ALLOW IN`，下面两个判定都按 verbose 形状写的。
STATUS=$(LC_ALL=C ufw status verbose)
case "$STATUS" in
  *"Status: inactive"*)
    echo ">> mysandbox-firewall: ufw 未启用，跳过（ufw enable 后重启本单元生效）" >&2
    exit 0
    ;;
esac

RULES=$(runuser -u "$MS_USER" -- env HOME="/home/$MS_USER" "$NODE" "$MS_DIR/dist/server/cli.js" firewall print) || {
  echo ">> mysandbox-firewall: 'mysandbox firewall print' 失败（dist 未构建或路径漂移？）" >&2
  exit 1
}

# ufw status verbose 行形状（实测 ufw 0.36.2）：
#   `7321/tcp   ALLOW IN   10.88.10.0/24   # comment`
#   `Anywhere   ALLOW FWD  Anywhere on mysandbox0   # comment`
# v6 行第二列是 (v6)，天然不匹配下面的精确比较，不会误判为已存在。
has_input() { # $1=port/proto|Anywhere  $2=来源网段
  printf '%s\n' "$STATUS" | awk -v s="$1" -v f="$2" '
    $1 == s && $2 == "ALLOW" && $3 == "IN" && $4 == f { found = 1 }
    END { exit !found }'
}
has_route() { # $1=桥设备名
  printf '%s\n' "$STATUS" | awk -v b="$1" '
    $2 == "ALLOW" && $3 == "FWD" && $5 == "on" && $6 == b { found = 1 }
    END { exit !found }'
}

TAB=$(printf '\t')
while IFS="$TAB" read -r kind spec arg comment; do
  case "$kind" in
    input)
      if [ "$spec" = any ]; then
        has_input Anywhere "$arg" && continue
        echo ">> ufw allow from $arg  # $comment"
        ufw allow from "$arg" comment "$comment" >/dev/null || exit 1
      else
        has_input "$spec" "$arg" && continue
        echo ">> ufw allow from $arg to any port ${spec%/*} proto ${spec#*/}  # $comment"
        ufw allow from "$arg" to any port "${spec%/*}" proto "${spec#*/}" comment "$comment" >/dev/null || exit 1
      fi
      ;;
    route)
      has_route "$spec" && continue
      echo ">> ufw route allow in on $spec  # $arg"
      ufw route allow in on "$spec" comment "$arg" >/dev/null || exit 1
      ;;
  esac
done <<EOF
$RULES
EOF
echo ">> mysandbox-firewall: done"
