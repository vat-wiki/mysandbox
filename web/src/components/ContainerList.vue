<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick, defineAsyncComponent } from 'vue'
import {
  listContainers,
  startContainer,
  stopContainer,
  restartContainer,
  adoptContainer,
  deleteContainer,
  listFiles,
  getListenPorts,
  getHostCwd,
  HOST_ID,
  Unauthorized,
  type ContainerView,
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { baseLabel } from '@/lib/caps'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Terminal as TerminalIcon, MoreHorizontal, RefreshCw, X, FolderOpen, CheckCheck, Monitor } from 'lucide-vue-next'
import CreateDialog from '@/components/CreateDialog.vue'
import BatchDialog from '@/components/BatchDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DeleteContainerDialog from '@/components/DeleteContainerDialog.vue'
import PaneDivider from '@/components/PaneDivider.vue'
import FilePanel from '@/components/FilePanel.vue'

// 异步加载终端组件：xterm 全家桶只在首次打开终端时才下载，首屏（容器列表）更轻。
const Terminal = defineAsyncComponent(() => import('@/components/Terminal.vue'))
// 文件编辑器（Monaco 较重）同理：点开文件才下载。
const FileEditorDialog = defineAsyncComponent(() => import('@/components/FileEditorDialog.vue'))
// 桌面查看器（noVNC，较重）：点「桌面」才下载。
const DesktopDialog = defineAsyncComponent(() => import('@/components/DesktopDialog.vue'))

// CLI `mysandbox open` 深链请求（App 解析 #open hash 后传入；seq 自增触发消费）。
export interface OpenReq {
  containerId: string
  path: string
  kind: 'file' | 'dir'
  seq: number
}

const props = defineProps<{ baseReady?: boolean | null; openReq?: OpenReq | null }>()
const emit = defineEmits<{
  (e: 'unauthorized'): void
  (e: 'open-base'): void
  (e: 'open-hosts'): void
  (e: 'open-handled'): void
}>()

const items = ref<ContainerView[]>([])
const loading = ref(false)
const err = ref('')
// 连接状态：轮询失败 -> connLost（温和提示条 + 保留旧数据）；恢复自动消失。
const connLost = ref(false)
const lastOkAt = ref(0)
const busy = ref<Record<string, boolean>>({})

// 终端 tab 持久化：刷新后重新打开之前那几个容器的终端、回到上次激活的 tab。
// 只存 {id,name} + activeIdx——会话本身的持久（滚动历史 / 正在跑的进程）由容器内 tmux 负责。
const TABS_KEY = 'mysandbox:term-tabs-v3'
function newTermId(): string {
  return crypto.randomUUID()
}
function newGroupId(): string {
  return crypto.randomUUID()
}
// 一个 group = 一个容器终端组：1..N 个 pane 水平并排，每 pane 一个独立 termId/会话。
// kind='host' 为宿主终端组（PTY 由 server 管理，cwd=镜像目录，containerId 为哨兵 '__host__'）。
interface Pane {
  termId: string
}
interface TermGroup {
  id: string
  containerId: string
  name: string
  kind?: 'host'
  panes: Pane[]
}
function loadTabs(): { groups: TermGroup[]; activeIdx: number } {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return { groups: [], activeIdx: 0 }
    const p = JSON.parse(raw) as { groups?: unknown; activeIdx?: unknown }
    const arr = Array.isArray(p.groups) ? p.groups : []
    const groups: TermGroup[] = arr
      .filter(
        (g): g is Record<string, unknown> =>
          !!g && typeof g === 'object' && typeof (g as { containerId?: unknown }).containerId === 'string',
      )
      .map((g) => ({
        id: typeof g.id === 'string' ? g.id : newGroupId(),
        containerId: String(g.containerId),
        name: typeof g.name === 'string' ? g.name : String(g.containerId),
        kind: g.kind === 'host' ? ('host' as const) : undefined,
        // 兼容旧 v2（每 tab 单 termId）：旧数据无 panes -> 包装成单 pane。
        panes:
          Array.isArray(g.panes) && g.panes.length
            ? g.panes
                .filter((pn) => !!pn && typeof (pn as { termId?: unknown }).termId === 'string')
                .map((pn) => ({ termId: String((pn as { termId: string }).termId) }))
            : [{ termId: typeof g.termId === 'string' ? g.termId : newTermId() }],
      }))
    const activeIdx = typeof p.activeIdx === 'number' ? p.activeIdx : 0
    return { groups, activeIdx: Math.min(Math.max(activeIdx, 0), Math.max(groups.length - 1, 0)) }
  } catch {
    return { groups: [], activeIdx: 0 }
  }
}
const savedTabs = loadTabs()
const groups = ref<TermGroup[]>(savedTabs.groups)
const activeIdx = ref(savedTabs.activeIdx)
// 二维 ref：termRefs[groupIdx][paneIdx]，closePane 时调 kill() 发 kill 帧真杀会话。
const termRefs = ref<(InstanceType<typeof Terminal> | null)[][]>([])
function saveTabs(): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ groups: groups.value, activeIdx: activeIdx.value }))
  } catch {
    /* localStorage 不可用就跳过 */
  }
}
watch([groups, activeIdx], saveTabs, { deep: true })

// ---- 拖动调整尺寸 ----
// 终端已占满主区，只剩一轴：pane 宽度（分隔条左右拖，flex-grow 比例，不持久化——
// 结构变化即重置等分，拖动只调比例）。Terminal 自带 ResizeObserver，容器尺寸一变即
// 自动 refit -> onResize -> 后端 exec.resize，无需额外联动后端。

// pane 宽比例：paneGrow[groupId] = 各 pane 的 flex-grow（等分时全 1）。分隔条固定 w-1=4px，
// pane 用 flexBasis:0 + flexGrow 按比例分剩余空间，故分隔条占位自动扣除、不溢出。
const paneGrow = ref<Record<string, number[]>>({})
function equalGrow(n: number): number[] {
  return Array.from({ length: n }, () => 1)
}
function initGrow(g: TermGroup): void {
  paneGrow.value[g.id] = equalGrow(g.panes.length)
}
function paneGrowOf(g: TermGroup, pIdx: number): number {
  return paneGrow.value[g.id]?.[pIdx] ?? 1
}
let dragGId = ''
let dragLeft = 0
let dragStartGrow: number[] = []
let dragAvailW = 0
// 拖动某分隔条时的快照（PaneDivider 的 dragstart 设、drag 用）。
// pIdx = 分隔条之后的 pane 序号；分隔条在 pane[pIdx-1] 与 pane[pIdx] 之间，拖动只调这两个。
function onPaneDragStart(g: TermGroup, pIdx: number, parentWidth: number) {
  dragGId = g.id
  dragLeft = pIdx - 1
  dragStartGrow = [...(paneGrow.value[g.id] ?? equalGrow(g.panes.length))]
  dragAvailW = Math.max(1, parentWidth - 4 * (g.panes.length - 1)) // 每条分隔条 4px
}
function onPaneDrag(dx: number) {
  const cur = paneGrow.value[dragGId]
  if (!cur) return
  const sumGrow = dragStartGrow.reduce((a, b) => a + b, 0) || 1
  const dGrow = (dx / dragAvailW) * sumGrow
  const l = dragLeft
  const sum = dragStartGrow[l] + dragStartGrow[l + 1]
  const minGrow = (120 / dragAvailW) * sumGrow // 最小 120px 对应的 grow
  let a = dragStartGrow[l] + dGrow
  let b = sum - a
  if (a < minGrow) {
    a = minGrow
    b = sum - minGrow
  }
  if (b < minGrow) {
    b = minGrow
    a = sum - minGrow
  }
  cur[l] = a
  cur[l + 1] = b
}
// 载入已存 group 时初始化各 group 的 pane 比例为等分。
for (const g of savedTabs.groups) initGrow(g)

const showCreate = ref(false)
// 批量选择：平时不占位，hover 行首浮现勾选框；勾中任意一个进入选择态（受管理容器全部常显），
// 执行完成 / Esc / 取消即退出。选择发生在列表上，批量对话框只吃打开时的快照。
const selected = ref<Set<string>>(new Set())
const selectionActive = computed(() => selected.value.size > 0)
// 快照而非 live 绑定：done 后立即清空选择，不能回头改已开对话框里的「已选 N 个」
const batchSel = ref<{ ids: string[]; names: string[] } | null>(null)
// 纳入管理（输入显示名）/ 删除 的目标容器，非 null 即弹对应 Dialog
const adoptTarget = ref<ContainerView | null>(null)
const delTarget = ref<ContainerView | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

// ---- 文件面板 ----
const showFiles = ref(false)
// 面板宽度（像素制，拖动独立于终端 pane 的比例制 paneGrow）。
const filesW = ref(320)
// 拖宽快照：dragstart 记下起始宽度与容器总宽，drag 按位移换算。
let filesDragStartW = 0
let filesDragAvailW = 0
function onFilesDragStart(_g: unknown, pIdx: number, parentWidth: number) {
  filesDragStartW = filesW.value
  filesDragAvailW = parentWidth
}
function onFilesDrag(dx: number) {
  // 面板在右侧：向左拖（负 dx）变宽
  const w = filesDragStartW - dx
  filesW.value = Math.min(Math.max(w, 220), Math.max(220, filesDragAvailW - 380))
}
// 文件面板跟随哪个 pane（active group 内的序号；group 切换/结构变化时归零）。
const filePaneIdx = ref(0)
const activeGroup = computed(() => groups.value[activeIdx.value])
const filePanes = computed(() => {
  const g = activeGroup.value
  if (!g) return []
  return g.panes.map((p, i) => ({ termId: p.termId, label: `${g.name} #${i + 1}` }))
})
const fileTermId = computed(() => filePanes.value[filePaneIdx.value]?.termId ?? null)
watch(
  () => activeGroup.value?.id,
  () => {
    filePaneIdx.value = 0
  },
)
const filePanelRef = ref<InstanceType<typeof FilePanel> | null>(null)
// 文件编辑器目标（v1 单编辑器：已有目标时轻提示换文件需先关）。
const editorTarget = ref<{ containerId: string; containerName: string; path: string } | null>(null)
// 桌面查看目标：null 关；打开时存容器 id/显示名。
const desktopTarget = ref<{ containerId: string; containerName: string } | null>(null)
function openFile(cId: string, cName: string, path: string) {
  if (editorTarget.value) {
    err.value = '已有文件在编辑，先关闭它再打开新文件'
    return
  }
  editorTarget.value = { containerId: cId, containerName: cName, path }
}
function onEditorSaved() {
  // 保存后刷新面板列表（若面板开着且指向同容器）。
  filePanelRef.value?.refresh()
}

// ---- 容器信息条（IP / 监听端口 / 映射端口）----
// active group 容器的网络信息直达条：IP 点击复制，端口 chip 点击开浏览器。
// 监听端口 on-demand 拉（切换 group / 容器恢复运行时），不进 5s 轮询——监听集合变化低频。
const activeContainer = computed(
  () => items.value.find((x) => x.id === activeGroup.value?.containerId) ?? null,
)
const listenPorts = ref<number[]>([])
let listenSeq = 0 // 竞态：切 group 时丢弃慢响应
const ipCopied = ref(false)
let ipCopyTimer: ReturnType<typeof setTimeout> | null = null
async function loadListenPorts() {
  const c = activeContainer.value
  const seq = ++listenSeq
  if (!c || c.state !== 'running') {
    listenPorts.value = []
    return
  }
  try {
    const r = await getListenPorts(c.id)
    if (seq !== listenSeq) return
    listenPorts.value = r.ports
  } catch {
    if (seq !== listenSeq) return
    listenPorts.value = [] // 容器刚停/权限等：静默置空
  }
}
watch(
  () => [activeGroup.value?.containerId, activeContainer.value?.state],
  () => void loadListenPorts(),
  { immediate: true },
)

// ---- 宿主终端信息条（cwd 路径）----
// host group 激活时轮询会话活跃 pane 的 cwd（信息条显示「宿主 · <路径>」）。
// 5s 间隔 + 切 group 立即拉一次；竞态 seq 同 loadListenPorts。
const hostCwd = ref('')
let hostCwdSeq = 0
let hostCwdTimer: ReturnType<typeof setInterval> | null = null
async function loadHostCwd() {
  const g = activeGroup.value
  const seq = ++hostCwdSeq
  if (g?.kind !== 'host') {
    hostCwd.value = ''
    return
  }
  const termId = g.panes[Math.min(filePaneIdx.value, g.panes.length - 1)]?.termId ?? g.panes[0]?.termId
  if (!termId) return
  try {
    const r = await getHostCwd(termId)
    if (seq !== hostCwdSeq) return
    hostCwd.value = r.cwd
  } catch {
    if (seq !== hostCwdSeq) return
    hostCwd.value = '' // 会话未建/已收（60s 宽限外）等：静默置空
  }
}
watch(
  () => activeGroup.value?.kind,
  (kind, old) => {
    if (kind === 'host') {
      void loadHostCwd()
      if (!hostCwdTimer) hostCwdTimer = setInterval(() => void loadHostCwd(), 5_000)
    } else if (old === 'host') {
      if (hostCwdTimer) {
        clearInterval(hostCwdTimer)
        hostCwdTimer = null
      }
      hostCwd.value = ''
    }
  },
  { immediate: true },
)
// docker 映射端口（去重：ipv4/ipv6 两条同名映射）。hostPort 在宿主侧可访问。
const mappedPorts = computed(() => {
  const seen = new Set<string>()
  const out: { pub: number; priv: number }[] = []
  for (const p of activeContainer.value?.ports ?? []) {
    if (!p.publicPort || !p.privatePort) continue
    const key = `${p.publicPort}->${p.privatePort}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pub: p.publicPort, priv: p.privatePort })
  }
  return out
})
async function copyIp() {
  const ip = activeContainer.value?.ip
  if (!ip) return
  try {
    await navigator.clipboard.writeText(ip)
    ipCopied.value = true
    if (ipCopyTimer) clearTimeout(ipCopyTimer)
    ipCopyTimer = setTimeout(() => (ipCopied.value = false), 1200)
  } catch {
    /* 剪贴板权限被拒就算了 */
  }
}
function openUrl(url: string) {
  window.open(url, '_blank', 'noopener')
}

// ---- CLI open 深链消费 ----
// 双条件：openReq 存在 + 容器列表已就绪（openReq 可能早于首次 listContainers 到达）。
const itemsReady = ref(false)
const lastOpenSeq = ref(0)
function dirname(p: string): string {
  if (p === '/' || !p.includes('/')) return '/'
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
async function consumeOpenReq(req: OpenReq) {
  if (req.seq === lastOpenSeq.value) return // 已消费
  lastOpenSeq.value = req.seq
  const c = items.value.find((x) => x.id === req.containerId || x.name === req.containerId)
  if (!c) {
    err.value = `open：容器不存在或已删除（${req.containerId}）`
    emit('open-handled')
    return
  }
  if (c.state !== 'running') {
    err.value = `open：容器 ${c.displayName || c.name} 未运行，无法打开文件`
    emit('open-handled')
    return
  }
  await locateContainerPath(c, req.path, req.kind)
  emit('open-handled')
}

// 深链与容器内 mysandbox 命令共用的核心：定位容器 -> 激活/创建终端组 -> 文件面板定位
// ->（文件则）开编辑器。
async function locateContainerPath(c: ContainerView, path: string, kind: 'file' | 'dir') {
  // 有 group 聚焦、无则开一个（编辑器/面板都以终端组为锚）。
  const gi = groups.value.findIndex((g) => g.containerId === c.id)
  if (gi >= 0) activeIdx.value = gi
  else openTerm(c)
  showFiles.value = true
  await nextTick()
  const dir = kind === 'dir' ? path : dirname(path)
  filePanelRef.value?.locate(c.id, dir)
  if (kind === 'file') {
    editorTarget.value = { containerId: c.id, containerName: c.displayName || c.name, path }
  }
}

// 容器内 mysandbox 命令（web 终端 OSC 7677）：kind 未知 -> listFiles 探测（200=目录 /
// 400 not_a_directory 或 404 不存在=文件，编辑器侧对不存在的文件走新建态），
// 定位后聚焦来源 group、面板跟随来源 pane。
async function onOscOpen(gIdx: number, pIdx: number, path: string) {
  const g = groups.value[gIdx]
  if (!g) return
  if (g.kind === 'host') return // 宿主侧暂无 OSC 种子（container-cli 只种容器），预留；将来加宿主 CLI 时复用 locate + HOST_ID 即可
  const c = items.value.find((x) => x.id === g.containerId)
  if (!c || c.state !== 'running') return // 终端还开着容器必在，理论上到不了这
  activeIdx.value = gIdx
  filePaneIdx.value = Math.min(pIdx, Math.max(g.panes.length - 1, 0))
  let kind: 'file' | 'dir' = 'file' // 400/404/其它异常都按文件：编辑器侧自会给出准确错误或新建态
  try {
    await listFiles(c.id, path)
    kind = 'dir'
  } catch {
    // 400 not_a_directory / 404 不存在 / 其它：按文件处理
  }
  await locateContainerPath(c, path, kind)
}
watch(
  [() => props.openReq, () => itemsReady.value],
  ([req, ready]) => {
    if (req && ready) void consumeOpenReq(req)
  },
  { immediate: true },
)

// 点容器「终端」：该容器已有 group 则聚焦，否则建单 pane group（避免重复打开堆积）。
// 想要同容器多个独立 shell -> 在 group 内点 ⊞ 分屏。
function openTerm(c: ContainerView) {
  const i = groups.value.findIndex((g) => g.containerId === c.id)
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  const g: TermGroup = { id: newGroupId(), containerId: c.id, name: c.displayName || c.name, panes: [{ termId: newTermId() }] }
  groups.value.push(g)
  initGrow(g)
  activeIdx.value = groups.value.length - 1
}
// 点侧栏「宿主」条目：开宿主终端（PTY 由 server 管理，cwd=镜像目录）。全局唯一一个 group。
function openHostTerm() {
  const i = groups.value.findIndex((g) => g.kind === 'host')
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  const g: TermGroup = {
    id: newGroupId(),
    containerId: HOST_ID,
    name: '宿主',
    kind: 'host',
    panes: [{ termId: newTermId() }],
  }
  groups.value.push(g)
  initGrow(g)
  activeIdx.value = groups.value.length - 1
}
// group 内分屏：末尾加一个 pane（新 termId 独立会话），水平并排。
// 结构变化即重置该 group 比例为等分（保留拖动比例的复杂度暂不做）。
function splitPane(gIdx: number) {
  const g = groups.value[gIdx]
  g.panes.push({ termId: newTermId() })
  initGrow(g)
}
// v-for 函数式 ref 收集器：二维 termRefs[groupIdx][paneIdx]。Vue 重排时自动重设，
// 故 closePane 只动 groups 数据、不手动 splice termRefs（避免与 ref(null) 竞态）。
function setTermRef(gIdx: number, pIdx: number, el: unknown) {
  if (!termRefs.value[gIdx]) termRefs.value[gIdx] = []
  termRefs.value[gIdx][pIdx] = (el as InstanceType<typeof Terminal> | null) ?? null
}
// 关单个 pane：先发 kill 帧杀该会话，再移除；panes 空了就移除整个 group，否则重置等分。
function closePane(gIdx: number, pIdx: number) {
  termRefs.value[gIdx]?.[pIdx]?.kill()
  const g = groups.value[gIdx]
  g.panes.splice(pIdx, 1)
  if (g.panes.length === 0) {
    closeGroup(gIdx)
    return
  }
  initGrow(g)
}
// 关整个 group：杀所有 pane 会话后移除。
function closeGroup(gIdx: number) {
  for (const ref of termRefs.value[gIdx] ?? []) ref?.kill()
  const g = groups.value[gIdx]
  delete paneGrow.value[g.id]
  groups.value.splice(gIdx, 1)
  termRefs.value.splice(gIdx, 1)
  if (groups.value.length === 0) {
    activeIdx.value = 0
    return
  }
  if (activeIdx.value >= groups.value.length) activeIdx.value = groups.value.length - 1
}

const selectedNames = computed(() =>
  items.value.filter((c) => selected.value.has(c.id)).map((c) => c.displayName || c.name),
)

function toggle(id: string) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

// 选择态的管理容器（全选/全不选只碰这些——外部容器本就没有勾选框）
const selectableItems = computed(() => items.value.filter((c) => c.managed || c.adopted))
const allSelected = computed(
  () => selectableItems.value.length > 0 && selectableItems.value.every((c) => selected.value.has(c.id)),
)
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(selectableItems.value.map((c) => c.id))
}
function clearSelection() {
  selected.value = new Set()
}
// Esc 退出选择态（对话框开着时不抢——reka-ui Dialog 本身会吃 Esc）
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && selectionActive.value) clearSelection()
}
onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

function openBatch() {
  batchSel.value = { ids: [...selected.value], names: selectedNames.value }
}

// 把新数据按字段合并进旧对象，保持对象引用稳定 -> 仅真正变化的字段才触发响应式，
// 避免轮询时整表无谓 re-render（闪烁的主因）。
function patchView(old: ContainerView, f: ContainerView) {
  // 标量字段：Vue 3 setter 内置 hasChanged，相同值不触发，可直接赋值
  old.name = f.name
  old.displayName = f.displayName
  old.status = f.status
  old.state = f.state
  old.image = f.image
  old.ip = f.ip
  old.managed = f.managed
  old.adopted = f.adopted
  old.description = f.description
  old.source = f.source
  old.command = f.command
  old.created = f.created
  // 引用类型字段：引用变了 Vue 就判为更新，故只在内容不同时才换引用
  if (JSON.stringify(old.networks) !== JSON.stringify(f.networks)) old.networks = f.networks
  if (JSON.stringify(old.ports) !== JSON.stringify(f.ports)) old.ports = f.ports
  if (JSON.stringify(old.tags) !== JSON.stringify(f.tags)) old.tags = f.tags
  if (JSON.stringify(old.labels) !== JSON.stringify(f.labels)) old.labels = f.labels
}

// 按字段合并：复用旧对象引用；仅当容器集合/数量变化时才替换数组引用。
function mergeItems(fresh: ContainerView[]) {
  const oldById = new Map(items.value.map((c) => [c.id, c]))
  const next: ContainerView[] = []
  for (const f of fresh) {
    const old = oldById.get(f.id)
    if (old) {
      patchView(old, f)
      next.push(old)
    } else {
      next.push(f) // 新出现的容器
    }
  }
  // 纯字段更新已由 patchView 触发；只有集合变化才需要换数组引用
  if (
    next.length !== items.value.length ||
    next.some((c, i) => c.id !== items.value[i]?.id)
  ) {
    items.value = next
  }
}

// silent=true 用于轮询：不动 loading、不覆盖错误条（避免按钮/错误条抖动）。
// 轮询失败不再静默吞掉——后端挂死/断连时用户完全失明比报错更糟；但要温和：
// 换成一条可关闭的连接状态条，不吓人也不打断。
async function refresh(silent = false) {
  if (!silent) loading.value = true
  try {
    const r = await listContainers()
    mergeItems(r.items)
    itemsReady.value = true
    lastOkAt.value = Date.now()
    connLost.value = false
    // 修剪已失效的选择（容器被删）
    const valid = new Set(r.items.map((c) => c.id))
    const pruned = new Set([...selected.value].filter((id) => valid.has(id)))
    if (pruned.size !== selected.value.size) selected.value = pruned
    // 关闭已消失容器的终端 group（容器已删，会话随容器消失，只从 UI 移除、不调 kill）。
    // 宿主 group 不依赖容器存在，豁免修剪。
    if (groups.value.some((g) => g.kind !== 'host' && !valid.has(g.containerId))) {
      groups.value = groups.value.filter((g) => g.kind === 'host' || valid.has(g.containerId))
      if (activeIdx.value >= groups.value.length) activeIdx.value = Math.max(0, groups.value.length - 1)
    }
    if (!silent) err.value = ''
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    if (silent) {
      // 轮询失败：标「连接丢失」，保留旧数据可用，附重试入口。手动刷新的错误仍走 err 主条。
      connLost.value = true
    } else {
      err.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    if (!silent) loading.value = false
  }
}

async function act(id: string, fn: () => Promise<unknown>) {
  busy.value[id] = true
  try {
    await fn()
    await refresh(true) // 操作后静默刷新，不触发 loading 抖动
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value[id] = false
  }
}

// —— 停止/重启守卫 ——
// mysandbox 自建的容器随便动；adopted/外部的容器可能是别的系统在用的服务（如 dener-*），
// 误点一下就是生产事故，过一道确认。删除本来就有 DeleteContainerDialog，不在此列。
const powerTarget = ref<{ c: ContainerView; action: 'stop' | 'restart' } | null>(null)
const POWER_TEXT = {
  stop: { verb: '停止', desc: '容器内所有进程会被终止（SIGTERM 后 SIGKILL）', fn: stopContainer },
  restart: { verb: '重启', desc: '容器会停止后重新启动，进程中断数秒', fn: restartContainer },
} as const
// mysandbox 来源（自建）直接执行；其余（adopted / 外部）弹确认。
function onPower(c: ContainerView, action: 'stop' | 'restart') {
  if (c.managed) {
    void act(c.id, () => POWER_TEXT[action].fn(c.id))
  } else {
    powerTarget.value = { c, action }
  }
}
// ConfirmDialog 确认后执行
async function doPower(_v?: unknown) {
  const t = powerTarget.value
  if (!t) return
  powerTarget.value = null
  await act(t.c.id, () => POWER_TEXT[t.action].fn(t.c.id))
}

function onAdopt(c: ContainerView) {
  adoptTarget.value = c
}
// ConfirmDialog 确认纳入管理：value 为显示名输入（空则回退容器名）
async function doAdopt(value: string | undefined) {
  const c = adoptTarget.value
  if (!c) return
  adoptTarget.value = null
  await act(c.id, () => adoptContainer(c.id, value?.trim() || c.name, 'dener'))
}

function onDelete(c: ContainerView) {
  delTarget.value = c
}
// DeleteContainerDialog 确认删除
async function doDelete(payload: { deleteData: boolean; confirmName?: string }) {
  const c = delTarget.value
  if (!c) return
  delTarget.value = null
  await act(c.id, () => deleteContainer(c.id, { deleteData: payload.deleteData, confirmName: payload.deleteData ? payload.confirmName : undefined }))
}

function stateColor(state: string): string {
  if (state === 'running') return 'bg-emerald-500'
  if (state === 'exited' || state === 'dead') return 'bg-zinc-500'
  if (state === 'paused') return 'bg-amber-500'
  return 'bg-blue-500'
}

// 状态徽章中文映射：界面全中文，唯独 state 是英文小写原样透出，观感割裂。
function stateLabel(state: string): string {
  const m: Record<string, string> = {
    running: '运行中',
    exited: '已停止',
    dead: '已失效',
    paused: '已暂停',
    created: '已创建',
    restarting: '重启中',
  }
  return m[state] ?? state
}

onMounted(() => {
  refresh()
  timer = setInterval(() => refresh(true), 5000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (hostCwdTimer) clearInterval(hostCwdTimer)
})
</script>

<template>
  <div class="flex h-full min-h-0 gap-0">
    <!-- 左侧容器窄栏：点容器=开/切终端（本工具的高频操作），⋯ 菜单收低频操作 -->
    <aside class="flex w-56 shrink-0 flex-col border-r border-border md:w-64">
      <!-- 宿主终端独立分区：放最顶、带分区标签，与下方「容器」分区平行——宿主不是容器，
           混进容器列表会被误读成一台容器；「容器 N」标题即两分区的天然分隔。点击开/切宿主 tab。 -->
      <div class="border-b border-border pb-1.5 pt-2">
        <div class="px-3 pb-1 text-[11px] font-medium text-muted-foreground">宿主</div>
        <button
          class="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
          :class="{ 'bg-accent/70': activeGroup?.kind === 'host' }"
          title="宿主终端（镜像目录）"
          @click="openHostTerm()"
        >
          <Monitor class="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span class="min-w-0 flex-1 truncate text-sm">宿主终端</span>
          <span class="shrink-0 text-[10px] text-muted-foreground">镜像目录</span>
        </button>
      </div>

      <div class="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span class="text-sm font-semibold">容器</span>
        <span class="text-xs text-muted-foreground">{{ items.length }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="ml-auto"
          :disabled="loading"
          :title="loading ? '刷新中…' : '刷新'"
          @click="refresh()"
        >
          <RefreshCw :class="loading ? 'animate-spin' : ''" />
        </Button>
      </div>

      <!-- 错误 / 断连提示：窄栏里做成轻量条 -->
      <p
        v-if="err"
        class="mx-2 mt-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >
        {{ err }}
      </p>
      <button
        v-if="connLost"
        class="mx-2 mt-2 flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-left text-xs text-amber-600 dark:text-amber-400"
        role="status"
        @click="refresh()"
      >
        <span class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
        连接失败，列表可能过期 · 点击重试
      </button>

      <div class="min-h-0 flex-1 overflow-y-auto py-1">
        <div
          v-for="c in items"
          :key="c.id"
          class="group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
          :class="{ 'bg-accent/70': selected.has(c.id) }"
          @click="openTerm(c)"
        >
          <!-- 行首勾选框：hover 浮现盖住状态点；选择态下受管理容器常显（外部容器无勾选框、状态点保留） -->
          <div class="relative flex shrink-0 items-center">
            <span
              v-if="!(c.managed || c.adopted)"
              :class="['h-2 w-2 rounded-full', stateColor(c.state)]"
              :title="stateLabel(c.state)"
            />
            <span
              v-else
              :class="[
                'h-2 w-2 rounded-full transition-opacity',
                stateColor(c.state),
                selected.has(c.id) || selectionActive ? 'opacity-0' : 'group-hover:opacity-0',
              ]"
            />
            <Checkbox
              v-if="c.managed || c.adopted"
              class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 transition-opacity"
              :class="selected.has(c.id) || selectionActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
              :model-value="selected.has(c.id)"
              @update:model-value="() => toggle(c.id)"
              @click.stop
            />
          </div>
          <span
            class="h-3 w-1 shrink-0 rounded-full"
            :style="{ backgroundColor: containerColor(c.id) }"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-sm" :title="c.displayName || c.name">{{
            c.displayName || c.name
          }}</span>
          <Badge
            v-if="!c.managed && !c.adopted"
            variant="outline"
            class="hidden shrink-0 border-transparent bg-muted text-[10px] text-muted-foreground group-hover:inline-flex"
            >外部</Badge
          >
          <!-- ⋯ 菜单：低频操作收进来（外部的容器只有「纳入管理」） -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                class="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                :disabled="busy[c.id]"
                :title="busy[c.id] ? '处理中…' : '更多操作'"
                @click.stop
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-44">
              <template v-if="!c.managed && !c.adopted">
                <DropdownMenuItem @click="onAdopt(c)">纳入管理</DropdownMenuItem>
              </template>
              <template v-else>
                <DropdownMenuItem v-if="c.state === 'running'" @click="onPower(c, 'stop')"
                  >停止</DropdownMenuItem
                >
                <DropdownMenuItem v-else @click="act(c.id, () => startContainer(c.id))"
                  >启动</DropdownMenuItem
                >
                <DropdownMenuItem v-if="c.state === 'running'" @click="desktopTarget = { containerId: c.id, containerName: c.displayName || c.name }"
                  >桌面</DropdownMenuItem
                >
                <DropdownMenuItem @click="onPower(c, 'restart')">重启</DropdownMenuItem>
                <DropdownMenuItem
                  v-if="c.managed"
                  class="text-destructive"
                  @click="onDelete(c)"
                  >删除</DropdownMenuItem
                >
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p v-if="!items.length && !loading" class="px-3 py-6 text-center text-xs text-muted-foreground">
          没有受管理的容器
        </p>
      </div>

      <!-- 批量条：进入选择态后浮现（全选 / 批量配置 / 退出） -->
      <div
        v-if="selectionActive"
        class="flex items-center gap-1 border-t border-border px-2 py-2"
      >
        <Button
          variant="outline"
          size="icon-xs"
          class="shrink-0"
          :title="allSelected ? '全不选' : '全选受管理容器'"
          @click="toggleAll"
        >
          <CheckCheck />
        </Button>
        <Button size="xs" class="min-w-0 flex-1" @click="openBatch">批量配置 ({{ selected.size }})</Button>
        <Button variant="outline" size="icon-xs" class="shrink-0" title="取消选择" @click="clearSelection">
          <X />
        </Button>
      </div>

      <div class="border-t border-border p-2">
        <Button
          size="sm"
          variant="outline"
          class="w-full"
          :disabled="baseReady === false"
          :title="baseReady === false ? `${baseLabel}未就绪` : ''"
          @click="showCreate = true"
          >＋ 新建容器</Button
        >
      </div>
    </aside>

    <!-- 右侧终端主区：tab 栏 + 分屏，占满剩余空间 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div
        v-if="baseReady === false"
        class="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <span>{{ baseLabel }}未就绪 —— 新建容器前先去处理（{{ baseLabel }}管理）。</span>
        <Button variant="destructive" size="xs" class="ml-auto" @click="emit('open-base')">{{ baseLabel }}管理</Button>
      </div>

      <!-- tab 栏：每组一个 tab，色条=容器色，·N=pane 数（>1 才显示） -->
      <div class="flex items-stretch border-b border-border bg-muted/30">
        <div
          v-for="(g, idx) in groups"
          :key="g.id"
          @click="activeIdx = idx"
          :class="[
            'flex cursor-pointer items-center gap-2 border-r border-border px-3 py-1.5 text-xs',
            idx === activeIdx ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-accent/50',
          ]"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :style="{ backgroundColor: g.kind === 'host' ? '#f59e0b' : containerColor(g.containerId) }"
          />
          <span class="font-mono">{{ g.name }}<span v-if="g.panes.length > 1" class="text-muted-foreground/60">·{{ g.panes.length }}</span></span>
          <button
            @click.stop="closeGroup(idx)"
            class="ml-1 text-muted-foreground hover:text-destructive"
            title="关闭终端组"
          >✕</button>
        </div>
        <span class="ml-auto self-center px-3 text-xs text-muted-foreground">{{ groups.length }} 个终端组</span>
        <button
          class="flex items-center gap-1 self-stretch border-l border-border px-3 text-xs"
          :class="showFiles ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'"
          :title="showFiles ? '关闭文件面板' : '打开文件面板（跟随终端目录）'"
          @click="showFiles = !showFiles"
        >
          <FolderOpen class="size-3.5" />
        </button>
      </div>

      <!-- 宿主信息条：会话 cwd（默认=镜像目录，cd 后跟随）。轮询 5s。 -->
      <div
        v-if="activeGroup?.kind === 'host'"
        class="flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-2 font-mono text-[11px] text-muted-foreground"
      >
        <Monitor class="size-3 shrink-0 text-amber-500" />
        <span class="shrink-0 select-none">宿主终端</span>
        <span class="shrink-0 select-none opacity-50">·</span>
        <span class="shrink-0 truncate" :title="hostCwd">{{ hostCwd || '…' }}</span>
      </div>

      <!-- 容器信息条：active group 容器的 IP（点击复制）· 容器内监听端口（点击打开）· docker 映射端口 -->
      <div
        v-else-if="activeContainer && activeContainer.state === 'running'"
        class="flex h-7 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border px-2 font-mono text-[11px] text-muted-foreground"
      >
        <button
          v-if="activeContainer.ip"
          class="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
          :title="ipCopied ? '' : '点击复制 IP'"
          @click="copyIp"
        >
          {{ ipCopied ? '已复制' : activeContainer.ip }}
        </button>
        <span v-if="listenPorts.length" class="shrink-0 select-none opacity-50">·</span>
        <button
          v-for="p in listenPorts"
          :key="'l' + p"
          class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
          :title="`容器内监听 ${p}，点击打开 http://${activeContainer.ip}:${p}`"
          @click="openUrl(`http://${activeContainer.ip}:${p}`)"
        >
          :{{ p }}
        </button>
        <template v-if="mappedPorts.length">
          <span class="shrink-0 select-none opacity-50">·</span>
          <button
            v-for="m in mappedPorts"
            :key="'m' + m.pub"
            class="shrink-0 rounded bg-muted/60 px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            :title="`宿主端口 ${m.pub} → 容器 ${m.priv}，点击打开`"
            @click="openUrl(`http://127.0.0.1:${m.pub}`)"
          >
            {{ m.pub }}→{{ m.priv }}
          </button>
        </template>
      </div>

      <!-- 工作区：终端 + 可选右侧文件面板 -->
      <div class="relative flex min-h-0 flex-1">
        <div class="relative min-h-0 min-w-0 flex-1 bg-zinc-950">
        <div
          v-for="(g, gIdx) in groups"
          :key="g.id"
          v-show="gIdx === activeIdx"
          class="absolute inset-0 flex"
        >
          <template v-for="(p, pIdx) in g.panes" :key="p.termId">
            <!-- pane 间分隔条（左右拖调宽）：pIdx>0 才有，在 pane[pIdx-1] 与 pane[pIdx] 之间 -->
            <PaneDivider
              v-if="pIdx > 0"
              @dragstart="(w: number) => onPaneDragStart(g, pIdx, w)"
              @drag="onPaneDrag"
            />
            <div
              class="flex min-w-[120px] flex-col"
              :style="{ flexGrow: paneGrowOf(g, pIdx), flexBasis: '0%' }"
            >
              <!-- pane 头部：标题用「容器名 #序号」——termId 是内部标识，4 位随机 hex 对人无意义；hover 看全 termId -->
              <div class="flex items-center gap-2 border-b border-border bg-muted/20 px-2 py-1 text-[10px]">
                <span
                  class="h-1.5 w-1.5 rounded-full"
                  :style="{ backgroundColor: g.kind === 'host' ? '#f59e0b' : containerColor(g.containerId) }"
                />
                <span class="font-mono text-muted-foreground" :title="p.termId">{{ g.name }}<span v-if="g.panes.length > 1"> #{{ pIdx + 1 }}</span></span>
                <div class="ml-auto flex items-center gap-2">
                  <button
                    @click="splitPane(gIdx)"
                    class="text-muted-foreground hover:text-foreground"
                    :title="g.kind === 'host' ? '分屏（宿主新终端）' : '分屏（同容器新终端）'"
                  >⊞</button>
                  <button
                    @click="closePane(gIdx, pIdx)"
                    class="text-muted-foreground hover:text-destructive"
                    title="关闭"
                  >✕</button>
                </div>
              </div>
              <!-- Terminal：常驻，切 group 时 v-show 恢复、ResizeObserver 自动 refit。
                   host group 连 /ws/host-terminal（无容器 id），其余连容器 exec。 -->
              <Terminal
                :ref="(el) => setTermRef(gIdx, pIdx, el)"
                :id="g.kind === 'host' ? undefined : g.containerId"
                :name="g.name"
                :term-id="p.termId"
                :host="g.kind === 'host'"
                :active="gIdx === activeIdx"
                @osc-open="(p: string) => onOscOpen(gIdx, pIdx, p)"
              />
            </div>
          </template>
        </div>
        <div
          v-if="!groups.length"
          class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground"
        >
          <TerminalIcon class="size-8 opacity-40" />
          <p class="text-sm">点击左侧容器打开终端</p>
          <p class="text-xs opacity-70">同一容器可分屏；多个容器并排开多个终端组</p>
        </div>
        </div>

        <!-- 右侧文件面板：跟随 active group 第一个 pane 的 cwd（可切 pane）。
             宿主组同样渲染：api.ts 按 HOST_ID 哨兵把文件请求切到 /api/host-terminal/*。 -->
        <PaneDivider
          v-if="showFiles"
          @dragstart="(w: number) => onFilesDragStart(activeGroup, 1, w)"
          @drag="onFilesDrag"
        />
        <FilePanel
          v-if="showFiles"
          ref="filePanelRef"
          class="shrink-0 border-l border-border"
          :style="{ width: filesW + 'px' }"
          :container-id="activeGroup ? activeGroup.containerId : ''"
          :container-name="activeGroup ? activeGroup.name : ''"
          :panes="filePanes"
          :term-id="fileTermId"
          :has-terminal="!!activeGroup"
          @close="showFiles = false"
          @open-file="(p: string) => activeGroup && openFile(activeGroup.containerId, activeGroup.name, p)"
          @pane-pick="(t: string) => (filePaneIdx = filePanes.findIndex((x) => x.termId === t))"
        />
      </div>

      <FileEditorDialog
        v-if="editorTarget"
        :key="editorTarget.containerId + editorTarget.path"
        :container-id="editorTarget.containerId"
        :container-name="editorTarget.containerName"
        :path="editorTarget.path"
        @close="editorTarget = null"
        @saved="onEditorSaved"
      />

      <DesktopDialog
        v-if="desktopTarget"
        :container-id="desktopTarget.containerId"
        :container-name="desktopTarget.containerName"
        @close="desktopTarget = null"
      />
    </div>
  </div>

  <CreateDialog
    v-if="showCreate"
    @created="showCreate = false; refresh()"
    @close="showCreate = false"
    @open-hosts="emit('open-hosts')"
  />

  <ConfirmDialog
    v-if="adoptTarget"
    title="纳入管理"
    description="为此容器设置显示名（可选，留空则用容器名）。"
    confirm-text="纳入"
    :input="{ default: adoptTarget.name, placeholder: adoptTarget.name }"
    @confirm="doAdopt"
    @close="adoptTarget = null"
  />

  <!-- 停止/重启确认（仅 adopted/外部容器）：这是别人的服务，误触半径不该只有 24px -->
  <ConfirmDialog
    v-if="powerTarget"
    :title="POWER_TEXT[powerTarget.action].verb + '容器'"
    :description="`确定要${POWER_TEXT[powerTarget.action].verb} ${powerTarget.c.displayName || powerTarget.c.name} 吗？该容器不是 mysandbox 创建的${powerTarget.c.adopted ? '（adopted）' : '（外部）'}，可能是其他系统在用的服务。${POWER_TEXT[powerTarget.action].desc}。`"
    :confirm-text="POWER_TEXT[powerTarget.action].verb"
    :variant="powerTarget.action === 'stop' ? 'destructive' : 'default'"
    @confirm="doPower"
    @close="powerTarget = null"
  />

  <DeleteContainerDialog
    v-if="delTarget"
    :container="delTarget"
    :busy="delTarget ? busy[delTarget.id] : false"
    @delete="doDelete"
    @close="delTarget = null"
  />

  <BatchDialog
    v-if="batchSel"
    :ids="batchSel.ids"
    :names="batchSel.names"
    @done="refresh(); clearSelection()"
    @close="batchSel = null"
    @unauthorized="emit('unauthorized')"
    @open-hosts="emit('open-hosts')"
  />
</template>
