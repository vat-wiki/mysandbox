// favicon 帧循环：Chromium 把 SVG favicon 栅格化成静态图，内嵌 CSS/SMIL 动画不播
// （只有 Firefox 原生播）。照 favicon-pong 的路子对同一个 <link rel="icon"> 换
// data URL 帧。两个刻意的边界：
// ① 只 setAttribute、不 remove/重建 <link>——重建会触发对 /favicon.svg 的重新
//    拉取（tabStatus.ts 注释里的旧坑），data URL 换 href 零网络请求；
// ② 帧字符串在启动时一次性编码好，setInterval 只做查表 + 赋值，y 不变不写。
// 节奏对齐 favicon.svg 里的 CSS 动画（2.6s 一拍，前 1.6s 静止）； prefers-reduced-motion 不播。
const FRAME_MS = 100
// 一个 2.6s 周期按 100ms 切 26 槽：0..15 静止，16..21 掀起/落下，22..25 归位
const TIMELINE = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  -5, -9, -10, -10, -6, -2,
  0, 0, 0, 0,
]

// 盒身各层与 favicon.svg 同源（顶盖留到运行时按 y 拼进动画层）
const BODY = [
  '<polygon points="66,107 120,134 120,184 66,157" fill="#FF9E2C"/>',
  '<polygon points="120,134 174,107 174,157 120,184" fill="#EF7215"/>',
  '<g stroke="#FFDE8F" stroke-width="4" stroke-linecap="round" opacity="0.45" fill="none">' +
    '<line x1="79.5" y1="114" x2="79.5" y2="164"/><line x1="93" y1="120.5" x2="93" y2="170.5"/>' +
    '<line x1="106.5" y1="127" x2="106.5" y2="177"/><line x1="133.5" y1="127" x2="133.5" y2="177"/>' +
    '<line x1="147" y1="120.5" x2="147" y2="170.5"/><line x1="160.5" y1="114" x2="160.5" y2="164"/>' +
  '</g>',
  '<polygon points="66,97 120,124 120,134 66,107" fill="#B8860B"/>',
  '<polygon points="120,124 174,97 174,107 120,134" fill="#B8860B"/>',
]
const LID =
  '<polygon points="120,56 174,83 120,110 66,83" fill="#FFC53D"/>' +
  '<polygon points="66,83 120,110 120,124 66,97" fill="#FF9E2C"/>' +
  '<polygon points="120,110 174,83 174,97 120,124" fill="#EF7215"/>'

function frameSvg(y: number): string {
  const lid = y === 0 ? `<g>${LID}</g>` : `<g transform="translate(0 ${y})">${LID}</g>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="55 55 130 130">` +
    BODY.join('') + lid + `</svg>`
  )
}

export function startAnimatedFavicon(): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const link = document.querySelector<HTMLLinkElement>("head > link[rel*='icon']")
  if (!link) return
  const frames = TIMELINE.map((y) => `data:image/svg+xml,${encodeURIComponent(frameSvg(y))}`)
  let i = 0
  let lastY = NaN
  setInterval(() => {
    const y = TIMELINE[i]
    const frame = frames[i]
    i = (i + 1) % TIMELINE.length
    if (y === lastY) return // 大半周期静止，不动 href
    lastY = y
    link.href = frame
  }, FRAME_MS)
}
