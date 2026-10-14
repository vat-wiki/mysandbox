// 浏览器通知（「无输出提醒」的站外延伸，模块级单例，每个浏览器窗口一份）：
// 琥珀标与 favicon 都只在本页可见——切去别的浏览器 tab / 别的应用窗口就什么都
// 看不到了，系统通知是唯一能把「终端安静下来了」递到眼前的通道。
//
// 形态对齐 tmux bell 的克制原则：只在页面不在前台时发（前台时 tab 身份点就是即时
// 信号）；同一组只在「新挂标」那一刻发一条（状态制重算的 diff 交给调用方，这里不
// 去重不重发）；回到本页（window focus）自动收掉还挂着的通知——标已看见，通知不
// 必再等。点击通知 = 聚焦窗口 + 调用方的落点回调（切到该组）。
//
// 权限：Notification API 要求安全上下文（localhost / https）；http 裸 IP 访问时
// `Notification` 不存在，notifyAvailable() 为 false，设置页据此降级说明。授权必须
// 用户手势触发——开关在设置弹框里，点开那一刻申请。开关记忆走 localStorage
// （浏览器维度，同 tab 布局约定），授权本身浏览器按站点记，二者独立存。

const ENABLE_KEY = 'mysandbox:browser-notify'

export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported'

export function notifyAvailable(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export function notifyPermission(): NotifyPermission {
  if (!notifyAvailable()) return 'unsupported'
  return Notification.permission as NotifyPermission
}

// 申请授权（必须在用户手势调用链里）。被拒/不支持原样返回，调用方自行降级。
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (!notifyAvailable()) return 'unsupported'
  try {
    return (await Notification.requestPermission()) as NotifyPermission
  } catch {
    return 'denied'
  }
}

export function quietNotifyEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLE_KEY) === '1'
  } catch {
    return false
  }
}

export function setQuietNotifyEnabled(v: boolean): void {
  try {
    if (v) localStorage.setItem(ENABLE_KEY, '1')
    else localStorage.removeItem(ENABLE_KEY)
  } catch {
    /* 存储不可用（隐私模式等）：本次会话内开关仍生效，只是不记忆 */
  }
}

// 还挂着的本页通知：回到本页统一收掉（bell 的「切回即消」在通知上的对应物）。
const live: Notification[] = []

function dismissAll(): void {
  for (const n of live.splice(0)) {
    try {
      n.close()
    } catch {
      /* 已被系统/用户收掉：忽略 */
    }
  }
}

let focusArmed = false
function ensureFocusDismiss(): void {
  if (focusArmed) return
  focusArmed = true
  window.addEventListener('focus', dismissAll)
  // focus 不总可靠（窗口切换到同源另一个窗口等场景），可见性恢复也收一道。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) dismissAll()
  })
}

// 发一条「无输出」通知。开关关/权限缺/页面在前台都不发（返回 false，调用方无需关心）。
export function fireQuietNotify(
  title: string,
  body: string,
  tag: string,
  onClick: () => void,
): boolean {
  if (!quietNotifyEnabled() || notifyPermission() !== 'granted') return false
  // 前台不发：tab 身份点可见，抢系统通知反而烦。
  if (document.hasFocus() && !document.hidden) return false
  ensureFocusDismiss()
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: '/favicon.svg',
    })
    n.onclick = () => {
      // 通知点击算用户手势，window.focus() 能把后台 tab 拉回前台。
      window.focus()
      onClick()
      n.close()
    }
    live.push(n)
    n.onclose = () => {
      const i = live.indexOf(n)
      if (i >= 0) live.splice(i, 1)
    }
    return true
  } catch {
    return false // 通知构造失败（权限被中途收回等）：静默，琥珀标仍在
  }
}
