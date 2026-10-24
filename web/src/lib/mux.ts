// 终端后端选择：tmux | msmux，**没有 auto**——每次开终端由用户显式二选一
// （桌面右键菜单 / 手机动作面板都有两个入口），本库不再做「agent 在线才切 msmux」
// 的自动探测。
//
// 服务端 config 的 mux.backend 是未显式选择路径（深链、恢复会话、popout 种子、
// 分屏继承）的默认值，同样是手动二选一；URL ?mux=0|1 只作为整页临时覆盖。
import { getMuxBackend, setMuxBackend, type MuxBackend } from './api'

export type TerminalBackend = MuxBackend
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
    .catch(() => 'tmux' as TerminalBackend)
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

/**
 * 该 target 本次连接是否走 msmux。显式选择（tmux/msmux）一票定音；未显式选择
 * （深链/恢复会话等）按服务端默认。选 msmux 但目标没上线：成败由连接反馈
 * （连不上直接报连接错误），这里不做可用性探测。
 */
export async function muxAgentAvailable(target: string, explicit?: 'tmux' | 'msmux'): Promise<boolean> {
  if (!target) return false
  if (explicit) return explicit === 'msmux'
  return (await terminalBackend()) === 'msmux'
}
