// 终端后端选择：auto（目标有 agent 才走 msmux）| tmux | msmux。
//
// 渐进替代的开关语义：默认 auto——只有目标上部署过 msmux agent 且当前在线，才把新连接
// 切到 /ws/mux-terminal；其余目标原样走 tmux。这样逐台部署即可逐台切换，任何目标
// 没有 agent 都不会影响旧路径。偏好存 localStorage，也可用 URL ?mux=0|1 临时覆盖。
import { listMuxAgents } from './api'

export type TerminalBackend = 'auto' | 'tmux' | 'msmux'
const PREF_KEY = 'mysandbox:terminal-backend'
const CACHE_MS = 4_000

export function terminalBackend(): TerminalBackend {
  const q = new URLSearchParams(location.search).get('mux')
  if (q === '1') return 'msmux'
  if (q === '0') return 'tmux'
  const v = localStorage.getItem(PREF_KEY)
  return v === 'tmux' || v === 'msmux' ? v : 'auto'
}

export function setTerminalBackend(mode: TerminalBackend): void {
  if (mode === 'auto') localStorage.removeItem(PREF_KEY)
  else localStorage.setItem(PREF_KEY, mode)
}

let cached: { at: number; targets: Set<string> } | null = null
let inflight: Promise<Set<string>> | null = null

async function agents(): Promise<Set<string>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.targets
  if (inflight) return inflight
  inflight = listMuxAgents()
    .then((r) => {
      const targets = new Set(r.agents.map((a) => a.target))
      cached = { at: Date.now(), targets }
      return targets
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 该 target 当前是否应走 msmux。tmux 模式恒 false；msmux 模式强制执行（成败由连接反馈）。 */
export async function muxAgentAvailable(target: string): Promise<boolean> {
  const mode = terminalBackend()
  if (mode === 'tmux' || !target) return false
  if (mode === 'msmux') return true
  try {
    return (await agents()).has(target)
  } catch {
    return false
  }
}

/** 部署/重连后清掉在线缓存，下一次连接立刻重新探测。 */
export function invalidateMuxAgents(): void {
  cached = null
}
