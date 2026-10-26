// xterm 5.5 的滚动区修正（从 Terminal.vue 抽出，2026-10-26）：接管 CSI S，让它走
// BufferService.scroll 的统一实现，并强制重算滚动区几何。
import type { Terminal as XTerm } from '@xterm/xterm'

// xterm 5.5 的 CSI S 直接 splice 滚动区行，绕过了 BufferService.scroll 的 scrollback
// 路径：顶部行被丢弃，滚动区外内容也可能被应用重绘后残留/覆盖。这里接管 SU，让它走
// 同一个 buffer 滚动实现——顶部行进 scrollback，滚动区外的固定行保持原位。
type ScrollRegionInputHandler = {
  _activeBuffer?: { scrollTop: number; scrollBottom: number }
  _bufferService?: { isUserScrolling?: boolean; scroll?: (attr: unknown) => void }
  _dirtyRowTracker?: { markRangeDirty?: (start: number, end: number) => void }
  _eraseAttrData?: () => unknown
}

export type TerminalViewportHost = {
  _core?: {
    viewport?: {
      syncScrollArea?: (immediate?: boolean) => void
      _currentRowHeight?: number
    }
  }
}

export function registerScrollRegionHandler(term: XTerm, webglActive: () => boolean): void {
  term.parser.registerCsiHandler({ final: 'S' }, (params) => {
    const inputHandler = (
      term as unknown as { _core?: { _inputHandler?: ScrollRegionInputHandler } }
    )._core?._inputHandler
    const buffer = inputHandler?._activeBuffer
    const bufferService = inputHandler?._bufferService
    const eraseAttrData = inputHandler?._eraseAttrData?.bind(inputHandler)
    const markRangeDirty = inputHandler?._dirtyRowTracker?.markRangeDirty?.bind(
      inputHandler._dirtyRowTracker,
    )
    if (!buffer || !bufferService?.scroll || !eraseAttrData) return false

    const first = params[0]
    const requested = typeof first === 'number' && Number.isFinite(first) && first > 0
      ? Math.floor(first)
      : 1
    const regionHeight = buffer.scrollBottom - buffer.scrollTop + 1
    const count = Math.min(requested, regionHeight)
    if (count <= 0) return false

    for (let index = 0; index < count; index += 1) {
      if (buffer.scrollTop >= buffer.scrollBottom) break
      bufferService.scroll(eraseAttrData())
    }
    markRangeDirty?.(0, term.rows - 1)
    // BufferService.scroll 已发 scroll 事件，但移动端 DOM 渲染器在软键盘/visualViewport
    // 变化期间可能拿到过期几何。这里幂等强制重算滚动区，并对 DOM 渲染器补一次全量重绘。
    const viewport = (term as TerminalViewportHost)._core?.viewport
    viewport?.syncScrollArea?.(true)
    if (!webglActive()) term.refresh(0, term.rows - 1)
    return true
  })
}
