// 触屏工具条配置：按键（工具条按钮）与指令（「指令」面板条目）共用这一份模块级状态，
// Terminal.vue 渲染、TerminalToolbarPage.vue（全屏设置页）编排（两个平级分区）。
// 查看偏好按项目约定只进 localStorage，不进 sidecar。
//
// v3 起两类条目地位平等：工具条只放按键，文本类动作（原「快捷短语」与「快捷指令」）
// 统一收进指令列表——语义都是「发送文本 + 回车」，不再维护两套模型、两个配置入口。
import { ref } from 'vue'

export type PoolAct =
  | { kind: 'seq'; seq: string }
  | { kind: 'repeat'; seq: string }
  | { kind: 'scroll'; pages: number }
  | { kind: 'scrollEnd'; top: boolean }
  | { kind: 'refresh' }
  | { kind: 'paste' }
  | { kind: 'copy' }
  | { kind: 'ctrl' }
  | { kind: 'alt' }
  | { kind: 'font'; delta: number }

export interface PoolEntry {
  label: string
  title: string
  act: PoolAct
}

export const KEY_POOL: Record<string, PoolEntry> = {
  esc: { label: 'Esc', title: '发送 Esc（中断 agent / 关闭菜单）', act: { kind: 'seq', seq: '\x1b' } },
  // 常用 Ctrl 控制键：触屏敲软键盘 + 粘滞 Ctrl 要两步，高频组合一键直发。
  // 覆盖面：中断（^C）/ EOF（^D）/ 挂起（^Z）/ 清屏（^L）/ 行首行尾与删行（^A ^E ^U ^K）/ 历史搜索（^R）。
  ctrlc: { label: '^C', title: '发送 Ctrl+C（中断当前命令 / 退出程序）', act: { kind: 'seq', seq: '\x03' } },
  ctrld: { label: '^D', title: '发送 Ctrl+D（EOF：退出 shell / 结束输入）', act: { kind: 'seq', seq: '\x04' } },
  ctrlz: { label: '^Z', title: '发送 Ctrl+Z（挂起当前任务，bg/fg 恢复）', act: { kind: 'seq', seq: '\x1a' } },
  ctrll: { label: '^L', title: '发送 Ctrl+L（清屏重绘）', act: { kind: 'seq', seq: '\x0c' } },
  ctrla: { label: '^A', title: '发送 Ctrl+A（跳到行首；tmux 前缀键）', act: { kind: 'seq', seq: '\x01' } },
  ctrle: { label: '^E', title: '发送 Ctrl+E（跳到行尾）', act: { kind: 'seq', seq: '\x05' } },
  ctrlu: { label: '^U', title: '发送 Ctrl+U（删除整行：光标前全部）', act: { kind: 'seq', seq: '\x15' } },
  ctrlw: { label: '^W', title: '发送 Ctrl+W（删除前一个词）', act: { kind: 'seq', seq: '\x17' } },
  ctrlk: { label: '^K', title: '发送 Ctrl+K（删到行尾）', act: { kind: 'seq', seq: '\x0b' } },
  ctrlr: { label: '^R', title: '发送 Ctrl+R（反向搜索历史）', act: { kind: 'seq', seq: '\x12' } },
  stab: { label: '⇥', title: '发送 Shift+Tab（切换权限模式）', act: { kind: 'seq', seq: '\x1b[Z' } },
  up: { label: '↑', title: '上方向键：选菜单项 / 翻输入历史（长按连发）', act: { kind: 'repeat', seq: '\x1b[A' } },
  down: { label: '↓', title: '下方向键：选菜单项 / 翻输入历史（长按连发）', act: { kind: 'repeat', seq: '\x1b[B' } },
  left: { label: '←', title: '左方向键（长按连发）', act: { kind: 'repeat', seq: '\x1b[D' } },
  right: { label: '→', title: '右方向键（长按连发）', act: { kind: 'repeat', seq: '\x1b[C' } },
  enter: { label: '⏎', title: '发送回车（确认 / 发送）', act: { kind: 'seq', seq: '\r' } },
  tab: { label: 'Tab', title: '发送 Tab（补全）', act: { kind: 'seq', seq: '\t' } },
  home: { label: 'Home', title: '发送 Home（跳到行首）', act: { kind: 'seq', seq: '\x1b[H' } },
  endk: { label: 'End', title: '发送 End（跳到行尾）', act: { kind: 'seq', seq: '\x1b[F' } },
  delk: { label: 'Del', title: '发送 Delete（向后删除，软键盘普遍没有）', act: { kind: 'seq', seq: '\x1b[3~' } },
  slash: { label: '/', title: '发送斜杠（路径 / 参数）', act: { kind: 'seq', seq: '/' } },
  dash: { label: '-', title: '发送连字符（命令行选项）', act: { kind: 'seq', seq: '-' } },
  pgup: { label: '上页', title: '上翻一页（只滚本地回滚区，不进 PTY）', act: { kind: 'scroll', pages: -1 } },
  pgdn: { label: '下页', title: '下翻一页（只滚本地回滚区，不进 PTY）', act: { kind: 'scroll', pages: 1 } },
  top: { label: '顶', title: '滚到历史顶部（只滚本地回滚区）', act: { kind: 'scrollEnd', top: true } },
  bottom: { label: '底', title: '滚回最新输出（只滚本地回滚区）', act: { kind: 'scrollEnd', top: false } },
  redraw: { label: '刷新', title: '刷新终端（重新拉取 tmux 历史并重绘；会回到最新输出）', act: { kind: 'refresh' } },
  paste: { label: '粘贴', title: '粘贴剪贴板内容', act: { kind: 'paste' } },
  copy: { label: '复制', title: '复制选中内容', act: { kind: 'copy' } },
  ctrl: { label: 'Ctrl', title: 'Ctrl 粘滞修饰（Termux 式）：点亮后下一个按键带 Ctrl 发出（^A / ^← 等），用掉即灭', act: { kind: 'ctrl' } },
  alt: { label: 'Alt', title: 'Alt 粘滞修饰（Termux 式）：点亮后下一个按键带 Alt 前缀发出（M-a / M-← 等），用掉即灭', act: { kind: 'alt' } },
  fontp: { label: 'A+', title: '增大字号', act: { kind: 'font', delta: 1 } },
  fontm: { label: 'A−', title: '减小字号', act: { kind: 'font', delta: -1 } },
}

export type ToolBtn =
  | { t: 'key'; id: string }
  // 自定义按键：label 显示在按钮上，seq 是发送给 PTY 的原始字节序列
  | { t: 'custom'; label: string; seq: string }
  // 固定的指令：引用 quickCmds 的 id，按钮文字/命令随指令编辑同步；点一下 = 命令 + 回车。
  // 解决「指令必须先进面板再点条目」的两级入口——常用指令固定后一键发送。
  | { t: 'cmd'; id: string }

// 「指令」面板条目：点条目发送 cmd + 回车。id 只服务列表 key 与拖拽（改名不换身份）。
export interface QuickCmd {
  id: string
  label: string
  cmd: string
}

const STORE_KEY = 'mysandbox:term-toolbar-v3'
// v3 之前的三个键：v2 工具条（含快捷短语）、独立快捷指令列表、v1 短语
const LEGACY_TOOLBAR_KEY = 'mysandbox:term-toolbar-v2'
const LEGACY_CMDS_KEY = 'mysandbox:term-quick-cmds'
const LEGACY_SNIPPETS_KEY = 'mysandbox:term-quick-snippets'

export const TOOLBAR_MAX = 24
// 一页 = 2 行 × 7 列（对齐 Termux 一行 7 键）。键超出自动溢到下一页，工具条横向轻扫翻页；
// Terminal.vue 的分页渲染与 TerminalToolbarPage 的顺序说明共用这个常数。
export const TB_PER_PAGE = 14

// 工具条最终渲染项 = 按键列表 + 固定入口（指令 / ⋯），按 TB_PER_PAGE 分页。
// 真实工具条（usePhoneToolbar）与设置页的布局预览共用这一份分页逻辑——预览不能自己再算，
// 否则改常量/固定入口顺序时两边会静默漂移。
export type ToolbarItem = ToolBtn | { t: 'cmds' } | { t: 'settings' }
export function toolbarPages(buttons: ToolBtn[]): ToolbarItem[][] {
  const items: ToolbarItem[] = [...buttons, { t: 'cmds' }, { t: 'settings' }]
  const out: ToolbarItem[][] = []
  for (let i = 0; i < items.length; i += TB_PER_PAGE) out.push(items.slice(i, i + TB_PER_PAGE))
  return out
}

// 预置布局 = Termux 默认 extra-keys 两行（各 7 键）逐位对齐：第一行 ESC / ^C / - HOME UP END PGUP，
// 第二行 TAB CTRL ALT LEFT DOWN RIGHT PGDN（Ctrl/Alt 都是粘滞修饰键，交互见 Terminal.vue）。
// 另补 Shift+Tab（切 agent 权限模式）与 ⏎（系统键盘收起时也能确认）。
// ^C 一键直发（中断 agent / 杀进程是这个场景的最高频动作）——比「粘滞 Ctrl + 软键盘 c」省两步。
const DEFAULT_BTNS: ToolBtn[] = [
  { t: 'key', id: 'esc' },
  { t: 'key', id: 'ctrlc' },
  { t: 'key', id: 'slash' },
  { t: 'key', id: 'dash' },
  { t: 'key', id: 'home' },
  { t: 'key', id: 'up' },
  { t: 'key', id: 'endk' },
  { t: 'key', id: 'pgup' },
  { t: 'key', id: 'tab' },
  { t: 'key', id: 'ctrl' },
  { t: 'key', id: 'alt' },
  { t: 'key', id: 'left' },
  { t: 'key', id: 'down' },
  { t: 'key', id: 'right' },
  { t: 'key', id: 'pgdn' },
  { t: 'key', id: 'enter' },
  { t: 'key', id: 'stab' },
  { t: 'key', id: 'redraw' },
]
// 首次进入的指令样例（原工具条短语「继续」并入这里）
const DEFAULT_CMDS: QuickCmd[] = [{ id: 'qc-default-continue', label: '继续', cmd: '继续' }]

let cmdSeq = 0
function newCmdId(): string {
  cmdSeq += 1
  return `qc-${Date.now().toString(36)}-${cmdSeq}`
}

function parseJSON(raw: string | null): unknown {
  try {
    return JSON.parse(raw ?? 'null')
  } catch {
    return null
  }
}

function asArray(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : []
}

function normalizeBtns(raw: unknown, cmdIds?: Set<string>): ToolBtn[] {
  const out: ToolBtn[] = []
  const seen = new Set<string>()
  for (const b of asArray(raw) as Array<Record<string, unknown>>) {
    if (b?.t === 'key' && typeof b.id === 'string' && KEY_POOL[b.id] && !seen.has('k:' + b.id)) {
      out.push({ t: 'key', id: b.id })
      seen.add('k:' + b.id)
    } else if (
      b?.t === 'custom' &&
      typeof b.label === 'string' && b.label.trim() &&
      typeof b.seq === 'string' && b.seq && !seen.has('c:' + b.label.trim())
    ) {
      out.push({ t: 'custom', label: b.label.trim(), seq: b.seq })
      seen.add('c:' + b.label.trim())
    } else if (
      b?.t === 'cmd' &&
      typeof b.id === 'string' && cmdIds?.has(b.id) && !seen.has('cmd:' + b.id)
    ) {
      // 只认当前指令列表里还存在的 id：指令被删后引用自动失效（rmQuickCmd 也会主动解绑）
      out.push({ t: 'cmd', id: b.id })
      seen.add('cmd:' + b.id)
    }
  }
  return out.slice(0, TOOLBAR_MAX)
}

// 指令统一成 { id, label, cmd }：兼容 v3 / 旧快捷指令（label+cmd）/ 旧短语（text 或纯字符串）。
function normalizeCmds(raw: unknown): QuickCmd[] {
  const out: QuickCmd[] = []
  const seen = new Set<string>()
  for (const item of asArray(raw)) {
    const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
    const rawLabel =
      obj && typeof obj.label === 'string' ? obj.label
        : obj && typeof obj.text === 'string' ? obj.text
          : typeof item === 'string' ? item : ''
    const cmd = obj && typeof obj.cmd === 'string' ? obj.cmd : rawLabel
    const label = rawLabel.trim()
    if (!label || !cmd.trim() || seen.has(label)) continue
    const id = obj && typeof obj.id === 'string' && obj.id ? obj.id : newCmdId()
    out.push({ id, label, cmd })
    seen.add(label)
  }
  return out
}

function loadConfig(): { keys: ToolBtn[]; cmds: QuickCmd[] } {
  const v3 = parseJSON(localStorage.getItem(STORE_KEY)) as { keys?: unknown; cmds?: unknown } | null
  // v3 存在即以它为准：空列表是合法状态（用户全删了），不能拿默认值兜底。
  // 例外：keys 数组非空但条目全不合法（坏数据）→ 落回默认布局。
  if (v3 && typeof v3 === 'object' && Array.isArray(v3.keys) && Array.isArray(v3.cmds)) {
    // 先归一化指令再校验按键里的 cmd 引用（id 必须存在）
    const cmds = normalizeCmds(v3.cmds)
    const keys = normalizeBtns(v3.keys, new Set(cmds.map((c) => c.id)))
    if (keys.length || v3.keys.length === 0) return { keys, cmds }
  }

  // v2 → v3 迁移：按键保留；快捷短语（发送文本+回车）与旧快捷指令、v1 短语全部并进指令列表。
  const v2 = parseJSON(localStorage.getItem(LEGACY_TOOLBAR_KEY))
  const keys = normalizeBtns(v2)
  const cmds = normalizeCmds([
    ...asArray(v2).filter((b) => (b as Record<string, unknown>)?.t === 'snippet'),
    ...asArray(parseJSON(localStorage.getItem(LEGACY_SNIPPETS_KEY))),
    ...asArray(parseJSON(localStorage.getItem(LEGACY_CMDS_KEY))),
  ])
  // 从没存过 v2 布局 = 没动过工具条配置：补上原有默认短语「继续」（旧版是运行时追加的）。
  if (!Array.isArray(v2) && !cmds.some((c) => c.label === '继续')) cmds.unshift(...DEFAULT_CMDS)
  return {
    keys: keys.length ? keys : DEFAULT_BTNS,
    cmds,
  }
}

// 模块级单例：工具条、设置弹窗、指令面板看到同一份列表，改动即时互见。
const initial = loadConfig()
export const toolButtons = ref<ToolBtn[]>(initial.keys)
export const quickCmds = ref<QuickCmd[]>(initial.cmds)

export function saveConfig() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ v: 3, keys: toolButtons.value, cmds: quickCmds.value }))
  } catch {
    /* 不可用就只本次生效 */
  }
}

// —— 指令固定到工具条（一键发送；完整列表仍在「指令」面板）——
export function getQuickCmd(id: string): QuickCmd | undefined {
  return quickCmds.value.find((c) => c.id === id)
}
export function isCmdPinned(id: string): boolean {
  return toolButtons.value.some((b) => b.t === 'cmd' && b.id === id)
}
export function toggleCmdPin(id: string): 'pinned' | 'unpinned' | 'full' {
  const at = toolButtons.value.findIndex((b) => b.t === 'cmd' && b.id === id)
  if (at >= 0) {
    toolButtons.value.splice(at, 1)
    saveConfig()
    return 'unpinned'
  }
  if (!getQuickCmd(id)) return 'unpinned'
  if (toolButtons.value.length >= TOOLBAR_MAX) return 'full'
  toolButtons.value.push({ t: 'cmd', id })
  saveConfig()
  return 'pinned'
}

export function rmBtn(i: number) {
  toolButtons.value.splice(i, 1)
  saveConfig()
}

export function addKeyBtn(id: string) {
  if (!KEY_POOL[id] || toolButtons.value.length >= TOOLBAR_MAX) return
  if (toolButtons.value.some((b) => b.t === 'key' && b.id === id)) return
  toolButtons.value.push({ t: 'key', id })
  saveConfig()
}

export function addCustomKey(label: string, seq: string) {
  const l = label.trim()
  if (!l || !seq || toolButtons.value.length >= TOOLBAR_MAX) return
  if (toolButtons.value.some((b) => b.t === 'custom' && b.label === l)) return
  toolButtons.value.push({ t: 'custom', label: l, seq })
  saveConfig()
}

// —— 指令增删改（label 作展示名，重名拒绝；cmd 原样发送，补 \r 由发送方负责）——
export function addQuickCmd(label: string, cmd: string): boolean {
  const l = label.trim()
  if (!l || !cmd.trim() || quickCmds.value.some((c) => c.label === l)) return false
  quickCmds.value.push({ id: newCmdId(), label: l, cmd })
  saveConfig()
  return true
}

export function updateQuickCmd(i: number, label: string, cmd: string): boolean {
  const c = quickCmds.value[i]
  const l = label.trim()
  if (!c || !l || !cmd.trim()) return false
  if (quickCmds.value.some((o, oi) => oi !== i && o.label === l)) return false
  c.label = l
  c.cmd = cmd
  saveConfig()
  return true
}

export function rmQuickCmd(i: number) {
  const [removed] = quickCmds.value.splice(i, 1)
  // 指令删了，工具条上固定它的按钮一并解绑（不留发不出去的幽灵键）
  if (removed) {
    const at = toolButtons.value.findIndex((b) => b.t === 'cmd' && b.id === removed.id)
    if (at >= 0) toolButtons.value.splice(at, 1)
  }
  saveConfig()
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

// 序列反向转义成可读形式（设置页的自定义按键描述用；可再手改回 parseSeq 的输入）。
export function formatSeq(seq: string): string {
  return [...seq].map((ch) => {
    const code = ch.charCodeAt(0)
    if (ch === '\\') return '\\\\'
    if (ch === '\x1b') return '\\e'
    if (ch === '\n') return '\\n'
    if (ch === '\r') return '\\r'
    if (ch === '\t') return '\\t'
    if (code < 0x20 || code === 0x7f) return '\\x' + code.toString(16).padStart(2, '0')
    return ch
  }).join('')
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
