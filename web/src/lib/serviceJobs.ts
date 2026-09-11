// 服务任务的状态跟踪 + 完成通知 + 迁移入口（模块级单例）。
// ServicesPanel（3s）与侧栏（15s/3s 自适应）两个轮询器都把最新任务表喂进来：
// - 按 jobId 记住上一次 state，只有「见过 running 且落到终态」的跳变才发 toast——
//   两个轮询器命中同一次跳变天然只发一条，页面刷新/首拉不会对已完成任务补发通知；
// - canceled 是用户自己点的，不通知；
// - create / apply / migrate 三种任务的文案分支（apply = 配置保存应用，migrate =
//   旧服务迁移到 compose 底账，详见 services.ts / serviceCompose.ts）。
import { toast } from 'vue-sonner'
import type { ServiceJobView, ServiceView } from '@/lib/api'
import { migrateService } from './api'

const lastStates = new Map<string, string>()

const kindLabel: Record<ServiceJobView['kind'], string> = { create: '创建', apply: '应用', migrate: '迁移' }

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
        if (j.kind === 'create') {
          toast.success(`应用容器 ${j.name} 就绪（${j.ip}）`, {
            description: '容器内可直接按服务名连接（hosts 已注入）；配置底账在 ~/.config/mysandbox/compose/。',
          })
        } else {
          // statusText 携带收尾叙事：「配置已应用」「已迁移到 compose 底账」等
          toast.success(`应用容器 ${j.name} ${kindLabel[j.kind]}完成`, { description: j.statusText })
        }
      } else if (j.state === 'error') {
        toast.error(`应用容器 ${j.name} ${kindLabel[j.kind]}失败`, {
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

// 迁移入口（服务面板「配置」页，旧版无底账服务专用）：rm 后按原形状经 compose
// 重建接管——数据在命名卷里无损；无数据卷的 custom 服务可写层会换新容器，先给
// 可行动的警告，确认才动手。启动失败（同名任务进行中 / meta 缺失）toast 展示。
export function requestServiceMigrate(s: ServiceView): void {
  const go = () => {
    migrateService(s.name)
      .then(() => toast.info(`已开始迁移 ${s.name}（进度见任务横幅 / 侧栏摘要）`))
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
  }
  if (s.preset === 'custom' && !s.volume) {
    toast.warning(`「${s.name}」没有数据卷——迁移会重建容器，可写层里的数据将丢失`, {
      action: { label: '仍要迁移', onClick: go },
      duration: 10_000,
    })
    return
  }
  go()
}
