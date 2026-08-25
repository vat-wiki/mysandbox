/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

// @novnc/novnc 是纯 JS 包（无类型声明）。只声明用到的 RFB 面：构造 + connect/disconnect
// + 三个事件（connect/disconnect/credentialsrequired/securityfailure，EventTargetMixin 派发）。
declare module '@novnc/novnc/core/rfb.js' {
  export interface RfbEventDetail {
    detail?: { clean?: boolean; reason?: string }
  }
  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: {
        scaleViewport?: boolean
        resizeSession?: boolean
        background?: string
        credentials?: { password?: string; username?: string; target?: string }
        wsProtocols?: string[]
      },
    )
    connect(): void
    disconnect(): void
    sendCredentials(creds: { password?: string; username?: string; target?: string }): void
    sendCtrlAltDel(): void
    focus(options?: { preventScroll?: boolean }): void
    blur(): void
    get capabilities(): { power: boolean; clipboard: boolean; clipboardUTF8: boolean }
    set scaleViewport(v: boolean)
    set resizeSession(v: boolean)
    set scale(v: number)
    set viewOnly(v: boolean)
    set showLocalCursor(v: boolean)
  }
}
