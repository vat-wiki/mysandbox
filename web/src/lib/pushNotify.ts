// Web Push 订阅与「在看」心跳（server/push.ts 的前端半边）。浏览器通知（
// lib/browserNotify）依赖页面活着——移动端后台 tab 被降频/冻结，agent 干完活的
// 时刻页面多半没在跑；推送经系统通道（SW + pushManager）下发，页面没开也照收。
//
// - 订阅：设置页开关触发（授权须用户手势），SW 在 /service-worker.js（vite public），
//   VAPID 公钥取自服务端，订阅登记 POST /api/push/subscribe。开关记忆走 localStorage
//   （同 tab 布局约定，浏览器维度）；授权本身浏览器按站点记，二者独立存。
// - 「在看」心跳：控制台页面可见期间每 10s 一拍（服务端 30s TTL）——任何一台设备的
//   控制台可见都算「用户在场」，服务端对到达的 waiting 不推（琥珀标足够）；页面隐藏
//   即停拍，30s 后推送恢复。心跳与开关独立：本机没开推送也照拍（别的设备的推送
//   也该被「正在看」抑制）。
import {
  getPushPublicKey,
  pushSubscribe,
  pushUnsubscribe,
  pushWatching,
} from './api'
import { requestNotifyPermission } from './browserNotify'

const ENABLE_KEY = 'mysandbox:web-push'

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function pushEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLE_KEY) === '1'
  } catch {
    return false
  }
}

function setPushEnabled(v: boolean): void {
  try {
    if (v) localStorage.setItem(ENABLE_KEY, '1')
    else localStorage.removeItem(ENABLE_KEY)
  } catch {
    /* 存储不可用（隐私模式等）：本次会话内开关仍生效，只是不记忆 */
  }
}

// base64url → Uint8Array（pushManager 的 applicationServerKey 要求）。
function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

// 开通（设置页开关，用户手势调用链里）。失败返回 false，开关弹回；错误已 toast。
export async function enablePush(): Promise<boolean> {
  if (!pushSupported()) return false
  if ((await requestNotifyPermission()) !== 'granted') return false
  const reg = await navigator.serviceWorker.register('/service-worker.js')
  await navigator.serviceWorker.ready
  const key = urlBase64ToUint8Array((await getPushPublicKey()).key)
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  await pushSubscribe(sub.toJSON())
  setPushEnabled(true)
  armWatchingHeartbeat()
  return true
}

// 关闭：退订浏览器侧 + 清服务端底账（尽力而为，失败不挡本地关闭）。
export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await pushUnsubscribe(sub.endpoint).catch(() => {})
      await sub.unsubscribe()
    }
  } catch {
    /* SW/订阅不存在等：本地开关照关 */
  }
  setPushEnabled(false)
}

// 「在看」心跳：页面可见时每 10s 一拍；隐藏时不拍（服务端 30s 后恢复推送）。
// App 启动即挂（无条件，见文件头：心跳语义是「用户在场」，与开关无关）。
let hbTimer: ReturnType<typeof setInterval> | null = null
export function armWatchingHeartbeat(): void {
  if (hbTimer || !pushSupported()) return
  const beat = () => {
    if (document.hidden) return
    void pushWatching().catch(() => {}) // 失败静默：下拍再试，服务端 TTL 兜底
  }
  beat()
  hbTimer = setInterval(beat, 10_000)
  document.addEventListener('visibilitychange', beat)
}
