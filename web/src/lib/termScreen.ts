// 终端屏幕/历史文本的纯工具（从 Terminal.vue 抽出，2026-10-26）：只吃换进来的
// xterm 实例，不持有状态、不碰 WS。组件里的接线与生命周期留在组件。
import type { Terminal as XTerm } from '@xterm/xterm'

// 剥 ANSI 序列（CSI + OSC）：delta 锚点匹配要用纯文本与 buffer 行（translateToString
// 本身已剥序列）对齐，写入时才用原始行（带色）。
export const ANSI_SEQ = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g

// 当前视口内容快照（逐行文本拼接）：「无输出提醒」的内容基线用——离开时快照 vs
// 安静判定时快照，相同 = 只是重绘（attach 整屏还原/重连/resize），不算新内容。
// 只取底部 rows 行（用户看到的画面）：⚠️ buffer.getLine(y) 的 y 是**全缓冲区绝对行号**，
// 0 = scrollback 顶——从 0 读会把「最老的 24 行」当视口（输出一超屏哈希就永远冻结，
// 基线恒等于当前，内容门槛全废，实测踩过）；文本行不含颜色/光标属性，重绘前后逐字节稳定。
export function screenHash(term: XTerm | null): string | undefined {
  if (!term) return undefined
  const buf = term.buffer.active
  const from = Math.max(0, buf.length - term.rows)
  const lines: string[] = []
  for (let y = from; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

// 重连增量回填：后端在 resume=1 时发 history-delta（最近 2000 物理行、含当前屏、带
// SGR）。前端拿 buffer 尾部（= 断线瞬间的最后一屏，必然也是 delta 内容里的一段）做
// 锚点，在 delta 里定位后只写入其后的部分——断线窗口期内错过的输出原位补齐、零重复。
// 找不到锚点（窗口期输出超 -2000 行 / 重连间列宽变化 reflow / 纯空屏无区分度）就静默
// 放弃，等同旧行为（只靠 attach 重绘恢复当前屏）。capture 用物理行（无 -J）正是为了
// 与 buffer 逐行对应；跨列宽的 reflow 会自然导致匹配失败，无需特判。
export function applyHistoryDelta(term: XTerm | null, text: string): void {
  if (!term) return
  const lines = text.split('\n')
  const buf = term.buffer.active
  // 锚点 = buffer 最后几行。我们自己写进 buffer 的横幅（>> 已断开 / >> 连接 / >> socket
  // 错误）不在 tmux 历史里，滤掉再取；全空锚点（清屏后的空画面）没有区分度，直接放弃。
  const ANCHOR = 6
  const raw: string[] = []
  for (let y = Math.max(0, buf.length - (ANCHOR + 4)); y < buf.length; y++) {
    raw.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  const anchor = raw.filter((l) => !l.startsWith('>> ')).slice(-ANCHOR)
  if (anchor.length < ANCHOR || anchor.every((l) => l === '')) return
  const plain = lines.map((l) => l.replace(ANSI_SEQ, '').replace(/\s+$/, ''))
  for (let i = 0; i + ANCHOR <= plain.length; i++) {
    let hit = true
    for (let j = 0; j < ANCHOR; j++) {
      if (plain[i + j] !== anchor[j]) {
        hit = false
        break
      }
    }
    if (!hit) continue
    // 锚点之后 = 断线窗口输出；delta 比一屏长时末尾还挂着重连时的当前屏（capture 默认
    // 到可见屏底），这 rows 行不写——交给 attach 重绘画进视口，否则滚动区出现整屏重复。
    const restCount = lines.length - (i + ANCHOR)
    const rest = restCount > term.rows ? lines.slice(i + ANCHOR, lines.length - term.rows) : lines.slice(i + ANCHOR)
    // 前缀复位 SGR：-e 行可能以未闭合的属性态结束，别带进后续输出流。结尾不加 CRLF：
    // 光标停在哪由 attach 重绘的绝对定位接管。
    if (rest.length) term.write(`\x1b[0m${rest.join('\r\n')}`)
    return
  }
}
