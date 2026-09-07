// 终端「无输出提醒」的前端侧（模块级单例）：输出时刻登记 + 内容基线 + 活跃投影。
//
// 「在不在看」与「要不要标」由 ContainerList 决定——提醒形态是 tab 身份点上的常驻
// 状态标（tmux bell 形态），不是 toast：不打断视线，切回组即消。popout 独立窗口各有
// 本模块一份实例，各自登记各自的终端。这里负责四件事：
//   1) noteTermOutput：Terminal.vue 每收到一个数据帧就登记该终端的最后「有效」输出
//      时刻——可见 tab 是 v-show 常驻（WS 恒 attach），这比服务端 5s 扫描精确得多。
//      prime 窗口（首帧后 PRIME_MS）内的帧不登记：attach 整屏重绘/新会话 prompt/
//      页面加载批量 attach 都落在窗口内，属于「打开动作自带的画面」而非新内容，
//      既不进提醒资格也不点亮光晕；
//   2) termRunSpanMs：活动段跨度（帧间隙 < RUN_GAP_MS 链同段）——agent 干活是连续
//      输出，秒级输出（敲命令/日志两行）不配打扰，跨度 ≥ SUSTAIN_MS 才有资格；
//   3) snapTermBaseline / termContentChanged：离开时刻的画面快照 vs 当前画面，纯重绘
//      （重连还原、resize 重排）内容不变就不提醒——「内容有过变化」才配标；
//   4) termActiveIds：把有效输出低频投影成响应式的「正在输出」集合，供 tab 身份点
//      的呼吸光晕用。
import { ref } from 'vue'

export function noteTermOutput(termId: string): void {
  const now = Date.now()
  if (!firstSeen.has(termId)) firstSeen.set(termId, now)
  if (now - (firstSeen.get(termId) as number) >= PRIME_MS) {
    // 活动段登记：帧间隙 < RUN_GAP_MS 链同段，超隙/首帧开新段（runStart 随 lastNotable 同步前移）。
    const last = lastNotable.get(termId)
    if (last === undefined || now - last >= RUN_GAP_MS) runStart.set(termId, now)
    lastNotable.set(termId, now)
  }
  ensureSampler()
}

export function forgetTerm(termId: string): void {
  firstSeen.delete(termId)
  lastNotable.delete(termId)
  runStart.delete(termId)
  baselineHash.delete(termId)
}

// —— 提醒资格的「时刻」门槛：prime 窗口 ——
// 首帧起 PRIME_MS 内的帧不算「新输出」。锚在首帧而非 WS open：慢启动的 zsh（omz +
// 插件）可能几秒不吐一个字节，锚 open 会把窗口耗在静默里。重连不重置 prime——重连
// 的整屏重绘由内容基线挡（画面还原 = 内容没变），而其首帧时刻早已过去、本就该算新帧。
export const PRIME_MS = 3000
const firstSeen = new Map<string, number>()
const lastNotable = new Map<string, number>()

export function lastTermNotableOutput(termId: string): number | undefined {
  return lastNotable.get(termId)
}

// —— 提醒资格的「内容」门槛：离开时刻的画面基线 ——
// markLeft 时 Terminal.screenHash() 快照当前视口；安静判定时再取一次对比。
const baselineHash = new Map<string, string>()

export function snapTermBaseline(termId: string, hash: string | undefined): void {
  if (hash !== undefined) baselineHash.set(termId, hash)
}

// 基线缺失（从没看过/拿不到快照）或当前快照缺失时不设门放行——还有 prime/时刻门槛
// 兜底，宁可少弹不可误弹的反面在这里让位：缺快照时按原时刻逻辑走。
export function termContentChanged(termId: string, currentHash: string | undefined): boolean {
  const base = baselineHash.get(termId)
  if (base === undefined || currentHash === undefined) return true
  return base !== currentHash
}

// —— 提醒资格的「活动段」门槛：agent 干活是连续输出 ——
// 敲个 ls、dev server 吐两行日志都是秒级输出，不配打扰；「连续输出持续了一段然后
// 停下」才是 agent 干完活/等你输入的形态特征。帧间隙 < RUN_GAP_MS 的有效输出链成同
// 一活动段（间隙阈值取 3min：agent 思考停顿一两分钟不断段，否则收尾前短段会漏报），
// 段跨度 = 末帧 - 首帧；跨度 ≥ SUSTAIN_MS 的段收尾才算数。静默确认见 QUIET_CONFIRM_MS。
// SUSTAIN 取 1min：agent 真实干活多数在 1-3 分钟量级，3min 实测偏保守漏报；30s 太近
// 「几条快速命令链着跑」的下限。出点的总延迟由 QUIET_CONFIRM_MS 决定，降它不更快。
export const RUN_GAP_MS = 180_000
export const SUSTAIN_MS = 60_000
// 「停了」的确认窗：静默满 1 分钟才认定活动段收尾（<1min 内恢复无感）——agent 思考
// 停顿 30s 不至于闪标。调用方取 max(服务端阈值, 此值) 作安静门槛。
export const QUIET_CONFIRM_MS = 60_000
const runStart = new Map<string, number>()

// 当前（或刚收尾的）活动段跨度：末帧 - 首帧。无有效输出返回 0。
export function termRunSpanMs(termId: string): number {
  const start = runStart.get(termId)
  const last = lastNotable.get(termId)
  if (start === undefined || last === undefined) return 0
  return Math.max(0, last - start)
}

// 作废活动段（切回组消费提醒时调）：链式跨度的间隙阈值是分钟级，若不清，提醒消费后
// 很快来的小输出（敲个 ls）会继承旧段跨度凑满 sustain、误挂标——看过即作废，新资格
// 必须来自新段。
export function resetTermRun(termId: string): void {
  runStart.delete(termId)
}

// —— 「正在输出」投影 ——
// 帧登记走普通 Map（不走响应式）：TUI 全速重绘时每秒上百帧，直连响应式会拖着 tab
// 栏跟着重渲染。这里 1s 采样一次投影成 Set，且成员没变就不替换引用——UI 每秒最多
// 重算一次、多数秒什么都不发生。ACTIVE_MS 是「还活着」的判定窗：agent 干活时恒在
// 重绘（帧间隔 << 4s），停手/等输入后 4s 内光晕熄灭。投影吃 lastNotable（prime 后
// 的有效输出）而非全量帧：attach 重绘/初始 prompt 只属于打开动作，不该把 tab 点亮
// 成「在干活」。采样器一经启动常驻（空转成本可忽略），不随集合清空而停。
const ACTIVE_MS = 4000
const activeIds = ref<ReadonlySet<string>>(new Set())
let sampler: ReturnType<typeof setInterval> | null = null

function ensureSampler(): void {
  if (sampler) return
  sampler = setInterval(() => {
    const now = Date.now()
    const next = new Set<string>()
    for (const [t, at] of lastNotable) {
      if (now - at < ACTIVE_MS) next.add(t)
    }
    const cur = activeIds.value
    if (next.size === cur.size && [...next].every((x) => cur.has(x))) return
    activeIds.value = next
  }, 1000)
}

// 本窗口正在输出的叶子集合（只读投影，ContainerList 按组聚合点亮 tab 身份点）。
export function termActiveIds(): ReadonlySet<string> {
  return activeIds.value
}

