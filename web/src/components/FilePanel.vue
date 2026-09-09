<script setup lang="ts">
// 右侧文件面板：跟随终端 pane 的 cwd 展示目录内容（tmux 查询），可逐级浏览、点文件
// 抛 open-file 给父级开编辑器，右键 新建文件/新建文件夹/重命名/删除。跟随与手动浏览
// 互斥：手动导航（点目录/输路径/外部定位）暂停跟随，恢复条一键回到终端所在目录。
import { ref, reactive, computed, watch, onMounted, onUnmounted, onBeforeUnmount, nextTick } from 'vue'
import {
  listFiles,
  getTermCwd,
  createEntry,
  renameEntry,
  deleteEntry,
  downloadEntry,
  copyEntry,
  setFileClipboard,
  getFileClipboard,
  Unauthorized,
  HOST_ID,
  type FileEntry,
  type FilesView,
  type FileClipboard,
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
  ChevronDown,
  PenLine,
  FilePlus,
  FolderPlus,
  Trash2,
  Download,
  Search,
  Loader2,
  HardDrive,
  ClipboardPaste,
  Copy,
  MoreHorizontal,
  Pencil,
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
  // opts.editing = 右键「编辑」直接落编辑态（默认只读）。
  (e: 'open-file', path: string, opts?: { diff?: { headPath?: string }; editing?: boolean }): void
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

// —— 路径复制 ——
// navigator.clipboard 不可用（http 局域网访问）时走 execCommand 兜底，必须同步在
// 用户手势栈里调（与 Terminal.vue / ContainerList.vue 同一手法的第三次落点，体量小不抽公共）。
function copyText(s: string, okMsg: string) {
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
  const done = (ok: boolean) => (ok ? toast(okMsg) : toast.error('复制失败：剪贴板不可用'))
  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(s)
      .then(() => done(true))
      .catch(() => done(legacy()))
  } else {
    done(legacy())
  }
}
// 顶栏弹框：复制当前目录的宿主路径。
function copyHostPath() {
  if (hostPath.value) copyText(hostPath.value, '已复制宿主路径')
}
// 行条目的宿主实际路径：当前目录 hostPath 加相对后缀（容器 /home/dev 在宿主 rootfs 是
// 线性映射，子路径同规则拼接即可，无需额外请求）。hostPath 不可用（挂载点等映射不到的
// 目录）返回 null，菜单里隐藏该项；宿主面板下 hostPath 就是路径本身，拼接天然成立。
function hostPathOf(row: EntryRow): string | null {
  if (!hostPath.value) return null
  const base = hostPath.value.replace(/\/+$/, '')
  if (row.path === path.value) return base || '/'
  const rel = path.value === '/' ? row.path : row.path.slice(path.value.length)
  return base + rel
}
function copyRowHostPath(row: EntryRow) {
  const hp = hostPathOf(row)
  if (hp) copyText(hp, '已复制实际路径')
}

// —— 跨面板复制粘贴（文件/文件夹通用）——
// 剪贴板是模块级单例（api.ts）：复制后切到目标容器/宿主的文件面板粘贴，支持
// 容器↔宿主↔容器与同容器跨目录。目标冲突由服务端 409 报错（不覆盖）。
const clip = ref<FileClipboard | null>(getFileClipboard())

// —— 多选（VS Code 式）：普通点击 = 打开/进入并清空选中；Ctrl/⌘ 点击 = 加入/移出选中；
// Shift 点击 = 从锚点到当前行范围选。选中按完整路径记（展开视图里同名条目可多层出现，
// 路径才唯一），3s 静默轮询换列表不影响；换目录整体清空（见下方 path watch）。
const selected = ref<Set<string>>(new Set())
let selAnchor: string | null = null
// 平铺视图里按显示顺序的条目路径：Shift 范围选的坐标系。
const entryPaths = computed(() =>
  rows.value.filter((r): r is EntryRow => r.kind === 'entry').map((r) => r.path),
)
function onRowClick(row: EntryRow, ev: MouseEvent) {
  if (ev.ctrlKey || ev.metaKey) {
    const s = new Set(selected.value)
    if (s.has(row.path)) s.delete(row.path)
    else s.add(row.path)
    selected.value = s
    selAnchor = row.path
    return
  }
  if (ev.shiftKey && selAnchor && selAnchor !== row.path) {
    const all = entryPaths.value
    const a = all.indexOf(selAnchor)
    const b = all.indexOf(row.path)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      selected.value = new Set(all.slice(lo, hi + 1))
      return
    }
  }
  selected.value = new Set()
  selAnchor = row.path
  openRow(row)
}
// 复制目标：右键/⋯ 菜单命中的行在选中集内 = 整个选中集一起复制，否则收拢为仅该行
// （VS Code 同语义）。选中集按 rows 现存条目过滤——选中后条目被删/折叠收起的不进剪贴板。
function copyToClipboard(row: EntryRow) {
  if (!selected.value.has(row.path)) {
    selected.value = new Set([row.path])
    selAnchor = row.path
  }
  const items = rows.value
    .filter((r): r is EntryRow => r.kind === 'entry' && selected.value.has(r.path))
    .map((r) => ({ path: r.path, name: r.entry.name, isDir: r.entry.type === 'dir' }))
  if (!items.length) return
  const c: FileClipboard = {
    containerId: targetId(),
    containerName: props.containerName,
    items,
  }
  setFileClipboard(c)
  clip.value = c
  toast(
    items.length === 1
      ? `已复制「${items[0].name}」，到目标面板粘贴（可跨容器 / 宿主）`
      : `已复制 ${items.length} 项，到目标面板粘贴（可跨容器 / 宿主）`,
  )
}
// 菜单文案：命中行在多选集内时显示数量。
function copyLabel(row: EntryRow): string {
  return selected.value.has(row.path) && selected.value.size > 1
    ? `复制选中 ${selected.value.size} 项（跨面板粘贴）`
    : '复制（跨面板粘贴）'
}
// 粘贴按钮 tooltip（顶栏）：单项显名字，多项显数量。
const clipLabel = computed(() => {
  const c = clip.value
  if (!c) return ''
  return c.items.length === 1
    ? `粘贴「${c.items[0].name}」到当前目录`
    : `粘贴 ${c.items.length} 项到当前目录`
})
function pasteInto(dir: string) {
  const c = clip.value
  if (!c || !dir) return
  const dstC = targetId()
  const from = c.containerId === HOST_ID ? '宿主' : c.containerName || c.containerId
  const to = isHost.value ? '宿主' : props.containerName
  const dstOf = (name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
  const items = c.items
  const total = items.length
  // 逐项顺序复制（服务端一份源一条 tar 管道）：单项冲突/失败不中断其余项，最后汇总。
  // 全部失败抛第一项错误走 error 分支；部分失败走成功分支外补一条 warning。
  toast.promise(
    (async () => {
      const failed: string[] = []
      for (const it of items) {
        try {
          await copyEntry({
            srcContainer: c.containerId,
            srcPath: it.path,
            dstContainer: dstC,
            dstPath: dstOf(it.name),
          })
        } catch (e) {
          failed.push(`${it.name}：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      if (failed.length === total) throw new Error(failed[0])
      if (dir === path.value) refresh() // 粘进当前目录立即刷新；粘进子目录下钻时可见
      if (failed.length)
        toast.warning(`其余 ${total - failed.length} 项已粘贴；失败：${failed.join('；')}`)
      return total === 1
        ? `已复制到 ${dstOf(items[0].name)}`
        : `已粘贴 ${total - failed.length}/${total} 项`
    })(),
    {
      loading:
        total === 1
          ? `正在复制 ${items[0].name}（${from} → ${to}）…`
          : `正在复制 ${total} 项（${from} → ${to}）…`,
      success: (msg: string) => msg,
      error: (e: unknown) => (e instanceof Error ? e.message : String(e)),
    },
  )
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let loadSeq = 0 // 竞态防护：慢响应回来时已被新请求取代则丢弃
// 非静默加载在途数：>0 = 转圈。静默轮询不置位也不清理（见 loadDir finally 的注释）。
let navOps = 0
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
  if (!opts.silent) {
    navOps++
    loading.value = true
  }
  try {
    const v = await listFiles(targetId(), p)
    if (seq !== loadSeq) return // 过期响应
    // 静默轮询发出后目标目录被导航换掉：丢弃，防止列表回跳旧目录
    if (opts.silent && p !== path.value) return
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
    // 转圈只由非静默请求置位，也只由非静默请求收尾——不能拿 seq 比较当清理条件：
    // 并发的静默轮询抢先完成会推高 loadSeq，非静默响应（导航目标）回来时被当过期
    // 跳过清理，转圈卡死且刷新按钮永久禁用（「点开文件夹一直 loading」就是这么来的）。
    if (!opts.silent && --navOps <= 0) {
      navOps = 0
      loading.value = false
    }
  }
}

// 轮询（3s）两层职责：
// 1) 跟随态查终端 cwd，变了就跳目录（loadDir 负责拉新列表）；
// 2) 当前目录内容静默重查：容器内进程/他人新建文件不用手点刷新即出现（签名不变则零
//    DOM 变更）。面板用 v-if 挂载，关闭即卸载、onUnmounted 清 timer，不空转。
// 右键菜单/操作弹窗开着时整体跳过：列表被换会让 ctxTarget 指向已不存在的条目对象、
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
  // 展开的子目录跟着静默刷新（per-dir 签名，内容没变零 DOM 变更）。
  for (const [p, st] of expanded) {
    if (st.open) void loadExpanded(p, true)
  }
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
    path.value = '' // 连路径一起清：在途静默响应的 p 比对落空被丢弃，不把旧容器列表写进新容器
    hostPath.value = null
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
// 路径变化（跟随跳转/手动导航/面包屑）：树展开整体收起——展开是「当前目录视图」的形态，
// 换了目录旧展开没有意义；静默轮询写回同值不触发 watch，展开原样保留。
watch(path, () => {
  expanded.clear()
  selected.value = new Set() // 换目录清空多选（选中是当前目录视图的形态，同展开）
  selAnchor = null
})

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
// contextmenu，按 data-path 找行（展开视图里同名条目可出现在多层，名字不再唯一）——
// 不用嵌套 trigger，也不 .stop（会阻断 reka 监听）。
const ctxTarget = ref<EntryRow | null>(null)
// 菜单开合状态（reka update:open）：开=true 期间轮询暂停（见 tick），条目快照不被换掉。
const menuOpen = ref(false)
function onCtxMenu(ev: MouseEvent) {
  const p = (ev.target as HTMLElement).closest('[data-path]')?.getAttribute('data-path') ?? null
  ctxTarget.value = p
    ? (rows.value.find((r): r is EntryRow => r.kind === 'entry' && r.path === p) ?? null)
    : null
}
// 触屏行内 ⋯ 菜单（手机右键不可达）：与 ContextMenu 同一批动作/处理器，只是入口不同。
function onRowMenu(row: EntryRow) {
  ctxTarget.value = row
}
// 命名弹窗：mode 区分三个操作；entry 为重命名/删除目标。err 是异步结果回显。
const nameDialog = ref<null | { mode: 'newFile' | 'newDir' | 'rename' }>(null)
const delTarget = ref<EntryRow | null>(null)
const opErr = ref('')
const opBusy = ref(false)
// 下载（文件或目录，目录走服务端 tar.gz）：名字取路径尾段，展开视图里的子层条目同样适用。
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
function download(row: EntryRow) {
  const name = row.path.slice(row.path.lastIndexOf('/') + 1) || row.path
  return downloadTo(row.path, name, row.entry.type === 'dir')
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

// —— 目录展开（行内树形视图）——
// 点行 = 进入目录（原导航不变）；点行首 chevron 或文件夹图标 = 原位展开子内容，子目录
// 可继续层层展开。展开状态按完整路径记（子层会出现与顶层同名的条目，路径才唯一）；
// 导航去新目录（path 变化）整体收起（见上方 watch），搜索时收起、只按相关度平铺——
// 树展开与搜索排序混排会让人迷失层级。
// 展开的目录随 3s 静默轮询刷新（per-dir 签名，内容没变零 DOM 变更，与主列表同手法）。
type EntryRow = { kind: 'entry'; entry: FileEntry; path: string; depth: number }
type TreeRow =
  | EntryRow
  | { kind: 'err'; path: string; depth: number; msg: string }
  | { kind: 'empty'; path: string; depth: number }
type ExpandState = { open: boolean; loading: boolean; entries: FileEntry[]; err: string; sig: string }
// 行几何：基础左距（原 px-2.5）+ 每层缩进；展开错误/空目录行再右移到名字列
// （chevron 16px + gap 8px），与同层文件名对齐。
const ROW_BASE = 10
const ROW_INDENT = 16

const expanded = reactive(new Map<string, ExpandState>())
const expandSeq = new Map<string, number>()

// 当前目录下拼完整路径（rows 顶层与新建/删除共用）。
function joinPath(name: string): string {
  return path.value === '/' ? `/${name}` : `${path.value}/${name}`
}

async function loadExpanded(p: string, silent: boolean) {
  const st = expanded.get(p)
  if (!st) return
  const seq = (expandSeq.get(p) ?? 0) + 1
  expandSeq.set(p, seq)
  if (!silent) st.loading = true
  try {
    const v = await listFiles(targetId(), p)
    if (seq !== expandSeq.get(p)) return // 过期响应
    const sig = sigOf(v)
    if (!silent || sig !== st.sig) {
      st.entries = v.entries
      st.sig = sig
    }
    if (!silent) st.err = ''
  } catch (e) {
    if (seq !== expandSeq.get(p)) return
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    // 静默失败保留旧内容下轮再试；手动展开的失败进行内错误行（点击重试）。
    if (!silent) st.err = e instanceof Error ? e.message : String(e)
  } finally {
    // 同 loadDir：清理不拿 seq 当条件——静默轮询抢先完成推高 expandSeq，手动展开的
    // 响应被当过期后若跳过清理，行内转圈卡死（行上有独立 loading 态）。
    if (!silent) st.loading = false
  }
}

function toggleExpand(row: EntryRow) {
  const p = row.path
  const st = expanded.get(p)
  if (st) {
    st.open = !st.open
    // 收起过的缓存还在（内容冻结在收起时刻）——重开有缓存先显示，空/出错才重拉，
    // 打开后的下一轮静默轮询会把内容追平。
    if (st.open && !st.entries.length && !st.err && !st.loading) void loadExpanded(p, false)
    return
  }
  expanded.set(p, { open: true, loading: true, entries: [], err: '', sig: '' })
  void loadExpanded(p, false)
}

// 行点击语义：目录进目录、link 先试目录后回退文件、文件抛 open-file（与原 openEntry 一致）。
function openRow(row: EntryRow) {
  if (row.entry.type === 'dir') openDir(row.path)
  else if (row.entry.type === 'link') void openLink(row.path)
  else emit('open-file', row.path)
}

// 平面化渲染模型：主列表 + 各展开目录的子内容（递归，带缩进层级），v-for 直接吃它。
// 搜索态退化为 displayEntries 的单层平铺。sigOf 吃 FilesView（子目录视图同构，签名复用）。
const rows = computed<TreeRow[]>(() => {
  if (q.value.trim()) {
    return displayEntries.value.map((e) => ({
      kind: 'entry' as const,
      entry: e,
      path: joinPath(e.name),
      depth: 0,
    }))
  }
  const out: TreeRow[] = []
  const walk = (list: FileEntry[], parent: string, depth: number) => {
    for (const e of list) {
      const p = parent === '/' ? `/${e.name}` : `${parent}/${e.name}`
      out.push({ kind: 'entry', entry: e, path: p, depth })
      if (e.type !== 'dir') continue
      const st = expanded.get(p)
      if (!st?.open) continue
      if (st.err) out.push({ kind: 'err', path: p, depth: depth + 1, msg: st.err })
      else if (!st.entries.length) {
        if (!st.loading) out.push({ kind: 'empty', path: p, depth: depth + 1 })
      } else walk(st.entries, p, depth + 1)
    }
  }
  walk(entries.value, path.value, 0)
  return out
})

async function confirmName(name: string) {
  const d = nameDialog.value
  if (!d) return
  opErr.value = ''
  opBusy.value = true
  try {
    const id = targetId()
    if (d.mode === 'rename') {
      const t = ctxTarget.value
      if (t && name !== t.entry.name) await renameEntry(id, t.path, name)
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
    await deleteEntry(targetId(), delTarget.value.path)
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
      <!-- 粘贴（跨面板剪贴板非空时出现）：粘到当前目录。触屏无右键，这是触屏粘贴入口。 -->
      <Button
        v-if="clip"
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :disabled="!path"
        :title="clipLabel"
        @click="pasteInto(path)"
      >
        <ClipboardPaste class="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        class="shrink-0"
        :disabled="loading"
        :title="loading ? '刷新中…' : '刷新'"
        @click="refresh"
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
            <!-- 行 = 树平面化结果（rows）：主列表 + 各展开目录的子内容。点行 = 进入/打开，
                 Ctrl/⌘ 点行 = 加入/移出多选、Shift 点行 = 从锚点范围选（VS Code 式，选中集
                 供「复制」整体带走）；点行首 chevron 或文件夹图标 = 原位展开子目录（.stop
                 防止触发行点击）；文件行用等宽占位保持名字列对齐。 -->
            <template v-for="row in rows" :key="row.kind + ':' + row.path">
              <!-- 展开失败的行内错误（点击重试）与空目录占位：缩进到同层名字列 -->
              <button
                v-if="row.kind === 'err'"
                class="block w-full py-1 text-left font-mono text-[11px] text-destructive/80 hover:text-destructive"
                :style="{ paddingLeft: `${ROW_BASE + row.depth * ROW_INDENT + 24}px` }"
                title="点击重试"
                @click="loadExpanded(row.path, false)"
              >
                {{ row.msg }}（点击重试）
              </button>
              <p
                v-else-if="row.kind === 'empty'"
                class="py-1 font-mono text-[11px] text-muted-foreground/50"
                :style="{ paddingLeft: `${ROW_BASE + row.depth * ROW_INDENT + 24}px` }"
              >
                （空）
              </p>
              <div
                v-else
                :data-path="row.path"
                class="flex cursor-pointer items-center gap-2 py-1.5 pr-2.5"
                :class="selected.has(row.path) ? 'bg-accent hover:bg-accent/70' : 'hover:bg-accent/50'"
                :style="{ paddingLeft: `${ROW_BASE + row.depth * ROW_INDENT}px` }"
                @click="onRowClick(row, $event)"
              >
                <!-- 展开热区 = chevron + 文件夹图标整体（含中间空隙）：点哪都是展开/收起，
                     间隙不再漏给行点击造成误下钻；hover 双双变亮 + cursor 暗示整块可点，
                     展开态 chevron 常亮（收起态淡灰）。点名字仍是进入目录。文件/link 行用
                     等宽占位（w-4 + 行 gap + 图标 = 38px）保持名字列对齐。 -->
                <span
                  v-if="row.entry.type === 'dir'"
                  class="group flex shrink-0 cursor-pointer items-center"
                  title="展开 / 收起"
                  @click.stop="toggleExpand(row)"
                >
                  <span
                    class="flex size-4 items-center justify-center group-hover:text-foreground"
                    :class="expanded.get(row.path)?.open ? 'text-foreground' : 'text-muted-foreground/50'"
                  >
                    <Loader2 v-if="expanded.get(row.path)?.loading" class="size-3 animate-spin" />
                    <ChevronDown v-else-if="expanded.get(row.path)?.open" class="size-3" />
                    <ChevronRight v-else class="size-3" />
                  </span>
                  <Folder class="ml-2 size-3.5 shrink-0 text-sky-400 group-hover:text-sky-300" />
                </span>
                <span v-else class="h-4 w-4 shrink-0" />
                <Link2 v-if="row.entry.type === 'link'" class="size-3.5 shrink-0 text-violet-400" />
                <FileText v-else-if="row.entry.type === 'file'" class="size-3.5 shrink-0 text-muted-foreground" />
                <span class="min-w-0 flex-1 truncate font-mono text-xs">
                  <template v-for="(s, i) in nameSegs(row.entry.name)" :key="i">
                    <span v-if="s.hit" class="rounded bg-primary/20 px-0.5 font-semibold text-primary">{{ s.t }}</span>
                    <template v-else>{{ s.t }}</template>
                  </template>
                </span>
                <span v-if="row.entry.type !== 'dir'" class="shrink-0 text-[10px] text-muted-foreground">{{
                  fmtSize(row.entry.size)
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
                    <DropdownMenuItem v-if="row.entry.type === 'file'" @click="emit('open-file', row.path, { editing: true })">
                      <Pencil /> 编辑
                    </DropdownMenuItem>
                    <DropdownMenuItem @click="download(row)">
                      <Download /> 下载
                    </DropdownMenuItem>
                    <DropdownMenuItem @click="copyToClipboard(row)">
                      <ClipboardPaste /> {{ copyLabel(row) }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="!isHost" @click="copyText(row.path, '已复制容器路径')">
                      <Copy /> 复制容器路径
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="hostPathOf(row)" @click="copyRowHostPath(row)">
                      <Copy /> 复制实际路径
                    </DropdownMenuItem>
                    <DropdownMenuItem @click="onRowMenu(row); nameDialog = { mode: 'rename' }">
                      <PenLine /> 重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" @click="onRowMenu(row); delTarget = row">
                      <Trash2 /> 删除
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </template>
          </template>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <template v-if="ctxTarget">
          <ContextMenuItem v-if="ctxTarget.entry.type === 'file'" @click="emit('open-file', ctxTarget.path, { editing: true })">
            编辑
          </ContextMenuItem>
          <ContextMenuItem @click="copyToClipboard(ctxTarget)">
            {{ copyLabel(ctxTarget) }}
          </ContextMenuItem>
          <ContextMenuItem v-if="!isHost" @click="copyText(ctxTarget.path, '已复制容器路径')">
            复制容器路径
          </ContextMenuItem>
          <ContextMenuItem v-if="hostPathOf(ctxTarget)" @click="copyRowHostPath(ctxTarget)">
            复制实际路径
          </ContextMenuItem>
          <ContextMenuItem @click="download(ctxTarget)">
            下载
          </ContextMenuItem>
          <ContextMenuItem @click="nameDialog = { mode: 'rename' }">
            重命名
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @click="delTarget = ctxTarget">
            删除
          </ContextMenuItem>
          <ContextMenuItem v-if="clip && ctxTarget.entry.type === 'dir'" @click="pasteInto(ctxTarget.path)">
            粘贴到该文件夹
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuItem v-if="clip" :disabled="!path" @click="pasteInto(path)">
          粘贴到当前目录
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path || path === '/'" @click="downloadDir">
          下载当前文件夹
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newFile' }">
          新建文件
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newDir' }">
          新建文件夹
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

    <!-- Git 变更 dock（底部）：条目点击以对比形态开 tab，可折叠，折叠头常显分支+变更数。
         diff 恒传（headPath 仅 R/C 有）：任何条目点击都以对比形态打开（untracked/新增 =
         左侧空的全增视图，服务端 absent 协议已兜住）——若写成「有 headPath 才带 diff」，
         M/A/D 等普通修改条目会静默落回普通编辑器形态。 -->
    <FilePanelGit
      v-if="hasTerminal && path"
      ref="gitRef"
      :key="targetId()"
      :container-id="targetId()"
      :path="path"
      @open-change="
        (t) => emit('open-file', t.path, { diff: t.headPath ? { headPath: t.headPath } : {} })
      "
      @navigate="openDir"
    />

    <!-- 命名弹窗（新建/重命名共用） -->
    <NameDialog
      v-if="nameDialog"
      :title="nameDialog.mode === 'rename' ? '重命名' : nameDialog.mode === 'newDir' ? '新建文件夹' : '新建文件'"
      :desc="nameDialog.mode === 'rename' ? ctxTarget?.path : path"
      :initial="nameDialog.mode === 'rename' ? ctxTarget?.entry.name : ''"
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
      :description="`确定删除 ${delTarget.entry.type === 'dir' ? '目录' : ''}“${delTarget.entry.name}”？${
        delTarget.entry.type === 'dir' ? '目录内所有内容将一并删除，' : ''
      }此操作不可恢复。`"
      confirm-text="删除"
      variant="destructive"
      :busy="opBusy"
      @confirm="confirmDelete"
      @close="delTarget = null"
    />
  </div>
</template>
