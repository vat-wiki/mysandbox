#!/usr/bin/env bash
# 拉取 WireGuard for Windows 官方 MSI 到本目录（随我们的安装器分发）。
#
# 上游：https://download.wireguard.com/windows-client/
# 用法：./fetch.sh [版本]                        默认 1.1.1，只取 amd64
#       ARCHES="amd64 arm64" ./fetch.sh 1.1.1    取多架构
#       WG_FETCH_PROXY=http://ip:port ./fetch.sh 国内需走代理（见 README）
#
# 跑完会重算 SHA256SUMS。版本变更请连 README 的版本表一起改。
set -euo pipefail

VERSION="${1:-1.1.1}"
ARCHES="${ARCHES:-amd64}"
BASE="https://download.wireguard.com/windows-client"

# ⚠️ 必须先 cd 进本目录再用相对文件名：Windows 自带的 curl.exe 不认 MSYS 风格的
# /d/... 路径，传绝对路径会报「Failed to open the file」。
cd "$(dirname "$0")"

if [ -n "${WG_FETCH_PROXY:-}" ]; then
  CURL_OPTS=(-x "$WG_FETCH_PROXY")
else
  CURL_OPTS=()
fi

for arch in $ARCHES; do
  file="wireguard-$arch-$VERSION.msi"
  printf '→ %s\n' "$file"
  curl -fSL --retry 3 --max-time 300 "${CURL_OPTS[@]+"${CURL_OPTS[@]}"}" "$BASE/$file" -o "$file"
done

# 重算校验和：只覆盖本目录内的 msi，排除其余文件
rm -f SHA256SUMS
for f in *.msi; do
  [ -e "$f" ] || continue
  sha256sum "$f" >> SHA256SUMS
done

printf '\n=== SHA256SUMS ===\n'
cat SHA256SUMS
printf '\n上游未发布 .sha256 旁文件，来源请另用 Authenticode 验：\n'
printf '  Get-AuthenticodeSignature <msi> | Format-List Status, SignerCertificate\n'
