// favicon 运行状态（模块级单例，每个浏览器窗口一份）：
// 把「有工具在跑」投影到页面图标上——终端 tab 栏的状态点只在站内可见，切去别的
// 浏览器 tab 就什么都看不到了，favicon 是唯一跨 tab 的展示面。
//
// 三态：idle（原 logo）→ busy（蓝点 = 运行中）→ done（绿点 = 收尾完成）。
// 设计要点：
//   - 蓝点有迟滞：本轮输出成段（termRunSpanMs ≥ SUSTAIN_MS）即记「有效运行」，之后
//     整个运行期间保持蓝点——agent 思考停顿/翻读文件的无输出期不回 logo；停流后走
//     确认窗（QUIET_CONFIRM_MS，与站内无输出提醒同源），走完且页面仍不在前台才落
//     绿点。期间任何新输出都撤回蓝点，思考停顿不闪「假完成」；
//   - 秒级命令（敲个 ls）不成段：停流即回 logo，不留任何状态；
//   - 前台不给绿点：用户正看着，tab 栏状态点就是即时信号，favicon 无需参与；
//   - 绿点是给离开的人看的：回到本页（visibilitychange → visible）即熄回原 logo，
//     工具仍在跑则由调用方下一拍重新点亮 busy。
// 渲染 = 原 favicon.svg 文本 + 右下角状态点拼成 SVG data URL；每次切换都移除重建
// <link rel="icon">（Chrome 对同一 link 的 href 反复改写偶发不刷新，重建是通行解法）。
// 后台 tab 的定时器会被浏览器节流，状态切换最多滞后约一分钟。
import { QUIET_CONFIRM_MS } from './terminalActivity'

type Mode = false | 'busy' | 'sustained'
type State = 'idle' | 'busy' | 'done'

// 与橙色 logo 拉开对比：跑=sky-400，完成=green-400；描边用近黑压住浅色浏览器主题。
const BUSY_COLOR = '#38bdf8'
const DONE_COLOR = '#4ade80'
// favicon viewBox 是 "55 55 130 130"，右下角落点 (158,158) r20 + 8 描边不越界。
const dotSvg = (color: string) =>
  `<circle cx="158" cy="158" r="20" fill="${color}" stroke="#0c0a09" stroke-width="8"/>`

let state: State = 'idle'
let lastMode: Mode = false
let everSustained = false
let confirmTimer: ReturnType<typeof setTimeout> | null = null
let baseSvg: string | null = null
let baseHref: string | null = null

function applyHref(href: string): void {
  // 首次落到这里时记下原 favicon 地址（idle 恢复用）
  if (baseHref === null) {
    const cur = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    baseHref = cur?.getAttribute('href') ?? '/favicon.svg'
  }
  // Chrome 偶发不刷新同一 <link> 的 href：移除重建而不是原地改
  document.querySelectorAll('link[rel="icon"]').forEach((el) => el.remove())
  const el = document.createElement('link')
  el.rel = 'icon'
  el.type = 'image/svg+xml'
  el.href = href
  document.head.appendChild(el)
}

async function loadBase(): Promise<string | null> {
  if (baseSvg !== null) return baseSvg
  try {
    baseSvg = await fetch(baseHref ?? '/favicon.svg').then((r) => r.text())
  } catch {
    return null // 拿不到底图就不折腾，原 favicon 保持原样（下次状态切换会再试）
  }
  return baseSvg
}

async function render(): Promise<void> {
  if (state === 'idle') {
    if (baseHref !== null) applyHref(baseHref)
    return
  }
  const svg = await loadBase()
  if (svg === null) return
  const dot = dotSvg(state === 'busy' ? BUSY_COLOR : DONE_COLOR)
  applyHref(`data:image/svg+xml,${encodeURIComponent(svg.replace('</svg>', dot + '</svg>'))}`)
}

function setState(next: State): void {
  if (state === next) return
  state = next
  void render()
}

function clearConfirm(): void {
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

// ContainerList 的 watcher 喂：false = 无组在输出；'busy' = 有输出但本轮还没成段；
// 'sustained' = 有输出且本轮已有 ≥ SUSTAIN_MS 的成段活动。
export function setFaviconBusy(mode: Mode): void {
  lastMode = mode
  if (mode === false) {
    if (state === 'busy' && everSustained && document.hidden) {
      // 确认窗：agent 思考停顿的短静默走不到头，走完且仍离开才认定收尾
      if (!confirmTimer) {
        confirmTimer = setTimeout(() => {
          confirmTimer = null
          if (state === 'busy' && document.hidden) setState('done')
        }, QUIET_CONFIRM_MS)
      }
    } else {
      clearConfirm()
      setState('idle')
    }
    everSustained = false
  } else {
    clearConfirm()
    everSustained ||= mode === 'sustained'
    setState('busy')
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  clearConfirm()
  // 回到本页即熄；工具还在跑的话立即点亮 busy（watcher 只在变化时发，得在这里补）
  setState(lastMode === false ? 'idle' : 'busy')
})
