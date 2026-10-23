// 终端后端选择：auto（目标有 agent 才走 msmux）| tmux | msmux。
//
// 渐进替代的开关语义：服务端 config 的 mux.backend 是默认值（auto——只有目标上部署过
// msmux agent 且当前在线，才把新连接切到 /ws/mux-terminal）。新开终端组可显式选择
// tmux/msmux，覆盖服务端默认；URL ?mux=0|1 只作为整页临时覆盖。
import { getMuxBackend, listMuxAgents, setMuxBackend, type MuxBackend } from './api'

export type TerminalBackend = 'auto' | 'tmux' | 'msmux'
const CACHE_MS = 4_000
let serverBackend: { at: number; mode: TerminalBackend } | null = null
let serverBackendInflight: Promise<TerminalBackend> | null = null

async function serverTerminalBackend(): Promise<TerminalBackend> {
  if (serverBackend && Date.now() - serverBackend.at < CACHE_MS) return serverBackend.mode
  if (serverBackendInflight) return serverBackendInflight
  serverBackendInflight = getMuxBackend()
    .then((r) => {
      serverBackend = { at: Date.now(), mode: r.backend }
      return r.backend
    })
    .catch(() => 'auto' as TerminalBackend)
    .finally(() => {
      serverBackendInflight = null
    })
  return serverBackendInflight
}

export async function terminalBackend(): Promise<TerminalBackend> {
  const q = new URLSearchParams(location.search).get('mux')
  if (q === '1') return 'msmux'
  if (q === '0') return 'tmux'
  return serverTerminalBackend()
}

export async function setTerminalBackend(mode: MuxBackend): Promise<MuxBackend> {
  serverBackend = { at: Date.now(), mode }
  const saved = await setMuxBackend(mode)
  return saved.backend
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
export async function muxAgentAvailable(target: string, explicit?: 'tmux' | 'msmux'): Promise<boolean> {
  if (explicit === 'tmux' || !target) return false
  if (explicit === 'msmux') return true
  const mode = await terminalBackend()
  if (mode === 'tmux') return false
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
