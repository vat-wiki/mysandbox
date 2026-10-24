// 新版本提示：页面 bundle 是加载时刻的快照，SPA 不会自己换——后端部署新版后旧页面
// 毫无感知。这不只是「界面旧」的问题：旧 bundle 缺新协议帧的处理分支会静默失能
// （实例：v0.9.16 的 msmux resume 补发 `{type:'modes'}`，旧页面收不懂 → 手机回前台
// 触摸滚动失效）。这里在「复用旧页面」高发的时机比对 /api/health 的版本与 build 时
// 固化进 bundle 的 __APP_VERSION__，不一致弹常驻 toast 引导刷新。
//
// health 免鉴权（TokenGate 前也能查）；失败静默——离线/后端没起时查不了，提示也没意义。
// 60s 节流：visibilitychange 会频繁触发，没必要每次都打；确认过期后置 stale 只报一次。
import { toast } from 'vue-sonner'
import { health } from './api'

const THROTTLE_MS = 60_000
let lastCheck = 0
let stale = false

export function checkStaleVersion(force = false): void {
  if (stale) return
  const now = Date.now()
  if (!force && now - lastCheck < THROTTLE_MS) return
  lastCheck = now
  health()
    .then((h) => {
      if (!h.version || h.version === __APP_VERSION__) return
      stale = true
      toast.info('新版本已部署', {
        description: `服务端已更新到 v${h.version}，当前页面还是 v${__APP_VERSION__}；旧页面可能缺新功能甚至静默失能，刷新即生效。`,
        // 7 天（2^31 内 setTimeout 安全）：等价于常驻。实测 duration: Infinity 偶发
        // 不生效（toast ~4s 即被收走，原因未查明），有限值绕开。
        duration: 7 * 24 * 3600 * 1000,
        closeButton: true,
        action: { label: '刷新', onClick: () => location.reload() },
      })
    })
    .catch(() => {})
}

// 启动 3s 后先对一次（覆盖「拿旧收藏夹/常驻 PWA 直接打开」的场景）；此后回前台、
// 网络恢复、慢轮询兜底（页面常驻前台的期间部署，靠轮询补上）。
export function startVersionWatch(): void {
  setTimeout(() => checkStaleVersion(true), 3000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkStaleVersion()
  })
  window.addEventListener('online', () => checkStaleVersion(true))
  setInterval(() => checkStaleVersion(), 120_000)
}
