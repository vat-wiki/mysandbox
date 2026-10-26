import { ref } from 'vue'

// 手机软键盘的全局状态（visualViewport 单一真相源，模块级单例）。
//
// 归属边界（同 docs/architecture/web.md「Teleport 覆盖层归属」）：本文件只产出
// 「键盘开没开 / 多高 / 键盘顶在哪」这类**无归属争议**的全局信号；谁该跟着动
// （终端盒子让位、工具条定位、底栏收起）由各消费方按自己的归属门控自行决定
// （终端那边是本实例持焦，见 usePhoneToolbar）。所有实例共享同一份键盘态。
//
// 两个"开"的语义不同，消费方按需要挑：
//   kbRaw  立即态：vv 差值刚超过阈值就算开，关也立刻算关。工具条显隐/底栏收起用它
//          （要跟手，键盘动画期间工具条就贴着键盘走）。
//   kbOpen 稳定态：开了等动画 settle（KB_SETTLE）+ 高度量化（KB_STEP），关了延迟
//          KB_CLOSE_DELAY 才落。终端盒子让位用它——每次开合只允许一次真正 resize。
//
// 为什么不走浏览器的 resize 语义（`interactive-widget=resizes-content` / Android
// adjustResize）：那会让 window.innerHeight 跟着缩，本文件的判据
// `innerHeight - vv.height - vv.offsetTop` 恒为 0，键盘就"探测不到"了；而 iOS Safari
// 压根不支持该 meta，两端仍得自己按 visualViewport 让位。统一一条路更好推理。
// 实测：Chrome Android 默认（resizes-visual）与 iOS Safari 下判据都成立。

/** 小于此差值视为地址栏/顶部栏伸缩，不是键盘（最矮的软键盘也在 200px 以上） */
const KB_MIN = 120
/** 高度量化：变化小于此不重建终端尺寸（≈2 行）。吞掉候选栏/预测栏的增减抖动 */
const KB_STEP = 48
/** 键盘动画 settle：连续 vv 事件停住后再应用，动画期间一次都不 resize */
const KB_SETTLE = 80
/**
 * 收键盘延迟恢复（非对称）：键盘收起后不立刻把终端撑回来，等这么久；
 * 窗口内重新聚焦/再弹键盘就取消——「收起来看一眼再点回来」不产生任何 resize。
 * 这是压掉「频繁切键盘来回 resize」的主要手段，数值偏大是有意的。
 */
const KB_CLOSE_DELAY = 900

/** 立即态：键盘在场 */
const kbRaw = ref(false)
/** 稳定态：键盘在场（含收起后的延迟窗口期） */
const kbOpen = ref(false)
/** 稳定态键盘高度（px）。量化过的值，只在变化 ≥ KB_STEP 时更新 */
const kbHeight = ref(0)
/** 键盘顶边在**布局视口**坐标里的位置：position: fixed 的定位基准 */
const kbTop = ref(0)
/** visualViewport 的尺寸/偏移（工具条、让位计算的几何输入） */
const vvHeight = ref(0)
const vvOffsetTop = ref(0)
/** 每次 vv 事件自增：给依赖几何量的 computed 当重算触发器 */
const vvTick = ref(0)

let started = false
let settleTimer = 0
let closeTimer = 0

function clearSettle() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = 0
}

function clearClose() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = 0
}

function applyKeyboard(raw: number) {
  if (raw <= KB_MIN) return
  // 已开且高度变化不足一个量化台阶：保持原值，不触发下游重排
  if (kbOpen.value && Math.abs(raw - kbHeight.value) < KB_STEP) return
  kbOpen.value = true
  kbHeight.value = raw
}

function scheduleClose() {
  if (!kbOpen.value || closeTimer) return
  closeTimer = window.setTimeout(() => {
    closeTimer = 0
    kbOpen.value = false
    kbHeight.value = 0
  }, KB_CLOSE_DELAY)
}

function onVv() {
  const vv = window.visualViewport
  if (!vv) return
  // 只在几何真的动了才打 tick：每个终端实例都挂着一个吃 tick 的 computed
  // （要 getBoundingClientRect），滚动事件空转时别让它反复量布局。
  const moved = vv.height !== vvHeight.value || vv.offsetTop !== vvOffsetTop.value
  vvHeight.value = vv.height
  vvOffsetTop.value = vv.offsetTop
  kbTop.value = Math.round(vv.offsetTop + vv.height)
  if (moved) vvTick.value++
  const raw = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
  kbRaw.value = raw > KB_MIN
  if (raw <= KB_MIN) {
    // 键盘收起（或地址栏伸缩）：稳定态延迟恢复，窗口内重开则取消
    clearSettle()
    scheduleClose()
    return
  }
  // 键盘在场：等动画帧串停住再落到稳定态（iOS 弹起约 250ms，期间 vv 连续派发）
  clearClose()
  clearSettle()
  settleTimer = window.setTimeout(() => {
    settleTimer = 0
    applyKeyboard(raw)
  }, KB_SETTLE)
}

function startWatch() {
  if (started) return
  started = true
  const vv = window.visualViewport
  if (!vv) return
  vv.addEventListener('resize', onVv)
  vv.addEventListener('scroll', onVv)
  onVv()
}

export function useVirtualKeyboard() {
  startWatch()
  return { kbRaw, kbOpen, kbHeight, kbTop, vvHeight, vvOffsetTop, vvTick }
}
