// 触屏工具条按钮配置（Terminal.vue 渲染按钮，ToolbarSettingsDialog.vue 编排，
// 两边共用这一份状态）。查看偏好按项目约定只进 localStorage，不进 sidecar。
// 「哪个键高频」是使用者自己的事，代码不替人猜：两行按钮全部从候选池编排。
// 预置一套 Termux 风格布局作起点；首次加载迁移旧版快捷短语键（term-quick-snippets）。
import { ref } from 'vue'

export type PoolAct =
  | { kind: 'seq'; seq: string }
  | { kind: 'repeat'; seq: string }
  | { kind: 'scroll'; pages: number }
  | { kind: 'scrollEnd'; top: boolean }
  | { kind: 'paste' }
  | { kind: 'copy' }
  | { kind: 'ctrl' }
  | { kind: 'font'; delta: number }

export interface PoolEntry {
  label: string
  title: string
  act: PoolAct
}

export const KEY_POOL: Record<string, PoolEntry> = {
  esc: { label: 'Esc', title: '发送 Esc（中断 agent / 关闭菜单）', act: { kind: 'seq', seq: '\x1b' } },
  stab: { label: '⇥', title: '发送 Shift+Tab（切换权限模式）', act: { kind: 'seq', seq: '\x1b[Z' } },
  up: { label: '↑', title: '上方向键：选菜单项 / 翻输入历史（长按连发）', act: { kind: 'repeat', seq: '\x1b[A' } },
  down: { label: '↓', title: '下方向键：选菜单项 / 翻输入历史（长按连发）', act: { kind: 'repeat', seq: '\x1b[B' } },
  left: { label: '←', title: '左方向键（长按连发）', act: { kind: 'repeat', seq: '\x1b[D' } },
  right: { label: '→', title: '右方向键（长按连发）', act: { kind: 'repeat', seq: '\x1b[C' } },
  enter: { label: '⏎', title: '发送回车（确认 / 发送）', act: { kind: 'seq', seq: '\r' } },
  tab: { label: 'Tab', title: '发送 Tab（补全）', act: { kind: 'seq', seq: '\t' } },
  home: { label: 'Home', title: '发送 Home（跳到行首）', act: { kind: 'seq', seq: '\x1b[H' } },
  endk: { label: 'End', title: '发送 End（跳到行尾）', act: { kind: 'seq', seq: '\x1b[F' } },
  slash: { label: '/', title: '发送斜杠（路径 / 参数）', act: { kind: 'seq', seq: '/' } },
  dash: { label: '-', title: '发送连字符（命令行选项）', act: { kind: 'seq', seq: '-' } },
  pgup: { label: '上页', title: '上翻一页（只滚本地回滚区，不进 PTY）', act: { kind: 'scroll', pages: -1 } },
  pgdn: { label: '下页', title: '下翻一页（只滚本地回滚区，不进 PTY）', act: { kind: 'scroll', pages: 1 } },
  top: { label: '顶', title: '滚到历史顶部（只滚本地回滚区）', act: { kind: 'scrollEnd', top: true } },
  bottom: { label: '底', title: '滚回最新输出（只滚本地回滚区）', act: { kind: 'scrollEnd', top: false } },
  paste: { label: '粘贴', title: '粘贴剪贴板内容', act: { kind: 'paste' } },
  copy: { label: '复制', title: '复制选中内容', act: { kind: 'copy' } },
  ctrl: { label: 'Ctrl', title: 'Ctrl 复合键面板（C/V/L/R/U/W/A/E/Z）', act: { kind: 'ctrl' } },
  fontp: { label: 'A+', title: '增大字号', act: { kind: 'font', delta: 1 } },
  fontm: { label: 'A−', title: '减小字号', act: { kind: 'font', delta: -1 } },
}

export type ToolBtn =
  | { t: 'key'; id: string }
  | { t: 'snippet'; text: string }
  // 自定义按键：label 显示在按钮上，seq 是发送给 PTY 的原始字节序列
  | { t: 'custom'; label: string; seq: string }

const TOOLBAR_KEY = 'mysandbox:term-toolbar-v2'
export const TOOLBAR_MAX = 24

// 预置布局参考 Termux 默认 extra-keys 两行（各 7 键）：第一行 ESC / - HOME UP END PGUP，
// 第二行 TAB CTRL ALT LEFT DOWN RIGHT PGDN（ALT 是粘滞键，暂无粘滞基建未收录，行尾补 ⏎），
// 另补 Shift+Tab（切 agent 权限模式）。前端 7 列 grid，默认布局逐行与 Termux 对齐。
const DEFAULT_BTNS: ToolBtn[] = [
  // 第一行（Termux row 1）
  { t: 'key', id: 'esc' },
  { t: 'key', id: 'slash' },
  { t: 'key', id: 'dash' },
  { t: 'key', id: 'home' },
  { t: 'key', id: 'up' },
  { t: 'key', id: 'endk' },
  { t: 'key', id: 'pgup' },
  // 第二行（Termux row 2，ALT 位空缺，行尾补 ⏎）
  { t: 'key', id: 'tab' },
  { t: 'key', id: 'ctrl' },
  { t: 'key', id: 'left' },
  { t: 'key', id: 'down' },
  { t: 'key', id: 'right' },
  { t: 'key', id: 'pgdn' },
  { t: 'key', id: 'enter' },
  // 第三行起：本场景补充
  { t: 'key', id: 'stab' },
]

function loadToolButtons(): ToolBtn[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(TOOLBAR_KEY) ?? 'null')
    if (Array.isArray(raw)) {
      const out: ToolBtn[] = []
      const seen = new Set<string>()
      for (const b of raw) {
        if (b?.t === 'key' && KEY_POOL[b.id] && !seen.has('k:' + b.id)) {
          out.push({ t: 'key', id: b.id })
          seen.add('k:' + b.id)
        } else if (b?.t === 'snippet' && typeof b.text === 'string' && b.text.trim() && !seen.has('s:' + b.text)) {
          out.push({ t: 'snippet', text: b.text })
          seen.add('s:' + b.text)
        } else if (
          b?.t === 'custom' &&
          typeof b.label === 'string' && b.label.trim() &&
          typeof b.seq === 'string' && b.seq && !seen.has('c:' + b.label.trim())
        ) {
          out.push({ t: 'custom', label: b.label.trim(), seq: b.seq })
          seen.add('c:' + b.label.trim())
        }
      }
      if (out.length) return out.slice(0, TOOLBAR_MAX)
    }
  } catch {
    /* 坏数据落默认 */
  }
  // 首次：默认布局 + 迁移旧版快捷短语（旧默认「继续」也已含在迁移里）
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('mysandbox:term-quick-snippets') ?? 'null')
    if (Array.isArray(raw)) {
      for (const s of raw) {
        if (typeof s === 'string' && s.trim()) DEFAULT_BTNS.push({ t: 'snippet', text: s })
      }
    }
  } catch {
    /* 迁移失败不影响默认布局 */
  }
  if (!DEFAULT_BTNS.some((b) => b.t === 'snippet')) DEFAULT_BTNS.push({ t: 'snippet', text: '继续' })
  return DEFAULT_BTNS
}

// 模块级单例：工具条与设置弹窗看到同一份列表，改动即时互见。
export const toolButtons = ref<ToolBtn[]>(loadToolButtons())

export function saveToolButtons() {
  try {
    localStorage.setItem(TOOLBAR_KEY, JSON.stringify(toolButtons.value))
  } catch {
    /* 不可用就只本次生效 */
  }
}

export function rmBtn(i: number) {
  toolButtons.value.splice(i, 1)
  saveToolButtons()
}

export function addKeyBtn(id: string) {
  if (!KEY_POOL[id] || toolButtons.value.length >= TOOLBAR_MAX) return
  if (toolButtons.value.some((b) => b.t === 'key' && b.id === id)) return
  toolButtons.value.push({ t: 'key', id })
  saveToolButtons()
}

export function addSnippet(text: string) {
  const t = text.trim()
  if (!t || toolButtons.value.length >= TOOLBAR_MAX) return
  if (toolButtons.value.some((b) => b.t === 'snippet' && b.text === t)) return
  toolButtons.value.push({ t: 'snippet', text: t })
  saveToolButtons()
}

export function addCustomKey(label: string, seq: string) {
  const l = label.trim()
  if (!l || !seq || toolButtons.value.length >= TOOLBAR_MAX) return
  if (toolButtons.value.some((b) => b.t === 'custom' && b.label === l)) return
  toolButtons.value.push({ t: 'custom', label: l, seq })
  saveToolButtons()
}

// —— 自定义按键的两种序列来源 ——

// 手输转义序列：\e / \E = ESC，\xHH 十六进制字节，\n \r \t \0，\\ 字面反斜杠；其余原样。
export function parseSeq(input: string): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    if (c !== '\\') {
      out += c
      continue
    }
    const n = input[++i]
    if (n === undefined) {
      out += c
      break
    }
    if (n === 'e' || n === 'E') out += '\x1b'
    else if (n === 'n') out += '\n'
    else if (n === 'r') out += '\r'
    else if (n === 't') out += '\t'
    else if (n === '0') out += '\x00'
    else if (n === 'x' || n === 'X') {
      const h = input.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{1,2}$/.test(h)) {
        out += String.fromCharCode(parseInt(h, 16))
        i += h.length
      } else out += n
    } else out += n
  }
  return out
}

// 物理键盘录制：把 keydown 编码成终端序列（xterm 风格 CSI/SS3 + 修饰位 1+shift+2*alt+4*ctrl）。
// 返回 null = 该键不产生发送序列（纯修饰键 / 无法编码的键）。meta 恒不编码（浏览器保留）。
export function encodeKeyDown(e: KeyboardEvent): { seq: string; label: string } | null {
  const k = e.key
  if (
    k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' ||
    k === 'CapsLock' || k === 'NumLock' || k === 'ScrollLock' ||
    k === 'Fn' || k === 'FnLock' || k === 'Dead' || k === 'Unidentified'
  ) return null
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0)
  const alt = e.altKey ? '\x1b' : ''
  const named: Record<string, string> = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' }
  const tildes: Record<string, number> = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 }
  const fkeys: Record<string, string | number> = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S', F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 }
  if (named[k]) return { seq: mod > 1 ? `\x1b[1;${mod}${named[k]}` : `\x1b[${named[k]}`, label: keyLabel(e) }
  if (tildes[k]) return { seq: mod > 1 ? `\x1b[${tildes[k]};${mod}~` : `\x1b[${tildes[k]}~`, label: keyLabel(e) }
  if (fkeys[k]) {
    const v = fkeys[k]
    return { seq: typeof v === 'string' ? (mod > 1 ? `\x1b[1;${mod}${v}` : `\x1bO${v}`) : mod > 1 ? `\x1b[${v};${mod}~` : `\x1b[${v}~`, label: keyLabel(e) }
  }
  if (k === 'Enter') return { seq: alt + '\r', label: keyLabel(e) }
  if (k === 'Tab') return { seq: e.shiftKey ? '\x1b[Z' : '\t', label: keyLabel(e) }
  if (k === 'Escape') return { seq: alt + '\x1b', label: keyLabel(e) }
  if (k === 'Backspace') return { seq: alt + (e.ctrlKey ? '\x08' : '\x7f'), label: keyLabel(e) }
  if (k === ' ') return { seq: (e.ctrlKey ? '\x00' : alt) + ' ', label: keyLabel(e) }
  if (k.length === 1) {
    let ch = k
    if (e.ctrlKey) {
      const code = k.toUpperCase().charCodeAt(0)
      if (code < 64 || code > 95) return null // C-组合只对 @A-Z[\]^_ 有控制字符
      ch = String.fromCharCode(code & 0x1f)
    }
    return { seq: alt + ch, label: keyLabel(e) }
  }
  return null
}

function keyLabel(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('C')
  if (e.altKey) parts.push('M')
  if (e.shiftKey && e.key.length > 1) parts.push('S')
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key
  return (parts.length ? parts.join('-') + '-' : '') + k
}
