// 全局事件层：SSE 单例订阅（/api/events，server/events.ts）+ 文件 watch 声明
// （POST /api/file-watches，server/fileWatch.ts）。
//
// 事件驱动替代固定轮询：容器/服务状态（lxc-monitor、docker events 旁路转发）与文件
// 变化（fs.watch）推给前端，各消费方收到事件才刷新；1s/3s 级轮询撤成 30s 级对账兜底
// （watcher 断了、事件丢了、s:/ssh 这类 watch 不了的目标都靠它）。本模块保证**全页面
// 只有一条 SSE 连接**：订阅者进 Set，首订阅建连、末订阅断开，断线指数退避重连。
//
// 文件 watch 声明是「全量替换」语义：组件挂载/导航时 setWatchDirs 声明自己正在看的
// 目录，卸载时传 null 撤销；模块内合并全部存活声明（按 target 并集 dirs）防抖后 POST，
// 20s 心跳续命——服务端按 clientId + TTL 记账，窗口关闭后声明自然过期回收。
import { postJson, getToken, Unauthorized } from './api'

export type SandboxEvent =
  | { type: 'container-state'; name: string; action: string }
  | { type: 'service-state'; name: string; action: string }
  | { type: 'file-changed'; target: string; dir: string }
  | { type: 'hello' }

// —— SSE 单例 ——
const listeners = new Set<(e: SandboxEvent) => void>()
let started = false
let stopped = false
let delay = 1_000
let controller: AbortController | null = null

async function sseLoop(): Promise<void> {
  while (!stopped) {
    try {
      controller = new AbortController()
      // 不走 api()：那条路径有 10s 超时，会掐死长连接。这里裸 fetch + 流式读。
      const res = await fetch('/api/events', {
        headers: { 'x-sandbox-token': getToken() ?? '' },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) throw new Error(`events stream ${res.status}`)
      delay = 1_000 // 连上即复位
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          // SSE 帧只发 data 行；': ping' 心跳注释行没有 data，天然跳过
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          try {
            const e = JSON.parse(dataLine.slice(5).trim()) as SandboxEvent
            for (const cb of [...listeners]) {
              try {
                cb(e)
              } catch {
                /* 单订阅者回调炸不拖垮分发 */
              }
            }
          } catch {
            /* 坏帧丢弃 */
          }
        }
      }
    } catch {
      /* 断流/网络抖动：退避重连（Unauthorized 也会走这里，重连无害） */
    }
    if (stopped) return
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 2, 15_000)
  }
}

/** 订阅全局事件。返回退订函数；末一个退订者触发断连。 */
export function onSandboxEvent(cb: (e: SandboxEvent) => void): () => void {
  listeners.add(cb)
  if (!started) {
    started = true
    stopped = false
    void sseLoop()
  }
  return () => {
    listeners.delete(cb)
    if (!listeners.size && started) {
      stopped = true
      started = false
      try {
        controller?.abort()
      } catch {
        /* noop */
      }
    }
  }
}

// —— 文件 watch 声明 ——
type WatchItem = { target: string; dirs: string[] }

const declarations = new Map<string, WatchItem>() // owner key → 声明
let pushTimer: ReturnType<typeof setTimeout> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function clientId(): string {
  // 每页面一份：服务端按 clientId + TTL 记账（45s 过期），心跳续命、关窗自然回收
  const KEY = 'mysandbox:watch-client'
  let id = sessionStorage.getItem(KEY)
  if (!id) {
    id = `w-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    sessionStorage.setItem(KEY, id)
  }
  return id
}

function desiredItems(): WatchItem[] {
  // 多个组件可看同一 target 的不同目录（面板 + 多个编辑器 tab）：按 target 并集 dirs
  const byTarget = new Map<string, Set<string>>()
  for (const item of declarations.values()) {
    let set = byTarget.get(item.target)
    if (!set) byTarget.set(item.target, (set = new Set()))
    for (const d of item.dirs) set.add(d)
  }
  return [...byTarget].map(([target, dirs]) => ({ target, dirs: [...dirs] }))
}

function pushWatches(): void {
  if (!declarations.size) return
  postJson('/api/file-watches', { clientId: clientId(), items: desiredItems() }).catch((e: unknown) => {
    if (!(e instanceof Unauthorized)) void e // 401 有全局流程管，这里静默（下拍心跳再试）
  })
}

/**
 * 声明「本组件正在看 target 的这些目录」（服务端 fs.watch 并广播 file-changed）。
 * owner 是组件身份 key（导航换目录就重发全量、卸载传 null 撤销）。声明只在有
 * 可 watch 目标（容器/宿主）时有意义；s:/ssh 目标服务端直接跳过，组件保留慢轮询。
 */
export function setWatchDirs(owner: string, item: WatchItem | null): void {
  if (item && item.dirs.length) declarations.set(owner, item)
  else declarations.delete(owner)
  if (!heartbeatTimer) heartbeatTimer = setInterval(pushWatches, 20_000)
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushWatches()
  }, 300)
}
