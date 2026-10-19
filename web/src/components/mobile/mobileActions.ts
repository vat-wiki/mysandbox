import { directUrl, serviceUrl } from '@/lib/proxy'
import { hasBaseAction } from '@/lib/caps'
import type { ContainerView, ServiceView } from '@/lib/api'
import type { CardAction } from './CardActionSheet.vue'

export type { CardAction } from './CardActionSheet.vue'

export type ContainerPortRow = { kind: 'web' | 'other' | 'map'; port: number; priv?: number }
export type ServicePortRow = { kind: 'web' | 'other'; port: number }

export interface ContainerActionDeps {
  openTerminal: (container: ContainerView) => void
  adopt: (container: ContainerView) => void
  start: (container: ContainerView) => void
  power: (container: ContainerView, action: 'stop' | 'restart') => void
  openDesktop: (container: ContainerView) => void
  codeServer: (container: ContainerView) => void
  rename: (container: ContainerView) => void
  export: (container: ContainerView) => void
  remove: (container: ContainerView) => void
  openUrl: (url: string) => void
  directPortUrl: (container: ContainerView, port: number) => string
  portTarget: (container: ContainerView, row: ContainerPortRow) => string
}

export interface ServiceActionDeps {
  openTerminal: (service: ServiceView) => void
  detail: (service: ServiceView) => void
  rename: (service: ServiceView) => void
  copyConnect: (service: ServiceView) => void
  op: (service: ServiceView, action: 'start' | 'stop' | 'restart') => void
  unadopt: (name: string) => void
  remove: (name: string, deleteData: boolean) => void
  openUrl: (url: string) => void
  directPortUrl: (service: ServiceView, port: number) => string
  portTarget: (service: ServiceView, row: ServicePortRow) => string
}

export function containerActions(c: ContainerView, ports: ContainerPortRow[], directOpenExtra: boolean): CardAction[] {
  const actions: CardAction[] = [{ id: 'open', label: '打开终端', primary: true }]
  if (!c.managed && !c.adopted) {
    actions.push({ id: 'adopt', label: '纳入管理' })
    return actions
  }

  if (c.state === 'running') {
    actions.push(
      { id: 'stop', label: '停止' },
      { id: 'desktop', label: '桌面' },
      { id: 'codeServer', label: 'Code Server' },
      { id: 'restart', label: '重启' },
    )
  } else {
    actions.push({ id: 'start', label: '启动' })
  }
  actions.push({ id: 'rename', label: '重命名' })
  if (hasBaseAction('export')) actions.push({ id: 'export', label: '导出为包' })
  if (c.managed) actions.push({ id: 'delete', label: '删除', destructive: true })

  if (c.state !== 'running') return actions
  for (const row of ports) {
    if (row.kind === 'map') {
      actions.push({ id: `port:${row.port}:${row.priv ?? ''}`, label: `端口 ${row.port} → ${row.priv}`, detail: '宿主端口' })
      continue
    }
    const url = serviceUrl('c', c.name, row.port, c.ip)
    actions.push({ id: `port:${row.port}`, label: `端口 ${row.port}`, detail: url })
    if (directOpenExtra && c.ip) {
      actions.push({ id: `port-direct:${row.port}`, label: `端口 ${row.port} 直连`, detail: directUrl(c.ip, row.port) })
    }
  }
  return actions
}

export function runContainerAction(c: ContainerView, action: CardAction, deps: ContainerActionDeps): void {
  if (action.id === 'open') {
    deps.openTerminal(c)
    return
  }
  const match = action.id.match(/^port(?:-direct)?:(\d+)$/)
  if (match) {
    const port = Number(match[1])
    const url = action.id.includes('port-direct')
      ? deps.directPortUrl(c, port)
      : deps.portTarget(c, { kind: 'web', port })
    deps.openUrl(url)
    return
  }
  if (action.id === 'adopt') deps.adopt(c)
  else if (action.id === 'start') deps.start(c)
  else if (action.id === 'stop') deps.power(c, 'stop')
  else if (action.id === 'restart') deps.power(c, 'restart')
  else if (action.id === 'desktop') deps.openDesktop(c)
  else if (action.id === 'codeServer') deps.codeServer(c)
  else if (action.id === 'rename') deps.rename(c)
  else if (action.id === 'export') deps.export(c)
  else if (action.id === 'delete') deps.remove(c)
}

export function serviceActions(s: ServiceView, ports: ServicePortRow[], directOpenExtra: boolean): CardAction[] {
  const actions: CardAction[] = [
    { id: 'open', label: '打开终端', primary: true },
    { id: 'detail', label: '详情' },
    { id: 'rename', label: '重命名' },
  ]
  if (s.connect.length) actions.push({ id: 'connect', label: '复制连接命令' })
  if (s.running) {
    for (const row of ports) {
      const url = serviceUrl('s', s.name, row.port, s.ip)
      actions.push({ id: `port:${row.port}`, label: `端口 ${row.port}`, detail: url })
      if (directOpenExtra && s.ip) {
        actions.push({ id: `port-direct:${row.port}`, label: `端口 ${row.port} 直连`, detail: directUrl(s.ip, row.port) })
      }
    }
  }
  if (!s.running) actions.push({ id: 'start', label: '启动' })
  else actions.push({ id: 'stop', label: '停止' })
  actions.push({ id: 'restart', label: '重启' })
  if (s.externalStack) actions.push({ id: 'unadopt', label: '取消收编', destructive: true })
  else {
    actions.push({ id: 'delete-keep', label: '删除（留数据卷）' })
    actions.push({ id: 'delete-data', label: '删除（连数据）', destructive: true })
  }
  return actions
}

export function runServiceAction(s: ServiceView, action: CardAction, deps: ServiceActionDeps): void {
  if (action.id === 'open') {
    deps.openTerminal(s)
    return
  }
  const match = action.id.match(/^port(?:-direct)?:(\d+)$/)
  if (match) {
    const port = Number(match[1])
    const url = action.id.includes('port-direct')
      ? deps.directPortUrl(s, port)
      : deps.portTarget(s, { kind: 'web', port })
    deps.openUrl(url)
    return
  }
  if (action.id === 'detail') deps.detail(s)
  else if (action.id === 'rename') deps.rename(s)
  else if (action.id === 'connect') deps.copyConnect(s)
  else if (action.id === 'start') deps.op(s, 'start')
  else if (action.id === 'stop') deps.op(s, 'stop')
  else if (action.id === 'restart') deps.op(s, 'restart')
  else if (action.id === 'unadopt') deps.unadopt(s.name)
  else if (action.id === 'delete-keep') deps.remove(s.name, false)
  else if (action.id === 'delete-data') deps.remove(s.name, true)
}
