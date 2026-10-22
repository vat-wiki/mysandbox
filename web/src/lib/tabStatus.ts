// 浏览器 tab 标题运行状态（模块级单例，每个浏览器窗口一份）：
// 把「有工具在跑」投影到标签标题上——终端 tab 栏的状态点只在站内可见，切去别的
// 浏览器 tab 后标题是唯一零成本可见的展示面。
//
// 三态：idle（原标题）→ busy（轮换展示运行中任务的标题）→ done（✅ 前缀 = 收尾完成）。
// 设计要点：
//   - busy 有迟滞：本轮输出成段（termRunSpanMs ≥ SUSTAIN_MS）即记「有效运行」，之后
//     整个运行期间保持 busy——agent 思考停顿/翻读文件的无输出期不摘；停流后走确认窗
//     （QUIET_CONFIRM_MS，与站内无输出提醒同源），走完且页面仍不在前台才落 done。
//     期间任何新输出都撤回 busy，思考停顿不闪「假完成」；
//   - 秒级命令（敲个 ls）不成段：停流即回原标题，不留任何状态；
//   - 前台不给 done：用户正看着，tab 栏状态点就是即时信号，标题无需参与；
//   - done 是给离开的人看的：回到本页（visibilitychange → visible）即熄回原标题，
//     工具仍在跑则由调用方下一拍重新点亮 busy。
// 渲染 = 纯 document.title 拼接，零请求零 DOM 改动（曾用 favicon 动态点方案：每次
// 状态切换移除重建 <link rel="icon">，idle 恢复时浏览器还会重新拉 /favicon.svg——
// 网络面板看着像在刷接口，且重建 link 各浏览器行为不一，退役）。
// 后台 tab 的定时器会被浏览器节流，轮换变慢——busy 本来就要保持整个运行期，无碍。
import { QUIET_CONFIRM_MS } from './terminalActivity'

type Mode = false | 'busy' | 'sustained'
type State = 'idle' | 'busy' | 'done'

const DONE_MARK = '✅'
// 多任务时标题轮换一拍；单任务静态展示不需要定时器
const TASK_ROTATE_MS = 2000

let state: State = 'idle'
let lastMode: Mode = false
let everSustained = false
let confirmTimer: ReturnType<typeof setTimeout> | null = null
let rotateTimer: ReturnType<typeof setInterval> | null = null
// 运行中任务标题（busy 态在标题里轮换展示；调用方随 setTabBusy 一起喂）：
let tasks: string[] = []
let taskIdx = 0
// 基础标题 = busy 任务轮换之外的部分：主窗口是 index.html 的「MySandbox」，popout
// 窗口是「<组名> · mysandbox」（ContainerList 的 activeTitle watcher 经 setTabBaseTitle 喂）。
let baseTitle = document.title

function apply(): void {
  if (state === 'done') {
    document.title = `${DONE_MARK} ${baseTitle}`
    return
  }
  // busy 且有任务清单时正文轮换成任务标题（多任务带 i/n 计数），否则用基础标题
  let body = baseTitle
  if (state === 'busy' && tasks.length) {
    const i = taskIdx % tasks.length
    const t = tasks[i]
    body = tasks.length > 1 ? `${t}（${i + 1}/${tasks.length}）· mysandbox` : `${t} · mysandbox`
  }
  document.title = body
}

function stopRotate(): void {
  if (rotateTimer) {
    clearInterval(rotateTimer)
    rotateTimer = null
  }
}

// 轮换定时器只在该跑的时候跑：busy 且任务多于一个（单任务静态展示即可）
function syncRotate(): void {
  if (state === 'busy' && tasks.length > 1) {
    if (!rotateTimer) {
      rotateTimer = setInterval(() => {
        taskIdx = (taskIdx + 1) % tasks.length
        apply()
      }, TASK_ROTATE_MS)
    }
  } else {
    stopRotate()
  }
}

function setState(next: State): void {
  if (state === next) return
  state = next
  syncRotate()
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

// 运行中任务标题清单（busy 态标题里轮换展示；与 setTabBusy 同一拍喂入）。空 = 回落
// 基础标题。清单变化时游标收回界内（旧清单缩短防越界），并按新数量启停轮换。
export function setTabTasks(list: string[]): void {
  tasks = list
  if (taskIdx >= tasks.length) taskIdx = 0
  syncRotate()
  apply()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  clearConfirm()
  // 回到本页即熄；工具还在跑的话立即点亮 busy（watcher 只在变化时发，得在这里补）
  setState(lastMode === false ? 'idle' : 'busy')
})
