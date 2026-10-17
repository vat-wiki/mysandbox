import type { TermGroup } from '@/lib/termlayout'
import type { CardAction } from './CardActionSheet.vue'

export type MobileEditorTab = {
  containerId: string
  containerName: string
  path: string
  diff?: { headPath?: string }
}

export interface GroupActionDeps {
  create: (group: TermGroup) => void
  toggleNotify: (group: TermGroup) => void
  popout: (group: TermGroup) => void
  hide: (group: TermGroup) => void
  close: (group: TermGroup) => void
}

export function groupActions(group: TermGroup, containerRunning: boolean): CardAction[] {
  const actions: CardAction[] = [
    { id: 'create', label: '新开一组终端' },
    {
      id: 'notify',
      label: group.quietNotify === false ? '开启无输出提醒' : '关闭无输出提醒',
      detail: group.quietNotify === false ? '有动静时挂琥珀标' : '切走后不再提醒',
    },
  ]
  if (group.kind === 'host' || group.kind === 'ssh' || containerRunning) {
    actions.push({ id: 'popout', label: '在独立窗口打开' })
  }
  actions.push({ id: 'hide', label: '隐藏' })
  actions.push({ id: 'close', label: '关闭', destructive: true })
  return actions
}

export function runGroupAction(group: TermGroup, action: CardAction, deps: GroupActionDeps): void {
  if (action.id === 'create') deps.create(group)
  else if (action.id === 'notify') deps.toggleNotify(group)
  else if (action.id === 'popout') deps.popout(group)
  else if (action.id === 'hide') deps.hide(group)
  else if (action.id === 'close') deps.close(group)
}

export interface FileTabActionInput {
  tab: MobileEditorTab
  editing: boolean
  preview: boolean
  previewable: boolean
  hasDiff: boolean
  isFirst: boolean
  isLast: boolean
  single: boolean
}

export interface FileTabActionDeps {
  toggleMode: (tab: MobileEditorTab) => void
  openNormal: (tab: MobileEditorTab) => void
  download: (tab: MobileEditorTab) => void
  copyPath: (tab: MobileEditorTab) => void
  copyHostPath: (tab: MobileEditorTab) => void
  close: (tab: MobileEditorTab) => void
  closeRange: (tab: MobileEditorTab, range: 'other' | 'left' | 'right') => void
}

export function fileTabActions(input: FileTabActionInput): CardAction[] {
  const { tab, editing, preview, previewable, hasDiff, isFirst, isLast, single } = input
  const actions: CardAction[] = [
    { id: 'toggle', label: editing && !preview ? '预览' : '编辑' },
  ]
  if (hasDiff) actions.push({ id: 'normal', label: '以普通方式打开' })
  if (previewable) actions.push({ id: 'download', label: '下载' })
  actions.push(
    { id: 'copy-path', label: '复制容器路径', detail: tab.path },
    { id: 'copy-host-path', label: '复制实际路径' },
    { id: 'close', label: '关闭', destructive: true },
    { id: 'close-other', label: '关闭其他', destructive: true, disabled: single },
    { id: 'close-left', label: '关闭左侧', destructive: true, disabled: isFirst },
    { id: 'close-right', label: '关闭右侧', destructive: true, disabled: isLast },
  )
  return actions
}

export function runFileTabAction(tab: MobileEditorTab, action: CardAction, deps: FileTabActionDeps): void {
  if (action.id === 'toggle') deps.toggleMode(tab)
  else if (action.id === 'normal') deps.openNormal(tab)
  else if (action.id === 'download') deps.download(tab)
  else if (action.id === 'copy-path') deps.copyPath(tab)
  else if (action.id === 'copy-host-path') deps.copyHostPath(tab)
  else if (action.id === 'close') deps.close(tab)
  else if (action.id === 'close-other') deps.closeRange(tab, 'other')
  else if (action.id === 'close-left') deps.closeRange(tab, 'left')
  else if (action.id === 'close-right') deps.closeRange(tab, 'right')
}
