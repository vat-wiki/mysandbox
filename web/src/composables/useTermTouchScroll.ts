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
    // 像素 → 整行：余量留在 accPx，凑满一行才调 scrollLines（亚行位移不丢，下次继续凑）
    const scrollByPx = (px: number) => {
      accPx += px
      const rows = Math.trunc(accPx / rowHeightOf())
      const term = deps.term()
      if (rows !== 0 && term) {
        accPx -= rows * rowHeightOf()
        if (altWheel()) sendWheelRows(rows)
        else term.scrollLines(rows)
      }
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
    const sendWheelRows = (rows: number) => {
      const term = deps.term()
      if (!term) return
      const col = Math.ceil(term.cols / 2)
      const row = Math.ceil(term.rows / 2)
      const btn = rows < 0 ? 64 : 65 // 64=滚轮上（看更早），65=滚轮下
      const n = Math.min(Math.abs(rows), 6) // 惯性高速限流，一次手势别刷爆 PTY
      for (let i = 0; i < n; i++) deps.send(`\x1b[<${btn};${col};${row}M`)
    }
    const onStart = (e: TouchEvent) => {
      stopMomentum()
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
      if (Math.abs(vel) < 0.1) return
      let last = performance.now()
      const step = (now: number) => {
        const dt = now - last
        last = now
        scrollByPx(vel * dt)
        vel *= Math.pow(0.03, dt / 1000)
        if (Math.abs(vel) > 0.02) momentumRaf = requestAnimationFrame(step)
        else momentumRaf = 0
      }
      momentumRaf = requestAnimationFrame(step)
    }
    root.addEventListener('touchstart', onStart, { capture: true, passive: true })
    root.addEventListener('touchmove', onMove, { capture: true, passive: false })
    root.addEventListener('touchend', onEnd, { capture: true })
    root.addEventListener('touchcancel', onEnd, { capture: true })
    cleanup = () => {
      stopMomentum()
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
