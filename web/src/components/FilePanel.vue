<script setup lang="ts">
// 右侧文件面板：跟随终端 pane 的 cwd 展示目录内容（tmux 查询），可逐级浏览、点文件
// 抛 open-file 给父级开编辑器，右键 新建文件/新建文件夹/重命名/删除。跟随与手动浏览
// 互斥：手动导航（点目录/输路径/外部定位）暂停跟随，恢复条一键回到终端所在目录。
import { ref, computed, watch, onMounted, onUnmounted, onBeforeUnmount, nextTick } from 'vue'
import {
  listFiles,
  getTermCwd,
  createEntry,
  renameEntry,
  deleteEntry,
  downloadEntry,
  Unauthorized,
  HOST_ID,
  type FileEntry,
  type FilesView,
} from '@/lib/api'
import { toast } from 'vue-sonner'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Folder,
  FileText,
  Link2,
  RefreshCw,
  X,
  FolderUp,
  ChevronRight,
  PenLine,
  FilePlus,
  FolderPlus,
  Trash2,
  Download,
  Search,
  HardDrive,
  Copy,
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
  // opts.diff 存在 = git 变更对比形态（Git 变更区块点击上抛；目录列表点文件不传）。
  (e: 'open-file', path: string, opts?: { diff?: { headPath?: string } }): void
  (e: 'pane-pick', termId: string): void
}>()

// 跟随模式：path 跟着终端 cwd 走。手动导航置 false（容器 id 冻结到 manualContainerId，
// 因手动只发生在同容器内换路径；切容器时父组件会换 props，watch 里回跟随态）。
const follow = ref(true)
const manualContainerId = ref(props.containerId)
const path = ref('')
// 当前目录对应的宿主机实际路径（listFiles 随视图返回；宿主面板 = path 本身）。
const hostPath = ref<string | null>(null)
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
// 宿主面板（HOST_ID 哨兵）：路径本来就是宿主路径，弹框里不重复展示容器路径行。
const isHost = computed(() => targetId() === HOST_ID)

// —— 宿主路径复制 ——
// navigator.clipboard 不可用（http 局域网访问）时走 execCommand 兜底，必须同步在
// 用户手势栈里调（与 Terminal.vue / ContainerList.vue 同一手法的第三次落点，体量小不抽公共）。
function copyHostPath() {
  const s = hostPath.value
  if (!s) return
  const legacy = () => {
    const ta = document.createElement('textarea')
    ta.value = s
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    ta.setAttribute('readonly', '')
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
  const done = (ok: boolean) =>
    ok ? toast('已复制宿主路径') : toast.error('复制失败：剪贴板不可用')
  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(s)
      .then(() => done(true))
      .catch(() => done(legacy()))
  } else {
    done(legacy())
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let loadSeq = 0 // 竞态防护：慢响应回来时已被新请求取代则丢弃
// 最近一次列表签名（path + 全部条目）。静默轮询据此判断「有没有变化」——没变化不赋值，
// keyed v-for 零 DOM 变更，滚动条位置与行悬停状态都不受打扰；有变化也只 patch 增删行，
// 滚动容器 DOM 节点不重建，scrollTop 原样保留。
let lastSig = ''
function sigOf(v: FilesView): string {
  return (
    v.path +
    '\n' +
    v.entries.map((e) => `${e.type}\u0000${e.name}\u0000${e.size}\u0000${e.mtime}`).join('\u0001')
  )
}

async function loadDir(p: string, opts: { silent?: boolean } = {}) {
  const seq = ++loadSeq
  if (!opts.silent) loading.value = true
  try {
    const v = await listFiles(targetId(), p)
    if (seq !== loadSeq) return // 过期响应
    path.value = v.path
    hostPath.value = v.hostPath ?? null
    const sig = sigOf(v)
    if (!opts.silent || sig !== lastSig) {
      entries.value = v.entries
      lastSig = sig
    }
    if (!opts.silent) err.value = ''
  } catch (e) {
    if (seq !== loadSeq) return
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    // 静默轮询失败不吭声（多半瞬时：容器重启中/exec 超时），列表保持原样下轮再试；
    // 主动操作/导航的失败照常进错误条。
    if (!opts.silent) err.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === loadSeq && !opts.silent) loading.value = false
  }
}

// 轮询（3s）两层职责：
// 1) 跟随态查终端 cwd，变了就跳目录（loadDir 负责拉新列表）；
// 2) 当前目录内容静默重查：容器内进程/他人新建文件不用手点刷新即出现（签名不变则零
//    DOM 变更）。面板用 v-if 挂载，关闭即卸载、onUnmounted 清 timer，不空转。
// 右键菜单/操作弹窗开着时整体跳过：列表被换会让 ctxEntry 指向已不存在的条目对象、
// 菜单打开瞬间列表被替换（用户正对着菜单里的「重命名」列表却变了）。
async function tick() {
  if (menuOpen.value || nameDialog.value || delTarget.value) return
  if (follow.value && props.termId && props.containerId) {
    try {
      const r = await getTermCwd(props.containerId, props.termId)
      noSession.value = false
      if (r.cwd !== path.value) {
        void loadDir(r.cwd)
        return // 新目录的列表由这次 loadDir 拉，不必再重查一遍
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
  if (path.value) void loadDir(path.value, { silent: true })
}

onMounted(() => {
  tick() // 立即一次（首帧就有内容）
  pollTimer = setInterval(tick, 3000)
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
    lastSig = '' // 防止旧签名恰好压住新容器的首拉
    q.value = '' // 搜索是当前目录视图，切容器一并清掉
    tick()
  },
)
watch(
  () => props.termId,
  () => {
    if (follow.value) tick()
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
    hostPath.value = v.hostPath ?? null
    entries.value = v.entries
    lastSig = sigOf(v)
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
// —— 面包屑 ——
// 返回上级的高频痛点：上级按钮只有路径行一颗，深层目录连点多次才到顶。面包屑让任意
// 祖先一键直达（点击中间段 = 跳到那级），末段保留「点击进路径编辑」的老交互。
const crumbs = computed(() => {
  if (!path.value) return []
  const segs = path.value.split('/').filter(Boolean)
  const out: { name: string; p: string }[] = [{ name: '/', p: '/' }]
  let acc = ''
  for (const s of segs) {
    acc += `/${s}`
    out.push({ name: s, p: acc })
  }
  return out
})
// 溢出不出滚动条：量容器宽（ResizeObserver），从当前目录（末段）向前尽量多放，
// 放不下的头部段折叠成「…」（点击 = 进路径编辑，仍可达任意层级）。
// mono 11px 字符宽约 6.6px + chip 内边距；SEP_W = 分隔符 12px + 两侧 gap。
const crumbsEl = ref<HTMLElement | null>(null)
const crumbsW = ref(0)
let crumbRO: ResizeObserver | null = null
watch(crumbsEl, (el) => {
  crumbRO?.disconnect()
  crumbsW.value = 0
  if (el) {
    crumbRO = new ResizeObserver((es) => (crumbsW.value = es[0].contentRect.width))
    crumbRO.observe(el)
  }
})
onBeforeUnmount(() => crumbRO?.disconnect())
function crumbW(name: string): number {
  return name.length * 6.6 + 6 // mono 11px 字宽 + chip px-0.5 内边距（略保守）
}
const SEP_W = 12
const ELLIPSIS_W = 18
const visibleCrumbs = computed(() => {
  const all = crumbs.value
  if (!crumbsW.value) return all // 首帧未量宽：全渲染，RO 挂载即触发立刻收敛
  const budget = crumbsW.value - (all.length > 2 ? ELLIPSIS_W : 0)
  let w = 0
  let k = 0
  while (k < all.length) {
    const cost = crumbW(all[all.length - 1 - k].name) + (k > 0 ? SEP_W : 0)
    if (k >= 1 && w + cost > budget) break // 至少保留当前段
    w += cost
    k++
  }
  return all.slice(all.length - k)
})
const crumbsDropped = computed(() => crumbs.value.length - visibleCrumbs.value.length)
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
  tick()
}
function refresh() {
  // 有路径就强刷当前目录列表。不能在跟随态走 tick 的静默路径等下一轮——右键新建/保存后的
  // 刷新要立刻可见，所以直接 loadDir 非静默强拉；path 还没定位出来（跟随态空路径）交给 tick。
  if (path.value) loadDir(path.value)
  else tick()
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
// 菜单开合状态（reka update:open）：开=true 期间轮询暂停（见 tick），条目快照不被换掉。
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
// 下载（文件或目录）：目录走服务端 tar.gz。浏览器磁盘兜底 Blob，大文件也稳。
const dlBusy = ref(false)
async function downloadTo(p: string, name: string, isDir: boolean) {
  if (dlBusy.value) return
  dlBusy.value = true
  toast(`开始下载 ${name}${isDir ? '（tar.gz）' : ''}`)
  try {
    await downloadEntry(targetId(), p, name, isDir)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    dlBusy.value = false
  }
}
function download(e: FileEntry) {
  return downloadTo(joinPath(e.name), e.name, e.type === 'dir')
}
// 空白处右键「下载当前文件夹」：目录名取 path 尾段（根目录在菜单里禁用，服务端也拒 /）。
function downloadDir() {
  const p = path.value
  return downloadTo(p, p.slice(p.lastIndexOf('/') + 1) || p, true)
}

// —— 名称搜索：命中按相关度前排 + 高亮，未命中不过滤、稳定垫后 ——
// 纯客户端视图（displayEntries 派生自 entries）：静默轮询换列表时搜索结果自动跟着重算。
// 相关度：全等 > 前缀 > 词边界（-_. 空格 数字 之后）> 裸包含（位置越靠前越相关）；
// 同分保持原顺序（服务端目录在前、字母序），未命中 MAX 保持原序垫后。
const q = ref('')
function hitRank(name: string, needle: string): number {
  const n = name.toLowerCase()
  const idx = n.indexOf(needle)
  if (idx < 0) return Number.MAX_SAFE_INTEGER
  if (n === needle) return 0
  if (idx === 0) return 1
  if (/[-_.\s\d]/.test(n[idx - 1])) return 2
  return 3 + Math.min(idx, 64)
}
const displayEntries = computed(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return entries.value
  return entries.value
    .map((e, i) => ({ e, i, r: hitRank(e.name, needle) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.e)
})
// 文件名拆段渲染高亮（多处命中全高亮；大小写不敏感，lower 与原串位置一一对应）。
function nameSegs(name: string): { t: string; hit: boolean }[] {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return [{ t: name, hit: false }]
  const segs: { t: string; hit: boolean }[] = []
  let rest = name
  let lower = name.toLowerCase()
  let pos = lower.indexOf(needle)
  while (pos >= 0) {
    if (pos > 0) segs.push({ t: rest.slice(0, pos), hit: false })
    segs.push({ t: rest.slice(pos, pos + needle.length), hit: true })
    rest = rest.slice(pos + needle.length)
    lower = lower.slice(pos + needle.length)
    pos = lower.indexOf(needle)
  }
  if (rest) segs.push({ t: rest, hit: false })
  return segs
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
        <FilePlus class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :disabled="!path"
        title="新建文件夹"
        @click="nameDialog = { mode: 'newDir' }"
      >
        <FolderPlus class="size-3.5" />
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
        <RefreshCw :class="['size-3.5', loading ? 'animate-spin' : '']" />
      </Button>
      <Button variant="ghost" size="icon-xs" class="shrink-0" title="关闭文件面板" @click="emit('close')">
        <X class="size-3.5" />
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

    <!-- 名称搜索：命中相关度前排 + 高亮，未命中垫后不滤掉；Esc/✕ 清空 -->
    <div v-if="hasTerminal" class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
      <Search class="size-3.5 shrink-0 text-muted-foreground" />
      <input
        v-model="q"
        class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        placeholder="搜索当前目录文件名…"
        @keydown.esc="q = ''"
      />
      <button
        v-if="q"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        title="清除搜索"
        @click="q = ''"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <!-- 路径行：面包屑（祖先可点直达，溢出折叠成…，末段点击进编辑）+ 上一级 + 宿主路径弹框。
         上一级用彩色 FolderUp：裸 chevron 语义太泛（收起/回顶?），文件夹+上箭头无歧义；
         蓝色与列表里文件夹图标同色系（目录动作的语言）。行内图标一律裸按钮（与搜索行同款，
         无 Button 外壳的 6px 盒子），两行字形垂直完全对齐。 -->
    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
      <button
        v-if="path && path !== '/'"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        title="上一级"
        @click="goParent"
      >
        <FolderUp class="size-3.5 shrink-0 text-sky-400" />
      </button>
      <input
        v-if="editingPath"
        ref="pathInputEl"
        v-model="pathInput"
        class="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px]"
        @keydown.enter.prevent="commitPath"
        @keydown.esc="editingPath = false"
        @blur="commitPath"
      />
      <div
        v-else-if="path"
        ref="crumbsEl"
        class="flex min-w-0 flex-1 items-center gap-0 overflow-hidden"
        title="点击任意上级直达；点击当前目录可编辑路径"
      >
        <button
          v-if="crumbsDropped"
          class="flex shrink-0 items-center rounded px-0.5 font-mono text-[11px] leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title="中间层级已折叠，点击编辑完整路径"
          @click="startEditPath"
        >
          …
        </button>
        <template v-for="(c, i) in visibleCrumbs" :key="c.p">
          <ChevronRight v-if="i || crumbsDropped" class="size-2.5 shrink-0 text-muted-foreground/40" />
          <button
            class="flex shrink-0 items-center rounded px-0.5 font-mono text-[11px] leading-none"
            :class="
              i === visibleCrumbs.length - 1
                ? 'text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            "
            @click="i === visibleCrumbs.length - 1 ? startEditPath() : openDir(c.p)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <span v-else class="min-w-0 flex-1 font-mono text-[11px] text-muted-foreground">…</span>
      <!-- 宿主实际路径：弹框展示容器路径与宿主 rootfs 实址（D1 直通，宿主可直读直写），
           宿主行点击复制。容器路径不设复制——就在屏上，终端里 tab 补全更顺手。 -->
      <Popover v-if="path">
        <PopoverTrigger as-child>
          <button class="shrink-0 text-muted-foreground hover:text-foreground" title="宿主机实际路径">
            <HardDrive class="size-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-80">
          <div v-if="!isHost" class="mb-2">
            <p class="mb-0.5 text-[10px] text-muted-foreground">容器内路径</p>
            <p class="break-all font-mono text-[11px]">{{ path }}</p>
          </div>
          <button
            class="block w-full text-left"
            title="点击复制宿主路径"
            @click="copyHostPath"
          >
            <p class="mb-0.5 text-[10px] text-muted-foreground">
              {{ isHost ? '宿主机路径（点击复制）' : '宿主机实际路径（点击复制）' }}
            </p>
            <p class="flex items-start gap-1.5 break-all font-mono text-[11px] text-foreground hover:text-primary">
              <span class="min-w-0">{{ hostPath || '（无法映射）' }}</span>
              <Copy v-if="hostPath" class="mt-0.5 size-3 shrink-0 opacity-60" />
            </p>
          </button>
        </PopoverContent>
      </Popover>
    </div>

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
              v-for="e in displayEntries"
              :key="e.name"
              :data-entry="e.name"
              class="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-accent/50"
              @click="openEntry(e)"
            >
              <Folder v-if="e.type === 'dir'" class="size-3.5 shrink-0 text-sky-400" />
              <Link2 v-else-if="e.type === 'link'" class="size-3.5 shrink-0 text-violet-400" />
              <FileText v-else class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">
                <template v-for="(s, i) in nameSegs(e.name)" :key="i">
                  <span v-if="s.hit" class="rounded bg-primary/20 px-0.5 font-semibold text-primary">{{ s.t }}</span>
                  <template v-else>{{ s.t }}</template>
                </template>
              </span>
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
                    <MoreHorizontal class="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @click="download(e)">
                    <Download /> 下载
                  </DropdownMenuItem>
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
          <ContextMenuItem @click="download(ctxEntry)">
            <Download /> 下载
          </ContextMenuItem>
          <ContextMenuItem @click="nameDialog = { mode: 'rename' }">
            <PenLine /> 重命名
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @click="delTarget = ctxEntry">
            <Trash2 /> 删除
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuItem :disabled="!path || path === '/'" @click="downloadDir">
          <Download /> 下载当前文件夹
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newFile' }">
          <FilePlus /> 新建文件
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newDir' }">
          <FolderPlus /> 新建文件夹
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

    <!-- Git 变更 dock（底部）：条目点击以对比形态开 tab，可折叠，折叠头常显分支+变更数 -->
    <FilePanelGit
      v-if="hasTerminal && path"
      ref="gitRef"
      :key="targetId()"
      :container-id="targetId()"
      :path="path"
      @open-change="
        (t) => emit('open-file', t.path, t.headPath ? { diff: { headPath: t.headPath } } : undefined)
      "
    />

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
