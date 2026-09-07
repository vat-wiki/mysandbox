// 终端「无输出提醒」的前端侧（模块级单例）：输出时刻登记 + 安静跳变检测 + 活跃投影。
//
// 与 serviceJobs.ts 同一套「见过 A 落到 B 才提醒」的去重模式：主窗口与 popout 各有
// 一份 ContainerList 轮询、各自维护自己的跳变表，命中同一次跳变各自只发一条；页面
// 刷新/首拉不补发历史提醒（首拍基线不产生跳变）。
//
// 「在不在看」的关联（谁该被提醒）由 ContainerList 决定，这里只负责四件事：
//   1) noteTermOutput：Terminal.vue 每收到一个数据帧就登记该终端的最后输出时刻——
//      可见 tab 是 v-show 常驻（WS 恒 attach），这比服务端 5s 扫描精确得多。输出分
//      两本账：lastOutput 全量登记（呼吸光晕用），lastNotable 只记 prime 窗口（首帧
//      后 PRIME_MS）之后的帧——attach 整屏重绘/新会话 prompt/页面加载批量 attach 都
//      落在窗口内，属于「打开动作自带的画面」而非新内容，不进提醒资格；
//   2) snapTermBaseline / termContentChanged：离开时刻的画面快照 vs 当前画面，纯重绘
//      （重连还原、resize 重排）内容不变就不提醒——「内容有过变化」才配弹；
//   3) trackTerminalActivity：喂入调用方算好的每叶子 quiet 布尔，只在 false→true
//      跳变时返回该叶子，调用方按组归并弹 toast；
//   4) termActiveIds：把帧级 lastOutput 低频投影成响应式的「正在输出」集合，供
//      tab 身份点的呼吸光晕用。
import { ref } from 'vue'

// termId -> 最后输出时刻（epoch ms）。仅本窗口 attach 着的终端有值且持续更新。
const lastOutput = new Map<string, number>()

export function noteTermOutput(termId: string): void {
  const now = Date.now()
  lastOutput.set(termId, now)
  if (!firstSeen.has(termId)) firstSeen.set(termId, now)
  if (now - (firstSeen.get(termId) as number) >= PRIME_MS) lastNotable.set(termId, now)
  ensureSampler()
}

export function forgetTerm(termId: string): void {
  lastOutput.delete(termId)
  firstSeen.delete(termId)
  lastNotable.delete(termId)
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

// —— 「正在输出」投影 ——
// 帧登记走普通 Map（不走响应式）：TUI 全速重绘时每秒上百帧，直连响应式会拖着 tab
// 栏跟着重渲染。这里 1s 采样一次投影成 Set，且成员没变就不替换引用——UI 每秒最多
// 重算一次、多数秒什么都不发生。ACTIVE_MS 是「还活着」的判定窗：agent 干活时恒在
// 重绘（帧间隔 << 4s），停手/等输入后 4s 内光晕熄灭。采样器一经启动常驻（空转成本
// 可忽略），不随集合清空而停。
const ACTIVE_MS = 4000
const activeIds = ref<ReadonlySet<string>>(new Set())
let sampler: ReturnType<typeof setInterval> | null = null

function ensureSampler(): void {
  if (sampler) return
  sampler = setInterval(() => {
    const now = Date.now()
    const next = new Set<string>()
    for (const [t, at] of lastOutput) {
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

export interface QuietFeedItem {
  key: string
  quiet: boolean
  quietMs: number
}

const prevQuiet = new Map<string, boolean>()

// 喂入一次快照（调用方已按「本窗口关心的叶子 + 开关」过滤），返回本次新落到
// quiet 的叶子。快照里没出现的 key 同步清掉（组关了/开关关了），防 Map 无界增长。
export function trackTerminalActivity(feed: QuietFeedItem[]): QuietFeedItem[] {
  const hits: QuietFeedItem[] = []
  const seen = new Set<string>()
  for (const it of feed) {
    seen.add(it.key)
    const prev = prevQuiet.get(it.key)
    prevQuiet.set(it.key, it.quiet)
    if (it.quiet && prev === false) hits.push(it)
  }
  for (const k of [...prevQuiet.keys()]) if (!seen.has(k)) prevQuiet.delete(k)
  return hits
}

