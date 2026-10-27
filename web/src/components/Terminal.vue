<script setup lang="ts">
// 终端 pane：xterm 实例与渲染接线 + 模板。连接生命周期、搜索、剪贴板、触屏滚动、
// OSC/链接已拆到 composables / lib（2026-10-26 治理，原单文件 2000 行）：
//   useTermSocket        建连/重连/detach/心跳/stdin 闸门/回填锚点/后端选路
//   useTermSearch        搜索浮层状态与命中跳转
//   useTermClipboard     文本/图片粘贴、剪贴板桥、兜底输入框
//   useTermTouchScroll   触屏滚动 + 惯性 + 备用屏滚轮转换
//   useTermLinks         OSC（标题/cwd/深链/52）与 Ctrl+点击路径链接
//   lib/termScreen       屏幕快照与 history-delta 回填（纯函数）
//   lib/termPaths        路径 token 识别（纯函数）
//   lib/termScrollRegion CSI S 滚动区修正
// 本文件只保留：xterm 创建/addon/键盘拦截/尺寸自适应/焦点与手机工具条接线。
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-vue-next'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { HOST_ID, sshGroupId, serviceFileId } from '@/lib/api'
import { RESTORED_TERM_IDS } from '@/lib/termlayout'
import { isCoarse, isPhone } from '@/composables/useDevice'
import { KEY_POOL, getQuickCmd } from '@/lib/termToolbar'
import { usePhoneToolbar } from '@/composables/usePhoneToolbar'
import { useTermSocket } from '@/composables/useTermSocket'
import { useTermSearch } from '@/composables/useTermSearch'
import { useTermClipboard } from '@/composables/useTermClipboard'
import { useTermTouchScroll } from '@/composables/useTermTouchScroll'
import { useTermLinks } from '@/composables/useTermLinks'
import { screenHash as screenHashOf } from '@/lib/termScreen'
import { registerScrollRegionHandler, type TerminalViewportHost } from '@/lib/termScrollRegion'
import QuickCmdsSheet from '@/components/QuickCmdsSheet.vue'
import { openToolbarSettings } from '@/lib/termToolbarNav'

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
    // 显式后端：新建终端组时菜单里二选一给定就固定；undefined = 服务端 mux.backend
    // （深链/恢复会话等未显式选择路径）。没有 auto。
    backend?: 'tmux' | 'msmux'
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
  // pane 获得焦点（xterm onFocus）：ContainerList 拿去让文件面板跟随最后聚焦的 pane。
  // 程序性恢复聚焦（refit 的 term.focus()）不上抛——见下方 suppressFocusEmit。
  (e: 'focus'): void
  // 终端输入了回车（onData 含 \r）：文件面板借此做即时的 cwd 跟随检查，消除 cd 后
  // 等轮询的体感延迟。
  (e: 'enter'): void
  // shell 集成上报 cwd（OSC 7，zsh precmd 发射）：cd 生效即到达，零轮询零请求的
  // 事件流。老容器/SSH/宿主无种子不上报，由 FilePanel 的 1s 轮询兜底。
  (e: 'cwd', path: string): void
  // msmux 上报前台进程名：图片粘贴桥用它绕开 tmux 专属的 REST fg 探测。
  (e: 'foreground', command: string): void
  // 收到首帧终端输出（二进制帧）：父组件据此注入首条命令/提示词。不用 onopen——
  // 那时后端 tmux 可能还没 attach 完，直接写 PTY 有概率丢输入。
  (e: 'ready'): void
  // 实际生效的终端后端（在线探测 + attach 完成）：pane 头部据此显示后端徽标。
  // msmux 是默认静默选路的，不显式上抛用户永远无从知道当前走的哪条。
  (e: 'backend', backend: 'tmux' | 'msmux'): void
}>()

// —— 终端实例与布局（所有 composable 只拿 getter，setup 期不读取）——
const el = ref<HTMLDivElement | null>(null)
// 根容器（带键盘占位 padding 的那层）：软键盘自适应要量它底边到布局视口底的距离，
// 扣掉布局自带的底部留白（移动端底部 tab 的 pb），见 usePhoneToolbar 的 setupViewportWatch。
const rootEl = ref<HTMLDivElement | null>(null)
let term: XTerm | null = null
let fit: FitAddon | null = null
let searchAddon: SearchAddon | null = null
let webglAddon: WebglAddon | null = null
let resizeObs: ResizeObserver | null = null
let rafId = 0
// PTY resize 去抖（见 term.onResize 处的注释）
let rzTimer = 0
let rzPending: { cols: number; rows: number } | null = null
let rzLast = ''
// 程序性聚焦抑制标志：refit 的 term.focus() 是「切 tab 恢复/窗口 resize」的附带动作，
// 不代表用户把焦点落在哪个 pane——DOM focus 事件在 focus() 调用内同步派发，同步开关
// 即可拦住。分屏新 pane / 点击 pane / 重连按钮的聚焦是真实落焦，照常上抛。
let suppressFocusEmit = false
const restoredTermIds = inject(RESTORED_TERM_IDS) ?? new Set<string>()

// —— 连接（WS 生命周期全部归属 useTermSocket）——
const sock = useTermSocket({
  props,
  events: {
    backend: (b) => emit('backend', b),
    title: (t) => emit('title', t),
    cwd: (p) => emit('cwd', p),
    foreground: (c) => emit('foreground', c),
    ready: () => emit('ready'),
  },
  term: () => term,
  restoredTermIds,
})
const { connState, sendStdin, sendResize, detachWs, recoverOnReturn } = sock

// 重连 = 重建 WS（termId 不变 -> 回到同一会话）。触摸设备不程序性聚焦（弹系统键盘）。
function reconnect(quiet = false) {
  sock.reconnect(quiet)
  if (!isCoarse.value) term?.focus()
}

// —— 搜索（浮层状态与命中跳转）——
const searchUi = useTermSearch({ addon: () => searchAddon, term: () => term })
const {
  searchVisible,
  searchQuery,
  searchInput,
  searchInputWidth,
  searchResultIndex,
  searchResultCount,
  searchCaseSensitive,
  searchRegex,
  searchWholeWord,
  runSearch,
  openSearch,
  closeSearch,
  setResults: setSearchResults,
  toggleCaseSensitive,
  toggleWholeWord,
  toggleRegex,
} = searchUi

// —— 直发 stdin（与 onData 同通道）：工具条按键/粘贴/滚轮共用 ——
function sendRaw(s: string) {
  sendStdin(s)
}

// —— 剪贴板（文本/图片/桥/兜底弹框）——
const clipboard = useTermClipboard({
  term: () => term,
  connected: sock.isOpen,
  send: sendRaw,
  // 图片落盘目标（四足文件端点哨兵）：宿主用 HOST_ID、SSH/服务加前缀、容器用 id。
  fileTargetId: () => fileTargetId.value,
  termId: () => props.termId,
  backend: sock.backend,
  foreground: sock.foreground,
  // 剪贴板桥只对容器终端成立：宿主/服务/SSH 没有 xclip shim 种子。
  bridgeContainerId: () =>
    props.host || props.ssh || props.service || !props.id ? undefined : props.id,
})
const {
  pasteFallback,
  pasteText,
  fallbackTa,
  pasteClipboard,
  copyText,
  copySelection,
  onTermPaste,
  onContextMenu,
  toolPaste,
  toolPasteConfirm,
  onFallbackPaste,
  onFallbackInput,
} = clipboard

// 图片粘贴落盘目标：文件端点四侧（容器/宿主/服务/SSH）同形，按哨兵分发。
const fileTargetId = computed(() =>
  props.host
    ? HOST_ID
    : props.ssh
      ? sshGroupId(props.ssh)
      : props.service
        ? serviceFileId(props.service)
        : props.id ?? '',
)

// —— OSC 集成与路径链接（Ctrl+点击打开）——
const links = useTermLinks({
  term: () => term,
  events: {
    title: (t) => emit('title', t),
    cwd: (p) => emit('cwd', p),
    oscOpen: (p) => emit('osc-open', p),
    linkOpen: (p, line, col) => emit('link-open', p, line, col),
  },
  copy: (text) => void copyText(text),
})

// —— 触屏滚动 ——
const touchScroll = useTermTouchScroll({ root: () => el.value, term: () => term, send: sendRaw })

// 点 ✕ 关闭时由父组件调用。真杀会话由父组件经 HTTP 端点（killTermSessionByTerm）完成——
// 非激活 tab 的 socket 已经 detach，靠 kill 帧会静默失效。这里只断自己的 socket（socket
// 存在时顺手补一发 kill 墓碑，覆盖 attach 飞行中 HTTP kill 先到的竞态）。
// **不在 onBeforeUnmount 里发**：刷新页面同样触发 unmount，那时杀掉会话会破坏刷新保留。
function kill() {
  sock.killSocket()
}

// 视口快照（「无输出提醒」的内容基线）——实现见 lib/termScreen。
function screenHash(): string | undefined {
  return screenHashOf(term)
}

// 程序化输入出口（Claude 终端对话框用）：与键盘输入同通道，调用方负责带回车。
function sendInput(s: string) {
  sendRaw(s)
}

// —— 字号：随容器宽度自适应（窄屏不溢出、大屏不显小）——
const FONT_FAMILY =
  '"Cascadia Code Variable", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, ' +
  '"Noto Sans Mono CJK SC", "Noto Sans Mono CJK JP", "Microsoft YaHei Mono", "PingFang SC", ' +
  'monospace, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'
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
      const prevCols = term?.cols ?? 0
      const prevRows = term?.rows ?? 0
      fit?.fit()
      // 键盘会话里的网格变化（布局视口模式是浏览器先缩、我们再让位）统一盖遮罩：
      // 这一拍 xterm reflow + 后端 exec.resize + TUI 整帧重绘都在里面。
      if (term && (term.cols !== prevCols || term.rows !== prevRows)) tb.noteGridChange()
      // 强制重算 xterm 内部滚动区（切回 tab 后「滚动不到最下面」的修复）。
      // xterm 5.5 的 Viewport._innerRefresh 直接读 viewport 的 offsetHeight，而
      // display:none 期间该值是 0——隐藏 tab 收到会推进外层 buffer 的输出（首载
      // 恢复多组 tab 时的历史回填、断线时的 ">> 已断开" writeln 等）时滚动区高度
      // 被算短整整一个视口，最底一行屏永远够不着；且 tmux 原地重绘不滚外层 buffer、
      // 尺寸也没变，syncScrollArea 之后不再被调用，错误一直留到刷新页面。fit 对
      // 「尺寸没变」是纯 no-op，救不了；这里在可见路径上强制 immediate 重算一次，
      // 健康态下是幂等写、零副作用。
      const vp = (term as unknown as TerminalViewportHost)._core?.viewport
      vp?.syncScrollArea?.(true)
      // 粘贴兜底对话框打开期间不抢焦点：term.focus() 会把光标拉回终端，
      // 用户正要在兜底 textarea 里长按/Ctrl+V 粘贴。
      // 触摸设备恒不程序性聚焦：切 tab / resize 的自动 focus 会直接弹系统键盘，
      // 键盘交给用户点终端区域时 xterm 自己的落焦（那是显式手势）。
      if (!pasteFallback.value && !isCoarse.value) {
        suppressFocusEmit = true
        try {
          term?.focus()
        } finally {
          suppressFocusEmit = false
        }
      }
    } catch {
      /* noop */
    }
  })
}

// 切到本 tab：等 display 生效后重算尺寸并聚焦；非激活期间 WS 已 detach（懒挂载，见
// detachWs），这里重连，resume=1 增量回填补上断开窗口的输出（buffer 零重复）。
watch(
  () => props.active,
  (a) => {
    if (a) {
      void nextTick(() => {
        // 等 display 生效后先同步 fit 拿真实 cols/rows 再连——恢复时非激活组是
        // display:none 挂载、term 停在 80x24 默认值，URL 带垃圾值会让后端先缩后撑
        // （shrink-then-grow，见 onMounted 同步 fit 注释）；refit 本体推 rAF 异步，
        // 这里不能只靠它。
        try {
          if (el.value?.clientWidth) fit?.fit()
        } catch {
          /* noop */
        }
        sock.ensureConnected()
        refit()
      })
    } else {
      detachWs()
    }
  },
)

// 真正刷新：本地 buffer 里的行一旦被 reflow/宽字符错位写坏，repaint 只会把坏内容再画一遍。
// 清 buffer 后按 resume=0 重连，服务端全量回填 + 重画当前屏，等价于在终端里 detach/attach
// 一次。代价是回到最新输出、丢弃本地多出的历史。
function refreshTerminal() {
  const currentTerm = term
  if (!currentTerm) return
  // 顺带清一次字形图集，避免 WebGL 图集损坏在重建后继续存在。
  try {
    ;(currentTerm as unknown as TerminalViewportHost)._core?.viewport?.syncScrollArea?.(true)
    webglAddon?.clearTextureAtlas()
  } catch {
    /* 渲染器重建中/上下文丢失时忽略 */
  }
  currentTerm.reset()
  sock.refresh()
  if (!isCoarse.value) {
    suppressFocusEmit = true
    try {
      currentTerm.focus()
    } finally {
      suppressFocusEmit = false
    }
  }
}

// 选区状态（候选池「复制」按钮的禁用态用）：term 实例非响应式，选区变化时同步到 ref。
// onSelectionChange 覆盖拖选/清选；工具条渲染期间手动同步一次。
const termHasSel = ref(false)
function syncSel() {
  termHasSel.value = !!term?.hasSelection()
}
// 工具条滚动只动本地 xterm scrollback，不向 PTY 发 PageUp/PageDown：
// 这样翻历史时不会影响正在运行的 TUI/交互程序，也不会被识别成按键。
function toolScroll(pages: number) {
  term?.scrollPages(pages)
}
function toolScrollEnd(top: boolean) {
  if (top) term?.scrollToTop()
  else term?.scrollToBottom()
}

// —— 手机软键盘 + 触屏工具条（usePhoneToolbar 整体归属，边界规则见其头注）——
// 焦点闸 / 键盘让位（kbInset/kbMask）/ 粘滞修饰 / 分页 / 长按连发 / 设置入口全在 composable；
// 这里只注入终端本体能力（发键/滚动/粘贴/复制/刷新/字号）。按键与指令的配置统一在
// 全屏设置页 TerminalToolbarPage（路由 terminal-toolbar），工具条不再有文本短语按钮。
const tb = usePhoneToolbar({
  rootEl,
  el,
  sendRaw,
  emitEnter: () => emit('enter'),
  toolScroll,
  toolScrollEnd,
  toolPaste,
  copySelection,
  refreshTerminal,
  stepFontSize,
})
const {
  termFocused,
  kbRaw,
  kbInset,
  kbMask,
  kbToolbarTop,
  toolbarEl,
  ctrlSticky,
  altSticky,
  sendToolSeq,
  runKeyBtn,
  tbDown,
  stopRepeat,
  toolPages,
  tbPage,
  cmdsOpen,
  openCmdsConfig,
  runQuickCmd,
  runCmdBtn,
  recentStrip,
  hasLastCmd,
  onCmdBtnDown,
  onCmdBtnUp,
  onCmdBtnClick,
  tbTouchStart,
  tbTouchEnd,
} = tb
// 固定到工具条的指令按钮：label 随指令编辑实时更新（id 稳定）
function cmdLabel(id: string) {
  return getQuickCmd(id)?.label ?? ''
}

// 字体探测串：终端会用到的 Cascadia 各分片都要触发加载。load() 不带 text 时只拉 latin
// 分片（默认探测文本是 ASCII）；盲文（▐▛█▘▝）、框线（╭─╮│）、箭头等在独立分片里，未就绪时
// WebGL 图集按 fallback 字体栅格化这些字形——宽度错、布局乱，且图集缓存不自动失效。
// 宿主终端连接即时（无 docker exec 延迟兜时间），竞态窗口比容器终端宽得多（实测踩过：
// claude 欢迎框半屏 + 字形错位）。
const FONT_PROBE = 'W█▘▝▐▛▜▌╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝●✢❯⏵⎿→←…'

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
    allowProposedApi: true,
    fontFamily: FONT_FAMILY,
    fontSize: computeFontSize(),
    cursorBlink: true,
    // ⚠️ 不开 smoothScrollDuration：它的动画每次 scrollLines 都从当前显示位置重置进度重跑
    // （origin = viewportElement.scrollTop），触摸连发调用下位置逐步落后手指、停手才补跳
    // ——快滑呈「一小块一小块」。行步进的平滑交给 useTermTouchScroll 自己的惯性 glide。
    scrollback: 10000, // 回滚行数，与 VSCode 集成终端默认一致（xterm 默认仅 1000）
    theme: { background: '#000000' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  searchAddon = new SearchAddon({ highlightLimit: 1000 })
  searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
    setSearchResults(resultIndex, resultCount)
  })
  term.loadAddon(searchAddon)
  term.loadAddon(new WebLinksAddon())
  term.open(el.value)
  registerScrollRegionHandler(term, () => !!webglAddon)
  links.register()
  // 键盘复制/粘贴拦截。返回 false=吞掉（不发 onData）、true=透传给终端。
  //   - Ctrl+Shift+C：复制选中（无选区也不发 ^C，纯复制键不应中断当前命令）。
  //   - Ctrl+V / Ctrl+Shift+V：粘贴（与桌面终端习惯一致；吞掉 ^V，牺牲 shell 的
  //     quoted-insert/literal-next，web 终端场景粘贴远比它常用）。
  //   - Ctrl+C：有选区时复制并清选区、吞掉；无选区时透传发 ^C=SIGINT（必须 return true）。
  //   其余按键一律透传，不影响 vim/less 等正常输入。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.code === 'KeyF' && e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      openSearch()
      return false
    }
    if (e.type === 'keydown' && e.key === 'Escape' && searchVisible.value) {
      e.preventDefault()
      closeSearch()
      return false
    }
    // 粘滞修饰（工具条 Ctrl/Alt 点亮态）+ 软键盘敲的单字符：在这里接管发送——Ctrl 字母
    // → 控制字符、Alt → ESC 前缀（sendToolSeq 消费粘滞），return false 不让 xterm 再
    // 处理一遍（否则字母会原样落屏）。带物理修饰的组合不拦，照常透传。
    // ⚠️ 这只拦得到真实 keydown——Android 软键盘（GBoard 等）敲字母走 composition/IME
    // 通道，keydown 只有 Unidentified，字符经 xterm 处理后从 onData 出来；那条路在
    // term.onData 里兜底消费粘滞（见下），keydown 拦走的不会进 onData，两边不双发。
    if (
      e.type === 'keydown' && (ctrlSticky.value || altSticky.value) &&
      e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
    ) {
      e.preventDefault()
      sendToolSeq(e.key)
      return false
    }
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
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches ?? false
  const fractionalDpr = window.devicePixelRatio % 1 !== 0
  if (!coarsePointer && !fractionalDpr) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webglAddon = null
        webgl.dispose()
        term?.refresh(0, term.rows - 1)
        refit()
      })
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

  // 懒挂载：非激活 tab（会话恢复时 display:none 挂载）不连，等切到该 tab 时由 active
  // watcher 重连——那时才同步 fit + 拿真实尺寸。
  if (props.active) void sock.connect()

  term.onData((data) => {
    // 回车即提交命令：上抛给文件面板做即时的 cwd 跟随检查（cd 提交后壳立即改目录，
    // 250ms 后查基本必中）。粘贴多行也含 \r，多抛几次无妨（跟随端去重）。
    // 粘滞修饰兜底（composition 路径见 attachCustomKeyEventHandler 注释）：keydown 拦截
    // return false 后 xterm 不再处理、不会走到这里，所以粘滞态还亮着就说明这次输入绕过
    // 了 keydown——在此消费并改写（Ctrl 逐字符 ctrlify，编码不了的保持原样；Alt 恒 ESC 前缀）。
    // ESC 开头的序列（1004 焦点上报 \x1b[I、鼠标上报、括号粘贴）不是「待修饰的按键」，
    // 不许碰——否则 ctrlify 会把 \x1b[I 改成 \x1b[\t 且白白消费掉粘滞态（vim/claude 开
    // 焦点上报时点 Ctrl 再落焦就是这条雷）。
    let out = data
    if ((ctrlSticky.value || altSticky.value) && !out.startsWith('\x1b')) {
      const withCtrl = ctrlSticky.value
      const withAlt = altSticky.value
      ctrlSticky.value = false
      altSticky.value = false
      if (withCtrl) out = Array.from(out, (ch) => tb.ctrlify(ch) ?? ch).join('')
      if (withAlt) out = '\x1b' + out
    }
    if (data.includes('\r')) emit('enter')
    sendStdin(out)
  })
  // PTY 尺寸去抖（140ms）：一次键盘开合/拖窗只发一次 exec.resize。中间尺寸不发——每次
  // 都是后端一次 SIGWINCH + 应用整帧重绘，是「切键盘时一直在闪」的主要来源。xterm 自己的
  // 网格仍逐帧跟盒子走（本地渲染，不发字节），视觉不断层。
  term.onResize(({ cols, rows }) => {
    rzPending = { cols, rows }
    if (rzTimer) clearTimeout(rzTimer)
    rzTimer = window.setTimeout(() => {
      rzTimer = 0
      const sz = rzPending
      rzPending = null
      if (!sz) return
      // 与上次已发的一致就不发：xterm 的 resize() 每调一次都 fire onResize（哪怕尺寸没变），
      // 键盘让位那一拍会连着 fit 两三次 —— 每次都送一次 exec.resize = SIGWINCH + 应用整帧
      // 重绘，白闪。
      const key = `${sz.cols}x${sz.rows}`
      if (key === rzLast) return
      rzLast = key
      sendResize(sz.cols, sz.rows)
      // 遮罩对齐真正的重绘：应用是在收到这次 resize 之后才整帧重画的（还隔着一次后端
      // 往返），只按盒子变化开窗必然先于重绘结束——「闪一下黑、黑退下去才重新布局」。
      tb.noteResizeSent()
    }, 140)
  })
  // 断线重连后要重新声明一次尺寸（期间可能被别的客户端改过）
  watch(connState, (s) => {
    if (s === 'lost') rzLast = ''
  })
  resizeObs = new ResizeObserver(() => refit())
  resizeObs.observe(el.value)
  // 选区同步：工具条「复制」按钮的禁用态跟随选区（仅手机工具条用，桌面无成本——一行回调）。
  term.onSelectionChange(syncSel)
  // 重绘落地信号：键盘遮罩开着时按「输出安静窗口」续时，黑层正好盖到最后一帧
  // （见 usePhoneToolbar 的 noteRepaint）。关着窗时是空转，一行判断。
  term.onWriteParsed(() => tb.noteRepaint())
  // 焦点落位上抛（文件面板跟随最后聚焦的 pane）。xterm 5 公开 API 无 onFocus 事件，
  // 借容器上的 focusin（xterm 隐藏 textarea 的 focus 冒泡上来，DOM focusin 在
  // focus() 调用内同步派发——suppressFocusEmit 开关拦得住）。此处的 mount focus 是
  // 「分屏新 pane / 新组首 pane 拿焦点」——真实落焦，不抑制；refit 的恢复性聚焦已抑制。
  // ⚠️ 首次分屏会把源 pane 的 Terminal 一并重建（根叶子升级 / 换向包裹，模板分支切换），
  // 重建实例的 mount focus 会多出一次老 pane 落焦上抛——ContainerList 的去重窗口按
  // 「分屏新 pane（cwdSourceOf 命中）优先」消解，见 onPaneFocus。
  el.value.addEventListener('focusin', onFocusIn)
  el.value.addEventListener('focusout', onFocusOut)
  // 图片粘贴入口（capture，原因见 onTermPaste 注释）。
  el.value.addEventListener('paste', onTermPaste, { capture: true })
  // 根容器空白区点击 = 聚焦终端。键盘让位（kbInset）会把 xterm 盒子缩到工具条上方，
  // 下面那片黑属于 root 而不属于 xterm——不收键盘的延迟窗口里点在那里没反应，用户会
  // 以为终端没响应。排除内容区/输入框/按钮（那些有自己的焦点语义）。
  rootEl.value?.addEventListener('pointerdown', onRootPointerDown)
  // 触摸设备不 mount 聚焦（弹系统键盘）：同 refit，键盘只由用户点终端触发。
  if (props.active && !isCoarse.value) term.focus()

  // 触屏滚动接管：所有 touch 设备（含平板/触屏本）都挂，鼠标环境零成本（listener 不会被触发）。
  if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) touchScroll.setup()
  document.addEventListener('visibilitychange', recoverOnReturn)
  window.addEventListener('focus', recoverOnReturn)
  window.addEventListener('online', recoverOnReturn)
  // 交互兜底重连：capture + passive，正常态进来第一个 if 就返回，零成本。
  // pointerdown 覆盖触摸与鼠标（触屏浏览器均派发），keydown 覆盖外接键盘。
  for (const t of ['pointerdown', 'keydown'] as const)
    document.addEventListener(t, recoverOnReturn, { capture: true, passive: true })
})

// 焦点落位双通道：上抛（文件面板跟随最后聚焦的 pane）+ 手机工具条焦点闸
// （termFocused 归属 usePhoneToolbar，tb 在下方声明——监听器挂载后才触发，无 TDZ 问题）。
const onFocusIn = () => {
  tb.onFocusedIn()
  if (!suppressFocusEmit) emit('focus')
}
const onFocusOut = () => {
  tb.onFocusedOut()
}
// 根容器空白处点击 = 交回终端焦点（触摸设备才有意义，桌面沿用原生行为）。
function onRootPointerDown(e: PointerEvent) {
  if (!isCoarse.value) return
  const t = e.target as HTMLElement | null
  if (!t || t.closest('.xterm, input, textarea, select, button, a, .search-shell')) return
  term?.focus()
}

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (rzTimer) clearTimeout(rzTimer)
  rzTimer = 0
  rzPending = null
  sock.dispose()
  document.removeEventListener('visibilitychange', recoverOnReturn)
  window.removeEventListener('focus', recoverOnReturn)
  window.removeEventListener('online', recoverOnReturn)
  for (const t of ['pointerdown', 'keydown'] as const)
    document.removeEventListener(t, recoverOnReturn, { capture: true })
  touchScroll.stop()
  resizeObs?.disconnect()
  el.value?.removeEventListener('focusin', onFocusIn)
  el.value?.removeEventListener('focusout', onFocusOut)
  rootEl.value?.removeEventListener('pointerdown', onRootPointerDown)
  el.value?.removeEventListener('paste', onTermPaste, { capture: true })
  // 链接 provider 与 tooltip 先于 WebGL addon 拆（同款防御性顺序：term.dispose 会连带
  // 清理，但显式 dispose 保证卸载路径上 tooltip 不残留 DOM）。
  links.dispose()
  // dispose 顺序：先 addon（WebGL renderer 挂在 term 上，得在 term 还活着时拆），
  // 再 term。反序会触发 term.dispose 内部访问已释放的 renderer -> TypeError。
  try {
    webglAddon?.dispose()
  } catch {
    /* context loss 后再 dispose 偶发报错，忽略 */
  }
  webglAddon = null
  try {
    searchAddon?.clearDecorations()
  } catch {
    /* 搜索插件已随终端清理则忽略 */
  }
  try {
    term?.dispose()
  } catch {
    /* noop */
  }
  term = null
  fit = null
  searchAddon = null
})

defineExpose({ kill, reconnect, refresh: refreshTerminal, screenHash, sendInput })
</script>

<template>
  <!-- bg-black + 内边距放外层：el 自身不带 padding，FitAddon 量到的 clientWidth/clientHeight 才是
       真实内容区，否则会多算 ~1 行、末行光标被底部边缘切掉一半。
       overscroll-none：iOS 聚焦终端时防页面整体上滚（终端是 body 内唯一内容，链上加锁即可）。
       手机软键盘弹起时**缩内层盒子**（kbInset 抬 bottom，ResizeObserver → refit → exec.resize）：
       rows 跟着可见高度走，备用屏 TUI 的窗口尺寸与可见区一致，光标行恒在屏内。 -->
  <!-- ⚠️ 根容器必须 flex-1 min-h-0 而不是 h-full：叶子是 flex-col（pane 头部 + 本体），
       h-full = 100% 叶子高，加头部后恒溢出一个头高——终端底部会盖住下方文件 tab 栏
       （旧换显布局溢的是黑底看不出来，编辑器+终端分栏后这 22px 正好压住 tab 栏右侧
       按钮）。flex-1 min-h-0 让本体只占头部之外的剩余空间。 -->
  <div ref="rootEl" class="relative min-h-0 flex-1 overflow-hidden bg-black px-2 py-1.5 overscroll-none">
    <!-- touch-none（touch-action: none）：触屏滚终端的唯一正解。xterm 的 touchmove 处理是 JS 驱动
         viewport.scrollTop，但只在回滚区边界才 preventDefault——滚动途中浏览器的原生平移同时在跑，
         而触点不在 .xterm-viewport 滚动层内，原生滚动链直接落到 document：上翻历史（手指下划）时
         document 顶部 overscroll 触发下拉刷新、手势被浏览器抢走。touch-action: none 让终端区域的手势
         完全交给 JS（xterm 自滚），浏览器不再启动原生平移/下拉刷新/双指缩放。中间层挂 overscroll-none
         挡不住这个——touch 侧的原生滚动链跳过 overflow:hidden 的祖先直达 document。 -->
    <div class="absolute inset-x-2 top-1.5" :style="{ bottom: `calc(0.375rem + ${kbInset}px)` }">
      <div ref="el" class="absolute inset-0 touch-none overflow-hidden" @contextmenu.prevent="onContextMenu" />
    </div>
    <!-- 键盘让位遮罩：盒子尺寸变化的那一下把 xterm reflow + TUI 整帧重绘盖住（kbMask
         由 usePhoneToolbar 按「尺寸变化 → exec.resize 发出 → 重绘输出停下」开窗）。
         只盖内容层，搜索框/兜底框/断线条都在更高 z 上照常可见。
         ⚠️ 亮起必须是**瞬时不透明**（duration-0），淡出才 150ms：两边同用 150ms 的话，
         盒子已经开始重排的头 150ms 只盖了几成黑，等于没盖住 —— 观感就是「闪一下，
         黑退掉了内容才跳」。 -->
    <div
      class="pointer-events-none absolute inset-0 z-[1] bg-black transition-opacity"
      :class="kbMask ? 'opacity-100 duration-0' : 'opacity-0 duration-150'"
    />
    <!-- 终端搜索：Ctrl+F 打开，Enter/Shift+Enter 跳转，Esc 返回终端。
         浮层用绝对定位，不参与 FitAddon 测量，避免改变终端网格尺寸。 -->
    <div class="search-shell" v-if="searchVisible">
      <div class="search-field">
        <Search class="size-3 shrink-0 text-zinc-500" />
        <input
          ref="searchInput"
          v-model="searchQuery"
          class="search-input"
          :style="{ width: searchInputWidth }"
          placeholder="搜索终端…"
          spellcheck="false"
          @input="runSearch('next')"
          @keydown.enter.prevent="runSearch($event.shiftKey ? 'previous' : 'next')"
          @keydown.esc.stop.prevent="closeSearch"
        />
      </div>
      <div class="search-filters">
        <button type="button" class="search-toggle" :class="{ 'search-on': searchCaseSensitive }" title="区分大小写" :aria-pressed="searchCaseSensitive" @click="toggleCaseSensitive">
          <CaseSensitive class="size-3" />
        </button>
        <button type="button" class="search-toggle" :class="{ 'search-on': searchWholeWord }" title="全字匹配" :aria-pressed="searchWholeWord" @click="toggleWholeWord">
          <WholeWord class="size-3" />
        </button>
        <button type="button" class="search-toggle" :class="{ 'search-on': searchRegex }" title="正则匹配" :aria-pressed="searchRegex" @click="toggleRegex">
          <Regex class="size-3" />
        </button>
      </div>
      <div class="search-meta">
        <span
          class="search-count shrink-0"
          :class="searchResultCount || searchQuery === '' ? 'text-zinc-500' : 'text-amber-400'"
        >
          {{ searchResultCount ? `${searchResultIndex + 1}/${searchResultCount}` : '无匹配' }}
        </span>
        <button type="button" class="search-btn" title="上一个匹配（Shift+Enter）" @click="runSearch('previous')">
          <ChevronUp class="size-3" />
        </button>
        <button type="button" class="search-btn" title="下一个匹配（Enter）" @click="runSearch('next')">
          <ChevronDown class="size-3" />
        </button>
        <button type="button" class="search-btn" title="关闭（Esc）" @click="closeSearch">
          <X class="size-3" />
        </button>
      </div>
    </div>
    <!-- 触屏工具条（手机 only，agent 遥控布局）。
         按钮全部 @pointerdown.prevent：点按钮不抢终端 textarea 焦点（否则软键盘收起→refit 的
         term.focus() 又抢回 = 键盘闪一下，且正在输入的 composition 被中断吞字——粘滞 Ctrl 后
         敲字母不响应就是它）。prevent 不影响 click 派发，各按钮 @click 照常工作。
         按钮 = 按键 + 固定到工具条的指令（完整指令列表仍在「指令」面板）；配置在全屏
         TerminalToolbarPage（存 lib/termToolbar.ts 模块级状态 + localStorage），7 列 grid
         自然换行（对齐 Termux 一行 7 键）——「哪个键高频」由使用者编排，代码不硬编码。预置布局 =
         Termux 默认 extra-keys 两行（ESC / - HOME ↑ END 上页 / Tab Ctrl Alt ← ↓ → 下页）+ ⏎ ⇥。
         Ctrl/Alt 是粘滞修饰（点亮→下一个键带修饰发出→用掉即灭，可叠加 C-M-x；软键盘单字符在
         attachCustomKeyEventHandler 接管）。Esc 中断（红色加重）/ ↑↓ 菜单与输入历史（长按连发）/
         「指令」面板（命名命令列表，点条目 = 整条命令+回车，面板只负责运行；增删改在设置页的
         指令分区，行尾图钉可把常用指令固定到工具条 = 一键发送）。工具条上方还有一条 28px 的
         「最近」条：运行过且未固定的指令自动出现，点一下直发；没有可显示项时整条不占高。
         长按「指令」= 重发上一条（带 ↻ 角标提示）。滑屏滚动的是本地回滚缓冲，↑↓ 是发给程序的输入
         （agent 菜单/全屏 TUI 唯一导航方式）——两者语义不同。工具条固定 2 行 × 7 列为
         一页，键多时整个卡片横向轻扫翻页（页点指示器标位），⋯ 设置入口是列表末项
         参与分页（点开全屏 TerminalToolbarPage；设置菜单里也有同一个稳定入口）。
         桌面不渲染。工具条是「键盘态 + 本实例持焦」双闸覆盖层——始终渲染以便
         测量高度，但平时不可见；定位用 kbToolbarTop 贴键盘上沿，终端自身已按「让位量 =
         键盘侵入 + 工具条高」缩过盒子，所以工具条落位后不会压住内容。焦点闸必须：终端组件按组/分屏
         多实例常驻，kbRaw（window.visualViewport）是全局信号、所有实例同时为真，
         而工具条 Teleport 到 body 不受源组件 v-show 约束——不按焦点收敛的话多实例
         工具条会全部显形精确叠放，tap 落到 DOM 末尾实例（不一定是眼前终端），其 WS
         已 detach，输入进 pendingInput 无声黑洞（表现：软键盘字母正常、快捷键全灭）。
         显隐/键盘态/粘滞/分页逻辑全部归属 composables/usePhoneToolbar.ts（通用规则见
         docs/architecture/web.md「Teleport 覆盖层归属」）。
         -->
    <Teleport to="body">
      <div
        v-if="isPhone"
        ref="toolbarEl"
        class="fixed inset-x-2 z-[80] select-none overflow-hidden border-t border-zinc-800 bg-black pt-1 transition-opacity md:hidden"
        :class="kbRaw && termFocused ? 'opacity-100' : 'pointer-events-none invisible opacity-0'"
        :style="kbRaw && termFocused ? { top: `${kbToolbarTop}px` } : undefined"
        @touchstart="tbTouchStart"
        @touchend="tbTouchEnd"
      >
      <!-- 最近指令条：运行过的指令（未固定的）自动出现，点一下即发；固定项已在主键区，不重复。
           只有 28px 高；没有可显示项时整条不渲染，键盘态不多占高度。 -->
      <div
        v-if="recentStrip.length"
        class="mb-1 flex touch-pan-x items-center gap-1 overflow-x-auto scroll-thin"
        @touchstart.stop
        @touchend.stop
      >
        <span class="shrink-0 pl-1 text-[10px] text-zinc-500">最近</span>
        <button
          v-for="c in recentStrip"
          :key="c.id"
          type="button"
          class="tb-cmd"
          :title="`发送指令「${c.label}」并回车`"
          @pointerdown.prevent
          @click="runCmdBtn(c.id)"
        >{{ c.label }}</button>
        <button
          type="button"
          class="tb-cmd"
          title="全部指令"
          @pointerdown.prevent
          @click="cmdsOpen = true"
        >更多</button>
      </div>
      <!-- 分页轨道：每页固定 2 行 × 7 列，横向轻扫翻页（手势见脚本 tbTouchStart/End） -->
      <div
        class="flex transition-transform duration-200 ease-out"
        :style="{ width: `${toolPages.length * 100}%`, transform: `translateX(-${(tbPage * 100) / toolPages.length}%)` }"
      >
        <div v-for="(pg, pi) in toolPages" :key="pi" class="grid shrink-0 grid-cols-7 gap-1" :style="{ width: `${100 / toolPages.length}%` }">
          <template v-for="b in pg" :key="b.t === 'key' ? `k:${b.id}` : b.t === 'custom' ? `c:${b.label}` : b.t === 'cmd' ? `cmd:${b.id}` : b.t === 'cmds' ? 'cmds' : 'settings'">
            <button
              v-if="b.t === 'key'"
              type="button" class="tb" :class="{ 'tb-esc': b.id === 'esc', 'tb-on': (b.id === 'ctrl' && ctrlSticky) || (b.id === 'alt' && altSticky) }"
              :disabled="b.id === 'copy' && !termHasSel"
              :title="KEY_POOL[b.id]?.title"
              @pointerdown.prevent="tbDown(b)" @pointerup="stopRepeat" @pointercancel="stopRepeat" @pointerleave="stopRepeat" @contextmenu.prevent
              @click="runKeyBtn(b.id)"
            >{{ KEY_POOL[b.id]?.label }}</button>
            <button
              v-else-if="b.t === 'custom'"
              type="button" class="tb overflow-hidden text-ellipsis whitespace-nowrap" :title="`发送自定义按键「${b.label}」`"
              @pointerdown.prevent @click="sendToolSeq(b.seq)"
            >{{ b.label }}</button>
            <button
              v-else-if="b.t === 'cmd'"
              type="button" class="tb overflow-hidden text-ellipsis whitespace-nowrap" :title="`发送指令「${cmdLabel(b.id)}」并回车`"
              @pointerdown.prevent @click="runCmdBtn(b.id)"
            >{{ cmdLabel(b.id) }}</button>
            <button
              v-else-if="b.t === 'cmds'"
              type="button" class="tb"
              :title="hasLastCmd ? '点开指令列表；长按重发上一条' : '快捷指令：点开列表，一键发送整条命令并回车'"
              @pointerdown.prevent="onCmdBtnDown" @pointerup="onCmdBtnUp" @pointercancel="onCmdBtnUp" @pointerleave="onCmdBtnUp"
              @click="onCmdBtnClick"
            >指令<span v-if="hasLastCmd" class="ml-0.5 text-[9px] text-zinc-500">↻</span></button>
            <button
              v-else
              type="button" class="tb" title="终端工具条设置（全屏页）" @pointerdown.prevent @click="openToolbarSettings('keys')"
            >⋯</button>
          </template>
        </div>
      </div>
      <!-- 页点指示器（仅多页时出现） -->
      <div v-if="toolPages.length > 1" class="mt-1 flex justify-center gap-1.5 pb-0.5">
        <span v-for="i in toolPages.length" :key="i" class="size-1.5 rounded-full transition-colors" :class="i - 1 === tbPage ? 'bg-zinc-400' : 'bg-zinc-700'" />
      </div>
      </div>
    </Teleport>
    <!-- 快捷指令面板只负责运行：点条目 = 整条命令 + 回车 + cwd 跟随并收起；
         配置跳全屏「终端工具条」页的指令分区（lib/termToolbarNav.ts），不再就地弹管理表单。
         数据 localStorage（lib/termToolbar.ts），多终端实例共享同一份。 -->
    <QuickCmdsSheet v-model:open="cmdsOpen" @run="runQuickCmd" @config="openCmdsConfig" />
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
      @click="reconnect(true)"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-black" />
      连接已断开 · 点击重连
    </button>
  </div>
</template>

<style>
/* 触屏工具条按钮：紧凑但命中区 ≥40px（高度 h-9），等宽字排布稳定。
   user-select/callout：长按连发期间不能弹出系统选择/放大镜；touch-action:manipulation
   消双击缩放延迟（主行固定不滚，无横滚冲突）。 */
.tb {
  height: 2.25rem;
  min-width: 2.5rem;
  padding: 0 0.5rem;
  flex-shrink: 0;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
  font-family: var(--font-mono), ui-monospace, monospace;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: manipulation;
}
/* Esc = agent 中断键，视觉加重（红色系），主行 flex-1 拉出大命中面。 */
.tb-esc {
  border-color: #7f1d1d;
  background: #2a1215;
  color: #fca5a5;
  font-weight: 600;
}
.tb-esc:active {
  background: #451a1d;
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
/* 「最近指令」条 chip：比主键矮一档（28px），一行放 3~4 条 + 更多。
   全局类（不 scoped）：设置页的布局预览复用同一套尺寸/配色，避免预览和实际漂移。 */
.tb-cmd {
  height: 1.75rem;
  min-width: 2.75rem;
  max-width: 8rem;
  padding: 0 0.5rem;
  flex-shrink: 0;
  overflow: hidden;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 11px;
  font-family: var(--font-mono), ui-monospace, monospace;
  white-space: nowrap;
  text-overflow: ellipsis;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.tb-cmd:active {
  background: #27272a;
}
/* 终端搜索：单行控件。渐变和内高光让浮层在纯黑终端上有清晰的边界层次。 */
.search-shell {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 30;
  width: fit-content;
  max-width: min(19rem, calc(100% - 1rem));
  min-width: min(12rem, calc(100% - 1rem));
  display: grid;
  grid-template-columns: auto auto auto auto;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid rgba(63, 63, 70, 0.65);
  border-radius: 0;
  background: linear-gradient(180deg, rgba(24, 24, 27, 0.96), rgba(9, 9, 11, 0.96));
  box-shadow: 0 16px 36px -18px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(18px) saturate(1.1);
}
.search-field {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
  height: 1.5rem;
  padding: 0 0.25rem 0 0.375rem;
  border-radius: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.38);
  background: transparent;
  transition: border-color 140ms ease;
}
.search-field:focus-within {
  border-bottom-color: #ffffff;
}
.search-input {
  min-width: 0;
  max-width: 100%;
  height: 100%;
  border: 0;
  outline: none;
  background: transparent;
  color: #f4f4f5;
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: 11px;
}
.search-input::placeholder {
  color: #52525b;
}
.search-meta {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  height: 1.5rem;
}
.search-count {
  min-width: 2rem;
  text-align: center;
  font-size: 9px;
  font-weight: 500;
}
.search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 0.1875rem;
  color: #a1a1aa;
  transition: background-color 120ms ease, color 120ms ease;
}
.search-btn:hover {
  background-color: #27272a;
  color: #e4e4e7;
}
.search-filters {
  display: inline-flex;
  flex-shrink: 0;
  gap: 0.125rem;
  padding: 0.125rem;
  border-radius: 0;
  background: rgba(9, 9, 11, 0.72);
}
.search-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 0.1875rem;
  color: #71717a;
  transition: background-color 120ms ease, color 120ms ease;
}
.search-toggle:hover {
  background-color: #27272a;
  color: #e4e4e7;
}
.search-on {
  background-color: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}
.search-on:hover {
  background-color: rgba(245, 158, 11, 0.2);
  color: #fcd34d;
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
