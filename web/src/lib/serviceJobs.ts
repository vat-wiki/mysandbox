// 服务创建任务的状态跟踪 + 完成通知（模块级单例）。
// ServicesPanel（3s）与侧栏（15s/3s 自适应）两个轮询器都把最新任务表喂进来：
// - 按 jobId 记住上一次 state，只有「见过 running 且落到终态」的跳变才发 toast——
//   两个轮询器命中同一次跳变天然只发一条，页面刷新/首拉不会对已完成任务补发通知；
// - canceled 是用户自己点的，不通知。
import { toast } from 'vue-sonner'
import type { ServiceJobView } from '@/lib/api'

const lastStates = new Map<string, string>()

// 喂入一次轮询快照，返回 running 数（轮询器据此自适应间隔/摘要条展示）。
export function trackServiceJobs(jobs: ServiceJobView[]): number {
  let running = 0
  const seen = new Set<string>()
  for (const j of jobs) {
    seen.add(j.id)
    const prev = lastStates.get(j.id)
    lastStates.set(j.id, j.state)
    if (j.state === 'running') {
      running++
      continue
    }
    if (prev === 'running') {
      if (j.state === 'done') {
        toast.success(`服务 ${j.name} 就绪（${j.ip}）`, {
          description: '容器内可直接按服务名连接（hosts 已注入）。',
        })
      } else if (j.state === 'error') {
        toast.error(`服务 ${j.name} 创建失败`, {
          description: j.error || j.statusText,
          duration: 15_000,
        })
      }
    }
  }
  // 服务端裁剪（KEEP_FINISHED）后同步清理，防 Map 无界增长
  for (const id of [...lastStates.keys()]) if (!seen.has(id)) lastStates.delete(id)
  return running
}
