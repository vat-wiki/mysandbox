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
/**
 * 本轮键盘是不是「布局视口模式」（浏览器自己缩了布局）。真 → 消费方需要反向补偿
 * （把容器钉回开键盘前的高度）；视觉视口模式布局没动，钉高只会引入无谓的漂移。
 */
const layoutMode = ref(false)
/** 键盘顶边在**布局视口**坐标里的位置：position: fixed 的定位基准 */
const kbTop = ref(0)
/**
 * 稳定态生效那一刻的键盘顶边快照。让位量必须用快照：收键盘的延迟窗口里
 * 键盘已经走了，实时 kbTop 会跳回屏幕底部，终端会提前撑回去。
 */
const kbTopAtOpen = ref(0)
/** visualViewport 的尺寸/偏移（工具条、让位计算的几何输入） */
const vvHeight = ref(0)
const vvOffsetTop = ref(0)
/**
 * 无键盘时的布局视口高度基线（只用于**识别**布局视口模式的键盘，不参与让位计算）。
 * 取历史最大值：地址栏自动隐藏会让 innerHeight 变大，取 max 才能保证键盘出现时的
 * 「基线 − 当前值」永远是真实键盘高度量级。
 */
let baseHeight = 0
/** 每次 vv 事件自增：给依赖几何量的 computed 当重算触发器 */
const vvTick = ref(0)

let started = false
let settleTimer = 0
let closeTimer = 0
let baseWidth = 0

function clearSettle() {
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = 0
}

function clearClose() {
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = 0
}

// 键盘开/关的最终几何不一定会再派发事件（实测华为浏览器：键盘完全收起后没有最后一拍
// vv/resize，尺寸量在半路——容器比可视区高几十 px，终端多算几行）。
// 所以状态一翻转就补两次定时重测（幂等，只是再读一次 innerHeight 重算）。
let rechecks: number[] = []
function scheduleRecheck() {
  for (const t of rechecks) clearTimeout(t)
  rechecks = [320, 820].map((d) => window.setTimeout(onVv, d))
}

function applyKeyboard(raw: number, byLayout: boolean) {
  if (raw <= KB_MIN) return
  // 已开且高度变化不足一个量化台阶：保持原值，不触发下游重排
  if (kbOpen.value && Math.abs(raw - kbHeight.value) < KB_STEP) return
  kbOpen.value = true
  kbHeight.value = raw
  kbTopAtOpen.value = kbTop.value
  layoutMode.value = byLayout
}

function scheduleClose() {
  if (!kbOpen.value || closeTimer) return
  closeTimer = window.setTimeout(() => {
    closeTimer = 0
    kbOpen.value = false
    kbHeight.value = 0
    layoutMode.value = false
  }, KB_CLOSE_DELAY)
}

function onVv() {
  const vv = window.visualViewport
  if (!vv) return
  const ih = window.innerHeight
  const iw = window.innerWidth
  // 转屏：基线与键盘态全部作废（宽度一变，之前的「无键盘高度」没有参考意义）
  if (iw !== baseWidth) {
    baseWidth = iw
    baseHeight = ih
    clearSettle()
    clearClose()
    kbRaw.value = false
    kbOpen.value = false
    kbHeight.value = 0
  }
  // 只在几何真的动了才打 tick：每个终端实例都挂着一个吃 tick 的 computed
  // （要 getBoundingClientRect），滚动事件空转时别让它反复量布局。
  const moved = vv.height !== vvHeight.value || vv.offsetTop !== vvOffsetTop.value
  vvHeight.value = vv.height
  vvOffsetTop.value = vv.offsetTop
  kbTop.value = Math.round(vv.offsetTop + vv.height)
  if (moved) vvTick.value++

  // 两种浏览器键盘模式，取能用的那个：
  //   ① 视觉视口模式（iOS Safari / Chrome Android 默认 resizes-visual）：
  //      布局不动，vv 矮了 → 差值 = 键盘高。
  //   ② 布局视口模式（Android adjustResize；华为浏览器实测是这样）：
  //      布局视口自己缩，innerHeight 与 vv.height 同步变，差值恒为 0 → 用
  //      「无键盘基线 − 当前 innerHeight」识别。第二种模式下浏览器已经把内容
  //      让过位了，我们只需要再给工具条腾地方（见 kbTopAtOpen 的用法）。
  const rawVisual = Math.max(0, Math.round(ih - vv.height - vv.offsetTop))
  const byVisual = rawVisual > KB_MIN
  const layoutShrunk = Math.abs(ih - vv.height) < 4 // 布局与视觉同高 = 没有浮层键盘
  // 只在手机宽度内认这种模式：桌面拖窗也会让 innerHeight 小于历史最大值，误判成键盘
  // 会让底栏/工具条跟着抖（虽然各处都有 isPhone 闸，但状态本身也不该乱翻）
  const rawLayout = layoutShrunk && iw <= 768 ? Math.max(0, Math.round(baseHeight - ih)) : 0
  const raw = byVisual ? rawVisual : rawLayout > KB_MIN ? rawLayout : rawVisual

  const wasRaw = kbRaw.value
  kbRaw.value = raw > KB_MIN
  if (wasRaw !== kbRaw.value) scheduleRecheck()
  if (raw <= KB_MIN) {
    // 基线只在键盘确认关闭时抬高（max：地址栏自动隐藏会让 innerHeight 变大，
    // 取 max 才能让下次键盘出现时的差值仍是真实键盘高度量级）
    if (!kbOpen.value) baseHeight = Math.max(baseHeight, ih)
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
    applyKeyboard(raw, !byVisual)
  }, KB_SETTLE)
}

function startWatch() {
  if (started) return
  started = true
  baseWidth = window.innerWidth
  baseHeight = window.innerHeight
  const vv = window.visualViewport
  if (!vv) return
  vv.addEventListener('resize', onVv)
  vv.addEventListener('scroll', onVv)
  // 布局视口模式（②）下 vv 的 resize 未必每次都来，window.resize 兜一层
  window.addEventListener('resize', onVv)
  onVv()
}

export function useVirtualKeyboard() {
  startWatch()
  return { kbRaw, kbOpen, kbHeight, kbTop, kbTopAtOpen, layoutMode, vvHeight, vvOffsetTop, vvTick }
}
