<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { getToken } from '@/lib/api'
import { noteTermOutput } from '@/lib/terminalActivity'
import { isPhone } from '@/composables/useDevice'

const props = withDefaults(
  // host=true 时连 /ws/host-terminal（宿主终端，PTY 由 server 管理，无容器 id）。
  // ssh 时连 /ws/ssh-terminal（远程主机，PTY 链 = script → ssh → 远端 tmux，shell 参数
  // 不适用——远端 shell 由远端自己决定）。
  // fromTermId = 分屏来源 pane 的 termId（仅分屏时由 TermLayoutNode 传入）：后端首次
  // 创建新会话时继承源 pane 的当前目录。放进 URL 而非 localStorage 布局树——cwd 只在
  // 新会话创建那一刻有意义，刷新后（会话必已存在、纯 attach）随内存映射消失即不再传。
  defineProps<{
    id?: string
    name: string
    termId: string
    shell?: string
    active?: boolean
    host?: boolean
    // docker 服务终端：连 /ws/service-terminal（PTY = 宿主 tmux 窗口跑 docker exec）。
    service?: string
    // SSH 主机终端：连 /ws/ssh-terminal（PTY = script 包 ssh，会话在远端 tmux 专用 socket）。
    ssh?: string
    fromTermId?: string
  }>(),
  {
    active: true,
    host: false,
  },
)
// 容器内 mysandbox 命令的联动事件：OSC 7677 payload 解析出的容器内路径；
// link-open 是终端 buffer 里 Ctrl+点击路径链接（path 为原始 token，可相对/带 ~，
// 行列来自栈跟踪式 `:行:列` 后缀）；title 是窗口标题变化（OSC 0/2：shell 钩子的
// 执行命令/空闲路径、CC·opencode 的任务标题——经 tmux set-titles 转发到这里，
// ContainerList 拿去更新 tab 标签）。
const emit = defineEmits<{
  (e: 'osc-open', path: string): void
  (e: 'link-open', path: string, line?: number, col?: number): void
  (e: 'title', title: string): void
}>()

// 点 ✕ 关闭时由父组件调用：发 {type:'kill'} 控制帧让后端 tmux kill-session 真杀会话。
// 不在 onBeforeUnmount 里发--刷新页面也会触发 unmount，那时发 kill 会误杀会话、破坏刷新保留。
// CONNECTING 时也不能跳过（原实现只查 OPEN）：断线自动重连未完成的窗口里点 ✕，kill 帧
// 被静默丢弃 → 服务端当纯 detach → 会话永活（「所有终端」里一直挂着、看似 ✕ 没生效）。
// 挂到 open 再发；close 先行入队，TCP 保序，服务端先收 kill 再见断开，wantKill 落地。
// fire-and-forget：open 前组件就卸载也无妨——没送到 kill 就当纯 detach（真 tmux 语义）。
function kill() {
  if (!ws) return
  const send = () => {
    try {
      ws?.send(JSON.stringify({ type: 'kill' }))
    } catch {
      /* socket 已关就忽略：没送到 kill 就当纯 detach，会话保留（真 tmux 语义） */
    }
    try {
      ws?.close(1000)
    } catch {
      /* noop */
    }
  }
  if (ws.readyState === WebSocket.OPEN) send()
  else if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('open', send, { once: true })
    // 连接失败（onerror 后 open 永不来）：随组件卸载一并丢弃，无需额外清理
  }
}

// 当前视口内容快照（逐行文本拼接）：「无输出提醒」的内容基线用——离开时快照 vs
// 安静判定时快照，相同 = 只是重绘（attach 整屏还原/重连/resize），不算新内容。
// 只取底部 rows 行（用户看到的画面）：⚠️ buffer.getLine(y) 的 y 是**全缓冲区绝对行号**，
// 0 = scrollback 顶——从 0 读会把「最老的 24 行」当视口（输出一超屏哈希就永远冻结，
// 基线恒等于当前，内容门槛全废，实测踩过）；文本行不含颜色/光标属性，重绘前后逐字节稳定。
function screenHash(): string | undefined {
  if (!term) return undefined
  const buf = term.buffer.active
  const from = Math.max(0, buf.length - term.rows)
  const lines: string[] = []
  for (let y = from; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}
// 建 WS 连接（含事件挂接与心跳）。抽到模块级：断线重连（reconnect）与首连共用。
// termId 不变 -> 后端 attach 回同一 tmux 会话（无限期保留，直到显式 ✕ 或 shell 退出）。
function connectWs() {
  const token = getToken() ?? ''
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const shell = props.shell || 'zsh'
  const base = props.host
    ? `${proto}://${location.host}/ws/host-terminal?token=${encodeURIComponent(token)}`
    : props.ssh
      ? `${proto}://${location.host}/ws/ssh-terminal?target=${encodeURIComponent(props.ssh)}&token=${encodeURIComponent(token)}`
      : props.service
        ? `${proto}://${location.host}/ws/service-terminal?name=${encodeURIComponent(props.service)}&token=${encodeURIComponent(token)}`
        : `${proto}://${location.host}/ws/terminal?id=${encodeURIComponent(props.id ?? '')}&token=${encodeURIComponent(token)}`
  const url =
    base +
    (props.ssh ? '' : `&shell=${encodeURIComponent(shell)}`) +
    `&cols=${term ? term.cols : 80}&rows=${term ? term.rows : 24}` +
    `&termId=${encodeURIComponent(props.termId)}` +
    (props.fromTermId ? `&from=${encodeURIComponent(props.fromTermId)}` : '')
  ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    connState.value = 'ok'
    term?.writeln(`\x1b[2m>> 连接 ${props.name}${props.ssh ? '' : ` (${shell})`}\x1b[0m`)
  }
  ws.onmessage = (ev) => {
    // 文本帧 = 服务端控制帧（二进制才是终端流）。目前只有 history：tmux pane 历史回填
    // （后端 attach 前 capture-pane 发来），写入 scrollback 后 tmux 整屏重绘落在空视口上。
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data) as { type?: string; text?: string }
        if (m.type === 'history' && m.text && !backfilled) {
          backfilled = true
          // N 行历史 + rows 个 CRLF = N+rows-1 个换行：恰好全部推进 scrollback、零空行
          // 缝隙、光标落底行（数学上精确成立，与 N 无关）；重绘的绝对定位画在空视口上。
          term?.write(m.text.split('\n').join('\r\n') + '\r\n'.repeat(term?.rows ?? 24))
        } else if (m.type === 'title' && typeof m.text === 'string') {
          // 重连/刷新后的标题恢复：pane title 留在 tmux 里不会随 attach 重发（历史回填
          // 只有可见文本），服务端 attach 前读 #T 补发此帧（terminal.ts / hostTerminal.ts）。
          emit('title', m.text)
        }
      } catch {
        /* 非法控制帧忽略 */
      }
      return
    }
    // 终端数据帧 = 有输出：登记最后输出时刻（「无输出提醒」用，见 lib/terminalActivity）。
    // 常驻 tab（v-show 非激活）也在收流，登记对所有可见组生效；历史回填（文本帧）不算。
    // prime 窗口内的帧只点亮光晕、不进提醒资格（attach 重绘/初始 prompt 是打开自带画面）。
    noteTermOutput(props.termId)
    term?.write(new Uint8Array(ev.data as ArrayBuffer))
  }
  // 非正常关闭（非 1000/1001）视为意外断线，置 lost 徽标；点「重连」条或刷新恢复。
  ws.onclose = (ev) => {
    if (hbTimer) {
      clearInterval(hbTimer)
      hbTimer = null
    }
    if (ev.code !== 1000 && ev.code !== 1001) connState.value = 'lost'
    term?.writeln(`\x1b[2m>> 已断开 (${ev.code})\x1b[0m`)
  }
  ws.onerror = () => term?.writeln('\x1b[31m>> socket 错误\x1b[0m')

  // 心跳探测：15s 一个空文本帧。服务端收到未知文本帧走 JSON.parse 失败分支静默忽略；
  // send 抛错（栈已死）则置 lost。TCP 半开（后端挂死不 reset）时 onclose 迟迟不来，
  // 这是前端唯一能感知的手段。
  // 帧里捎带当前尺寸做对账：onResize 只在尺寸变化时触发，任何竞态丢帧（隐藏 tab 挂载时
  // fit 失败、WS 早于 fit 建立、refit 与 resize 帧交错）都会让 PTY/tmux 停在陈旧尺寸，
  // 表现为 TUI（claude 等）只画终端一半宽且永不恢复。后端 resize 分支尺寸不变即跳过，
  // 正常路径零成本；尺寸漂移时这里每 15s 纠正一次，作为 onResize 的兜底。
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(term ? JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }) : '')
    } catch {
      connState.value = 'lost'
    }
  }, 15_000)
}

// 断线重连：卸掉旧 WS 重建。termId 不变 -> 后端 attach 回同一 tmux 会话（无时限保留），
// 历史/正在跑的任务都在。终端上方的「连接已断开 · 点击重连」条走这里。
function reconnect() {
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  ws = null
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = null
  }
  connState.value = 'ok'
  connectWs()
  term?.focus()
}
defineExpose({ kill, reconnect, screenHash })

const el = ref<HTMLDivElement | null>(null)
let term: XTerm | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObs: ResizeObserver | null = null
let rafId = 0
let webglAddon: WebglAddon | null = null
let linkProv: { dispose(): void } | null = null
// 断线状态（终端上方覆盖条用）：'ok' | 'lost'。TCP 半开（后端挂死/NAT 超时）时 onclose 不会触发，
// 靠心跳探测置 lost。tmux 会话在后端无限期保留（真 tmux 语义），重连即恢复。
const connState = ref<'ok' | 'lost'>('ok')
let hbTimer: ReturnType<typeof setInterval> | null = null
// tmux 历史回填只做一次（组件首连）：reconnect 时 term 实例还在、scrollback 已有内容，
// 再回填会重复整段历史。断线期间产生的输出留在 tmux 历史里滚不到（可接受的缺口）。
let backfilled = false

// 内置 Cascadia Code Variable 优先（woff2 打包，跨端一致）；彩色 emoji 走系统字体兜底。
const FONT_FAMILY =
  '"Cascadia Code Variable", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, ' +
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'

// 字号随容器宽度自适应：窄屏不溢出、大屏不显小。用户显式调过（触屏工具条 A±）则
// 记忆优先（clamp 10–18），跨 pane/刷新保持。
const FONT_SIZE_KEY = 'mysandbox:term-font-size'
function computeFontSize(): number {
  const saved = Number(localStorage.getItem(FONT_SIZE_KEY))
  if (Number.isFinite(saved) && saved >= 10 && saved <= 18) return saved
  const w = el.value?.clientWidth ?? window.innerWidth
  if (w < 640) return 13 // 手机：偏大便于触屏阅读
  if (w > 1600) return 15
  return 13
}
// 触屏工具条 A±：写记忆并立即重算（refit 内会同步 term.options.fontSize）。
function stepFontSize(delta: number) {
  const cur = computeFontSize()
  const next = Math.max(10, Math.min(18, cur + delta))
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(next))
  } catch {
    /* 不可用就只本次生效 */
  }
  refit()
}

// 防抖 fit：合并一帧内的多次尺寸变化，避免拖窗/字号切换时高频抖动；同时同步字号。
function refit() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    rafId = 0
    if (!el.value || el.value.clientWidth === 0) return
    const fs = computeFontSize()
    if (term && term.options.fontSize !== fs) term.options.fontSize = fs
    try {
      fit?.fit()
      // 强制重算 xterm 内部滚动区（切回 tab 后「滚动不到最下面」的修复）。
      // xterm 5.5 的 Viewport._innerRefresh 直接读 viewport 的 offsetHeight，而
      // display:none 期间该值是 0——隐藏 tab 收到会推进外层 buffer 的输出（首载
      // 恢复多组 tab 时的历史回填、断线时的 ">> 已断开" writeln 等）时滚动区高度
      // 被算短整整一个视口，最底一行屏永远够不着；且 tmux 原地重绘不滚外层 buffer、
      // 尺寸也没变，syncScrollArea 之后不再被调用，错误一直留到刷新页面。fit 对
      // 「尺寸没变」是纯 no-op，救不了；这里在可见路径上强制 immediate 重算一次，
      // 健康态下是幂等写、零副作用。
      const vp = (
        term as unknown as {
          _core?: { viewport?: { syncScrollArea?: (immediate?: boolean) => void } }
        }
      )._core?.viewport
      vp?.syncScrollArea?.(true)
      // 粘贴兜底对话框打开期间不抢焦点：term.focus() 会把光标拉回终端，
      // 用户正要在兜底 textarea 里长按/Ctrl+V 粘贴。
      if (!pasteFallback.value) term?.focus()
    } catch {
      /* noop */
    }
  })
}

// 切到本 tab：等 display 生效后重算尺寸并聚焦。
watch(
  () => props.active,
  (a) => {
    if (a) nextTick(refit)
  },
)

// 复制/粘贴：tmux 不再劫持鼠标（后端 set -g mouse off），交互层由 xterm.js 接管。
// 剪贴板走 navigator.clipboard；OSC 52（TUI 应用请终端代写剪贴板）也汇到 copyText
// （见下方 registerOscHandler(52)）。
// 非 https 环境（http://局域网IP 访问）navigator.clipboard 是 undefined——一律走
// execCommand 兜底 + toast 提示，不再静默吞（否则 Ctrl+C 复制 / Ctrl+V 粘贴双双无声失败）。
// execCommand 必须在用户手势事件栈里同步调用：keydown（Ctrl+C/V 路径）与 click（工具条/右键）
// 都是合法手势；不能 await 后再调（手势已过期，Firefox 直接拒绝）。
function legacyCopy(s: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = s
  // 移出可视区但保持可聚焦；readonly 防软键盘弹出，防止页面滚到底
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  ta.setAttribute('readonly', '')
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}
async function copyText(s: string): Promise<boolean> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(s)
      return true
    } catch {
      /* 权限被拒等：落 execCommand 兜底 */
    }
  }
  // execCommand 要求同步在用户手势里调——本函数若被 await 了别的异步操作后才调到这里，
  // 手势可能已过期，但 Chrome/Edge 对 copy 的手势检查较松，值得一试。
  if (legacyCopy(s)) return true
  toast.error('复制失败：剪贴板不可用（非 https 访问时浏览器禁用剪贴板 API）')
  return false
}
async function pasteClipboard() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (navigator.clipboard) {
    try {
      const t = await navigator.clipboard.readText()
      if (t) ws.send(new TextEncoder().encode(t)) // 走和 onData 同一条 stdin 通道
      return
    } catch {
      /* Firefox 常态拒绝 readText：落兜底对话框 */
    }
  }
  pasteFallback.value = true // clipboard 不可用/被拒：弹兜底输入框（textarea 原生粘贴永远可用）
  nextTick(() => fallbackTa.value?.focus())
}
// 右键：有选区复制（并清选区）、无选区粘贴。.prevent 阻止浏览器原生右键菜单。
function onContextMenu() {
  if (term?.hasSelection()) {
    void copyText(term.getSelection()).then(() => term?.clearSelection())
  } else {
    void pasteClipboard()
  }
}

// —— 手机触屏工具条（重度终端使用的核心补充）——
// 触屏没有右键/Ctrl 组合，复制粘贴/Esc/方向键/Ctrl 粘滞全走这条工具条（模板里 md:hidden）。
// 粘贴优先走 navigator.clipboard.readText；iOS Safari 常态性拒绝读取（需用户手势且默认不授权），
// 拒绝时自动弹兜底输入框——用户在 textarea 里系统级长按粘贴，确认后走同一条 stdin 通道发送。
const pasteFallback = ref(false)
const pasteText = ref('')
const fallbackTa = ref<HTMLTextAreaElement | null>(null)
const ctrlSticky = ref(false)
async function toolPaste() {
  if (navigator.clipboard) {
    try {
      const t = await navigator.clipboard.readText()
      if (t) sendRaw(t)
      return
    } catch {
      /* readText 被拒：开兜底输入框 */
    }
  }
  pasteFallback.value = true // clipboard 不可用（非 https）/被拒：同 pasteClipboard 的兜底
  nextTick(() => fallbackTa.value?.focus())
}
function toolPasteConfirm() {
  if (pasteText.value) sendRaw(pasteText.value)
  pasteText.value = ''
  pasteFallback.value = false
}
// 系统级粘贴（Ctrl+V / 长按）落进 textarea 时 paste 事件自带 clipboardData —— 直接自动发送，
// 不再要求点「发送到终端」；个别环境 paste 事件不带数据时不拦默认行为，让文本进 textarea，
// 由 input(insertFromPaste) 补一枪。两个都扑空才需要手动点按钮（按钮保留作兜底）。
function fallbackSend(text: string) {
  if (!text) return
  sendRaw(text)
  pasteText.value = ''
  pasteFallback.value = false
}
function onFallbackPaste(e: ClipboardEvent) {
  const t = e.clipboardData?.getData('text')
  if (!t) return
  e.preventDefault()
  fallbackSend(t)
}
function onFallbackInput(e: InputEvent) {
  if (e.inputType === 'insertFromPaste' && pasteText.value) fallbackSend(pasteText.value)
}
function toolCopy() {
  if (!term?.hasSelection()) return
  void copyText(term.getSelection()).then(() => term?.clearSelection())
}
// 选区状态（复制按钮的禁用态用）：term 实例非响应式，选区变化时同步到 ref。
// onSelectionChange 覆盖拖选/清选；工具条渲染期间手动同步一次。
const termHasSel = ref(false)
function syncSel() {
  termHasSel.value = !!term?.hasSelection()
}
// 粘滞 Ctrl：点亮后下一个字母键以 Ctrl 组合发送（'c' -> \x03），发完自动熄灭。
// 组合入口有两个：工具条按键走 toolKey（Esc/Tab/方向键——字母组合在此只是兜底），
// 软键盘字母走 onData（工具条没有字母键，手机上 Ctrl+C 等组合的唯一路径）。
function sendCtrlCombo(data: string): string | null {
  if (!ctrlSticky.value) return null
  // 只有单个字母才组合（实体键盘的 Ctrl 组合到达 onData 时已是控制字符，不受影响）。
  if (data.length === 1 && data.toLowerCase() >= 'a' && data.toLowerCase() <= 'z') {
    ctrlSticky.value = false
    return String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96)
  }
  return null
}
function toolKey(ch: string, ctrl = false) {
  const combo = sendCtrlCombo(ch)
  if (combo !== null) {
    sendRaw(combo)
    return
  }
  sendRaw(ch)
  if (ctrlSticky.value) ctrlSticky.value = false
}
// 直发 stdin（与 onData 同通道）：工具条按键/粘贴共用。
function sendRaw(s: string) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(s))
}

// —— 软键盘自适应（仅手机）——
// visualViewport 在键盘弹起时收缩（layout viewport 不动），kbH = 布局高 - 可视高 即键盘
// 占位。把根容器 paddingBottom 撑出 kbH，内层 el 已有 ResizeObserver → 自动走现有 refit，
// 与 tmux resize 对账心跳（15s）协同，PTY cols/rows 始终正确。
const kbH = ref(0)
let vvCleanup: (() => void) | null = null
function setupViewportWatch() {
  const vv = window.visualViewport
  if (!vv) return
  const onVv = () => {
    const h = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
    kbH.value = h > 120 ? h : 0 // 透值过滤地址栏小幅伸缩
  }
  vv.addEventListener('resize', onVv)
  vv.addEventListener('scroll', onVv)
  vvCleanup = () => {
    vv.removeEventListener('resize', onVv)
    vv.removeEventListener('scroll', onVv)
  }
}

// 滚轮/滚动条：交给 xterm.js 原生处理（与 VSCode 集成终端一致）--tmux 不再开 mouse 劫持，
// 终端流不带鼠标追踪序列，xterm 默认即把滚轮滚 scrollback 并保留右侧滚动条。无需手写 wheel 接管，
// 手写反而会 preventDefault 掉原生滚动、破坏滚动条。

// 字体探测串：终端会用到的 Cascadia 各分片都要触发加载。load() 不带 text 时只拉 latin
// 分片（默认探测文本是 ASCII）；盲文（▐▛█▘▝）、框线（╭─╮│）、箭头等在独立分片里，未就绪时
// WebGL 图集按 fallback 字体栅格化这些字形——宽度错、布局乱，且图集缓存不自动失效。
// 宿主终端连接即时（无 docker exec 延迟兜时间），竞态窗口比容器终端宽得多（实测踩过：
// claude 欢迎框半屏 + 字形错位）。
const FONT_PROBE = 'W█▘▝▐▛▜▌╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝●✢❯⏵⎿→←…'

// —— 路径链接识别（Ctrl+点击打开）——
// 规则：token 以 / ~/ ./ ../ 开头或恰好是裸 ~；前一字符（若有）必须是空白或 "'=[({<
// 之一（防 URL/普通词中段误配；`?a=/tmp/x` 的 = 后可配是刻意保留——`--out=/path` 场景）；
// 主体字符集 [A-Za-z0-9._~+@%$-] 加 /；结尾剥句读；支持 :行(:列) 后缀（栈跟踪）。
// 明确不匹配：不含 / 的裸文件名（防误报）、// 开头（协议相对 URL）、跨行 wrap、含空格路径。
interface PathToken {
  start: number
  end: number
  path: string
  line?: number
  col?: number
}
const PRE_BOUNDARY = /[\s"'=[({<]/
const TOKEN_CHAR = /[A-Za-z0-9._~+@%$-]/
const TRAIL_PUNCT = /[.,;:)\]"'`]/

function findPathTokens(text: string): PathToken[] {
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

onMounted(async () => {
  if (!el.value) return
  // 等内置字体就绪再开终端：否则首次 fit 用 fallback 字体的 cell 宽度度量，cols 偏小，
  // 首屏表现为终端只占容器一半宽度、字符网格错位（图标像块拼），拖窗触发重 fit 才恢复。
  // fontsource 在 main.ts 顶部已预取，这里 await 通常瞬时；1.5s 超时兜底防字体源卡住。
  const fontP =
    document.fonts?.load?.(`${computeFontSize()}px "Cascadia Code Variable"`, FONT_PROBE) ??
    Promise.resolve()
  await Promise.race([fontP.catch(() => {}), new Promise<void>((r) => setTimeout(r, 1500))])

  term = new XTerm({
    fontFamily: FONT_FAMILY,
    fontSize: computeFontSize(),
    cursorBlink: true,
    scrollback: 10000, // 回滚行数，与 VSCode 集成终端默认一致（xterm 默认仅 1000）
    theme: { background: '#000000' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(el.value)
  // OSC 0/2（窗口标题）：shell 钩子（scripts/zshrc / 宿主 ~/.zshrc 的 preexec/precmd）
  // 与 TUI 应用（CC/opencode）发的标题，经 tmux set-titles on（session 级选项）转发到
  // 这里——ContainerList 拿去更新 tab 标签/popout 窗口标题。plain shell 降级（无 tmux）
  // 时序列直达，同样走这里，链路两种模式天然覆盖。
  term.onTitleChange((t) => emit('title', t.trim()))
  // 容器内 mysandbox 命令：捕获 OSC 7677（tmux 下走 DCS passthrough，到这里已还原为裸 OSC）。
  // payload 形如 "open;<path>"：action 取首个 ; 之前，路径取其后全部（路径可含 ;）。
  // 返回 true = 已消费，不落入默认处理。
  term.parser.registerOscHandler(7677, (data) => {
    const i = data.indexOf(';')
    if (i >= 0 && data.slice(0, i) === 'open') {
      const path = data.slice(i + 1)
      if (path.startsWith('/')) emit('osc-open', path)
    }
    return true
  })
  // OSC 52（剪贴板操作）：TUI 应用（opencode/claude code 等）在容器内没有 X/Wayland
  // 环境，xclip/wl-copy 全失败，唯一的复制通道就是「请终端代写剪贴板」的 OSC 52。
  // xterm.js 核心不实现它——不接的话应用提示「已复制」但剪贴板纹丝不动（VSCode 终端
  // 实现了 OSC 52，所以同样的 opencode 在 VSCode 里能复制）。
  // payload：`<selection>;<base64|?>`；? = 查询剪贴板（只回空——我们只做写入侧，
  // 读回会话里粘贴已有 navigator.clipboard 通道，且查询有剪贴板内容外泄面）。
  // tmux 下它以 DCS passthrough 到达，xterm 解包后仍是 52 号 OSC，无需特判。
  term.parser.registerOscHandler(52, (data) => {
    const i = data.indexOf(';')
    if (i < 0) return true
    if (data.slice(i + 1) === '?') return true // 查询：不回应
    // base64 → UTF-8：atob 出的是 latin1 字节，中文等非 ASCII 必须经 Uint8Array 解码
    try {
      const b64 = data.slice(i + 1)
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k)
      const text = new TextDecoder().decode(bytes)
      if (text) void copyText(text)
    } catch {
      /* 非法 base64：静默 */
    }
    return true
  })
  // 路径链接 provider（Ctrl+点击打开）。必须在上面 WebLinksAddon 之后注册：xterm 按注册
  // 顺序取第一个命中位置的链接，URL 撞位时归 web-links，别调换顺序。
  // 宽字符映射是核心：translateToString 的字符串索引 ≠ cell 列（CJK 占 2 cell，其后还有
  // 1 个 width=0 的续格），必须 cell walk 建「字符串索引 -> cell 列」映射（xterm 内部
  // web-links 的 _mapStrIdx 同款手法）。
  linkProv = term.registerLinkProvider({    provideLinks(bufferLineNumber, callback) {
      const t = term
      if (!t) return callback(undefined)
      const line = t.buffer.active.getLine(bufferLineNumber - 1)
      // 折行续行跳过：URL 折行后的 /xxx 段会误配，且不支持跨行 token（v1 限制）
      if (!line || line.isWrapped) return callback(undefined)
      const limit = Math.min(line.length, t.cols) // resize 后 line.length 可能 > cols（陈旧尾格）
      const cell = t.buffer.active.getNullCell() // 复用 scratch cell，避免逐格建对象
      const cellOf: number[] = [] // 字符串索引 -> 所在 cell 的 0 基列
      const widthAt: number[] = [] // cell 列 -> 宽度
      let text = ''
      for (let x = 0; x < limit; x++) {
        if (!line.getCell(x, cell)) break
        const w = cell.getWidth()
        widthAt[x] = w
        if (w === 0) continue // 宽字符续格：不产生字符串内容
        const chars = cell.getChars()
        for (let k = 0; k < chars.length; k++) cellOf.push(x)
        text += chars
      }
      // 快速出局：scrollback 大量鼠标移动时不做无谓扫描
      if (!text.includes('/') && !text.includes('~')) return callback(undefined)
      const toks = findPathTokens(text)
      if (!toks.length) return callback(undefined)
      callback(
        toks.map((tk) => ({
          range: {
            // xterm 的 range 是 1 基；_linkAtPosition 用闭区间 start<=x<=end，end.x 是
            // 末字符的下一列（与 web-links 的 _mapStrIdx 返回值同语义；实测 underline
            // 宽度 = x2-x1 = token 精确 cell 数）。末字符是宽字符时 +1 覆盖续格。
            start: { x: cellOf[tk.start]! + 1, y: bufferLineNumber },
            end: {
              x: cellOf[tk.end - 1]! + 1 + (widthAt[cellOf[tk.end - 1]!] === 2 ? 1 : 0),
              y: bufferLineNumber,
            },
          },
          text: tk.path,
          // 显式声明 hover 装饰（缺省值也是全开，显式写防止默认值随版本漂移）。
          decorations: { underline: true, pointerCursor: true },
          // 只在按住 Ctrl/Cmd（macOS）时激活；普通点击 no-op，选区/聚焦等原生行为不受影响。
          activate(event: MouseEvent) {
            if (!(event.ctrlKey || event.metaKey)) return
            emit('link-open', tk.path, tk.line, tk.col)
          },
          hover(event: MouseEvent) {
            showLinkTip(event, tk.path)
          },
          leave() {
            hideLinkTip()
          },
        })),
      )
    },
  })
  // 键盘复制/粘贴拦截。返回 false=吞掉（不发 onData）、true=透传给终端。
  //   - Ctrl+Shift+C：复制选中（无选区也不发 ^C，纯复制键不应中断当前命令）。
  //   - Ctrl+V / Ctrl+Shift+V：粘贴（与桌面终端习惯一致；吞掉 ^V，牺牲 shell 的
  //     quoted-insert/literal-next，web 终端场景粘贴远比它常用）。
  //   - Ctrl+C：有选区时复制并清选区、吞掉；无选区时透传发 ^C=SIGINT（必须 return true）。
  //   其余按键一律透传，不影响 vim/less 等正常输入。
  term.attachCustomKeyEventHandler((e) => {
    if (!(e.ctrlKey && !e.altKey && !e.metaKey)) return true
    if (e.shiftKey && e.code === 'KeyC') {
      if (e.type === 'keydown' && term!.hasSelection()) void copyText(term!.getSelection())
      return false
    }
    // 粘贴：Ctrl+V 和 Ctrl+Shift+V 都匹配（e.code 不区分 shift）。
    // attachCustomKeyEventHandler 对 keydown 和 keyup 各回调一次：不区分 e.type 的话 pasteText
    // 会被调两次（按下 + 抬起）。
    // secure context（https/localhost）：keydown 时手动粘贴并 preventDefault 掉原生 paste，
    // 否则手动 readText + 原生 paste（xterm 内置粘贴）+ keyup 三路叠加 = 粘贴内容 ×3。
    // 非 secure context（http://IP 访问）：navigator.clipboard 不存在，手动路径必落兜底弹框；
    // 而 paste 事件自带 clipboardData、无需任何权限，是浏览器唯一放行的免权限粘贴通道 ——
    // 此时不 preventDefault，让原生 paste 走 xterm 内置粘贴，全程无弹框。
    if (e.code === 'KeyV') {
      if (e.type === 'keydown') {
        if (navigator.clipboard) {
          e.preventDefault()
          void pasteClipboard()
        }
        // 无 clipboard API：不 preventDefault —— 原生 paste 派发给 xterm 内置粘贴完成发送。
      }
      return false // 两种环境都不发 ^V（quoted-insert）；return false 不 preventDefault，见上
    }
    if (e.code === 'KeyC') {
      if (term!.hasSelection()) {
        // keydown 复制并清选区；keyup 不重复写剪贴板。
        if (e.type === 'keydown') void copyText(term!.getSelection()).then(() => term!.clearSelection())
        return false
      }
      return true // 无选区：透传 -> xterm 发 ^C = SIGINT
    }
    return true
  })
  // WebGL 渲染器：栅格化 glyph，等宽对齐更稳（vscode 终端默认即此）。两处降级到 DOM 渲染器：
  //  - 粗指针（手机/平板）：canvas 不支持原生选词复制，DOM 渲染器才能长按选择。
  //  - 非整数 devicePixelRatio（125%/150% 缩放）：webgl addon 的 glyph atlas 在分数像素下
  //    采样偏移会随列数累积——186 列终端右侧错出多格、框线画成楼梯状（实测踩过：claude
  //    TUI 框只渲染左半 + 字形错位，缓冲区数据完好所以复制出的文本是完整的）。addon 用
  //    devicePixelContentBoxSize 修正舍入，但 Firefox 不支持该 API，修正直接失效。
  //    DOM 渲染器逐字符独立定位，不受影响；性能差异在千行 scrollback 级别才可感。
  const isCoarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false
  const fractionalDpr = window.devicePixelRatio % 1 !== 0
  if (!isCoarse && !fractionalDpr) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
      webglAddon = webgl // 持引用：卸载时先 dispose addon，避免 term.dispose 内部清理 renderer 时访问已释放资源
    } catch {
      /* webgl 不可用，回退 DOM 渲染器 */
    }
  }
  // 首次 fit 多阶段兜底：mount 瞬间布局/字体/WebGL 偶发未就绪，单次 fit 可能算错 cols
  // （term 停默认 80 → 视觉终端只占面板一半，拖窗重 fit 才恢复）。多帧覆盖各时序。
  refit()
  requestAnimationFrame(() => refit())
  setTimeout(refit, 200)
  ;(document.fonts?.load?.(`${computeFontSize()}px "Cascadia Code Variable"`, FONT_PROBE) ?? Promise.resolve())
    .then(refit)
    .catch(() => {})

  // 字体分片晚到时 WebGL 图集可能已用 fallback 字体栅格化过字形（宽度错、布局乱，
  // 图集缓存不会自动失效——拖窗 refit 也不恢复）。fonts.ready 后强制清一次图集重栅格化，
  // 这是「claude 欢迎框半屏 + 字形错位」的兜底（容器终端的 docker exec 延迟天然给了字体
  // 加载时间，宿主终端即时连接没有，此问题在宿主侧高发）。
  document.fonts?.ready?.then(() => {
    try {
      webglAddon?.clearTextureAtlas()
    } catch {
      /* addon 已 dispose（context loss）则忽略 */
    }
  })

  // 构建 WS URL 前同步 fit 一次：refit() 把 fit 推到 rAF 里异步执行，此刻 term.cols/rows 仍是
  // xterm 默认 80x24。若 URL 带这个陈旧值，后端 exec.resize 会把 tmux 窗口先缩到 80、等前端
  // rAF fit 完再撑回真实尺寸（shrink-then-grow），且 rAF 的那次 resize 会打断 tmux attach 的
  // 重绘字节流、触发 xterm reflow -> 光标与提示符行解耦、刷新后光标窜到下一行（按回车才复位）。
  // 同步 fit 后 URL 带真实尺寸、后端首帧即 resize 到位，rAF refit 发现尺寸未变不再 reflow。
  // ⚠️ 仅在可见时 fit：恢复多个 tab 时非激活组是 display:none 挂载，这里量到的是 NaN/0 尺寸，
  // 别把垃圾值喂给 resize/URL——等激活 refit 或 ResizeObserver 兜底。
  try {
    if (el.value.clientWidth > 0) fit?.fit()
  } catch {
    /* noop */
  }

  // 构建 WS（见下方模块级 connectWs）。
  connectWs()

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      // 粘滞 Ctrl 消费：软键盘字母在此组合成控制字符（手机发 Ctrl+C 的唯一路径）。
      const combo = sendCtrlCombo(data)
      ws.send(new TextEncoder().encode(combo ?? data))
    }
  })
  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  })
  resizeObs = new ResizeObserver(refit)
  resizeObs.observe(el.value)
  // 选区同步：工具条「复制」按钮的禁用态跟随选区（仅手机工具条用，桌面无成本——一行回调）。
  term.onSelectionChange(syncSel)
  if (props.active) term.focus()

  // 软键盘自适应仅手机启用（桌面 visualViewport 变化无意义，少挂监听）。
  if (isPhone.value) setupViewportWatch()
})

// 路径链接 tooltip：挂在 term.element 内的动态 DOM（带 xterm-hover class——xterm 的
// mousemove 会沿 composedPath 找到它，视为「仍在链接上」不误触发 leave）。
// pointer-events:none 让它永不抢鼠标事件。leave() 里必须移除：xterm 在行重绘/resize/
// mouseleave/跨 cell 时都会清当前链接。样式在下方非 scoped <style>（动态 DOM 带不上
// Vue scoped 的 data 属性）。
let linkTip: HTMLDivElement | null = null
function showLinkTip(ev: MouseEvent, path: string) {
  const root = term?.element
  if (!root) return
  if (!linkTip) {
    linkTip = document.createElement('div')
    linkTip.className = 'ms-term-link-tip xterm-hover'
    root.appendChild(linkTip)
  }
  const short = path.length > 64 ? path.slice(0, 61) + '…' : path
  linkTip.textContent = `Ctrl+点击打开 ${short}`
  linkTip.style.left = `${ev.clientX + 10}px`
  linkTip.style.top = `${ev.clientY + 14}px`
}
function hideLinkTip() {
  linkTip?.remove()
  linkTip = null
}

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (hbTimer) clearInterval(hbTimer)
  vvCleanup?.()
  resizeObs?.disconnect()
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  // 链接 provider 与 tooltip 先于 WebGL addon 拆（同款防御性顺序：term.dispose 会连带
  // 清理，但显式 dispose 保证卸载路径上 tooltip 不残留 DOM）。
  try {
    linkProv?.dispose()
  } catch {
    /* noop */
  }
  hideLinkTip()
  // dispose 顺序：先 addon（WebGL renderer 挂在 term 上，得在 term 还活着时拆），
  // 再 term。反序会触发 term.dispose 内部访问已释放的 renderer -> TypeError。
  try {
    webglAddon?.dispose()
  } catch {
    /* context loss 后再 dispose 偶发报错，忽略 */
  }
  webglAddon = null
  try {
    term?.dispose()
  } catch {
    /* noop */
  }
  term = null
  fit = null
})
</script>

<template>
  <!-- bg-black + 内边距放外层：el 自身不带 padding，FitAddon 量到的 clientWidth/clientHeight 才是
       真实内容区，否则会多算 ~1 行、末行光标被底部边缘切掉一半。
       overscroll-none：iOS 聚焦终端时防页面整体上滚（终端是 body 内唯一内容，链上加锁即可）。
       手机软键盘弹起时 paddingBottom 撑出键盘高度（kbH），内层 ResizeObserver 自动 refit。 -->
  <div class="relative flex h-full flex-col bg-black px-2 py-1.5 overscroll-none" :style="kbH > 0 ? { paddingBottom: kbH + 'px' } : undefined">
    <div ref="el" class="min-h-0 flex-1 overflow-hidden" @contextmenu.prevent="onContextMenu" />
    <!-- 触屏工具条（手机 only）：复制/粘贴/Esc/Tab/方向/Ctrl 粘滞/字号。
         桌面（≥768px 或鼠标环境）不渲染——右键与键盘快捷键已覆盖。 -->
    <div v-if="isPhone" class="flex shrink-0 items-center gap-1 overflow-x-auto scroll-thin border-t border-zinc-800 pt-1 md:hidden">
      <button type="button" class="tb" title="粘贴剪贴板内容" @click="toolPaste">粘贴</button>
      <button type="button" class="tb" :disabled="!termHasSel" title="复制选中内容" @click="toolCopy">复制</button>
      <button type="button" class="tb" :class="ctrlSticky ? 'tb-on' : ''" title="粘滞 Ctrl：点亮后下一个字母键以 Ctrl 组合发送" @click="ctrlSticky = !ctrlSticky">Ctrl</button>
      <button type="button" class="tb" title="发送 Esc" @click="toolKey('\x1b')">Esc</button>
      <button type="button" class="tb" title="发送 Tab" @click="toolKey('\t')">Tab</button>
      <button type="button" class="tb" title="上方向键" @click="toolKey('\x1b[A')">↑</button>
      <button type="button" class="tb" title="下方向键" @click="toolKey('\x1b[B')">↓</button>
      <button type="button" class="tb" title="左方向键" @click="toolKey('\x1b[D')">←</button>
      <button type="button" class="tb" title="右方向键" @click="toolKey('\x1b[C')">→</button>
      <button type="button" class="tb" title="减小字号" @click="stepFontSize(-1)">A−</button>
      <button type="button" class="tb" title="增大字号" @click="stepFontSize(1)">A+</button>
    </div>
    <!-- 粘贴兜底输入：浏览器剪贴板 API 不可用/被拒时自动弹（桌面 http://IP 访问、Firefox
         readText 拒绝、iOS Safari 均落这里）。textarea 里系统级粘贴（Ctrl+V / 长按）不走
         clipboard API，永远可用；@paste/@input 捕获到粘贴动作即自动发送，按钮仅作兜底。 -->
    <div v-if="pasteFallback" class="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 rounded-t-lg border-t border-zinc-700 bg-zinc-900 p-3 pb-safe">
      <p class="text-xs text-zinc-500">桌面浏览器可直接在终端里 Ctrl+V 粘贴，无需此框。</p>
      <textarea
        ref="fallbackTa"
        v-model="pasteText"
        class="h-24 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-sm text-zinc-100"
        placeholder="在此粘贴内容（Ctrl+V / 长按）…"
        @paste="onFallbackPaste"
        @input="onFallbackInput"
      />
      <div class="flex justify-end gap-2">
        <button type="button" class="tb" @click="pasteFallback = false; pasteText = ''">取消</button>
        <button type="button" class="tb tb-on" @click="toolPasteConfirm">发送到终端</button>
      </div>
    </div>
    <!-- 断线覆盖条：非正常断开时显示，点击重连（termId 不变 -> 回到同一 tmux 会话） -->
    <button
      v-if="connState === 'lost'"
      class="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-amber-500/90 px-3 py-1 text-xs font-medium text-black"
      @click="reconnect"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-black" />
      连接已断开 · 点击重连
    </button>
  </div>
</template>

<style>
/* 触屏工具条按钮：紧凑但命中区 ≥40px（高度 h-9），等宽字排布稳定。
   tb-on 为激活态（粘滞 Ctrl 点亮 / 发送按钮）。 */
.tb {
  height: 2.25rem;
  min-width: 2.75rem;
  padding: 0 0.625rem;
  flex-shrink: 0;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
  font-family: var(--font-mono), ui-monospace, monospace;
}
.tb:active {
  background: #27272a;
}
.tb:disabled {
  opacity: 0.35;
}
.tb-on {
  border-color: #f59e0b;
  color: #fbbf24;
}
/* 路径链接 tooltip：动态创建挂在 term.element 内，Vue scoped 样式够不着，用全局类名。 */
.ms-term-link-tip {
  position: fixed;
  z-index: 50;
  pointer-events: none; /* 不抢鼠标事件：hover 不会被自己打断，也无需担心挡住点击 */
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid #3f3f46;
  border-radius: 4px;
  background: #18181b;
  color: #d4d4d8;
  padding: 2px 6px;
  font-size: 11px;
  font-family: var(--font-mono), ui-monospace, monospace;
}
</style>
