// 工具条设置页的统一入口（全屏页，路由承载）。
// 三处复用：设置菜单「终端工具条」、工具条 ⋯、指令面板「配置」（定位到指令分区）。
// 放 lib 里而不是逐层 emit：入口横跨设置菜单/终端/指令面板，传事件会穿三层组件。
import { router, TERMINAL_TOOLBAR_ROUTE } from '@/router'

export type ToolbarSettingsSection = 'keys' | 'cmds'

export function openToolbarSettings(section: ToolbarSettingsSection = 'keys') {
  // 从工具条 ⋯ 进入时终端 textarea 还持焦：先 blur 收键盘。否则全屏页下面挂着软键盘，
  // 工具条（Teleport z-[80]）也可能浮在新页面边缘。只针对终端焦点，不动菜单按钮等其他焦点。
  const active = document.activeElement
  if (active instanceof HTMLElement && active.closest('.xterm')) active.blur()
  void router.push({
    name: TERMINAL_TOOLBAR_ROUTE,
    query: section === 'cmds' ? { section: 'cmds' } : {},
  })
}
