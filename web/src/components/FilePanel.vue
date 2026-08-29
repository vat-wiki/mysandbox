<script setup lang="ts">
// 右侧文件面板：跟随终端 pane 的 cwd 展示目录内容（tmux 查询），可逐级浏览、点文件
// 抛 open-file 给父级开编辑器，右键 新建文件/新建文件夹/重命名/删除。跟随与手动浏览
// 互斥：手动导航（点目录/输路径/外部定位）暂停跟随，恢复条一键回到终端所在目录。
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  listFiles,
  getTermCwd,
  createEntry,
  renameEntry,
  deleteEntry,
  Unauthorized,
  type FileEntry,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import NameDialog from '@/components/NameDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import FilePanelGit from '@/components/FilePanelGit.vue'
import type { GitChange } from '@/lib/api'
import {
  Folder,
  FileText,
  Link2,
  RefreshCw,
  X,
  ChevronUp,
  PenLine,
  FilePlus,
  FolderPlus,
  Trash2,
  MoreHorizontal,
} from 'lucide-vue-next'

const props = defineProps<{
  containerId: string
  containerName: string
  // active group 的 pane 列表（label 供 >1 pane 时下拉显示），termId 为当前跟随源。
  panes: { termId: string; label: string }[]
  termId: string | null
  hasTerminal: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open-file', path: string): void
  (e: 'pane-pick', termId: string): void
  (e: 'open-change', c: { absPath: string; oldAbsPath?: string; entry: GitChange }): void
}>()

// 跟随模式：path 跟着终端 cwd 走。手动导航置 false（容器 id 冻结到 manualContainerId，
// 因手动只发生在同容器内换路径；切容器时父组件会换 props，watch 里回跟随态）。
const follow = ref(true)
const manualContainerId = ref(props.containerId)
const path = ref('')
const entries = ref<FileEntry[]>([])
const loading = ref(false)
const err = ref('')
// cwd 轮询温和失败提示（会话没起/容器重启）：不进主错误条，恢复自愈。
const noSession = ref(false)
// 路径输入框（手动跳转用）：显示当前 path，Enter 提交；失焦还原避免半截输入覆盖显示。
const pathInput = ref('')
const editingPath = ref(false)
const pathInputEl = ref<HTMLInputElement | null>(null)

// 有效目标容器：follow 用 props（active group），手动时冻结。
function targetId(): string {
  return follow.value ? props.containerId : manualContainerId.value
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let loadSeq = 0 // 竞态防护：慢响应回来时已被新请求取代则丢弃

async function loadDir(p: string) {
  const seq = ++loadSeq
  loading.value = true
  try {
    const v = await listFiles(targetId(), p)
    if (seq !== loadSeq) return // 过期响应
    path.value = v.path
    entries.value = v.entries
    err.value = ''
  } catch (e) {
    if (seq !== loadSeq) return
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

// cwd 轮询：3s 一次；cwd 变化且处于跟随态 -> 更新列表。会话不存在（404 等）温和提示。
// 面板用 v-if 挂载，关闭即卸载、onUnmounted 清 timer，不空转。
// 右键菜单/操作弹窗开着时跳过：换目录会让 ctxEntry 指向已不存在的条目对象、
// 菜单打开瞬间列表被替换（用户正对着菜单里的「重命名」列表却变了）。
async function pollCwd() {
  if (!props.termId || !props.containerId) return
  if (menuOpen.value || nameDialog.value || delTarget.value) return
  try {
    const r = await getTermCwd(props.containerId, props.termId)
    noSession.value = false
    if (follow.value && r.cwd !== path.value) {
      loadDir(r.cwd)
    }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    // 终端会话还没建好/容器重启中：温和提示，继续轮询等它回来
    noSession.value = true
  }
}

onMounted(() => {
  pollCwd() // 立即一次（首帧就有内容）
  pollTimer = setInterval(pollCwd, 3000)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})

// 切容器（props 变）：无论之前是否手动，都回到跟随态、由下一次轮询定位新容器 cwd。
// 切 pane（termId 变）：跟随态下立刻拉一次新 pane 的 cwd。
watch(
  () => props.containerId,
  () => {
    follow.value = true
    entries.value = []
    pollCwd()
  },
)
watch(
  () => props.termId,
  () => {
    if (follow.value) pollCwd()
  },
)

// —— 导航（均暂停跟随）——
function pauseFollow() {
  manualContainerId.value = props.containerId
  follow.value = false
}
function openDir(p: string) {
  pauseFollow()
  loadDir(p)
}
// link 条目不知道指向文件还是目录：先按目录试，失败回退按文件打开。
async function openLink(p: string) {
  pauseFollow()
  const seq = ++loadSeq
  try {
    const v = await listFiles(props.containerId, p)
    if (seq !== loadSeq) return
    path.value = v.path
    entries.value = v.entries
    err.value = ''
  } catch {
    emit('open-file', p)
  }
}
function openEntry(e: FileEntry) {
  const p = path.value === '/' ? `/${e.name}` : `${path.value}/${e.name}`
  if (e.type === 'dir') openDir(p)
  else if (e.type === 'link') void openLink(p)
  else emit('open-file', p)
}
function goParent() {
  if (path.value === '/') return
  const i = path.value.lastIndexOf('/')
  openDir(i <= 0 ? '/' : path.value.slice(0, i))
}
// 路径输入框：进入编辑态时预填当前路径，Enter 提交、Esc/失焦还原。
function startEditPath() {
  pathInput.value = path.value
  editingPath.value = true
  nextTick(() => pathInputEl.value?.focus())
}
function commitPath() {
  editingPath.value = false
  const p = pathInput.value.trim()
  if (p && p.startsWith('/')) openDir(p)
}
function resumeFollow() {
  follow.value = true
  noSession.value = false
  pollCwd()
}
function refresh() {
  // 有路径就强刷当前目录列表。不能在跟随态走 pollCwd——它只在「cwd 变了」时才
  // loadDir，cwd 没变时是空转：右键新建/保存后的刷新、手点刷新按钮全都无效，
  // 表现为「新建了文件列表不变，要退上级再进来才看到」。
  if (path.value) loadDir(path.value)
  else pollCwd()
  gitRef.value?.refresh()
}

// 外部定位入口（CLI open / 父组件请求）：直接展示某容器某目录，暂停跟随。
function locate(containerId: string, p: string) {
  manualContainerId.value = containerId
  follow.value = containerId !== props.containerId // 同容器也暂停（用户明确要看这个目录）
  loadDir(p)
}
defineExpose({ locate, refresh })

// git 变更区块的 ref（refresh 链透传用）
const gitRef = ref<InstanceType<typeof FilePanelGit> | null>(null)

// —— 右键操作（新建/重命名/删除）——
// 右键命中的条目（null = 空白处，新建作用于当前目录）。事件委托：trigger 容器上监听
// contextmenu，按 data-entry 找行——不用嵌套 trigger，也不 .stop（会阻断 reka 监听）。
const ctxEntry = ref<FileEntry | null>(null)
// 菜单开合状态（reka update:open）：开=true 期间轮询暂停（见 pollCwd），条目快照不被换掉。
const menuOpen = ref(false)
function onCtxMenu(ev: MouseEvent) {
  const el = (ev.target as HTMLElement).closest('[data-entry]')
  ctxEntry.value = el ? (entries.value.find((e) => e.name === el.getAttribute('data-entry')) ?? null) : null
}
// 触屏行内 ⋯ 菜单（手机右键不可达）：与 ContextMenu 同一批动作/处理器，只是入口不同。
function onRowMenu(e: FileEntry) {
  ctxEntry.value = e
}
// 命名弹窗：mode 区分三个操作；entry 为重命名/删除目标。err 是异步结果回显。
const nameDialog = ref<null | { mode: 'newFile' | 'newDir' | 'rename' }>(null)
const delTarget = ref<FileEntry | null>(null)
const opErr = ref('')
const opBusy = ref(false)
// 当前目录下拼完整路径（与 openEntry 同款）。
function joinPath(name: string): string {
  return path.value === '/' ? `/${name}` : `${path.value}/${name}`
}
async function confirmName(name: string) {
  const d = nameDialog.value
  if (!d) return
  opErr.value = ''
  opBusy.value = true
  try {
    const id = targetId()
    if (d.mode === 'rename') {
      const p = joinPath(ctxEntry.value?.name ?? '')
      if (name !== ctxEntry.value?.name) await renameEntry(id, p, name)
    } else {
      await createEntry(id, joinPath(name), d.mode === 'newDir' ? 'dir' : 'file')
    }
    nameDialog.value = null
    refresh()
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    opBusy.value = false
  }
}
async function confirmDelete() {
  if (!delTarget.value) return
  opErr.value = ''
  opBusy.value = true
  try {
    await deleteEntry(targetId(), joinPath(delTarget.value.name))
    delTarget.value = null
    refresh()
  } catch (e) {
    opErr.value = e instanceof Error ? e.message : String(e)
    delTarget.value = null
    opErr.value && (err.value = opErr.value) // 删除失败进主错误条（弹窗已关）
  } finally {
    opBusy.value = false
  }
}

// 人性化文件大小（目录不显示）。
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-card">
    <!-- 头：容器名 + pane 选择 + 关闭 -->
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
      <Folder class="size-3.5 shrink-0 text-muted-foreground" />
      <span class="min-w-0 truncate font-mono text-xs font-medium" :title="containerName">{{
        containerName
      }}</span>
      <select
        v-if="panes.length > 1"
        class="ml-auto max-w-24 shrink-0 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-muted-foreground"
        title="跟随哪个终端的目录"
        :value="termId ?? undefined"
        @change="emit('pane-pick', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in panes" :key="p.termId" :value="p.termId">{{ p.label }}</option>
      </select>
      <!-- 新建文件/文件夹（目录级操作）：手机主入口（触屏无右键），桌面也是顺手按钮 -->
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :disabled="!path"
        title="新建文件"
        @click="nameDialog = { mode: 'newFile' }"
      >
        <FilePlus />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :disabled="!path"
        title="新建文件夹"
        @click="nameDialog = { mode: 'newDir' }"
      >
        <FolderPlus />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :class="{ 'ml-auto': panes.length <= 1 }"
        :disabled="loading"
        :title="loading ? '刷新中…' : '刷新'"
        @click="refresh"
      >
        <RefreshCw :class="loading ? 'animate-spin' : ''" />
      </Button>
      <Button variant="ghost" size="icon-xs" class="shrink-0" title="关闭文件面板" @click="emit('close')">
        <X />
      </Button>
    </div>

    <!-- 已暂停跟随提示条 -->
    <button
      v-if="!follow"
      class="flex shrink-0 items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-left text-[11px] text-amber-600 dark:text-amber-400"
      @click="resumeFollow"
    >
      已暂停跟随终端目录 · 点击恢复
    </button>
    <!-- 会话温和提示（等 tmux 会话建立/容器恢复，自动消失） -->
    <p
      v-else-if="noSession"
      class="shrink-0 border-b border-border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground"
    >
      终端会话未就绪，等待中…
    </p>

    <!-- 路径行：可点击进入编辑 -->
    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :disabled="path === '/' || !path"
        title="上一级"
        @click="goParent"
      >
        <ChevronUp />
      </Button>
      <input
        v-if="editingPath"
        ref="pathInputEl"
        v-model="pathInput"
        class="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]"
        @keydown.enter.prevent="commitPath"
        @keydown.esc="editingPath = false"
        @blur="commitPath"
      />
      <button
        v-else
        class="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-muted-foreground hover:text-foreground"
        :title="path || '（等待终端目录…）'"
        @click="startEditPath"
      >
        {{ path || '…' }}
      </button>
    </div>

    <!-- Git 变更区块：当前目录在仓库内才渲染（组件内部对 repo:false 也整体 v-if）。
         :key=容器 id：切容器重建（折叠态复位），path 变化组件内部自会重查。 -->
    <FilePanelGit
      v-if="hasTerminal && path"
      ref="gitRef"
      :key="targetId()"
      :container-id="targetId()"
      :path="path"
      @open-change="(c) => emit('open-change', c)"
      @open-file="(p) => emit('open-file', p)"
      @locate-dir="openDir"
    />

    <!-- 列表体：ContextMenu 包裹，右键新建/重命名/删除 -->
    <ContextMenu @update:open="(v: boolean) => (menuOpen = v)">
      <ContextMenuTrigger as-child>
        <div class="scroll-thin min-h-0 flex-1 overflow-y-auto" @contextmenu="onCtxMenu">
          <p v-if="!hasTerminal" class="px-3 py-6 text-center text-xs text-muted-foreground">
            先在左侧打开终端
          </p>
          <template v-else>
            <p v-if="err" class="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {{ err }}
            </p>
            <p
              v-else-if="!entries.length && !loading"
              class="px-3 py-6 text-center text-xs text-muted-foreground"
            >
              空目录
            </p>
            <div
              v-for="e in entries"
              :key="e.name"
              :data-entry="e.name"
              class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-accent/50"
              @click="openEntry(e)"
            >
              <Folder v-if="e.type === 'dir'" class="size-3.5 shrink-0 text-sky-400" />
              <Link2 v-else-if="e.type === 'link'" class="size-3.5 shrink-0 text-violet-400" />
              <FileText v-else class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ e.name }}</span>
              <span v-if="e.type !== 'dir'" class="shrink-0 text-[10px] text-muted-foreground">{{
                fmtSize(e.size)
              }}</span>
              <!-- 行内 ⋯（重命名/删除）：触屏无右键，这是手机上的唯一入口；桌面隐藏 -->
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    class="shrink-0 md:hidden"
                    title="更多操作"
                    @click.stop
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @click="onRowMenu(e); nameDialog = { mode: 'rename' }">
                    <PenLine /> 重命名
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" @click="onRowMenu(e); delTarget = e">
                    <Trash2 /> 删除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </template>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <template v-if="ctxEntry">
          <ContextMenuItem @click="nameDialog = { mode: 'rename' }">
            <PenLine /> 重命名
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @click="delTarget = ctxEntry">
            <Trash2 /> 删除
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newFile' }">
          <FilePlus /> 新建文件
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newDir' }">
          <FolderPlus /> 新建文件夹
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

    <!-- 命名弹窗（新建/重命名共用） -->
    <NameDialog
      v-if="nameDialog"
      :title="nameDialog.mode === 'rename' ? '重命名' : nameDialog.mode === 'newDir' ? '新建文件夹' : '新建文件'"
      :desc="nameDialog.mode === 'rename' ? ctxEntry?.name : path"
      :initial="nameDialog.mode === 'rename' ? ctxEntry?.name : ''"
      :ok-text="nameDialog.mode === 'rename' ? '重命名' : '创建'"
      :err="opErr"
      :busy="opBusy"
      @confirm="confirmName"
      @close="nameDialog = null"
    />
    <!-- 删除确认 -->
    <ConfirmDialog
      v-if="delTarget"
      title="删除"
      :description="`确定删除 ${delTarget.type === 'dir' ? '目录' : ''}“${delTarget.name}”？${
        delTarget.type === 'dir' ? '目录内所有内容将一并删除，' : ''
      }此操作不可恢复。`"
      confirm-text="删除"
      variant="destructive"
      :busy="opBusy"
      @confirm="confirmDelete"
      @close="delTarget = null"
    />
  </div>
</template>
