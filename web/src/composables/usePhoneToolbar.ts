import { ref, computed, watch, onBeforeUnmount, nextTick, type Ref } from 'vue'
import {
  toolButtons,
  getQuickCmd,
  recentCmds,
  recentCmdIds,
  isCmdPinned,
  recordCmdUseByText,
  KEY_POOL,
  toolbarPages,
  type ToolbarItem,
  type ToolBtn,
} from '@/lib/termToolbar'
import { openToolbarSettings } from '@/lib/termToolbarNav'
import { isPhone } from '@/composables/useDevice'
import { useVirtualKeyboard } from '@/composables/useVirtualKeyboard'

// 手机软键盘适配 + 触屏工具条的唯一归属（从 Terminal.vue 整体抽出，2026-10-26）。
// 抽出动机：终端组件按组/分屏多实例常驻，而这里是「全局信号（visualViewport）×
// 每实例状态（键盘态/工具条）」的交界——叠放 bug（v0.10.5 修）的根子就是
// 这条边界散落在 2000 行组件里看不全。收进一个文件后，边界规则可以一句话说完：
//
//   全局信号只允许驱动「无归属争议」的布尔（kbOpen）；凡涉及尺寸/定位/交互的
//   派生计算与 UI 显示权，一律以「本实例持焦」为前提（termFocused 门控）。
//
// 键盘的时序/量化（什么时候算"开了"、收起延迟多久）是全局的，归
// composables/useVirtualKeyboard.ts；本文件只做「本实例要不要让位、让多少」。
//
// 归属判定 = 容器 focusin/focusout（后台实例 display:none 不可能聚焦，天然出局）。
// deps 是终端本体能力（发键/滚动/粘贴/刷新/字号），由 Terminal.vue 注入——
// 本文件不 import xterm、不碰 WS，保持纯 UI 逻辑可独立推理。

export interface PhoneToolbarDeps {
  /** 终端根元素（让位量测量对象），display:none 时 rect 为 0 */
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
}

export function usePhoneToolbar(deps: PhoneToolbarDeps) {
  // —— 本实例是否持焦（工具条显隐 + 让位归属的闸）——
  // focusin 置真；focusout 后下一拍核实——焦点可能在容器内子元素间移动（textarea ↔
  // 搜索框），真离开才算失焦。后台实例不可能收到 focusin，天然不显工具条、也不让位。
  const termFocused = ref(false)
  // 让位归属 + 粘滞：只在持焦时翻转（开→让位），失焦不立刻收回——键盘收起有
  // KB_CLOSE_DELAY 的窗口期，窗口内再点回来就不产生任何尺寸变化（A 的核心）。
  const kbShrink = ref(false)
  const onFocusedIn = () => {
    termFocused.value = true
  }
  const onFocusedOut = () => {
    setTimeout(() => {
      const active = document.activeElement
      termFocused.value = !!deps.el.value?.contains(active)
      // 焦点搬去了**别的终端 pane**（分屏）：立刻交还让位权，别让两份让位叠着算。
      // 其余失焦（点空白/切视图 = 键盘要收）保持粘滞——延迟窗口正是为这种情形留的。
      if (!termFocused.value && active instanceof HTMLElement && active.closest('.xterm')) kbShrink.value = false
    })
  }

  // —— 软键盘：真实让位（resize），不是整盒平移 ——
  // 键盘弹起时**缩终端盒子**：rows 跟着可见高度走，xterm fit → 后端 exec.resize →
  // 备用屏 TUI（claude/codex）拿到的窗口尺寸与可见区一致，光标行/输入框永远在屏内。
  // 此前是「盒子不动 + 内层整盒上移」，结构上过不去——备用屏没有回滚缓冲，平移切掉的
  // frame 上半部分滚不回来（alt screen 只有一个屏幕）。
  //
  // 三次降噪，让每次开合最多一次 resize 且不刺眼：
  //   1) 量化：键盘高度变化 < KB_STEP 不重建尺寸（候选栏/预测栏增减被吞掉，见
  //      useVirtualKeyboard）；细分行数变化交给 xterm fit 的幂等性兜住。
  //   2) 非对称：开键盘等动画 settle 后让位，收键盘延迟 900ms 再撑回，窗口内重新聚焦
  //      则取消——「收起来看一眼再点回来」零 resize（时序同样是全局的）。
  //   3) 遮罩：盒子尺寸变化时盖一层黑（kbMask）盖住 xterm reflow + TUI 整帧重绘，
  //      观感从「内容跳一下」变成「黑一下」。
  const KB_GAP = 6 // 终端底与工具条之间的呼吸位（px）
  const KB_MIN_TERM = 120 // 让位上限：终端至少留这么高（≈7~9 行），防小屏键盘吃光
  /** 盒子尺寸变化时的基础遮盖窗口（xterm 本地 reflow 这一拍） */
  const KB_MASK_MS = 260
  /**
   * 「exec.resize 已经发出去」之后再盖多久：覆盖后端往返 + 应用整帧重绘 + xterm 解析渲染。
   * 比 KB_MASK_MS 短——前面的链路早就走完，只剩最后一跳（本地 LXC/msmux 往返是毫秒级，
   * 大头是 TUI 自己那帧重绘）。
   */
  const KB_MASK_SEND_MS = 220
  /** 「应用重绘输出停住」的安静窗口：遮罩开着时每收到一帧输出就按它续一次 */
  const KB_MASK_QUIET_MS = 120
  /** 遮罩硬上限：重绘链路再慢、输出再刷屏也不能一直黑着（到点按到期收） */
  const KB_MASK_MAX_MS = 640

  const { kbRaw, kbOpen, kbTop, kbTopAtOpen, vvTick } = useVirtualKeyboard()
  /** 键盘会话中（含收起后的延迟窗口）：遮罩只在会话里开，桌面拖窗/普通 resize 不许黑屏。 */
  const keyboardSession = () => isPhone.value && (kbRaw.value || kbOpen.value)

  const toolbarHeight = ref(0)
  const toolbarEl = ref<HTMLDivElement | null>(null)
  let toolbarResizeObs: ResizeObserver | null = null

  // 稳定态跟随：持焦时 kbShrink 跟键盘走；失焦时只等键盘确认收起再收回（粘滞，见上）。
  watch(
    [kbOpen, termFocused],
    ([open, focused]) => {
      if (focused) kbShrink.value = open
      else if (!open) kbShrink.value = false
    },
    { immediate: true },
  )

  // 让位量 = 键盘顶（含工具条）压到终端盒里的高度，量「被压住多少」而不是「键盘多高」：
  // 分屏时上方 pane 的底边本来就在键盘之上（量出来 0，不参与让位），下方 pane 才是被压的
  // 那个；布局视口模式（浏览器自己让过位）下 rect 也已经在键盘之上 → 只剩工具条那点高度。
  // 用稳定态快照 kbTopAtOpen 而不是实时 kbTop：延迟窗口里键盘已经走了，几何不能跟着变。
  const kbInset = computed(() => {
    void vvTick.value
    if (!isPhone.value || !kbShrink.value) return 0
    const root = deps.rootEl.value
    if (!root) return 0
    const rect = root.getBoundingClientRect()
    if (rect.height <= 0) return 0
    const toolbarTop = kbTopAtOpen.value - toolbarHeight.value - KB_GAP
    const wanted = Math.max(0, rect.bottom - toolbarTop)
    // 上限按「留足最少可见行」算。注意布局视口模式下 rect 已被反向补偿拉长（含键盘后
    // 面那段），所以不能用比例：按比例会在刚好卡边时把工具条压到终端上。
    const cap = Math.max(0, Math.round(rect.height) - KB_MIN_TERM)
    return Math.max(0, Math.min(Math.round(wanted), cap))
  })

  // 工具条定位用**立即态**几何（kbTop 跟 vv 走）：键盘动画期间它就贴着键盘上沿滑，
  // 不用等 settle；收起瞬间工具条立刻消失（见 Terminal 模板的 kbRaw 闸）。
  const kbToolbarTop = computed(() => {
    void vvTick.value
    if (!kbRaw.value) return 0
    return Math.max(0, kbTop.value - toolbarHeight.value - KB_GAP)
  })

  // 遮罩窗口：尺寸一变立刻盖住，等 xterm refit + 应用重绘落地后再淡出。
  // 关键是**结束时刻**要对齐真正重绘落地的那一拍，否则就是「闪一下黑、黑退下去内容才跳」
  // ——遮罩和重排脱节。重绘链路的时序是：盒子变 → (rAF) xterm refit → onResize 140ms 去抖
  // → exec.resize 发出去 → 后端 SIGWINCH → 应用整帧重绘 → WS 回来 xterm 解析渲染。
  // 所以只按「盒子变」那一下开 260ms 必然会先于重绘结束，必须再等「已经发出去」的那一拍补一段
  // （noteResizeSent，被去重掉不发时自然也不用补）。
  const kbMask = ref(false)
  let maskTimer = 0
  /** 本次窗口开始时刻：硬上限按它算，输出刷屏时也不能一直黑着 */
  let maskOpenedAt = 0
  function showMask(ms = KB_MASK_MS) {
    const now = Date.now()
    if (!kbMask.value) maskOpenedAt = now
    kbMask.value = true
    if (maskTimer) clearTimeout(maskTimer)
    const cap = maskOpenedAt + KB_MASK_MAX_MS - now
    maskTimer = window.setTimeout(() => {
      maskTimer = 0
      kbMask.value = false
    }, Math.max(0, Math.min(ms, cap)))
  }
  watch(kbInset, (v, prev) => {
    if (v !== prev) showMask()
  })
  // 布局视口模式（浏览器自己缩布局）下，真正那次 resize 来自浏览器、比 kbInset 早：
  // 网格尺寸在键盘会话里变了就补一次遮罩，让「浏览器重排 + 应用重绘」也落在黑层后面。
  function noteGridChange() {
    if (!keyboardSession()) return
    showMask()
  }
  // exec.resize 真的发出去之后补一段（含后端往返 + 应用重绘 + xterm 渲染）。
  function noteResizeSent() {
    if (!keyboardSession()) return
    showMask(KB_MASK_SEND_MS)
  }
  // 应用那一帧重绘到了（xterm onWriteParsed）：遮罩开着就按「输出安静窗口」延长，
  // 让黑层正好盖到最后一帧落地而不是卡在固定时长上（TUI 重绘快慢差很多）。
  // 硬上限 KB_MASK_MAX_MS 兜住输出刷屏的情形。
  function noteRepaint() {
    if (!kbMask.value) return // 没开窗时输出与键盘无关，零成本返回
    if (!keyboardSession()) return
    showMask(KB_MASK_QUIET_MS)
  }

  // 工具条高度测量（让位量与定位都吃它）：键盘态显隐只看 opacity，盒子高度恒可测。
  function setupToolbarMeasure() {
    if (toolbarResizeObs) return
    const syncToolbarHeight = () => {
      toolbarHeight.value = toolbarEl.value?.offsetHeight ?? 0
    }
    syncToolbarHeight()
    if (toolbarEl.value) {
      toolbarResizeObs = new ResizeObserver(syncToolbarHeight)
      toolbarResizeObs.observe(toolbarEl.value)
    }
  }
  // 设备形态翻转（桌面缩窄 <768 / 窗口还原）：此前只在挂载时判一次，翻转过的实例
  // 永远没有工具条高度。nextTick 保证翻转后 toolbarEl 已渲染可测量。
  watch(
    isPhone,
    (v) => {
      if (v) void nextTick(setupToolbarMeasure)
      else {
        toolbarResizeObs?.disconnect()
        toolbarResizeObs = null
        toolbarHeight.value = 0
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
  // ⋯ 不再打开弹窗：跳全屏「终端工具条」设置页（lib/termToolbarNav.ts，路由承载）。
  // 配置页是全局单例、不依赖键盘——设置菜单里也有同一个入口。
  // 「指令」打开快捷指令面板（QuickCmdsSheet）：面板只负责运行（点条目 = 发送整条命令并回车）；
  // 面板右上「配置」关面板并跳到设置页的指令分区——运行与配置不混在同一个面板里。
  const cmdsOpen = ref(false)
  function openCmdsConfig() {
    cmdsOpen.value = false
    openToolbarSettings('cmds')
  }
  function runQuickCmd(cmd: string) {
    // 面板只传命令文本：先按文本记一次最近使用，再发
    recordCmdUseByText(cmd)
    deps.sendRaw(cmd + '\r')
    deps.emitEnter() // 命令语义，与工具条回车一致走 cwd 跟随
  }
  // 工具条上固定的指令按钮：与面板点条目同语义（命令 + 回车 + cwd 跟随）
  function runCmdBtn(id: string) {
    const c = getQuickCmd(id)
    if (c) runQuickCmd(c.cmd)
  }

  // —— 工具条「最近」条：最近运行过、且没固定的指令（固定项已在主键区，不重复）——
  // 只占一行 28px（+4px 间距）；没有可显示项时整条不渲染，键盘态不多占高度。
  const recentStrip = computed(() => recentCmds.value.filter((c) => !isCmdPinned(c.id)).slice(0, 5))
  const hasLastCmd = computed(() => recentCmds.value.length > 0)

  // —— 长按「指令」= 重发上一条（不占格；短按仍开面板）——
  // 450ms 触发一次 + 轻震动；按住期间不打开面板；松手后的 click 由 fired 闸门吃掉。
  let cmdHoldTimer = 0
  let cmdHoldFired = false
  function clearCmdHold() {
    if (cmdHoldTimer) clearTimeout(cmdHoldTimer)
    cmdHoldTimer = 0
  }
  function onCmdBtnDown() {
    clearCmdHold()
    cmdHoldFired = false
    if (!recentCmdIds.value.length) return
    cmdHoldTimer = window.setTimeout(() => {
      cmdHoldTimer = 0
      cmdHoldFired = true
      const id = recentCmdIds.value[0]
      if (id) runCmdBtn(id)
      if ('vibrate' in navigator) navigator.vibrate(10)
    }, 450)
  }
  function onCmdBtnUp() {
    clearCmdHold()
  }
  function onCmdBtnClick() {
    clearCmdHold()
    if (cmdHoldFired) {
      cmdHoldFired = false
      return
    }
    cmdsOpen.value = true
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
  // 工具条按钮 = 按键/自定义键 + 固定到工具条的指令（cmd 引用）；完整指令列表仍在面板里。
  // 分页走 lib/termToolbar.ts 的 toolbarPages——设置页的布局预览吃同一份结果，不会漂移。
  const toolPages = computed<ToolbarItem[][]>(() => toolbarPages(toolButtons.value))
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
    clearCmdHold()
    if (maskTimer) clearTimeout(maskTimer)
    maskTimer = 0
    toolbarResizeObs?.disconnect()
    toolbarResizeObs = null
  })

  return {
    // 焦点闸
    termFocused,
    onFocusedIn,
    onFocusedOut,
    // 键盘态
    kbRaw,
    kbOpen,
    kbInset,
    kbMask,
    kbToolbarTop,
    noteGridChange,
    noteResizeSent,
    noteRepaint,
    toolbarEl,
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
  }
}
