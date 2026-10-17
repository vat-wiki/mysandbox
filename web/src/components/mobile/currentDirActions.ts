import type { CardAction } from './CardActionSheet.vue'

export interface CurrentDirActionDeps {
  paste: () => void
  download: () => void
  createFile: () => void
  createDir: () => void
}

export function currentDirActions(hasClipboard: boolean, canDownload: boolean): CardAction[] {
  const actions: CardAction[] = []
  if (hasClipboard) actions.push({ id: 'paste', label: '粘贴到当前目录' })
  actions.push(
    { id: 'download', label: '下载当前文件夹', disabled: !canDownload },
    { id: 'create-file', label: '新建文件' },
    { id: 'create-dir', label: '新建文件夹' },
  )
  return actions
}

export function runCurrentDirAction(action: CardAction, deps: CurrentDirActionDeps): void {
  if (action.id === 'paste') deps.paste()
  else if (action.id === 'download') deps.download()
  else if (action.id === 'create-file') deps.createFile()
  else if (action.id === 'create-dir') deps.createDir()
}
