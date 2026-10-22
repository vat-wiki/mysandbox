// 浏览器通知（「无输出提醒」的站外延伸，模块级单例，每个浏览器窗口一份）：
// 琥珀标只在本页可见；tab 标题前缀虽能跨 tab 瞄到，但不主动打扰、不可点击跳回——
// 要把「终端安静下来了」递到眼前（人可能切去了别的应用窗口），系统通知是唯一通道。
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

// 「刚打开」宽限：移动端 Chrome 会冻结/节流后台 tab，冻结期间积下的等待事件，会在
// 点开浏览器的瞬间随补跑的轮询落地——而这一拍经常赶在 focus 事件之前，此刻页面已在
// 渲染、hasFocus() 却还是 false，前台闸门拦不住 → 用户正看着屏幕时炸出系统通知
// （「一打开就通知」）。页面刚变为可见的几秒内不发：用户在场，琥珀标就是即时信号；
// 宽限期内拦下的调用方**不消费**（见 ContainerList refreshActivity），积压事件留到
// 真正离场后的那一拍再发——不错过，只是不当场炸。
const OPEN_GRACE_MS = 10_000
let visibleSince = Date.now()
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) visibleSince = Date.now()
})
export function justOpened(): boolean {
  return Date.now() - visibleSince < OPEN_GRACE_MS
}

// 「用户在场」补强判据：部分安卓 Chrome 解冻恢复后 focus 事件迟迟不来、hasFocus()
// 恒 false（持久性怪态，非恢复瞬间一闪）——宽限一过、用户还在页面上看时，前台闸门
// 依旧误判成「切走了」，积压/新到的事件在用户正看着时炸响（「每次一打开浏览器就
// 响」）。两个补强信号把这种状态认出来：
//   - everFocused：自页面变为可见以来收到过 focus 事件。切走（桌面失焦/换 tab）之前
//     必然获过焦——「可见但从未获焦」≈ 解冻恢复怪态 ≈ 在场。
//   - lastGesture：页面上的 pointerdown/keydown/touchstart。刚摸过页面 = 在看
//     （兜 focus 事件已到但 hasFocus() 说谎的更罕见变体）。
// 放行条件收敛为：可见 + 失焦 + 获过焦 + 30s 内没摸过——该状态在移动端几乎不存在，
// 桌面误伤只有「切走前 30s 内刚在控制台点过」≤30s 的发送延迟。
const GESTURE_RECENT_MS = 30_000
let everFocused = false
let lastGesture = 0
window.addEventListener('focus', () => {
  everFocused = true
})
for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) {
  window.addEventListener(ev, () => { lastGesture = Date.now() }, { passive: true, capture: true })
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) everFocused = false
})
function userPresent(): boolean {
  if (document.hidden) return false
  if (!everFocused) return true // 可见但从未获焦：解冻恢复怪态，人在看
  return Date.now() - lastGesture < GESTURE_RECENT_MS
}

// 发一条「无输出」通知。开关关/权限缺/页面在前台/刚打开宽限内都不发（返回 false，
// 调用方自行决定是否消费，见 justOpened 注释）。
export function fireQuietNotify(
  title: string,
  body: string,
  tag: string,
  onClick: () => void,
): boolean {
  if (!quietNotifyEnabled() || notifyPermission() !== 'granted') return false
  // 前台不发：tab 身份点可见，抢系统通知反而烦。
  if (document.hasFocus() && !document.hidden) return false
  // 补强判据（userPresent）：可见但从未获焦（解冻怪态）/ 刚摸过页面 = 人在看，不发。
  if (userPresent()) return false
  if (justOpened()) return false
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
