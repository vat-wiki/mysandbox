// 终端后端选择（自动部署时代）：host / LXC / SSH 目标默认 msmux——agent 不在线或
// 二进制陈旧由服务端在连接时自动部署/升级兜底（muxAgent.ts），前端不做可用性探测；
// docker 服务目标恒走 tmux（不参与自动部署）。URL ?mux=0|1 整页临时覆盖；
// 「用 tmux 打开」保留为显式退路（msmux 故障时用）。
export type TerminalBackend = 'tmux' | 'msmux'

export async function terminalBackend(target = ''): Promise<TerminalBackend> {
  const q = new URLSearchParams(location.search).get('mux')
  if (q === '1') return 'msmux'
  if (q === '0') return 'tmux'
  return target.startsWith('s:') ? 'tmux' : 'msmux'
}

/**
 * 该 target 本次连接是否走 msmux。显式选择（tmux/msmux）一票定音；未显式选择
 * （深链/恢复会话等）按 target 种类取默认（见上）。选 msmux 但目标缺 agent：
 * 服务端连接时自动部署兜底，成败由连接反馈，这里不做探测。
 */
export async function muxAgentAvailable(target: string, explicit?: 'tmux' | 'msmux'): Promise<boolean> {
  if (!target) return false
  if (explicit) return explicit === 'msmux'
  return (await terminalBackend(target)) === 'msmux'
}
