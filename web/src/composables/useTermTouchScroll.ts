// 触屏滚动接管（从 Terminal.vue 抽出，2026-10-26）。
//
// xterm 内建在 bindMouse 里注册的 touchstart/touchmove 滚 viewport 真机上不可靠：touchmove
// 非被动但滚动途中不 preventDefault，浏览器手势判定抢走手势后直接 touchcancel，终端纹丝
// 不动（桌面 wheel 同一注册点，所以桌面无感）。这里 capture 阶段自管：preventDefault 在手
// 保证 touchmove 必达，stopPropagation 防 xterm 内部 handler 双重滚动。touchstart/touchend
// 不截获——点按聚焦、长按等原生行为保持。顺带补惯性滑动（xterm 内建无 momentum，长历史
// 1:1 跟手翻不动）。普通缓冲只动本地 scrollback、不向 PTY 发字节；备用屏 + 应用开鼠标
// 上报时例外——触摸位移转 SGR 滚轮发给应用（见 altWheel/queueWheel），否则 claude
// 这类全屏 TUI 在手机上完全没法滚。
//
// ⚠️ 必须走 term.scrollLines()（整行）而不是直改 .xterm-viewport.scrollTop（像素）：xterm 的
// 权威滚动状态是 ydisp（整行坐标），viewport 每次渲染刷新都把 scrollTop 重置回 ydisp × 行高——
// 像素直改会被吃掉、凑满一行才跳一格（实测一卡一卡）。滚轮同理是按行滚动，这里把触摸位移
// 像素累积、凑整行调 scrollLines，与滚轮同路径、无对齐打架。
//
// ⚠️ 备用屏那条路**丝滑上限由应用决定**，不是网络：每一步都是「滚轮按键 → 应用整帧重绘 →
// 字节回来 → xterm 渲染」，帧率 = claude 自己的重绘帧率（15~40ms/帧），且只能整行跳。
// 我们能做的只有别在应用渲染不过来时继续灌事件（见 queueWheel 的 flow control）。
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
    // 像素 → 整行：余量留在 accPx，凑满一行才动（亚行位移不丢，下次继续凑）
    const scrollByPx = (px: number) => {
      accPx += px
      const rows = Math.trunc(accPx / rowHeightOf())
      const term = deps.term()
      if (rows !== 0 && term) {
        accPx -= rows * rowHeightOf()
        if (altWheel()) queueWheel(rows)
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

    // —— 备用屏滚轮：按应用重绘节流（flow control）——
    // 每一步都是按键，应用收到才会重绘；发得比它画得快就只能在 PTY 里排队，体感是
    // 「手指停了内容还在追」「迟一拍再窜」。所以同一时刻只允许一批在飞，等应用下一帧
    // 输出（term.onWriteParsed）再放行下一批——节奏直接跟应用的重绘走。
    const WHEEL_BATCH_MAX = 3 // 单批最多几行（原来一口气 6 行，渲染队列跟不上）
    const WHEEL_PENDING_MAX = 20 // 积压上限（应用卡住时不能无限攒，手指抬起后还在滚）
    const WHEEL_RELEASE_MS = 150 // 兜底放行：滚到顶/底时应用可能整帧不动、没有输出
    let wheelPending = 0 // 待发的行数（有符号，负 = 往更早看）
    let wheelInFlight = false
    let wheelTimer = 0
    let pumpRaf = 0

    const sendWheelRows = (rows: number) => {
      const term = deps.term()
      if (!term || rows === 0) return
      const col = Math.ceil(term.cols / 2)
      const row = Math.ceil(term.rows / 2)
      const btn = rows < 0 ? 64 : 65 // 64=滚轮上（看更早），65=滚轮下
      let seq = ''
      for (let i = 0; i < Math.abs(rows); i++) seq += `\x1b[<${btn};${col};${row}M`
      deps.send(seq) // 一批一条 WS 消息：拆成多次发只会让 PTY 侧多排几次队
    }
    const pumpWheel = () => {
      if (wheelInFlight || wheelPending === 0) return
      const n = Math.sign(wheelPending) * Math.min(Math.abs(wheelPending), WHEEL_BATCH_MAX)
      wheelPending -= n
      sendWheelRows(n)
      wheelInFlight = true
      if (wheelTimer) clearTimeout(wheelTimer)
      wheelTimer = window.setTimeout(releaseWheel, WHEEL_RELEASE_MS)
    }
    function releaseWheel() {
      if (wheelTimer) {
        clearTimeout(wheelTimer)
        wheelTimer = 0
      }
      if (!wheelInFlight) return
      wheelInFlight = false
      pumpWheel()
    }
    // 一次 rAF 内的多次 touchmove 合并成一批（高刷屏上一帧可能有 2~3 个 move 事件）
    const queueWheel = (rows: number) => {
      wheelPending += rows
      if (Math.abs(wheelPending) > WHEEL_PENDING_MAX) {
        wheelPending = Math.sign(wheelPending) * WHEEL_PENDING_MAX
      }
      if (pumpRaf) return
      pumpRaf = requestAnimationFrame(() => {
        pumpRaf = 0
        pumpWheel()
      })
    }
    // 新手势/点按停下：丢掉还没发的尾巴，别让内容在手离开后自己继续滑
    const dropWheelQueue = () => {
      wheelPending = 0
      if (pumpRaf) cancelAnimationFrame(pumpRaf)
      pumpRaf = 0
    }
    // 应用输出 = 上一批滚轮已被消费（重绘落地）：放行下一批。
    const writeSub = deps.term()?.onWriteParsed(() => releaseWheel())

    const onStart = (e: TouchEvent) => {
      stopMomentum()
      dropWheelQueue()
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
      dropWheelQueue()
      if (wheelTimer) clearTimeout(wheelTimer)
      wheelTimer = 0
      writeSub?.dispose()
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
