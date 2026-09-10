// 服务任务的状态跟踪 + 完成通知 + 更新/重建入口（模块级单例）。
// ServicesPanel（3s）与侧栏（15s/3s 自适应）两个轮询器都把最新任务表喂进来：
// - 按 jobId 记住上一次 state，只有「见过 running 且落到终态」的跳变才发 toast——
//   两个轮询器命中同一次跳变天然只发一条，页面刷新/首拉不会对已完成任务补发通知；
// - canceled 是用户自己点的，不通知；
// - create / update / rebuild 三种任务的文案分支（update = 拉新镜像重建，rebuild = 用
//   本地镜像重建，详见 services.ts）。
import { toast } from 'vue-sonner'
import type { ServiceJobView, ServiceView } from '@/lib/api'
import { rebuildService, updateService } from './api'

const lastStates = new Map<string, string>()

const kindLabel: Record<ServiceJobView['kind'], string> = { create: '创建', update: '更新', rebuild: '重建' }

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
            description: '容器内可直接按服务名连接（hosts 已注入）。',
          })
        } else {
          // statusText 携带收尾叙事：「镜像已是最新，无需重建」/「服务 xx 已更新/已重建」
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

// 更新/重建共用的入口壳：无数据卷的服务动作 = 重建容器，可写层数据（容器内非挂载
// 路径）会丢——先给可行动的警告，确认才动手；其余直接开。启动失败（同名任务进行中 /
// meta 缺失）toast 展示，不弹窗打断。
function requestServiceMutation(s: ServiceView, verb: string, go: () => void): void {
  if (s.preset === 'custom' && !s.volume) {
    toast.warning(`「${s.name}」没有数据卷，${verb}会重建容器——可写层里的数据将丢失`, {
      action: { label: `仍要${verb}`, onClick: go },
      duration: 10_000,
    })
    return
  }
  go()
}

// 更新入口（侧栏卡片 ⋯ 菜单 / 服务面板按钮共用）：registry latest 追新。
export function requestServiceUpdate(s: ServiceView): void {
  requestServiceMutation(s, '更新', () => {
    updateService(s.name)
      .then(() => toast.info(`已开始更新 ${s.name}（进度见任务横幅 / 侧栏摘要）`))
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
  })
}

// 重建入口（同上）：用本地镜像重建，不碰 registry——本地 build 迭代服务的对口入口。
export function requestServiceRebuild(s: ServiceView): void {
  requestServiceMutation(s, '重建', () => {
    rebuildService(s.name)
      .then(() => toast.info(`已开始重建 ${s.name}（进度见任务横幅 / 侧栏摘要）`))
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))
  })
}
