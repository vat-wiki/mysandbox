// favicon 运行状态（模块级单例，每个浏览器窗口一份）：
// 把「有工具在跑」投影到页面图标上——终端 tab 栏的状态点只在站内可见，切去别的
// 浏览器 tab 就什么都看不到了，favicon 是唯一跨 tab 的展示面。
//
// 三态：idle（原 logo）→ busy（蓝点 = 任一终端组有输出流）→ done（绿点 = 收尾完成）。
// 门槛与回熄：
//   - busy 期间调用方带 sustained 标记（本轮输出有 ≥ SUSTAIN_MS 的成段活动）才算
//     「有效运行」——敲几条命令的秒级输出不算，避免随手一敲就在离开期间留下绿点；
//   - 输出停了不立刻给 done：起 DONE_CONFIRM_MS 确认窗，期间输出恢复（agent 思考
//     停顿）就撤回 busy；窗口走完且页面仍不在前台才亮绿点；
//   - 前台不给 done：用户正看着，tab 栏状态点就是即时信号，favicon 无需参与；
//   - done 是给离开的人看的：回到本页（visibilitychange → visible）即熄回原 logo，
//     若工具仍在跑由调用方下一拍重新点亮 busy。
// 渲染 = 原 favicon.svg 文本 + 右下角状态点拼成 SVG data URL，替换 <link rel="icon">
// 的 href；idle 恢复原 href。后台 tab 的定时器会被浏览器节流，状态切换最多滞后约一分钟。

type Mode = false | 'busy' | 'sustained'
type State = 'idle' | 'busy' | 'done'

// 与橙色 logo 拉开对比：跑=sky-400，完成=green-400；描边用近黑压住浅色浏览器主题。
const BUSY_COLOR = '#38bdf8'
const DONE_COLOR = '#4ade80'
// favicon viewBox 是 "55 55 130 130"，右下角落点 (158,158) r20 + 8 描边不越界。
const dotSvg = (color: string) =>
  `<circle cx="158" cy="158" r="20" fill="${color}" stroke="#0c0a09" stroke-width="8"/>`

export const DONE_CONFIRM_MS = 30_000

let state: State = 'idle'
let lastMode: Mode = false
let everSustained = false
let confirmTimer: ReturnType<typeof setTimeout> | null = null
let baseSvg: string | null = null
let baseHref: string | null = null
let linkEl: HTMLLinkElement | null = null

function iconLink(): HTMLLinkElement | null {
  if (linkEl) return linkEl
  linkEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (linkEl && baseHref === null) baseHref = linkEl.getAttribute('href')
  return linkEl
}

async function render(): Promise<void> {
  const el = iconLink()
  if (!el) return
  if (state === 'idle') {
    if (baseHref) el.setAttribute('href', baseHref)
    return
  }
  if (!baseSvg) {
    try {
      const res = await fetch(baseHref ?? '/favicon.svg')
      baseSvg = await res.text()
    } catch {
      return // 拿不到底图就不折腾，原 favicon 保持原样
    }
  }
  const dot = dotSvg(state === 'busy' ? BUSY_COLOR : DONE_COLOR)
  el.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(baseSvg.replace('</svg>', dot + '</svg>'))}`)
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
    if (state === 'busy') {
      if (everSustained && document.hidden) {
        // 确认窗：agent 思考停顿的短静默走不到头，走完且仍离开才认定收尾
        if (!confirmTimer) {
          confirmTimer = setTimeout(() => {
            confirmTimer = null
            if (state === 'busy' && document.hidden) setState('done')
          }, DONE_CONFIRM_MS)
        }
      } else {
        clearConfirm()
        setState('idle')
      }
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
