// 触屏滚动接管（从 Terminal.vue 抽出，2026-10-26）。
//
// xterm 内建在 bindMouse 里注册的 touchstart/touchmove 滚 viewport 真机上不可靠：touchmove
// 非被动但滚动途中不 preventDefault，浏览器手势判定抢走手势后直接 touchcancel，终端纹丝
// 不动（桌面 wheel 同一注册点，所以桌面无感）。这里 capture 阶段自管：preventDefault 在手
// 保证 touchmove 必达，stopPropagation 防 xterm 内部 handler 双重滚动。touchstart/touchend
// 不截获——点按聚焦、长按等原生行为保持。顺带补惯性滑动（xterm 内建无 momentum，长历史
// 1:1 跟手翻不动）。普通缓冲只动本地 scrollback、不向 PTY 发字节；备用屏 + 应用开鼠标
// 上报时例外——触摸位移转 SGR 滚轮发给应用（见 altWheel/sendWheelRows），否则 claude
// 这类全屏 TUI 在手机上完全没法滚。
//
// ⚠️ 必须走 term.scrollLines()（整行）而不是直改 .xterm-viewport.scrollTop（像素）：xterm 的
// 权威滚动状态是 ydisp（整行坐标），viewport 每次渲染刷新都把 scrollTop 重置回 ydisp × 行高——
// 像素直改会被吃掉、凑满一行才跳一格（实测一卡一卡）。滚轮同理是按行滚动，这里把触摸位移
// 像素累积、凑整行调 scrollLines，与滚轮同路径、无对齐打架。
//
// ⚠️ 普通缓冲的「亚行补偿」（smoothScreen，`?smooth=0` 可关）：scrollLines 只能整行走，
// 快滑时视觉是一格一格跳。补法是把**已经画好的那一层**（`.xterm-screen`，含 cursor/selection
// 图层）按不足一行的余量整体 translate —— 纯合成器变换，零重绘、亚像素，于是在两次整行跨步
// 之间画面能像原生一样连续跟手；跨行的瞬间 ydisp 前进一行 + 平移量归零，两件事在同一个任务里
// 做（xterm 的重绘走 rAF 去抖，落在同一帧），净位移仍然连续。代价：朝运动方向那一侧会露出
// ≤1 行的空白（内容正在进/出，视角上等同原生 overscroll 的露底），滚动停住时按「就近半行」
// 吸附一次（≤½ 行，肉眼几乎看不出来）。**只对普通缓冲做**：备用屏内容是应用画回来的，重绘
// 时机不可控，平移归零对不上应用那一帧就会撕扯（那条路暂不做）。
import type { Terminal as XTerm } from '@xterm/xterm'
import type { TerminalViewportHost } from '@/lib/termScrollRegion'

export interface TermTouchScrollDeps {
  root: () => HTMLElement | null
  term: () => XTerm | null
  /** 发 stdin（滚轮序列发往 PTY；普通缓冲不经过这里） */
  send: (s: string) => void
}

export function useTermTouchScroll(deps: TermTouchScrollDeps) {
  let cleanup: (() => void) | null = null
  let momentumRaf = 0

  function stopMomentum() {
    if (momentumRaf) cancelAnimationFrame(momentumRaf)
    momentumRaf = 0
  }

  function setup() {
    const root = deps.root()
    if (!root || cleanup) return
    let tracking = false
    let lastY = 0
    let lastT = 0
    let vel = 0 // px/ms，指数平滑后的瞬时速度
    let accPx = 0 // 未凑满整行的像素余量

    const rowHeightOf = (): number => {
      // viewport._currentRowHeight 是 xterm 内部行高（与 scrollTop 同一坐标系）；
      // 内部形状拿不到时用 rows DOM 实测兜底。
      const term = deps.term()
      const h = (term as TerminalViewportHost | null)?._core?.viewport?._currentRowHeight
      if (h && h > 0) return h
      const rowsEl = term?.element?.querySelector('.xterm-rows') as HTMLElement | null
      return rowsEl && term ? rowsEl.getBoundingClientRect().height / term.rows : 20
    }
    // —— 亚行补偿（普通缓冲）：把画好的那层按「不足一行」的余量平移，视觉上连续跟手 ——
    // `?smooth=0` 可关（实验开关，回退用）。
    const SMOOTH_ON = (() => {
      try {
        return new URLSearchParams(location.search).get('smooth') !== '0'
      } catch {
        return true
      }
    })()
    let screenLayer: HTMLElement | null = null
    let screenOffset = 0 // 当前平移量（px，正 = 画面上移）
    const screenEl = (): HTMLElement | null => {
      if (screenLayer?.isConnected) return screenLayer
      screenLayer =
        (deps.term()?.element?.querySelector('.xterm-screen') as HTMLElement | null) ?? null
      return screenLayer
    }
    const applyScreenOffset = (px: number) => {
      if (!SMOOTH_ON) return
      const v = Math.round(px * 10) / 10 // 0.1px 量化：值没变就别碰样式
      if (v === screenOffset) return
      const el = screenEl()
      if (!el) {
        screenOffset = 0
        return
      }
      screenOffset = v
      if (v === 0) el.style.transform = ''
      else {
        el.style.willChange = 'transform'
        el.style.transform = `translate3d(0, ${v}px, 0)`
      }
    }
    // 停住时收尾：余量过半个行高就再滚一行（吸附到最近的整行），然后清掉像素偏移。
    // 不做的话画面会永远停在半行上（留一条 ≤1 行的空白）。
    const settleSmooth = () => {
      if (!screenOffset) return
      const rowH = rowHeightOf()
      if (Math.abs(accPx) >= rowH / 2) deps.term()?.scrollLines(Math.sign(accPx))
      accPx = 0
      applyScreenOffset(0)
    }

    // 像素 → 整行：余量留在 accPx，凑满一行才调 scrollLines（亚行位移不丢，下次继续凑）；
    // 不足一行的余量交给亚行补偿平移（备用屏没有本地内容可平移，恒为 0）
    const scrollByPx = (px: number) => {
      accPx += px
      const rowH = rowHeightOf()
      const rows = Math.trunc(accPx / rowH)
      const term = deps.term()
      if (!term) return
      if (rows !== 0) {
        accPx -= rows * rowH
        if (altWheel()) sendWheelRows(rows)
        else term.scrollLines(rows)
      }
      // 备用屏（ybase 恒 0）平移等于画假动作，只有普通缓冲可以拿余量补偿
      applyScreenOffset(term.buffer.active.type === 'alternate' ? 0 : -accPx)
    }
    // 备用屏（全屏 TUI）+ 应用开了鼠标上报（claude 开 ?1000h/?1003h/?1006h，实测确认）：
    // 本地 scrollback 没内容可滚（ybase 恒 0），触摸位移转成 SGR 滚轮序列发给 PTY，
    // 让应用自己滚（claude 滚 transcript）——与桌面滚轮同构（xterm 对鼠标追踪中的真实
    // 滚轮就是这么发的）。应用没开鼠标上报时保持 no-op：触摸滚动不该给纯 TUI 发位移。
    const altWheel = (): boolean => {
      const term = deps.term()
      return (
        !!term &&
        term.buffer.active.type === 'alternate' &&
        term.modes.mouseTrackingMode !== 'none'
      )
    }
    // 一次位移可能凑出很多行（快滑时单个 touchmove 就是上百像素）。**必须全发出去**：
    // 以前用 Math.min(|rows|, 6) 截断又不补，超出的部分直接蒸发 —— 同样一段手指位移，
    // 慢拖 1:1 跟手、快滑只走一半，而且随手的快慢时有时无（2026-10-27 修）。
    // 现在按 6 行一条消息切块发完（一条 WS 消息对应 PTY 一次 read，别拆太碎）。
    const WHEEL_CHUNK = 6
    const sendWheelRows = (rows: number) => {
      const term = deps.term()
      if (!term || rows === 0) return
      const col = Math.ceil(term.cols / 2)
      const row = Math.ceil(term.rows / 2)
      const btn = rows < 0 ? 64 : 65 // 64=滚轮上（看更早），65=滚轮下
      let left = Math.abs(rows)
      while (left > 0) {
        const n = Math.min(left, WHEEL_CHUNK)
        let seq = ''
        for (let i = 0; i < n; i++) seq += `\x1b[<${btn};${col};${row}M`
        deps.send(seq)
        left -= n
      }
    }
    const onStart = (e: TouchEvent) => {
      stopMomentum()
      settleSmooth() // 上一手势如果没走到收尾（多指打断等），先把半行吸附掉
      tracking = e.touches.length === 1
      if (!tracking) return
      lastY = e.touches[0].clientY
      lastT = e.timeStamp
      vel = 0
      accPx = 0
    }
    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) {
        tracking = false // 多指（双指残留）丢弃，防跳变
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const y = e.touches[0].clientY
      const dy = lastY - y
      const dt = Math.max(1, e.timeStamp - lastT)
      lastY = y
      lastT = e.timeStamp
      if (dy === 0) return
      scrollByPx(dy)
      vel = vel * 0.8 + (dy / dt) * 0.2
    }
    const onEnd = () => {
      if (!tracking) return
      tracking = false
      // 惯性 glide：按毫秒速度外推，指数衰减 τ≈0.3s（每秒剩 3%）——自然减速不急刹
      if (Math.abs(vel) < 0.1) {
        settleSmooth()
        return
      }
      let last = performance.now()
      const step = (now: number) => {
        const dt = now - last
        last = now
        scrollByPx(vel * dt)
        vel *= Math.pow(0.03, dt / 1000)
        if (Math.abs(vel) > 0.02) momentumRaf = requestAnimationFrame(step)
        else {
          momentumRaf = 0
          settleSmooth() // 惯性走完：把最后的半行吸附掉
        }
      }
      momentumRaf = requestAnimationFrame(step)
    }
    root.addEventListener('touchstart', onStart, { capture: true, passive: true })
    root.addEventListener('touchmove', onMove, { capture: true, passive: false })
    root.addEventListener('touchend', onEnd, { capture: true })
    root.addEventListener('touchcancel', onEnd, { capture: true })
    cleanup = () => {
      stopMomentum()
      applyScreenOffset(0) // 卸载前清掉像素偏移（只影响视觉，不动内容）
      root.removeEventListener('touchstart', onStart, { capture: true })
      root.removeEventListener('touchmove', onMove, { capture: true })
      root.removeEventListener('touchend', onEnd, { capture: true })
      root.removeEventListener('touchcancel', onEnd, { capture: true })
      cleanup = null
    }
  }

  function stop() {
    cleanup?.()
  }

  return { setup, stop }
}
