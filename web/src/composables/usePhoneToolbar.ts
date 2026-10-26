import { ref, computed, watch, onBeforeUnmount, nextTick, type Ref } from 'vue'
import { toolButtons, KEY_POOL, TB_PER_PAGE, type ToolBtn } from '@/lib/termToolbar'
import { isPhone } from '@/composables/useDevice'

// 手机软键盘适配 + 触屏工具条的唯一归属（从 Terminal.vue 整体抽出，2026-10-26）。
// 抽出动机：终端组件按组/分屏多实例常驻，而这里是「全局信号（visualViewport）×
// 每实例状态（kbOpen/kbShift/工具条）」的交界——叠放 bug（v0.10.5 修）的根子就是
// 这条边界散落在 2000 行组件里看不全。收进一个文件后，边界规则可以一句话说完：
//
//   全局信号只允许驱动「无归属争议」的布尔（kbOpen）；凡涉及位移/定位/交互的
//   派生计算与 UI 显示权，一律以「本实例持焦」为前提（termFocused 门控）。
//
// 归属判定 = 容器 focusin/focusout（后台实例 display:none 不可能聚焦，天然出局）。
// deps 是终端本体能力（发键/滚动/粘贴/刷新/字号），由 Terminal.vue 注入——
// 本文件不 import xterm、不碰 WS，保持纯 UI 逻辑可独立推理。

export interface PhoneToolbarDeps {
  /** 终端根元素（kbShift 位移作用对象 + 锚点计算），display:none 时 rect 为 0 */
  rootEl: Ref<HTMLElement | null>
  /** 终端容器元素（焦点监听挂点；xterm 隐藏 textarea 的 focus 事件从这里冒泡） */
  el: Ref<HTMLElement | null>
  /** 发 stdin（唯一出口，Terminal 的 sendRaw——含 pendingInput 闸门） */
  sendRaw: (s: string) => void
  /** 回车/短语后的 cwd 跟随（Terminal emit('enter')） */
  emitEnter: () => void
  /** 工具条滚动：只动本地 scrollback，不向 PTY 发字节 */
  toolScroll: (pages: number) => void
  toolScrollEnd: (top: boolean) => void
  /** 剪贴板粘贴（含被拒时的兜底弹框，Terminal 自持） */
  toolPaste: () => Promise<void> | void
  /** 复制当前选区并清选区 */
  copySelection: () => void
  refreshTerminal: () => void
  stepFontSize: (delta: number) => void
  /** xterm 隐藏 textarea 引用（锚点计算用；capture 阶段尚未聚焦，不能查 activeElement） */
  textarea: () => HTMLTextAreaElement | null
}

type TbItem = ToolBtn | { t: 'settings' } | { t: 'cmds' }

export function usePhoneToolbar(deps: PhoneToolbarDeps) {
  // —— 本实例是否持焦（工具条显隐第二把闸）——
  // focusin 置真；focusout 后下一拍核实——焦点可能在容器内子元素间移动（textarea ↔
  // 搜索框），真离开才算失焦。后台实例不可能收到 focusin，天然不显工具条。
  const termFocused = ref(false)
  const onFocusedIn = () => {
    termFocused.value = true
    // 夺焦时键盘多半已开着（vv 无新事件）→ kbShift 可能是失焦期间的陈值/0，
    // 立即按当前锚点重算一次，工具条与位移同步落位。
    if (kbOpen.value) syncShift()
  }
  const onFocusedOut = () => {
    setTimeout(() => {
      termFocused.value = !!deps.el.value?.contains(document.activeElement)
    })
  }

  // —— 软键盘纯 CSS 裁切（仅手机）——
  // 键盘弹起时不改终端盒子尺寸：xterm/PTY 的 cols/rows 保持不变，不触发 fit/resize。
  // 外层 root 固定并裁切，内层按 kbShift 整盒上移。pointerdown 记录触点对应的原始
  // 内容坐标；键盘出现后只抬到刚好让这个坐标保持在工具条上方。没有触点兜底时才按
  // 终端底部计算。cols/rows 不变，回滚位置不会被 resize/reflow 重置。
  const kbShift = ref(0)
  const kbOpen = ref(false)
  const kbToolbarTop = ref(0)
  const toolbarHeight = ref(0)
  const toolbarEl = ref<HTMLDivElement | null>(null)
  let focusAnchorY: number | null = null
  let toolbarResizeObs: ResizeObserver | null = null
  let vvCleanup: (() => void) | null = null
  function saveFocusAnchor(event: PointerEvent) {
    if (!isPhone.value) return
    const textarea = deps.textarea()
    const rect = textarea?.getBoundingClientRect()
    const focusY = rect && rect.height > 0 ? rect.top + rect.height / 2 : event.clientY
    focusAnchorY = focusY + kbShift.value
  }
  // 位移计算：只对持焦实例有意义（后台实例 root display:none，rect 全 0，算出来是垃圾）。
  function syncShift() {
    const vv = window.visualViewport
    if (!vv) return
    const root = deps.rootEl.value
    const layoutBottom = root ? root.getBoundingClientRect().bottom : 0
    const visualBottom = vv.offsetTop + vv.height
    const safeBottom = visualBottom - toolbarHeight.value - 14
    const contentBottom = layoutBottom - 6
    const anchorBottom = focusAnchorY ?? contentBottom
    kbToolbarTop.value = Math.max(0, visualBottom - toolbarHeight.value - 6)
    kbShift.value = Math.max(0, Math.round(anchorBottom - safeBottom))
  }
  function setupViewportWatch() {
    const vv = window.visualViewport
    if (!vv || vvCleanup) return
    const syncToolbarHeight = () => {
      toolbarHeight.value = toolbarEl.value?.offsetHeight ?? 0
    }
    syncToolbarHeight()
    if (toolbarEl.value) {
      toolbarResizeObs = new ResizeObserver(syncToolbarHeight)
      toolbarResizeObs.observe(toolbarEl.value)
    }
    const onVv = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      if (kb <= 120) {
        kbOpen.value = false
        kbToolbarTop.value = 0
        kbShift.value = 0 // 透值过滤地址栏小幅伸缩
        focusAnchorY = null
        return
      }
      // 键盘态全程跟随（kbOpen 供夺焦瞬间工具条即时正确）；位移只给持焦实例算。
      kbOpen.value = true
      if (termFocused.value) syncShift()
    }
    vv.addEventListener('resize', onVv)
    vv.addEventListener('scroll', onVv)
    vvCleanup = () => {
      vv.removeEventListener('resize', onVv)
      vv.removeEventListener('scroll', onVv)
      toolbarResizeObs?.disconnect()
      toolbarResizeObs = null
    }
  }
  // 设备形态翻转（桌面缩窄 <768 / 窗口还原）：此前只在挂载时按 isPhone 判一次，
  // 翻转过的实例永远没有键盘监听。flush post 保证翻转后 toolbarEl 已渲染可测量。
  watch(
    isPhone,
    (v) => {
      if (v) nextTick(setupViewportWatch)
      else {
        vvCleanup?.()
        vvCleanup = null
      }
    },
    { immediate: true },
  )

  // —— Alt / Ctrl 粘滞修饰（Termux extra-keys 同款交互）——
  // 点亮后下一个按键带修饰发出，用掉即灭；可叠加（Ctrl+Alt 都点亮再按字母 = C-M-x）。
  // Ctrl 的改写只对可编码形状生效（单字符 @A-Z[\]^_ → 控制字符、CSI 导航键 → ;5 修饰参数），
  // 改不动的原样发出；Alt 恒为 ESC 前缀。软键盘敲的单字符在 attachCustomKeyEventHandler
  // 里接管（Terminal.vue），工具条自身按键走 sendToolSeq / tbDown。
  const altSticky = ref(false)
  const ctrlSticky = ref(false)
  // Ctrl 修饰的序列改写：返回 null = 该形状没有 Ctrl 编码。
  function ctrlify(s: string): string | null {
    if (s.length === 1) {
      const code = s.toUpperCase().charCodeAt(0)
      if (code < 64 || code > 95) return null
      return String.fromCharCode(code & 0x1f)
    }
    const m = /^\x1b\[(\d*)([A-H~])$/.exec(s)
    if (m) return `\x1b[${m[1] || '1'};5${m[2]}`
    return null
  }
  // 工具条按键统一出口（seq 键 / 自定义键 / 粘滞后的单键）：消费粘滞态后发送。
  function sendToolSeq(seq: string) {
    if (ctrlSticky.value) {
      ctrlSticky.value = false
      seq = ctrlify(seq) ?? seq
    }
    if (altSticky.value) {
      altSticky.value = false
      seq = '\x1b' + seq
    }
    deps.sendRaw(seq)
  }
  // ⋯ 打开工具条设置弹窗（ToolbarSettingsDialog）：按钮编排收进独立区域。
  const settingsOpen = ref(false)
  // 「指令」打开快捷指令面板（QuickCmdsSheet）：点条目 = 发送整条命令并回车。
  const cmdsOpen = ref(false)
  function runQuickCmd(cmd: string) {
    deps.sendRaw(cmd + '\r')
    deps.emitEnter() // 短语多带命令语义，与工具条回车一致走 cwd 跟随
  }

  // 工具条方向键长按连发：pointerdown 即发一次，400ms 后起 80ms 间隔连发；抬起/取消/
  // 移出（touch 有隐式指针捕获，pointerup 恒能到达）停止。只用于 ↑↓←→ 这类可重复键。
  let repDelay = 0
  let repIv = 0
  function keyRepeat(ch: string) {
    deps.sendRaw(ch)
    stopRepeat()
    repDelay = window.setTimeout(() => {
      repIv = window.setInterval(() => deps.sendRaw(ch), 80)
    }, 400)
  }
  function stopRepeat() {
    if (repDelay) clearTimeout(repDelay)
    if (repIv) clearInterval(repIv)
    repDelay = 0
    repIv = 0
  }

  // 单个按钮的点击/按住分派：seq 直发；连发键走 pointerdown（click 忽略防双发）。
  function runKeyBtn(id: string) {
    const e = KEY_POOL[id]
    if (!e) return
    const a = e.act
    switch (a.kind) {
      case 'seq':
        sendToolSeq(a.seq)
        if (id === 'enter' && !ctrlSticky.value && !altSticky.value) deps.emitEnter() // 回车与短语一致走 cwd 跟随
        break
      case 'repeat':
        break // 长按连发在 tbDown 里处理
      case 'scroll':
        deps.toolScroll(a.pages)
        break
      case 'scrollEnd':
        deps.toolScrollEnd(a.top)
        break
      case 'refresh':
        deps.refreshTerminal()
        break
      case 'paste':
        void deps.toolPaste()
        break
      case 'copy':
        deps.copySelection()
        break
      case 'ctrl':
      case 'alt':
        break // 粘滞修饰在 tbDown（pointerdown）里切换——click 生成在某些浏览器不可靠
      case 'font':
        deps.stepFontSize(a.delta)
        break
    }
  }
  function tbDown(b: ToolBtn) {
    if (b.t !== 'key') return
    const a = KEY_POOL[b.id]?.act
    if (a?.kind === 'ctrl') {
      ctrlSticky.value = !ctrlSticky.value
      return
    }
    if (a?.kind === 'alt') {
      altSticky.value = !altSticky.value
      return
    }
    if (a?.kind === 'repeat') {
      if (ctrlSticky.value || altSticky.value) {
        sendToolSeq(a.seq) // 粘滞态：首键带修饰发出并消费粘滞（修饰组合没有连发需求）
        return
      }
      keyRepeat(a.seq)
    }
  }

  // —— 分页（固定 2 行 × 7 列）——
  // 两行是整体：键多于 14 个时整个卡片横向轻扫翻页（阈值 48px 且横向位移须大于纵向，
  // 不成手势就不拦截按钮点击），页面滑动有过渡动画；⋯ 设置入口作为列表最后一项参与
  // 分页，不再是常驻末格。页点指示器只在多于 1 页时出现。
  // ⋯ 设置与「指令」都是固定入口不进编排列表，恒跟在按钮末尾（⋯ 恒最后一项）。
  const toolItems = computed<TbItem[]>(() => [...toolButtons.value, { t: 'cmds' }, { t: 'settings' }])
  const toolPages = computed<TbItem[][]>(() => {
    const out: TbItem[][] = []
    for (let i = 0; i < toolItems.value.length; i += TB_PER_PAGE) out.push(toolItems.value.slice(i, i + TB_PER_PAGE))
    return out
  })
  const tbPage = ref(0)
  watch(
    () => toolPages.value.length,
    (n) => {
      if (tbPage.value > n - 1) tbPage.value = Math.max(0, n - 1)
    },
    { immediate: true },
  )
  let tbTouchX = 0
  let tbTouchY = 0
  let tbTouching = false
  function tbTouchStart(e: TouchEvent) {
    const t = e.touches[0]
    tbTouchX = t.clientX
    tbTouchY = t.clientY
    tbTouching = true
  }
  function tbTouchEnd(e: TouchEvent) {
    if (!tbTouching) return
    tbTouching = false
    const t = e.changedTouches[0]
    const dx = t.clientX - tbTouchX
    const dy = t.clientY - tbTouchY
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy)) return
    tbPage.value = Math.min(toolPages.value.length - 1, Math.max(0, tbPage.value + (dx < 0 ? 1 : -1)))
  }

  onBeforeUnmount(() => {
    stopRepeat() // 长按连发的定时器不随组件卸载自动消失
    vvCleanup?.()
    vvCleanup = null
  })

  return {
    // 焦点闸
    termFocused,
    onFocusedIn,
    onFocusedOut,
    // 键盘态
    kbOpen,
    kbShift,
    kbToolbarTop,
    toolbarEl,
    saveFocusAnchor,
    // 工具条
    ctrlSticky,
    altSticky,
    ctrlify,
    sendToolSeq,
    runKeyBtn,
    tbDown,
    stopRepeat,
    toolPages,
    tbPage,
    settingsOpen,
    cmdsOpen,
    runQuickCmd,
    tbTouchStart,
    tbTouchEnd,
  }
}
