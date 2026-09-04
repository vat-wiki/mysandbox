// 终端「无输出提醒」的前端侧（模块级单例）：输出时刻登记 + 安静跳变检测。
//
// 与 serviceJobs.ts 同一套「见过 A 落到 B 才提醒」的去重模式：主窗口与 popout 各有
// 一份 ContainerList 轮询、各自维护自己的跳变表，命中同一次跳变各自只发一条；页面
// 刷新/首拉不补发历史提醒（首拍基线不产生跳变）。
//
// 「在不在看」的关联（谁该被提醒）由 ContainerList 决定，这里只负责两件事：
//   1) noteTermOutput：Terminal.vue 每收到一个数据帧就登记该终端的最后输出时刻——
//      可见 tab 是 v-show 常驻（WS 恒 attach），这比服务端 5s 扫描精确得多；
//   2) trackTerminalActivity：喂入调用方算好的每叶子 quiet 布尔，只在 false→true
//      跳变时返回该叶子，调用方按组归并弹 toast。
import { termSessionKey, type TermActivityView } from '@/lib/api'

// termId -> 最后输出时刻（epoch ms）。仅本窗口 attach 着的终端有值且持续更新。
const lastOutput = new Map<string, number>()

export function noteTermOutput(termId: string): void {
  lastOutput.set(termId, Date.now())
}

export function forgetTerm(termId: string): void {
  lastOutput.delete(termId)
}

export function lastTermOutput(termId: string): number | undefined {
  return lastOutput.get(termId)
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

export { termSessionKey }
export type { TermActivityView }
