#!/usr/bin/env bash
# read-image.sh — 通过统一模型 image-read 读取/理解图片内容（OpenAI 兼容接口，网关自动路由）。
# 用法:
#   read-image.sh <图片路径> [图片路径 ...] [-p "提示词"]
# 示例:
#   read-image.sh /path/to/screenshot.png
#   read-image.sh -p "提取这张截图里的所有文字" a.png
#   read-image.sh a.png b.png -p "对比这两张图"
#
# 输出: 模型返回的文本内容。失败时输出错误信息并退出非 0。
# 可用环境变量覆盖：IMAGE_READ_API_URL / IMAGE_READ_API_KEY / IMAGE_READ_PROMPT

set -euo pipefail

API_URL="${IMAGE_READ_API_URL:-http://10.12.135.150:7800/openai/v1/chat/completions}"
MODEL="image-read"
API_KEY="${IMAGE_READ_API_KEY:-sk-myapikey--Je5xkIdBtiyJT9oTuzEqoCFse5OYLIZ}"
DEFAULT_PROMPT="${IMAGE_READ_PROMPT:-请详细描述这张图片的内容。}"

IMAGES=()
PROMPT="$DEFAULT_PROMPT"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p)
      if [[ $# -lt 2 ]]; then
        echo "错误: -p 后面需要跟提示词" >&2
        exit 1
      fi
      PROMPT="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *)
      IMAGES+=("$1")
      shift
      ;;
  esac
done

if [[ ${#IMAGES[@]} -eq 0 ]]; then
  echo "错误: 请至少提供一个图片路径" >&2
  exit 1
fi

for dep in base64 curl python3; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "错误: 缺少依赖 '$dep'，请先安装" >&2
    exit 1
  fi
done

# 编码图片为 data URL（base64 写入临时文件，python3 直接读文件，避免命令行参数长度上限）
TMP_FILES=()
B64_FILES=()
MIMES=()
cleanup() {
  rm -f "${TMP_FILES[@]}"
}
trap cleanup EXIT

for img in "${IMAGES[@]}"; do
  if [[ ! -f "$img" ]]; then
    echo "错误: 图片文件不存在: $img" >&2
    exit 1
  fi
  tmp="$(mktemp)"
  TMP_FILES+=("$tmp")
  base64 -w0 "$img" > "$tmp"
  case "${img##*.}" in
    png|PNG) mime="image/png" ;;
    jpg|jpeg|JPG|JPEG) mime="image/jpeg" ;;
    gif|GIF) mime="image/gif" ;;
    webp|WEBP) mime="image/webp" ;;
    bmp|BMP) mime="image/bmp" ;;
    *) mime="image/png" ;;
  esac
  B64_FILES+=("$tmp")
  MIMES+=("$mime")
done

PAYLOAD_FILE="$(mktemp)"
TMP_FILES+=("$PAYLOAD_FILE")

IMAGE_ARGS=()
for i in "${!B64_FILES[@]}"; do
  IMAGE_ARGS+=( "${MIMES[$i]}" "${B64_FILES[$i]}" )
done

python3 - "$MODEL" "$PROMPT" "${IMAGE_ARGS[@]}" > "$PAYLOAD_FILE" <<'PYEOF'
import json, sys
model = sys.argv[1]
prompt = sys.argv[2]
parts = [{"type": "text", "text": prompt}]
args = sys.argv[3:]
for i in range(0, len(args), 2):
    mime, b64file = args[i], args[i + 1]
    with open(b64file) as fh:
        b64 = fh.read().strip()
    parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
payload = {"model": model, "messages": [{"role": "user", "content": parts}]}
json.dump(payload, sys.stdout)
PYEOF

# 调用 API（@ 文件传 body，避免参数长度限制）
curl -sS -f "$API_URL" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @"$PAYLOAD_FILE" \
| python3 -c '
import json, sys
data = json.load(sys.stdin)
try:
    msg = data["choices"][0]["message"]
    # 部分推理模型把答案放在 reasoning_content，content 为空时回退
    text = (msg.get("content") or "").strip() or (msg.get("reasoning_content") or "").strip()
    print(text)
except Exception:
    print(json.dumps(data, ensure_ascii=False))
'
