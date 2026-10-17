// 触屏工具条按钮配置（Terminal.vue 渲染按钮，ToolbarSettingsDialog.vue 编排，
// 两边共用这一份状态）。查看偏好按项目约定只进 localStorage，不进 sidecar。
// 「哪个键高频」是使用者自己的事，代码不替人猜：两行按钮全部从候选池编排。
// 预置一套 agent 布局作起点；首次加载迁移旧版快捷短语键（term-quick-snippets）。
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

export type ToolBtn = { t: 'key'; id: string } | { t: 'snippet'; text: string }

const TOOLBAR_KEY = 'mysandbox:term-toolbar-v1'
export const TOOLBAR_MAX = 24

const DEFAULT_BTNS: ToolBtn[] = [
  { t: 'key', id: 'esc' },
  { t: 'key', id: 'stab' },
  { t: 'key', id: 'up' },
  { t: 'key', id: 'down' },
  { t: 'key', id: 'enter' },
  { t: 'key', id: 'ctrl' },
  { t: 'key', id: 'tab' },
  { t: 'key', id: 'pgup' },
  { t: 'key', id: 'pgdn' },
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
