// 终端 buffer 里的路径 token 识别（Ctrl+点击打开）。纯字符串逻辑，从 Terminal.vue
// 抽出（2026-10-26）——链接 provider 与行内命中测试共用，便于单测与复用。

// 规则：token 以 / ~/ ./ ../ 开头或恰好是裸 ~；前一字符（若有）必须是空白或 "'=[({<
// 之一（防 URL/普通词中段误配；`?a=/tmp/x` 的 = 后可配是刻意保留——`--out=/path` 场景）；
// 主体字符集 [A-Za-z0-9._~+@%$-] 加 /；结尾剥句读；支持 :行(:列) 后缀（栈跟踪）。
// 明确不匹配：不含 / 的裸文件名（防误报）、// 开头（协议相对 URL）、跨行 wrap、含空格路径。
export interface PathToken {
  start: number
  end: number
  path: string
  line?: number
  col?: number
}

const PRE_BOUNDARY = /[\s"'=[({<]/
const TOKEN_CHAR = /[A-Za-z0-9._~+@%$-]/
const TRAIL_PUNCT = /[.,;:)\]"'`]/

export function findPathTokens(text: string): PathToken[] {
  const out: PathToken[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '/' && ch !== '~' && ch !== '.') continue
    if (i > 0 && !PRE_BOUNDARY.test(text[i - 1]!)) continue
    let start = -1
    if (ch === '/') {
      if (text[i + 1] === '/') {
        i++ // // 开头 = 协议相对 URL，不碰
        continue
      }
      start = i
    } else if (text.startsWith('~/', i) || text.startsWith('./', i) || text.startsWith('../', i)) {
      start = i
    } else if (ch === '~' && !(text[i + 1] && TOKEN_CHAR.test(text[i + 1]!))) {
      start = i // 裸 ~ = home（~user 形态不支持）
    } else {
      continue
    }
    let j = start + 1
    while (j < text.length && (TOKEN_CHAR.test(text[j]!) || text[j] === '/')) j++
    let raw = text.slice(start, j)
    while (raw.length > 1 && TRAIL_PUNCT.test(raw[raw.length - 1]!)) raw = raw.slice(0, -1)
    if (raw.length < 2 && raw !== '~') continue // 单个 / 噪音太大（散文里的斜杠）
    if (!raw.includes('/') && raw !== '~') continue // 裸文件名不匹配（防误报）
    // :行(:列) 后缀：不在字符集内，须从原文另行消费
    let line: number | undefined
    let col: number | undefined
    const lm = /^:(\d{1,7})(?::(\d{1,7}))?/.exec(text.slice(start + raw.length))
    if (lm) {
      line = Number(lm[1])
      if (lm[2]) col = Number(lm[2])
    }
    const end = start + raw.length + (line !== undefined ? lm![0].length : 0)
    out.push({ start, end, path: raw, line, col })
    i = end - 1
  }
  return out
}
