// 浏览器 tab 标题运行状态（模块级单例，每个浏览器窗口一份）：
// 把「有工具在跑」投影到标签标题前缀上——终端 tab 栏的状态点只在站内可见，切去
// 别的浏览器 tab 后标题是唯一零成本可见的展示面。
//
// 三态：idle（原标题）→ busy（月相轮播 = 运行中）→ done（✅ = 收尾完成）。
// 设计要点：
//   - busy 有迟滞：本轮输出成段（termRunSpanMs ≥ SUSTAIN_MS）即记「有效运行」，之后
//     整个运行期间保持 busy——agent 思考停顿/翻读文件的无输出期不摘标记；停流后走
//     确认窗（QUIET_CONFIRM_MS，与站内无输出提醒同源），走完且页面仍不在前台才落
//     done。期间任何新输出都撤回 busy，思考停顿不闪「假完成」；
//   - 秒级命令（敲个 ls）不成段：停流即回原标题，不留任何状态；
//   - 前台不给 done：用户正看着，tab 栏状态点就是即时信号，标题无需参与；
//   - done 是给离开的人看的：回到本页（visibilitychange → visible）即熄回原标题，
//     工具仍在跑则由调用方下一拍重新点亮 busy。
// 渲染 = 标题前缀拼接（状态记号 + 基础标题），零请求零 DOM 改动。曾用 favicon
// 动态点方案：每次状态切换移除重建 <link rel="icon">，idle 恢复时浏览器还会重新
// 拉 /favicon.svg——网络面板看着像在刷接口，且重建 link 各浏览器行为不一，退役。
// 后台 tab 的定时器会被浏览器节流，状态切换最多滞后约一分钟。
import { QUIET_CONFIRM_MS } from './terminalActivity'

type Mode = false | 'busy' | 'sustained'
type State = 'idle' | 'busy' | 'done'

// busy 动画 = 月相轮播（转到满月再亏回来，一眼是「在转」不是静态符号）；每帧一个
// emoji，250ms 一拍 ≈ 2s 一轮。后台 tab 定时器被节流后动画变慢甚至近停——没关系，
// busy 本来就要保持整个运行期，慢速轮播/任意一帧都仍是「在跑」的信号。
const BUSY_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘']
const BUSY_FRAME_MS = 250
const DONE_MARK = '✅'

let state: State = 'idle'
let lastMode: Mode = false
let everSustained = false
let confirmTimer: ReturnType<typeof setTimeout> | null = null
let spinTimer: ReturnType<typeof setInterval> | null = null
let spinIdx = 0
// 基础标题 = 状态记号之外的部分：主窗口是 index.html 的「MySandbox」，popout 窗口
// 是「<组名> · mysandbox」（ContainerList 的 activeTitle watcher 经 setTabBaseTitle 喂）。
let baseTitle = document.title

function apply(): void {
  const mark = state === 'busy' ? BUSY_FRAMES[spinIdx] : state === 'done' ? DONE_MARK : ''
  document.title = mark ? `${mark} ${baseTitle}` : baseTitle
}

function stopSpin(): void {
  if (spinTimer) {
    clearInterval(spinTimer)
    spinTimer = null
  }
}

function setState(next: State): void {
  if (state === next) return
  state = next
  if (state === 'busy') {
    spinIdx = 0
    if (!spinTimer) spinTimer = setInterval(() => ((spinIdx = (spinIdx + 1) % BUSY_FRAMES.length), apply()), BUSY_FRAME_MS)
  } else {
    stopSpin()
  }
  apply()
}

function clearConfirm(): void {
  if (confirmTimer) {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }
}

// ContainerList 的 watcher 喂：false = 无组在输出；'busy' = 有输出但本轮还没成段；
// 'sustained' = 有输出且本轮已有 ≥ SUSTAIN_MS 的成段活动。
export function setTabBusy(mode: Mode): void {
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

// 基础标题变化时重算（popout 动态标题跟随当前组；主窗口不调这个）
export function setTabBaseTitle(t: string): void {
  if (baseTitle === t) return
  baseTitle = t
  apply()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  clearConfirm()
  // 回到本页即熄；工具还在跑的话立即点亮 busy（watcher 只在变化时发，得在这里补）
  setState(lastMode === false ? 'idle' : 'busy')
})
