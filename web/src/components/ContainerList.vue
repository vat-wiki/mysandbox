<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick, defineAsyncComponent, provide } from 'vue'
import {
  listContainers,
  startContainer,
  stopContainer,
  restartContainer,
  adoptContainer,
  deleteContainer,
  updateMeta,
  listFiles,
  downloadEntry,
  getListenPorts,
  resolveTermPath,
  listServices,
  listServiceJobs,
  listTermActivity,
  termSessionKey,
  HOST_ID,
  Unauthorized,
  type ContainerView,
  type ResolveView,
  type ServiceView,
  type TermSessionView,
  type TermActivityView,
} from '@/lib/api'
import { trackServiceJobs } from '@/lib/serviceJobs'
import {
  lastTermOutput,
  forgetTerm,
  trackTerminalActivity,
  termActiveIds,
  type QuietFeedItem,
} from '@/lib/terminalActivity'
import { newId } from '@/lib/id'
import { containerColor, containerColorA, stateLabel } from '@/lib/utils'
import { baseLabel, hasBaseAction } from '@/lib/caps'
import { isPhone } from '@/composables/useDevice'
import { extOf, previewKind } from '@/lib/preview'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Terminal as TerminalIcon, MoreHorizontal, RefreshCw, X, FolderOpen, Monitor, Globe, Plus, Settings2, Network, ArrowRightLeft, ListChecks, Container, PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next'
import CreateDialog from '@/components/CreateDialog.vue'
import BatchDialog from '@/components/BatchDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DeleteContainerDialog from '@/components/DeleteContainerDialog.vue'
import TermSessionsDialog from '@/components/TermSessionsDialog.vue'
import PaneDivider from '@/components/PaneDivider.vue'
import TermLayoutNode from '@/components/TermLayoutNode.vue'
import FilePanel from '@/components/FilePanel.vue'
import {
  TERM_OPS,
  MAX_GROUP_PANES,
  equalGrows,
  leafCount,
  leafIds,
  newSplitId,
  normalizeRoot,
  ordinalOf,
  removeLeaf,
  splitLeaf,
  type LayoutDir,
  type LayoutNode,
  type SplitNode,
  type TermGroup,
} from '@/lib/termlayout'

// 异步加载重组件：Monaco 编辑器点开文件才下载、noVNC 点「桌面」才下载，不拖累首屏。
// （终端组件的异步加载移到了 TermLayoutNode——首个 pane 出现时才拉 xterm 全家桶。）
const FileEditorPane = defineAsyncComponent(() => import('@/components/FileEditorPane.vue'))
// 桌面查看器（noVNC，较重）：点「桌面」才下载。
const DesktopDialog = defineAsyncComponent(() => import('@/components/DesktopDialog.vue'))
// 容器导出为包（SSE 日志对话框）：点「导出为包」才下载。
const ExportContainerDialog = defineAsyncComponent(() => import('@/components/ExportContainerDialog.vue'))

// CLI `mysandbox open` 深链请求（App 解析 #open hash 后传入；seq 自增触发消费）。
export interface OpenReq {
  containerId: string
  path: string
  kind: 'file' | 'dir'
  seq: number
}

const props = defineProps<{
  baseReady?: boolean | null
  openReq?: OpenReq | null
  // 独立窗口模式：?popout=<containerId|__host__> 打开的新浏览器窗口。
  // 无侧栏/header，自动为目标开一个全新终端组，分屏能力与主窗口相同；
  // 布局持久化到独立 key，不与主窗口互相污染。popoutTarget=容器 id 或 HOST_ID 哨兵。
  popout?: boolean
  popoutTarget?: string
}>()
const emit = defineEmits<{
  (e: 'unauthorized'): void
  (e: 'open-base'): void
  // 打开服务管理面板；create=true 表示来自摘要条 ＋（面板打开时直接弹新建对话框）
  (e: 'open-services', create?: boolean): void
  (e: 'open-handled'): void
}>()

const items = ref<ContainerView[]>([])
const loading = ref(false)
const err = ref('')
// 连接状态：轮询失败 -> connLost（温和提示条 + 保留旧数据）；恢复自动消失。
const connLost = ref(false)
const lastOkAt = ref(0)
const busy = ref<Record<string, boolean>>({})

// 终端 tab 持久化：刷新后重新打开之前那几个容器的终端、回到上次激活的 tab（含分屏树与比例）。
// 会话本身的持久（滚动历史 / 正在跑的进程）由容器内 tmux 负责。popout 独立窗口用独立 key，
// 与主窗口互不读写——否则两边 deep watch 互相覆盖，对方的组会「串」进窗口里。
const TABS_KEY =
  props.popout && props.popoutTarget
    ? `mysandbox:term-tabs-popout-${props.popoutTarget}`
    : 'mysandbox:term-tabs-v4'
// 隐藏的终端组（tab 右键「隐藏」）：独立存档。隐藏 ≠ 关闭——不杀会话（Terminal 卸载 =
// 纯 detach），只从 tab 栏摘掉，随时从会话对话框恢复。与 tabs 分开存：两边生命周期不同
// （关 tab 是真杀，隐藏是暂存），混在一个数组里就得给每条加状态位、修剪逻辑两处判。
const HIDDEN_KEY =
  props.popout && props.popoutTarget
    ? `mysandbox:term-hidden-popout-${props.popoutTarget}`
    : 'mysandbox:term-hidden'
// 隐藏存档上限：隐藏是「暂存不干掉」，不是收藏夹——无限堆积只会让会话对话框越来越难翻。
const MAX_HIDDEN_GROUPS = 50
function newTermId(): string {
  return newId()
}
function newGroupId(): string {
  return newId()
}
// 一个 group = 一个容器终端组，root 是布局树（类型与操作见 lib/termlayout.ts）：
// 叶子 = 一个独立 termId/会话，split = 同方向多块嵌套（row 左右 / col 上下），任意组合。
// kind='host' 为宿主终端组（PTY 由 server 管理，cwd=镜像目录，containerId 为哨兵 '__host__'）。
// 单个 group 的持久化解析：非法丢弃、旧版迁移（v3 扁平 panes / v2 单 termId）包成布局树。
// tabs 与 hidden 两个存档共用。
function parseGroup(o: unknown): TermGroup | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (typeof r.containerId !== 'string') return null
  let root = normalizeRoot(r.root)
  if (!root) {
    const ids = Array.isArray(r.panes)
      ? r.panes
          .filter(
            (pn): pn is { termId: string } =>
              !!pn && typeof (pn as { termId?: unknown }).termId === 'string',
          )
          .map((pn) => pn.termId)
      : typeof r.termId === 'string'
        ? [r.termId]
        : []
    if (!ids.length) return null
    root =
      ids.length === 1
        ? { kind: 'leaf', termId: ids[0] }
        : {
            kind: 'split',
            id: newSplitId(),
            dir: 'row',
            children: ids.map((t) => ({ kind: 'leaf' as const, termId: t })),
            grows: equalGrows(ids.length),
          }
  }
  return {
    id: typeof r.id === 'string' ? r.id : newGroupId(),
    containerId: r.containerId,
    name: typeof r.name === 'string' ? r.name : r.containerId,
    kind: r.kind === 'host' ? ('host' as const) : undefined,
    seq: typeof r.seq === 'number' && r.seq >= 1 ? r.seq : undefined,
    quietNotify: typeof r.quietNotify === 'boolean' ? r.quietNotify : undefined,
    root,
  }
}
function loadTabs(): { groups: TermGroup[]; activeIdx: number } {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return { groups: [], activeIdx: 0 }
    const p = JSON.parse(raw) as Record<string, unknown>
    const arr = Array.isArray(p.groups) ? p.groups : []
    const groups = arr.map(parseGroup).filter((g): g is TermGroup => !!g)
    // 旧存档没有 seq（v3 迁移或早期 v4）：按现有顺序补发，同容器依次取已用最大值之后的号
    const maxSeq = new Map<string, number>()
    for (const g of groups) maxSeq.set(g.containerId, Math.max(maxSeq.get(g.containerId) ?? 0, g.seq ?? 0))
    for (const g of groups) {
      if (g.seq === undefined) {
        const next = (maxSeq.get(g.containerId) ?? 0) + 1
        maxSeq.set(g.containerId, next)
        g.seq = next
      }
    }
    const activeIdx = typeof p.activeIdx === 'number' ? p.activeIdx : 0
    return { groups, activeIdx: Math.min(Math.max(activeIdx, 0), Math.max(groups.length - 1, 0)) }
  } catch {
    return { groups: [], activeIdx: 0 }
  }
}
function loadHidden(): TermGroup[] {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr
      .map(parseGroup)
      .filter((g): g is TermGroup => !!g)
      .slice(-MAX_HIDDEN_GROUPS)
  } catch {
    return []
  }
}
const savedTabs = loadTabs()
const groups = ref<TermGroup[]>(savedTabs.groups)
const activeIdx = ref(savedTabs.activeIdx)
const hiddenGroups = ref<TermGroup[]>(loadHidden())
// termId -> Terminal 实例（close 时调 kill() 发 kill 帧真杀会话）。函数式 ref 挂/卸自动进出表；
// key 是稳定的 termId，布局重排/塌缩不会错杀别的会话。
const termRefs = new Map<string, { kill(): void }>()
function saveTabs(): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({ groups: groups.value, activeIdx: activeIdx.value }))
  } catch {
    /* localStorage 不可用就跳过 */
  }
}
watch([groups, activeIdx], saveTabs, { deep: true })
function saveHidden(): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(hiddenGroups.value))
  } catch {
    /* localStorage 不可用就跳过 */
  }
}
watch(hiddenGroups, saveHidden, { deep: true })

// 手机侧栏抽屉：overlay 形态（绝对定位 + 遮罩），终端区宽度不变——不选 push 是刻意的：
// push 会改终端容器宽度 → 触发 refit / tmux resize，打断正在跑的 TUI/vim。
// 默认收起；选完容器/宿主自动收（见 openTerm/openHostTerm）。
const drawerOpen = ref(false)

// 侧栏收起（窄边 rail）：桌面(md+)专属形态——手机抽屉忽略此状态恒展开（rail 对触屏没意义）。
// 收起态只留导航骨架：展开键 / ＋ 新建 / 容器首字图标列（title 带全名与状态）/ 底部环境区。
// loadBool 为 function 声明（提升），此处可安全前置调用。
const collapsed = ref(loadBool('mysandbox:sidebar-collapsed'))
watch(collapsed, (v) => {
  try {
    localStorage.setItem('mysandbox:sidebar-collapsed', v ? '1' : '0')
  } catch {
    /* localStorage 不可用就跳过 */
  }
})

// ---- 分屏树的动作与拖拽 ----
// 树操作纯函数在 lib/termlayout.ts；这里经 TERM_OPS 注入给递归的 TermLayoutNode 上抛动作。
// 分隔条拖动只调相邻两块 grows：dragstart 快照，move 把像素位移换算成 grow 增量
// （两块总和不变，按该轴最小像素钳制）。Terminal 自带 ResizeObserver，尺寸一变即
// 自动 refit -> 后端 exec.resize，无需额外联动。
let dragNode: SplitNode | null = null
let dragLeft = 0
let dragStartGrows: number[] = []
let dragAvail = 0
let dragMinPx = 120
function dividerStart(node: SplitNode, idx: number, parentSize: number, minPx: number) {
  if (parentSize <= 0) return // 隐藏组（display:none）量不到尺寸，忽略，避免算出退化比例
  dragNode = node
  dragLeft = idx - 1
  dragStartGrows = [...node.grows]
  dragAvail = Math.max(1, parentSize - 4 * (node.children.length - 1)) // 每条分隔条 4px
  dragMinPx = minPx
}
function dividerDrag(delta: number) {
  if (!dragNode) return
  const start = dragStartGrows
  const sumGrow = start.reduce((a, b) => a + b, 0) || 1
  const dGrow = (delta / dragAvail) * sumGrow
  const l = dragLeft
  const pairSum = start[l] + start[l + 1]
  const minGrow = (dragMinPx / dragAvail) * sumGrow
  let a = start[l] + dGrow
  let b = pairSum - a
  if (a < minGrow) {
    a = minGrow
    b = pairSum - minGrow
  }
  if (b < minGrow) {
    b = minGrow
    a = pairSum - minGrow
  }
  dragNode.grows[l] = a
  dragNode.grows[l + 1] = b
}
// 分屏 cwd 继承：freshTermId -> 源 pane 的 termId。仅内存、不进 localStorage——
// cwd 只在「新会话首次创建」那一刻有意义（后端 new-session -c 源 pane 当前目录），
// 刷新后会话必已存在（attach 回去），映射随页面消亡正好不再传 from。
const splitCwdFrom = new Map<string, string>()
provide(TERM_OPS, {
  split(group, termId, dir) {
    const fresh = newTermId()
    splitCwdFrom.set(fresh, termId)
    group.root = splitLeaf(group.root, termId, dir, fresh)
  },
  close(group, termId) {
    termRefs.get(termId)?.kill()
    const root = removeLeaf(group.root, termId)
    if (root) group.root = root
    else closeGroupById(group.id)
  },
  setRef(termId, el) {
    if (el) termRefs.set(termId, el as { kill(): void })
    else termRefs.delete(termId)
  },
  cwdSourceOf(termId) {
    return splitCwdFrom.get(termId)
  },
  onOscOpen,
  onLinkOpen,
  dividerStart,
  dividerDrag,
  ordinalOf,
  groupLabel,
})

const showCreate = ref(false)
// 批量配置对话框开关。容器选择在对话框内完成（containers prop 传全集，默认全选），
// 侧栏不再有选择态。
const showBatch = ref(false)
// 纳入管理（输入显示名）/ 删除 的目标容器，非 null 即弹对应 Dialog
const adoptTarget = ref<ContainerView | null>(null)
const delTarget = ref<ContainerView | null>(null)
let timer: ReturnType<typeof setInterval> | null = null

// ---- 文件面板 ----
// 开合与「正在编辑哪个文件」都持久化：刷新后原样恢复（终端 tab 有存档，文件侧不能比它短）。
// 与 tabs 同款：popout 独立 key，窗口间互不读写。编辑器只存 target（容器/路径/diff 模式）；
// line/col 是一次性的 Ctrl+点击定位，不还原。
const FILES_OPEN_KEY =
  props.popout && props.popoutTarget
    ? `mysandbox:files-open-popout-${props.popoutTarget}`
    : 'mysandbox:files-open'
// 文件 tab 栏持久化（tab 序列 + 主区归属）：刷新后恢复打开的文件与编辑/终端哪个占主区。
// popout 独立窗口用独立 key，与主窗口互不影响。
const EDITOR_TABS_KEY =
  props.popout && props.popoutTarget
    ? `mysandbox:editor-tabs-popout-${props.popoutTarget}`
    : 'mysandbox:editor-tabs'
const EDITOR_AREA_KEY =
  props.popout && props.popoutTarget
    ? `mysandbox:editor-area-popout-${props.popoutTarget}`
    : 'mysandbox:editor-area'
function loadBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const showFiles = ref(loadBool(FILES_OPEN_KEY))
watch(showFiles, (v) => {
  try {
    localStorage.setItem(FILES_OPEN_KEY, v ? '1' : '0')
  } catch {
    /* localStorage 不可用就跳过 */
  }
})
// 面板宽度（像素制，拖动独立于终端 pane 的比例制 grows）。
const filesW = ref(320)
// 拖宽快照：dragstart 记下起始宽度与容器总宽，drag 按位移换算。
let filesDragStartW = 0
let filesDragAvailW = 0
function onFilesDragStart(_g: unknown, pIdx: number, parentWidth: number) {
  filesDragStartW = filesW.value
  filesDragAvailW = parentWidth
}
// 面板提为根级通栏列后，dragstart 的 parentWidth = 根容器宽（含侧栏）——380 预留之外
// 还要扣掉侧栏本身，否则上限会越过一个侧栏宽、把终端主列挤到 124px。
// 侧栏桌面恒 w-64（popout 无侧栏）；手机侧栏是抽屉不占位，且拖宽本来就不渲染。
// 侧栏宽度（像素）：展开 256（md:w-64），收起 rail 48（md:w-12）——文件面板拖宽的
// 可用宽上限随之联动，rail 时文件面板能拖得更宽。
const FILES_SIDEBAR_W = computed(() => (props.popout ? 0 : collapsed.value ? 48 : 256))
function onFilesDrag(dx: number) {
  // 面板在右侧：向左拖（负 dx）变宽
  const w = filesDragStartW - dx
  filesW.value = Math.min(Math.max(w, 220), Math.max(220, filesDragAvailW - FILES_SIDEBAR_W.value - 380))
}
// 文件面板跟随哪个 pane（active group 内的序号；group 切换/结构变化时归零）。
const filePaneIdx = ref(0)
const activeGroup = computed(() => groups.value[activeIdx.value])
const filePanes = computed(() => {
  const g = activeGroup.value
  if (!g) return []
  return leafIds(g.root).map((termId, i) => ({ termId, label: `${groupLabel(g)} #${i + 1}` }))
})
const fileTermId = computed(() => filePanes.value[filePaneIdx.value]?.termId ?? null)
watch(
  () => activeGroup.value?.id,
  () => {
    filePaneIdx.value = 0
  },
)
const filePanelRef = ref<InstanceType<typeof FilePanel> | null>(null)
// —— 文件 tab（VSCode 式多开）——
// 每个 tab 一个常驻 FileEditorPane（v-show 切换，保 Monaco 撤销栈/滚动位——同终端组机制）。
// diff 存在 = git 变更对比模式（只读快照分支）；line/col 来自终端 Ctrl+点击 `:行:列` 后缀。
// tab 身份 = containerId+path：diff/普通是同一 tab 的两种形态，重复打开即更新并激活。
// 主区归属（areaMode）：文件 tab 栏在上、终端 tab 栏在下，同区切换——点谁主区给谁；
// 开文件切到编辑器，动终端 tab 切回终端，最后一个文件 tab 关掉时回落终端。
type EditorTab = {
  containerId: string
  containerName: string
  path: string
  diff?: { headPath?: string }
  line?: number
  col?: number
}
function tabId(t: { containerId: string; path: string }): string {
  return `${t.containerId}::${t.path}`
}
function loadEditorTabs(): EditorTab[] {
  try {
    const raw = localStorage.getItem(EDITOR_TABS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.flatMap((x): EditorTab[] => {
      if (typeof x !== 'object' || x === null) return []
      const r = x as Record<string, unknown>
      if (typeof r.containerId !== 'string' || !r.containerId) return []
      if (typeof r.path !== 'string' || !r.path.startsWith('/')) return []
      const d = r.diff as { headPath?: unknown } | null | undefined
      return [
        {
          containerId: r.containerId,
          containerName: typeof r.containerName === 'string' ? r.containerName : r.containerId,
          path: r.path,
          // diff 形态整体保留（headPath 仅 R/C 条目有；{} = 无旧路径的普通对比）。
          // 严校 headPath 会把后者刷回普通态——diff: {} 经 JSON.stringify 仍是 {}，得放行。
          diff: d && typeof d === 'object' ? { ...(typeof d.headPath === 'string' ? { headPath: d.headPath } : {}) } : undefined,
        },
      ]
    })
  } catch {
    return []
  }
}
const editorTabs = ref<EditorTab[]>(loadEditorTabs())
const activeEditorIdx = ref(0)
function loadAreaMode(): 'editor' | 'terminal' {
  try {
    return localStorage.getItem(EDITOR_AREA_KEY) === 'editor' && editorTabs.value.length ? 'editor' : 'terminal'
  } catch {
    return 'terminal'
  }
}
const areaMode = ref<'editor' | 'terminal'>(loadAreaMode())
watch(
  [editorTabs, activeEditorIdx, areaMode],
  () => {
    try {
      localStorage.setItem(EDITOR_TABS_KEY, JSON.stringify(editorTabs.value))
      localStorage.setItem(EDITOR_AREA_KEY, areaMode.value)
    } catch {
      /* localStorage 不可用就跳过 */
    }
    // 激活下标钳在有效范围（tab 关掉/恢复后可能越界）
    if (activeEditorIdx.value >= editorTabs.value.length) {
      activeEditorIdx.value = Math.max(editorTabs.value.length - 1, 0)
    }
  },
  { deep: true },
)
// 各 tab 的脏标（pane 上报，tab 上画 ● ——自动保存窗口内/冲突未决时可见）
const tabDirty = ref<Record<string, boolean>>({})
// pane 引用表：tab X 要先让 pane 冲刷未落改动（requestClose），冲完 pane 自己 emit close；
// toggleTextPreview 供 tab 右键菜单切换 svg/md 的编辑⇄预览渲染。
const paneRefs = new Map<
  string,
  { requestClose: () => void; toggleTextPreview?: () => void }
>()
function setPaneRef(t: EditorTab, el: unknown) {
  const key = tabId(t)
  if (el) paneRefs.set(key, el as { requestClose: () => void; toggleTextPreview?: () => void })
  else paneRefs.delete(key)
}
function openFile(cId: string, cName: string, path: string, opts?: { diff?: { headPath?: string }; line?: number; col?: number }) {
  const i = editorTabs.value.findIndex((t) => t.containerId === cId && t.path === path)
  if (i >= 0) {
    // 同文件重复打开：刷新显示名/对比态/定位目标并激活（pane 内 watch 自行跟进）
    editorTabs.value[i] = { ...editorTabs.value[i], containerName: cName, diff: opts?.diff, line: opts?.line, col: opts?.col }
    activeEditorIdx.value = i
  } else {
    editorTabs.value.push({ containerId: cId, containerName: cName, path, diff: opts?.diff, line: opts?.line, col: opts?.col })
    activeEditorIdx.value = editorTabs.value.length - 1
  }
  areaMode.value = 'editor'
}
function onFileTabClick(i: number) {
  activeEditorIdx.value = i
  areaMode.value = 'editor'
}
// tab X：pane 冲刷后自己 close；这里不直接摘（冲刷失败/冲突要留在原处裁决）
function closeFileTab(t: EditorTab) {
  paneRefs.get(tabId(t))?.requestClose()
}
// —— 文件 tab 右键批量关闭 ——
// 逐个走 pane 的 requestClose（dirty 先冲刷落盘）；409 冲突/保存失败的 pane 会自己
// 留在 tab 栏上等裁决（见 FileEditorPane.requestClose），不静默丢数据。activeIdx
// 由 editorTabs 的 watch 自动钳制。
function closeFileTabsRange(t: EditorTab, range: 'other' | 'left' | 'right') {
  const i = editorTabs.value.findIndex((x) => tabId(x) === tabId(t))
  if (i < 0) return
  const doomed =
    range === 'other'
      ? editorTabs.value.filter((_, k) => k !== i)
      : range === 'left'
        ? editorTabs.value.slice(0, i)
        : editorTabs.value.slice(i + 1)
  for (const d of doomed) paneRefs.get(tabId(d))?.requestClose()
}
// —— 文件 tab 右键复制路径 ——
// 容器路径直接复制；宿主实址惰性派生：listFiles(dirname) 的 hostPath（容器 rootfs 前缀
// 或宿主原样）拼回文件名——一次目录列表请求，对普通/diff/预览态一致成立，无需后端加字段。
async function copyTabText(s: string, okMsg: string) {
  if (!s) return
  let ok = false
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(s)
      ok = true
    } catch {
      /* 落 execCommand 兜底（同 copyIpOf 手法） */
    }
  }
  if (!ok) ok = legacyCopy(s)
  if (ok) toast(okMsg)
  else toast.error('复制失败：剪贴板不可用')
}
function copyTabPath(t: EditorTab) {
  void copyTabText(t.path, '已复制容器路径')
}
// tab 右键「下载」：仅可预览类型（图片/视频/音频/PDF）出现——走整文件流，与编辑器
// 预览的取流路径同源。目录下载在文件面板右键，不在 tab 上。
async function downloadTab(t: EditorTab) {
  try {
    await downloadEntry(t.containerId, t.path, t.path.slice(t.path.lastIndexOf('/') + 1), false)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
async function copyTabHostPath(t: EditorTab) {
  const dir = t.path.slice(0, t.path.lastIndexOf('/')) || '/'
  try {
    const v = await listFiles(t.containerId, dir)
    const hp = v.hostPath ? v.hostPath.replace(/\/$/, '') + '/' + t.path.slice(t.path.lastIndexOf('/') + 1) : null
    if (!hp) return toast.error('该文件无宿主机实际路径')
    void copyTabText(hp, '已复制实际路径')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
function removeTab(t: EditorTab) {
  const i = editorTabs.value.findIndex((x) => tabId(x) === tabId(t))
  if (i < 0) return
  delete tabDirty.value[tabId(t)]
  editorTabs.value.splice(i, 1)
  if (!editorTabs.value.length) areaMode.value = 'terminal' // 最后一个文件 tab 关掉，主区还给终端
}
// diff 面板「以普通方式打开」：清 diff 标记，pane 的 watch(diff) 自动重走普通加载。
function onOpenNormal(t: EditorTab) {
  const i = editorTabs.value.findIndex((x) => tabId(x) === tabId(t))
  if (i >= 0) editorTabs.value[i] = { ...editorTabs.value[i], diff: undefined }
}
function onEditorSaved() {
  // 保存后刷新面板列表（若面板开着且指向同容器）。
  filePanelRef.value?.refresh()
}
// 桌面查看目标：null 关；打开时存容器 id/显示名。
const desktopTarget = ref<{ containerId: string; containerName: string } | null>(null)

// ---- 容器网络信息（tab 栏右侧「网络」下拉的数据源）----
// active group 容器的 IP（点击复制）· 容器内监听端口（点击打开）· docker 映射端口。
// 监听端口进 5s 轮询（active 容器 running 期间）：容器内新起服务监听新端口无需刷新页面，
// 下拉自动跟上。每 tick 一次 lxc-attach + 少量并发 TCP 探测，仅针对当前容器，成本可忽略。
const activeContainer = computed(
  () => items.value.find((x) => x.id === activeGroup.value?.containerId) ?? null,
)
// 监听端口分组：web 端口（后端实测返回 HTML）标 Globe 可点开；其余（ssh/db/redis
// 等非网页）平铺弱化展示——下拉空间有限，不再做「其他 N」折叠。
const listenPorts = ref<number[]>([])
const webPorts = ref<number[]>([])
let listenSeq = 0 // 竞态：切 group 时丢弃慢响应
let listenTimer: ReturnType<typeof setInterval> | null = null
// 复制成功的 IP（null=无）：精确存值而非全局 bool——多容器下只回显点过的那张卡。
const copiedIp = ref<string | null>(null)
let ipCopyTimer: ReturnType<typeof setTimeout> | null = null
// execCommand 兜底（同 Terminal.vue copyText 的手法）：非 https 访问时
// navigator.clipboard 是 undefined，只在用户手势栈里同步调 execCommand 才有效。
function legacyCopy(s: string): boolean {
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
// 卡片与网络下拉共用的复制入口：成功后「已复制」回显 1.2s（绑定 ipCopied）。
async function copyIpOf(ip: string) {
  if (!ip) return
  let ok = false
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(ip)
      ok = true
    } catch {
      /* 落 execCommand 兜底 */
    }
  }
  if (!ok) ok = legacyCopy(ip)
  if (ok) {
    copiedIp.value = ip
    if (ipCopyTimer) clearTimeout(ipCopyTimer)
    ipCopyTimer = setTimeout(() => (copiedIp.value = null), 1200)
  }
}
const otherListenPorts = computed(() => listenPorts.value.filter((p) => !webPorts.value.includes(p)))
async function loadListenPorts() {
  const c = activeContainer.value
  const seq = ++listenSeq
  if (!c || c.state !== 'running') {
    listenPorts.value = []
    webPorts.value = []
    return
  }
  try {
    const r = await getListenPorts(c.id)
    if (seq !== listenSeq) return
    listenPorts.value = r.ports
    webPorts.value = r.web ?? []
    // 同步进卡片端口表：active 容器的图标 5s 跟新（慢轮询 15s 之外更及时）
    portsById.value = { ...portsById.value, [c.id]: { ports: r.ports, web: r.web ?? [] } }
  } catch {
    if (seq !== listenSeq) return
    listenPorts.value = [] // 容器刚停/权限等：静默置空
    webPorts.value = []
  }
}
watch(
  () => [activeGroup.value?.containerId, activeContainer.value?.state],
  () => {
    void loadListenPorts()
    // 轮询随容器状态启停：running 持续刷，切走/停止即停，不空转。
    const running = activeContainer.value?.state === 'running'
    if (running && !listenTimer) {
      listenTimer = setInterval(() => void loadListenPorts(), 5_000)
    } else if (!running && listenTimer) {
      clearInterval(listenTimer)
      listenTimer = null
    }
  },
  { immediate: true },
)
onUnmounted(() => {
  if (listenTimer) {
    clearInterval(listenTimer)
    listenTimer = null
  }
})
// docker 映射端口（去重：ipv4/ipv6 两条同名映射）。hostPort 在宿主侧可访问。
// 抽成函数：tab 下拉的 mappedPorts 与侧栏卡片端口浮层（cardPortRows）共用。
function mappedPortsOf(c: ContainerView): { pub: number; priv: number }[] {
  const seen = new Set<string>()
  const out: { pub: number; priv: number }[] = []
  for (const p of c.ports ?? []) {
    if (!p.publicPort || !p.privatePort) continue
    const key = `${p.publicPort}->${p.privatePort}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ pub: p.publicPort, priv: p.privatePort })
  }
  return out
}
const mappedPorts = computed(() => (activeContainer.value ? mappedPortsOf(activeContainer.value) : []))
async function copyIp() {
  await copyIpOf(activeContainer.value?.ip ?? '')
}
function openUrl(url: string) {
  window.open(url, '_blank', 'noopener')
}

// ---- 侧栏卡片端口图标：全部运行中容器的监听端口 ----
// active 容器已有 5s 精刷（tab 下拉用，loadListenPorts 顺手同步进来）；这里补一个 15s
// 慢轮询覆盖所有 running 容器——每容器一次 awk 读 /proc/net/tcp（无 ss 依赖）+ 内网
// 毫秒级 TCP 探测，个人 sandbox 个位数容器，成本可忽略。页面隐藏时跳过、回前台立即补刷；
// 失败静默（容器刚停/重启中等），下次轮询自愈。结果整表重建：已删/已停的条目自然消失。
const portsById = ref<Record<string, { ports: number[]; web: number[] }>>({})
let portsTimer: ReturnType<typeof setInterval> | null = null
let portsSeq = 0 // 竞态：慢轮询响应乱序时丢弃旧表
async function refreshAllPorts() {
  if (props.popout || document.hidden) return
  const running = items.value.filter((c) => c.state === 'running')
  if (!running.length) {
    portsById.value = {}
    return
  }
  const seq = ++portsSeq
  const rs = await Promise.allSettled(running.map((c) => getListenPorts(c.id)))
  if (seq !== portsSeq) return
  const next: Record<string, { ports: number[]; web: number[] }> = {}
  running.forEach((c, i) => {
    if (rs[i].status === 'fulfilled') next[c.id] = rs[i].value
  })
  portsById.value = next
}
function onVisChange() {
  if (!document.hidden) void refreshAllPorts()
}
// 卡片端口浮层的行：web（实测返回 HTML）/ other（其余监听）/ map（docker 宿主映射）
// 三态合一，渲染与点击行为按 kind 分支——与 tab 栏网络下拉同信息结构，纵向更紧凑。
type PortRow = { kind: 'web' | 'other' | 'map'; port: number; priv?: number }
function cardPortRows(id: string): PortRow[] {
  const v = portsById.value[id]
  if (!v) return []
  const rows: PortRow[] = v.web.map((p) => ({ kind: 'web' as const, port: p }))
  for (const p of v.ports) {
    if (!v.web.includes(p)) rows.push({ kind: 'other' as const, port: p })
  }
  const c = items.value.find((x) => x.id === id)
  if (c) for (const m of mappedPortsOf(c)) rows.push({ kind: 'map' as const, port: m.pub, priv: m.priv })
  return rows
}
function portRowTarget(c: ContainerView, r: PortRow): string {
  return r.kind === 'map' ? `http://127.0.0.1:${r.port}` : `http://${c.ip}:${r.port}`
}
function portRowTitle(c: ContainerView, r: PortRow): string {
  const t = portRowTarget(c, r)
  if (r.kind === 'web') return `已验证返回网页，点击打开 ${t}`
  if (r.kind === 'map') return `宿主端口 ${r.port} → 容器 ${r.priv}，点击打开`
  return `容器内监听 ${r.port}（未返回 HTML），点击打开 ${t}`
}
// 浮层显隐：mouseenter/leave 挂在图标+浮层共用的 wrapper（移进浮层不算离开）；
// 触屏无 hover——点按图标切换 pinned，再点收起。
const portsHover = ref<string | null>(null)
const portsPinned = ref<string | null>(null)

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
// ->（文件则）开编辑器。首参放宽为最小结构形状：宿主组没有 ContainerView，只有
// {id: HOST_ID, name: '宿主'}；line/col 透传编辑器定位（同文件换行号靠 dialog 内 watch）。
async function locateContainerPath(
  c: { id: string; name: string; displayName?: string },
  path: string,
  kind: 'file' | 'dir',
  line?: number,
  col?: number,
) {
  // 有 group 聚焦、无则开一个（编辑器/面板都以终端组为锚）。
  const gi = groups.value.findIndex((g) => g.containerId === c.id)
  if (gi >= 0) activeIdx.value = gi
  else if (c.id === HOST_ID) openHostTerm()
  else openTerm(c)
  showFiles.value = true
  await nextTick()
  const dir = kind === 'dir' ? path : dirname(path)
  filePanelRef.value?.locate(c.id, dir)
  if (kind === 'file') {
    openFile(c.id, c.displayName || c.name, path, { line, col })
  }
}

// 文件面板 open-file 汇聚点：目录列表点文件（无 opts）与 Git 变更条目点击（opts.diff
// = 对比形态）共用。写成函数而非模板内联箭头——对象类型字面量在模板表达式里编不过。
function onPanelOpenFile(p: string, o?: { diff?: { headPath?: string } }) {
  if (activeGroup.value) openFile(activeGroup.value.containerId, activeGroup.value.name, p, o)
}

// 容器内 mysandbox 命令（web 终端 OSC 7677）：kind 未知 -> listFiles 探测（200=目录 /
// 400 not_a_directory 或 404 不存在=文件，编辑器侧对不存在的文件走新建态），
// 定位后聚焦来源 group、面板跟随来源 pane（termId -> DFS 序号）。
async function onOscOpen(group: TermGroup, termId: string, path: string) {
  if (group.kind === 'host') return // 宿主侧暂无 OSC 种子（container-cli 只种容器），预留；将来加宿主 CLI 时复用 locate + HOST_ID 即可
  const c = items.value.find((x) => x.id === group.containerId)
  if (!c || c.state !== 'running') return // 终端还开着容器必在，理论上到不了这
  const gi = groups.value.findIndex((g) => g.id === group.id)
  if (gi >= 0) activeIdx.value = gi
  filePaneIdx.value = Math.min(ordinalOf(group.root, termId), Math.max(leafCount(group.root) - 1, 0))
  let kind: 'file' | 'dir' = 'file' // 400/404/其它异常都按文件：编辑器侧自会给出准确错误或新建态
  try {
    await listFiles(c.id, path)
    kind = 'dir'
  } catch {
    // 400 not_a_directory / 404 不存在 / 其它：按文件处理
  }
  await locateContainerPath(c, path, kind)
}

// 终端 Ctrl+点击路径链接：后端权威解析（tmux pane cwd + ~ 展开 + readlink 归一 + 类型
// 探测，一次往返），宿主组与容器组同路径。missing 按 file（编辑器侧 404 → 新建态）。
async function onLinkOpen(group: TermGroup, termId: string, raw: string, line?: number, col?: number) {
  const gi = groups.value.findIndex((g) => g.id === group.id)
  if (gi >= 0) activeIdx.value = gi
  filePaneIdx.value = Math.min(ordinalOf(group.root, termId), Math.max(leafCount(group.root) - 1, 0))
  let r: ResolveView
  try {
    r = await resolveTermPath(group.containerId, termId, raw) // host 组 containerId 即 HOST_ID，哨兵自动分流
  } catch {
    return // 会话已收 / 容器已停等：静默（终端还在屏上，用户看得见状态）
  }
  const kind: 'file' | 'dir' = r.kind === 'dir' ? 'dir' : 'file'
  if (group.kind === 'host') {
    // 宿主组必在（点击来自组内活着的 Terminal），无 running 概念
    await locateContainerPath({ id: HOST_ID, name: '宿主' }, r.path, kind, line, col)
    return
  }
  const c = items.value.find((x) => x.id === group.containerId)
  if (!c || c.state !== 'running') return // 终端还开着容器必在，理论上到不了这
  await locateContainerPath(c, r.path, kind, line, col)
}
watch(
  [() => props.openReq, () => itemsReady.value],
  ([req, ready]) => {
    if (req && ready) void consumeOpenReq(req)
  },
  { immediate: true },
)

// 建组公共体：单叶子根（新 termId = 独立会话），激活为新 tab。分屏走 pane 头部按钮。
// root 可选传入（会话对话框按既有 termId 建组/合组分屏用）；缺省 = 全新单叶子。
function createGroup(containerId: string, name: string, kind?: 'host', root?: LayoutNode): TermGroup {
  // seq = 同容器现有组的最大序号 + 1（稳定身份，不随关闭/排序变化）
  let seq = 0
  for (const x of groups.value) {
    if (x.containerId === containerId) seq = Math.max(seq, x.seq ?? 1)
  }
  const g: TermGroup = { id: newGroupId(), containerId, name, kind, seq: seq + 1, root: root ?? { kind: 'leaf', termId: newTermId() } }
  // 插到同容器（宿主）最后一组的后面：同容器的 tab 天然聚拢，配合拖拽可随意调序。
  let at = groups.value.length
  for (let i = groups.value.length - 1; i >= 0; i--) {
    if (groups.value[i].containerId === containerId) {
      at = i + 1
      break
    }
  }
  groups.value.splice(at, 0, g)
  activeIdx.value = groups.value.indexOf(g)
  areaMode.value = 'terminal' // 任何终端组动作（建组/恢复/接入）都意味着主区该归终端
  return g
}
// 组显示名：同容器多组并存时带稳定序号（dev·1 / dev·2 …），单一组就是原名。
// 序号是创建时定死的（seq），拖拽换位/关闭别的组都不会让「dev·2」换组。
function groupLabel(g: TermGroup): string {
  const peers = groups.value.filter((x) => x.containerId === g.containerId)
  if (peers.length <= 1) return g.name
  return `${g.name}·${g.seq ?? peers.indexOf(g) + 1}`
}
// 手动新开一组（tab 右键菜单「新开一组终端」）：为该 tab 的容器/宿主再开一组全新终端。
// 侧栏点容器是「聚焦已有组」，这里是「再开一组」——单组分屏满 MAX_GROUP_PANES
// 块后想要更多终端，走这个显式动作。触屏长按 tab 同样能弹菜单。
function openNewGroup(g: TermGroup) {
  createGroup(g.containerId, g.name, g.kind)
}
// 点容器「终端」：该容器已有 group 则聚焦，否则建组（避免重复打开堆积）。
// 想要同容器多个独立 shell -> 在 pane 头部点左右 / 上下分屏。
// 首参为最小结构形状（locateContainerPath 宿主分支复用，见其注释）。
function openTerm(c: { id: string; name: string; displayName?: string }) {
  if (isPhone.value) drawerOpen.value = false
  const i = groups.value.findIndex((g) => g.containerId === c.id)
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(c.id, c.displayName || c.name)
}
// 点侧栏「宿主」条目：开宿主终端（PTY 由 server 管理，cwd=镜像目录）。全局唯一一个 group。
function openHostTerm() {
  if (isPhone.value) drawerOpen.value = false
  const i = groups.value.findIndex((g) => g.kind === 'host')
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(HOST_ID, '宿主', 'host')
}

// 在独立窗口（popout）打开某容器/宿主的纯终端工作区（App 按 ?popout= 渲染无侧栏形态）。
// 新窗口首屏自动开一个全新终端组，之后随意左右/上下分屏；布局存独立 key，
// 与主窗口互不影响；tmux 会话按 termId 归属，刷新窗口即可恢复。
// tab 右键菜单的守卫：容器组要 running（停着的容器 popout 出来是死终端），宿主恒可。
function containerRunning(id: string): boolean {
  return items.value.some((c) => c.id === id && c.state === 'running')
}
function openPopout(target: string) {
  const url = `${location.pathname}?popout=${encodeURIComponent(target)}`
  window.open(url, '_blank', 'noopener,width=1080,height=720')
}
// popout 首屏种子：等首轮容器列表就绪再建组（名字要用 displayName）。已有存档则跳过
// （刷新恢复语义）；目标容器不存在/已删则不种子，空态文案兜底、修剪逻辑随后清档。
watch(
  () => itemsReady.value,
  (ready) => {
    if (!props.popout || !ready || groups.value.length) return
    if (props.popoutTarget === HOST_ID) {
      createGroup(HOST_ID, '宿主', 'host')
      return
    }
    const c = items.value.find((x) => x.id === props.popoutTarget)
    if (c) createGroup(c.id, c.displayName || c.name)
  },
  { immediate: true },
)
// popout 无 header，窗口标题是唯一身份标识：跟随当前组名。
watch(
  () => activeGroup.value?.name,
  (name) => {
    if (props.popout && name) document.title = `${name} · mysandbox`
  },
  { immediate: true },
)

// 关整个 group（按 id 定位——递归组件里没有稳定的下标）：杀所有会话后移除。
function closeGroupById(gId: string) {
  const gi = groups.value.findIndex((g) => g.id === gId)
  if (gi < 0) return
  for (const t of leafIds(groups.value[gi].root)) termRefs.get(t)?.kill()
  groups.value.splice(gi, 1)
  if (groups.value.length === 0) {
    activeIdx.value = 0
    return
  }
  if (activeIdx.value >= groups.value.length) activeIdx.value = groups.value.length - 1
}

// —— tab 隐藏 / 恢复 / 会话对话框 ——
// 隐藏与 ✕（closeGroupById）刻意区分：隐藏不杀任何会话（组从 groups 摘掉 → Terminal
// 卸载 → WS 关闭 = 服务端纯 detach），收进隐藏存档随时恢复——「关掉 tab ≠ 关掉会话」
// 是真 tmux 语义的自然延伸。恢复 = 原样插回（含分屏树），seq 撞号（隐藏期间同容器开过
// 新组）则顺延到最大 + 1，显示名跟着变成 dev·3。
function hideGroupById(gId: string) {
  const gi = groups.value.findIndex((g) => g.id === gId)
  if (gi < 0) return
  const [g] = groups.value.splice(gi, 1)
  // 「在看」关系收尾：隐藏激活中的组 = 离开它（此刻起算 leftAt）。必须在挪进
  // hiddenGroups 之后、watch 追不上——watch 回调里 byId 已找不到该组，不会执行 markLeft。
  // 非激活组本就有历史 leftAt（离开时刻），覆盖成 now 只会让隐藏前的输出少积资格，
  // 而那部分输出若已过安静阈值、其提醒在隐藏前的轮询里就发过了，无损失。
  if (gi === activeIdx.value) markLeft(g)
  hiddenGroups.value.push(g)
  if (hiddenGroups.value.length > MAX_HIDDEN_GROUPS) hiddenGroups.value.shift()
  if (groups.value.length === 0) {
    activeIdx.value = 0
    return
  }
  if (gi < activeIdx.value) activeIdx.value -= 1 // 被隐藏的组在激活组之前：索引左移补位
  if (activeIdx.value >= groups.value.length) activeIdx.value = groups.value.length - 1
}
function restoreHidden(g: TermGroup) {
  const i = hiddenGroups.value.findIndex((x) => x.id === g.id)
  if (i < 0) return
  hiddenGroups.value.splice(i, 1)
  const clash = groups.value.some((x) => x.containerId === g.containerId && x.seq === g.seq)
  if (clash) {
    let mx = g.seq ?? 0
    for (const x of [...groups.value, ...hiddenGroups.value]) {
      if (x.containerId === g.containerId) mx = Math.max(mx, x.seq ?? 1)
    }
    g.seq = mx + 1
  }
  // 插到同容器（宿主）簇末尾：与 createGroup 同款聚拢
  let at = groups.value.length
  for (let j = groups.value.length - 1; j >= 0; j--) {
    if (groups.value[j].containerId === g.containerId) {
      at = j + 1
      break
    }
  }
  groups.value.splice(at, 0, g)
  activeIdx.value = groups.value.indexOf(g)
}

// 会话对话框：恢复隐藏 + 接入其他窗口/浏览器的活跃会话（服务端扫描）。
const showSessions = ref(false)
// 打开时剪掉容器已删的隐藏组：会话随容器消亡，留着只会恢复出连不上的空 tab。
watch(showSessions, (open) => {
  if (!open) return
  const valid = new Set(items.value.map((c) => c.id))
  const kept = hiddenGroups.value.filter((g) => g.kind === 'host' || valid.has(g.containerId))
  if (kept.length !== hiddenGroups.value.length) hiddenGroups.value = kept
})
// 本窗口已占用的会话 key（可见 + 隐藏的全部叶子）：对话框据此区分「已打开」/
// 「使用中」——不再从列表排除任何会话，扫到的全列（用户要的就是全集）。
const occupiedSet = computed(() => {
  const s = new Set<string>()
  for (const g of [...groups.value, ...hiddenGroups.value]) {
    const kind = g.kind === 'host' ? 'host' : 'container'
    const cid = g.kind === 'host' ? undefined : g.containerId
    for (const t of leafIds(g.root)) s.add(termSessionKey(kind, cid, t))
  }
  return s
})
// 接入：单个 = 单 tab；多个（同容器「全部接入」）= 一个 row 分屏组（≤MAX_GROUP_PANES，
// 上限由对话框截）。termId 不变 → 后端 new-session -A attach 回原会话，现场全保留。
function adoptSessions(list: TermSessionView[]) {
  const first = list[0]
  if (!first) return
  const host = first.kind === 'host'
  const cid = host ? HOST_ID : first.containerId!
  const c = host ? undefined : items.value.find((x) => x.id === cid)
  const name = host ? '宿主' : c ? c.displayName || c.name : cid
  const ids = list.map((s) => s.termId)
  const root: LayoutNode =
    ids.length === 1
      ? { kind: 'leaf', termId: ids[0] }
      : {
          kind: 'split',
          id: newSplitId(),
          dir: 'row',
          children: ids.map((t) => ({ kind: 'leaf' as const, termId: t })),
          grows: equalGrows(ids.length),
        }
  createGroup(cid, name, host ? 'host' : undefined, root)
}

// —— tab 长按（触屏）= 右键 ——
// 触屏没有 contextmenu 可依赖（iOS 完全没有），500ms 长按后合成一个 contextmenu 事件，
// reka 的 ContextMenuTrigger 响应它——桌面右键与触屏长按汇成同一条路径。
// ✕ 按钮上不触发（长按 ✕ 的意图是关不是弹菜单）；移动超阈值（横向滚 tab 栏）取消；
// 合成后吞掉紧随的 click（长按松手不该切走 tab）。
let lpTimer: ReturnType<typeof setTimeout> | null = null
let lpFired = false
let lpX = 0
let lpY = 0
function tabPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch') return
  if ((e.target as HTMLElement).closest('button')) return
  tabPointerCancel()
  lpFired = false
  lpX = e.clientX
  lpY = e.clientY
  const el = e.currentTarget as HTMLElement
  lpTimer = setTimeout(() => {
    lpTimer = null
    lpFired = true
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: lpX, clientY: lpY }),
    )
  }, 500)
}
function tabPointerMove(e: PointerEvent) {
  if (lpTimer && Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) tabPointerCancel()
}
function tabPointerCancel() {
  if (lpTimer) {
    clearTimeout(lpTimer)
    lpTimer = null
  }
}
function onTabClick(idx: number) {
  if (lpFired) {
    lpFired = false
    return
  }
  activeIdx.value = idx
  areaMode.value = 'terminal' // 点终端 tab = 主区切回终端（同区切换）
}

// ---- tab 拖拽排序 ----
// 原生 HTML5 DnD + live-reorder：dragover 越过相邻 tab 中点即实时交换 groups 顺序
// （Vue 按 key 移动节点，终端实例不重建）。焦点跟随被拖 tab，拖完落在哪就激活哪。
const dragTabIdx = ref(-1)
let dragFocusGId = ''
function onTabDragStart(e: DragEvent, idx: number) {
  dragTabIdx.value = idx
  dragFocusGId = activeGroup.value?.id ?? ''
  // Firefox 要求 setData 才会真正进入拖拽；effectAllowed=move 消除「禁止」光标
  e.dataTransfer?.setData('text/plain', String(idx))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onTabDragOver(e: DragEvent, idx: number) {
  const from = dragTabIdx.value
  if (from < 0 || idx === from) return
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const to = e.clientX > r.left + r.width / 2 ? idx + 1 : idx
  if (to === from || to === from + 1) return // 还没越过中点，不抖动
  const [g] = groups.value.splice(from, 1)
  const at = to > from ? to - 1 : to
  groups.value.splice(at, 0, g)
  dragTabIdx.value = at
  const fi = groups.value.findIndex((x) => x.id === dragFocusGId)
  if (fi >= 0) activeIdx.value = fi
  e.preventDefault() // 允许 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}
function onTabDragEnd() {
  dragTabIdx.value = -1
}

// 批量配置可选的容器（受管理/已纳入的）：传给 BatchDialog 的全集。
const selectableItems = computed(() => items.value.filter((c) => c.managed || c.adopted))

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
    // 卡片端口表还空着且存在运行中容器（首屏 / 全停过后又启动）→ 立即补刷一次，
    // 不等 15s 慢轮询——表非空时跳过，不会叠加成 5s 高频轮询。
    if (!Object.keys(portsById.value).length && r.items.some((c) => c.state === 'running')) {
      void refreshAllPorts()
    }
    const valid = new Set(r.items.map((c) => c.id))
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
// 重命名 = 改显示名（meta.displayName）：tab/侧栏/文件面板全用它，随时可改、不动容器真名。
// 成功后同步已开终端组的名字快照（组内 pane 头、文件面板 label 都读它）。
const renameTarget = ref<ContainerView | null>(null)
function onRename(c: ContainerView) {
  renameTarget.value = c
}
// 导出为包：任意容器 → tar.zst（不只模板）。要求容器已停止（对话框里有提示）。
const exportTarget = ref<ContainerView | null>(null)
async function doRename(value: string | undefined) {
  const c = renameTarget.value
  if (!c) return
  renameTarget.value = null
  const displayName = value?.trim()
  if (!displayName) return
  await act(c.id, async () => {
    await updateMeta(c.id, { displayName })
    for (const g of groups.value) {
      if (g.containerId === c.id) g.name = displayName
    }
  })
}
// DeleteContainerDialog 确认删除
async function doDelete(payload: { deleteData: boolean; confirmName?: string }) {
  const c = delTarget.value
  if (!c) return
  delTarget.value = null
  await act(c.id, () => deleteContainer(c.id, { deleteData: payload.deleteData, confirmName: payload.deleteData ? payload.confirmName : undefined }))
}

// —— 底部服务摘要条 ——
// docker 配套服务在侧栏只占一行：聚合状态点 + 名称串，点击开管理面板。
// 服务是配套设施，刻意不以行的形态进侧栏——避免和容器列表形成第二个并列清单，
// 冲淡「容器是唯一主体」的层级。轮询自适应：闲时 15s（服务启停低频），有创建任务
// 进行中时 3s（任务进度/完成 toast 的及时性；任务 tail=0，payload 极小）。
// 完成通知去重在 lib/serviceJobs.ts（服务面板打开时的独立轮询也喂它，天然只发一次）。
const svcItems = ref<ServiceView[]>([])
// null=未知（首拉前），false=docker 不可达
const svcReachable = ref<boolean | null>(null)
const svcJobsRunning = ref(0)
let svcTimer: ReturnType<typeof setInterval> | null = null
const SVC_IDLE_MS = 15000
const SVC_ACTIVE_MS = 3000
let svcIntervalMs = SVC_IDLE_MS
function armSvcTimer() {
  if (svcTimer) clearInterval(svcTimer)
  svcTimer = setInterval(() => void refreshServices(), svcIntervalMs)
}
async function refreshServices() {
  try {
    const [v, jobsR] = await Promise.all([listServices(), listServiceJobs(0)])
    svcItems.value = v.items
    svcReachable.value = v.status?.reachable ?? null
    svcJobsRunning.value = trackServiceJobs(jobsR.jobs)
    // 有任务在跑 → 收紧轮询；全落定 → 回到闲时节奏
    const want = svcJobsRunning.value > 0 ? SVC_ACTIVE_MS : SVC_IDLE_MS
    if (want !== svcIntervalMs) {
      svcIntervalMs = want
      armSvcTimer()
    }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    svcReachable.value = false // daemon 挂了等：降级显示「docker 不可达」，不打扰主流程
  }
}
const svcDotClass = computed(() => {
  if (svcJobsRunning.value > 0) return 'animate-pulse bg-blue-500'
  if (svcReachable.value === false) return 'bg-destructive'
  if (!svcItems.value.length) return 'bg-zinc-400'
  return svcItems.value.every((s) => s.running) ? 'bg-emerald-500' : 'bg-amber-500'
})
const svcSummary = computed(() => {
  if (svcReachable.value === false) return 'docker 不可达'
  if (svcJobsRunning.value > 0) return `${svcJobsRunning.value} 个服务任务进行中…`
  const names = svcItems.value.map((s) => s.name)
  if (!names.length) return '暂无配套服务'
  const shown = names.slice(0, 3).join(' · ')
  return names.length > 3 ? `${shown} 等 ${names.length} 个` : shown
})

// —— 终端无输出提醒（agent 干完活/等输入）——
// 服务端（server/activity.ts）已在周期扫 tmux 输出，这里 5s 拉一次快照做提醒决策。
// 「在不在看」前端自判：可见 tab 是 v-show 常驻（WS 恒 attach），tmux 的 attached 完全
// 不代表用户在看——只有「当前激活 tab + 终端区」才算看。每叶子两份时刻：
//   - lastOutput（lib/terminalActivity，Terminal.vue 每个数据帧登记）：可见叶子用它，
//     比服务端 5s 扫描精确；
//   - leftAt（离开时刻）：从「正在看」切走/切去编辑器/隐藏的时刻；WATCHING = 正在看。
//     提醒资格 = 安静超过阈值 && 最后一次输出发生在离开之后——看过结果再走的人不再被
//     打扰（否则「看着它跑完→切走」每次都误报），而中途离开后 agent 才收尾的能收到。
// 隐藏组收不到流，用服务端 quiet + 反推的输出时刻对齐 leftAt（留扫描周期余量）。
// 开关 per 组（tab 右键「无输出时提醒」），随组进 localStorage。
const WATCHING = Number.POSITIVE_INFINITY
const leftAtByTerm = new Map<string, number>()
function markWatch(g: TermGroup) {
  for (const t of leafIds(g.root)) leftAtByTerm.set(t, WATCHING)
}
function markLeft(g: TermGroup) {
  const now = Date.now()
  for (const t of leafIds(g.root)) leftAtByTerm.set(t, now)
}
// 激活组 / 主区形态变化 = 「在看」关系变化。首跑（页面加载恢复的 tabs）统一落基线：
// 激活组在看，其余组从加载起就没看过（它们常驻挂载、此后有输出就能积资格）。
watch(
  () => [groups.value[activeIdx.value]?.id ?? '', areaMode.value] as const,
  ([gid, mode], prev) => {
    if (!prev) {
      const now = Date.now()
      for (const g of groups.value) {
        const watching = g.id === gid && mode === 'terminal'
        for (const t of leafIds(g.root)) leftAtByTerm.set(t, watching ? WATCHING : now)
      }
      return
    }
    const [oldGid, oldMode] = prev
    const byId = (id: string) => groups.value.find((x) => x.id === id)
    if (oldMode === 'terminal' && oldGid && (oldGid !== gid || mode !== 'terminal')) {
      const g = byId(oldGid)
      if (g) markLeft(g)
    }
    if (mode === 'terminal' && gid) {
      const g = byId(gid)
      if (g) markWatch(g)
    }
  },
  { immediate: true },
)

function activityKeyOf(g: TermGroup, t: string): string {
  return g.kind === 'host' ? termSessionKey('host', undefined, t) : termSessionKey('container', g.containerId, t)
}
// tab 身份点颜色（宿主琥珀 / 容器色）：光晕与本体共用。
function tabDotColor(g: TermGroup): string {
  return g.kind === 'host' ? '#f59e0b' : containerColor(g.containerId)
}
// 有输出在流的组（任一叶子 4s 内收到过帧）：tab 身份点呼吸光晕。
// 帧登记在 lib/terminalActivity（1s 低频投影成响应式集合），agent 干活时长亮、
// 停手/等输入 ~4s 熄灭——「运行中」的即时视觉状态，与安静提醒（离开后）互补。
const busyGroupIds = computed(() => {
  const active = termActiveIds()
  const s = new Set<string>()
  for (const g of groups.value) {
    if (leafIds(g.root).some((t) => active.has(t))) s.add(g.id)
  }
  return s
})
function switchToGroup(g: TermGroup) {
  if (hiddenGroups.value.some((x) => x.id === g.id)) {
    restoreHidden(g) // 恢复即激活（内部已设 activeIdx）
    return
  }
  const gi = groups.value.findIndex((x) => x.id === g.id)
  if (gi >= 0) {
    activeIdx.value = gi
    areaMode.value = 'terminal'
  }
}
let actTimer: ReturnType<typeof setInterval> | null = null
const ACTIVITY_MS = 5000
async function refreshActivity() {
  if (!groups.value.length && !hiddenGroups.value.length) return
  let threshold = 15
  let rows: TermActivityView[]
  try {
    const r = await listTermActivity()
    threshold = r.threshold > 0 ? r.threshold : 15
    rows = r.items
  } catch (e) {
    if (e instanceof Unauthorized) emit('unauthorized')
    return // 轮询失败静默（服务重启窗口期常见），下拍再试
  }
  const rowByKey = new Map(rows.map((r) => [termSessionKey(r.kind, r.containerId, r.termId), r]))
  const feed: QuietFeedItem[] = []
  const keyToGroup = new Map<string, TermGroup>()
  for (const g of [...groups.value, ...hiddenGroups.value]) {
    if (g.quietNotify === false) continue
    const visible = groups.value.includes(g)
    for (const t of leafIds(g.root)) {
      const key = activityKeyOf(g, t)
      keyToGroup.set(key, g)
      const leftAt = leftAtByTerm.get(t) ?? WATCHING
      let quiet = false
      let quietMs = 0
      if (visible) {
        const last = lastTermOutput(t)
        if (last !== undefined) {
          quietMs = Date.now() - last
          quiet = quietMs >= threshold * 1000 && last > leftAt
        }
      } else {
        const r = rowByKey.get(key)
        if (r?.state === 'quiet') {
          quietMs = r.quietSeconds * 1000
          // 服务端输出时刻反推（±一个扫描周期，留 6s 余量）：隐藏前就停了的不打扰
          quiet = Date.now() - quietMs > leftAt + 6000
        }
      }
      feed.push({ key, quiet, quietMs })
    }
  }
  const hits = trackTerminalActivity(feed)
  // 同组分屏多叶子同时安静归并成一条；正看着的组 leftAt=WATCHING 不会命中资格。
  const byGroup = new Map<TermGroup, number>()
  for (const hit of hits) {
    const g = keyToGroup.get(hit.key)
    if (!g) continue
    byGroup.set(g, Math.max(byGroup.get(g) ?? 0, hit.quietMs))
  }
  for (const [g, ms] of byGroup) {
    const sec = Math.max(1, Math.round(ms / 1000))
    toast.info(`${groupLabel(g)} 已 ${sec}s 无输出`, {
      description: '可能已完成或在等你输入。',
      action: { label: '切换', onClick: () => switchToGroup(g) },
      duration: 12_000,
    })
  }
  // 修剪已不存在的叶子登记（组关了 / 开关关了）：两张表同步清，防无界增长
  const alive = new Set<string>()
  for (const g of [...groups.value, ...hiddenGroups.value]) {
    for (const t of leafIds(g.root)) alive.add(t)
  }
  for (const t of [...leftAtByTerm.keys()]) {
    if (!alive.has(t)) {
      leftAtByTerm.delete(t)
      forgetTerm(t)
    }
  }
}

onMounted(() => {
  refresh()
  timer = setInterval(() => refresh(true), 5000)
  // 无输出提醒：popout 独立窗口也有自己的终端组，同样参与轮询。
  void refreshActivity()
  actTimer = setInterval(() => void refreshActivity(), ACTIVITY_MS)
  if (!props.popout) {
    void refreshServices()
    armSvcTimer()
    void refreshAllPorts() // 首刷不等 15s：首屏卡片就有端口图标
    portsTimer = setInterval(() => void refreshAllPorts(), 15_000)
    document.addEventListener('visibilitychange', onVisChange)
  }
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (svcTimer) clearInterval(svcTimer)
  if (portsTimer) clearInterval(portsTimer)
  if (actTimer) clearInterval(actTimer)
  document.removeEventListener('visibilitychange', onVisChange)
})
</script>

<template>
  <div class="relative flex h-full min-h-0 gap-0">
    <!-- 左侧窄栏的信息架构：一个主体 + 底部环境区。
         「容器」是全侧栏唯一的列表（弱化小标签作分组头）；宿主终端与 docker 服务摘要
         是钉在底部的两行环境入口（容器之外的东西，不以行的形态混进容器清单）。
         模板/全局 hosts 等容器作用域的低频配置收进容器标题的 ⋯ 菜单。popout 独立窗口不渲染。
         手机（<768px）：侧栏转 overlay 抽屉（max-md:absolute + 遮罩），默认收起，
         汉堡入口在 tab 栏最左；桌面（≥768）恒为静态侧栏，抽屉相关类全部不命中。 -->
    <div
      v-if="!props.popout && drawerOpen"
      class="fixed inset-0 z-30 bg-black/50 md:hidden"
      @click="drawerOpen = false"
    />
    <aside
      v-if="!props.popout"
      class="flex w-56 shrink-0 flex-col border-r border-border bg-background max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[85vw] max-md:max-w-80 max-md:shadow-xl max-md:transition-transform md:transition-[width] md:duration-200"
      :class="[drawerOpen ? '' : 'max-md:-translate-x-full', collapsed && !isPhone ? 'md:w-12' : 'md:w-64']"
    >
      <!-- 收起态（窄边 rail，仅桌面；手机抽屉忽略 collapsed）：只留导航骨架——
            logo（点击展开，收缩后品牌仍在） / ＋ 新建 / 容器首字图标列（容器色淡染，
            title 带全名·状态·IP）/ 底部环境区（配置菜单 · 宿主 · 服务 · 展开键）。
            列表异常给一枚提示点，点击展开并重试。 -->
      <template v-if="collapsed && !isPhone">
        <div class="flex h-10 shrink-0 items-center justify-center border-b border-border">
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg hover:bg-accent/50"
            title="展开侧栏"
            @click="collapsed = false"
          >
            <img src="/logo.svg" alt="" class="size-5" />
          </button>
        </div>
        <div class="flex shrink-0 items-center justify-center border-b border-border py-1.5">
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="baseReady === false"
            :title="baseReady === false ? `${baseLabel}未就绪，无法新建` : '新建容器'"
            @click="showCreate = true"
          >
            <Plus />
          </Button>
        </div>
        <button
          v-if="err || connLost"
          type="button"
          class="mx-auto mt-2 shrink-0"
          :title="err || '连接失败，列表可能过期 · 点击展开并重试'"
          @click="((collapsed = false), refresh())"
        >
          <span class="block size-2 rounded-full" :class="err ? 'bg-destructive' : 'bg-amber-500 animate-pulse'" />
        </button>
        <div class="scroll-thin flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto py-2">
          <button
            v-for="c in items"
            :key="c.id"
            type="button"
            class="flex size-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-medium transition-colors"
            :class="[
              activeGroup?.containerId === c.id ? 'ring-1 ring-border' : 'hover:bg-accent/40',
              c.state !== 'running' ? 'opacity-40' : '',
            ]"
            :style="{
              backgroundColor: containerColorA(c.id, activeGroup?.containerId === c.id ? 0.22 : 0.1),
              color: containerColor(c.id),
            }"
            :title="`${c.displayName || c.name} · ${stateLabel(c.state)}${c.ip ? ` · ${c.ip}` : ''}`"
            @click="openTerm(c)"
          >
            {{ (c.displayName || c.name).trim().slice(0, 1).toUpperCase() }}
          </button>
          <Container v-if="!items.length && !loading" class="size-4 text-muted-foreground/40" />
        </div>
        <div class="flex shrink-0 flex-col items-center gap-0.5 border-t border-border py-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-xs" title="容器环境配置">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="start">
              <DropdownMenuItem @click="emit('open-base')">
                <Settings2 /> {{ baseLabel }}管理
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                :disabled="!selectableItems.length"
                :title="selectableItems.length ? '' : '没有受管理的容器'"
                @click="showBatch = true"
              >
                <ListChecks /> 批量配置
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg hover:bg-accent/50"
            :class="activeGroup?.kind === 'host' ? 'bg-accent/50' : ''"
            title="宿主终端"
            @click="openHostTerm()"
          >
            <Monitor class="size-4 text-amber-500" />
          </button>
          <button
            type="button"
            class="relative flex size-8 items-center justify-center rounded-lg hover:bg-accent/50"
            title="docker 配套服务（postgres/redis…，容器内按服务名访问）——点击管理"
            @click="emit('open-services')"
          >
            <img src="/docker.svg" alt="" class="size-4" />
            <span :class="['absolute bottom-1 right-1 h-2 w-2 rounded-full ring-1 ring-background', svcDotClass]" />
          </button>
          <!-- 伸缩键钉在环境区最底（与服务行同列）——顶部只留品牌，收/展动作统一放底部 -->
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            title="展开侧栏"
            @click="collapsed = false"
          >
            <PanelLeftOpen class="size-4" />
          </button>
        </div>
      </template>

      <!-- 展开态：品牌块 + 容器卡片列表 + 底部环境区 -->
      <template v-else>
      <!-- 品牌块：纯身份标识，居中。系统健康不做常驻展示——引擎/连接出问题时终端连不上，
           tmux 连接错误自然会暴露问题，不值得为小概率状态占一眼。手机抽屉态左侧加收起按钮；
           桌面收起动作在服务摘要行下方（与收缩态展开键同一位置，肌肉记忆一致）。 -->
      <div class="relative flex h-10 shrink-0 items-center justify-center gap-2 border-b border-border px-3">
        <Button
          variant="ghost"
          size="icon-xs"
          class="absolute left-1 md:hidden"
          title="收起侧栏"
          @click="drawerOpen = false"
        >
          <X />
        </Button>
        <img src="/logo.svg" alt="" class="size-5" />
        <span class="text-sm font-semibold tracking-tight">MySandbox</span>
      </div>

      <!-- 容器分区标题：弱化为分组小标签——品牌块已是全侧栏唯一强标题，两个同字重标题
           上下叠着会互相竞争。⟳ 刷新 / ＋ 新建（基座未就绪时禁用）/ ⋯ 低频配置 -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border py-1.5 pl-3 pr-1.5">
        <img src="/lxc.svg" alt="" class="size-3.5" /><span class="text-xs font-medium text-muted-foreground">系统容器</span>
        <span class="text-[10px] text-muted-foreground/70">{{ items.length }}</span>
        <div class="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="loading"
            :title="loading ? '刷新中…' : '刷新'"
            @click="refresh()"
          >
            <RefreshCw :class="loading ? 'animate-spin' : ''" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="baseReady === false"
            :title="baseReady === false ? `${baseLabel}未就绪，无法新建` : '新建容器'"
            @click="showCreate = true"
          >
            <Plus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-xs" title="容器环境配置">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @click="emit('open-base')">
                <Settings2 /> {{ baseLabel }}管理
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                :disabled="!selectableItems.length"
                :title="selectableItems.length ? '' : '没有受管理的容器'"
                @click="showBatch = true"
              >
                <ListChecks /> 批量配置
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
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

      <!-- 容器卡片区：数量有限（个人 sandbox 常年个位数），行形态浪费纵向空间且
           信息密度低——改两行卡片平铺「看一眼就该知道」的状态（状态文字、IP、描述），
           低频操作仍收 ⋯。色条与 tab 栏同色呼应。宿主条目刻意保持单行（见上）。 -->
      <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <!-- 首屏加载骨架：只在列表还没数据时占位（轮询静默刷新不打这里） -->
        <template v-if="loading && !items.length">
          <Skeleton v-for="i in 3" :key="i" class="h-12 w-full rounded-lg" />
        </template>
        <div
          v-for="c in items"
          :key="c.id"
          class="group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 pl-3.5 transition-colors active:bg-accent"
          :class="
            activeGroup?.containerId === c.id
              ? 'border-border/60 bg-accent'
              : 'border-transparent hover:bg-accent/40'
          "
          @click="openTerm(c)"
        >
          <!-- 左缘色条：卡片唯一的色彩元素——容器身份色（与 tab 呼应），兼作状态指示：
               running = 容器色；非 running = 灰条，右侧两行整体降亮度（整卡置灰 =
               已停/失效，不再另设状态点）。选中加粗全高；平时短一截，hover 恢复饱和。
               悬停色条看精确状态文案（title）。 -->
          <span
            class="absolute left-0 w-[3px] rounded-full transition-all"
            :class="[
              activeGroup?.containerId === c.id ? 'inset-y-1' : 'inset-y-2.5',
              c.state === 'running'
                ? activeGroup?.containerId === c.id
                  ? 'opacity-100'
                  : 'opacity-40 group-hover:opacity-90'
                : 'bg-muted-foreground/30',
            ]"
            :style="c.state === 'running' ? { backgroundColor: containerColor(c.id) } : undefined"
            :title="stateLabel(c.state)"
          />
          <!-- 第一行：身份行。非 running 整行降亮度——明度即活性。 -->
          <div
            class="flex min-w-0 items-center gap-1.5 pr-6"
            :class="c.state !== 'running' ? 'opacity-60' : ''"
          >
            <span
              class="min-w-0 truncate text-[13px] font-medium leading-snug text-foreground"
              :title="c.displayName || c.name"
              >{{ c.displayName || c.name }}</span
            >
          </div>
          <!-- 第二行：IP（点击复制，成功回显绿色）+ 描述/外部徽章。
               非 running 整行再降一档，灰色条是「还活着」的唯一信号。 -->
          <div
            class="flex items-center gap-2 text-[11px] leading-snug text-muted-foreground"
            :class="c.state !== 'running' ? 'opacity-50' : ''"
          >
            <button
              v-if="c.ip"
              type="button"
              class="shrink-0 font-mono tabular-nums transition-colors hover:text-foreground"
              :class="copiedIp === c.ip ? 'text-emerald-500' : ''"
              :title="copiedIp === c.ip ? '已复制' : '点击复制 IP'"
              @click.stop="copyIpOf(c.ip)"
              >{{ c.ip }}</button
            >
            <span v-else class="shrink-0 opacity-50">无 IP</span>
            <span class="min-w-0 flex-1 truncate" :title="c.description || c.name">{{
              c.description || c.name
            }}</span>
            <Badge
              v-if="!c.managed && !c.adopted"
              variant="outline"
              class="hidden shrink-0 border-transparent bg-muted text-[10px] text-muted-foreground group-hover:inline-flex pointer-coarse:inline-flex"
              >外部</Badge
            >
            <!-- 右下角端口图标：running 且扫到监听端口才出现（全部容器 15s 慢轮询，
                 active 容器随 tab 下拉 5s 精刷）。hover 浮出端口面板（触屏点按切换，
                 再点收起）；面板向上弹（列表底部卡片不出屏），行点击打开浏览器。 -->
            <div
              v-if="c.state === 'running' && (portsById[c.id]?.ports.length ?? 0) > 0"
              class="relative shrink-0"
              @mouseenter="portsHover = c.id"
              @mouseleave="portsHover = null"
            >
              <button
                type="button"
                class="flex rounded transition-colors"
                :class="portsHover === c.id || portsPinned === c.id ? 'text-foreground' : 'text-muted-foreground/70 hover:text-foreground'"
                title="监听端口"
                @click.stop="portsPinned = portsPinned === c.id ? null : c.id"
              >
                <Network class="size-3" />
              </button>
              <div
                v-if="portsHover === c.id || portsPinned === c.id"
                class="absolute bottom-full right-0 z-30 mb-1 w-44 rounded-md border border-border bg-popover p-1 shadow-md"
              >
                <button
                  v-for="r in cardPortRows(c.id)"
                  :key="r.kind + r.port"
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[11px] transition-colors hover:bg-accent"
                  :title="portRowTitle(c, r)"
                  @click.stop="openUrl(portRowTarget(c, r))"
                >
                  <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                  <ArrowRightLeft v-else-if="r.kind === 'map'" class="size-3 shrink-0" />
                  <span v-else class="w-3 shrink-0 text-center text-muted-foreground">:</span>
                  <span class="flex-1 tabular-nums">{{ r.kind === 'map' ? `${r.port} → ${r.priv}` : r.port }}</span>
                  <span v-if="r.kind === 'web'" class="text-[10px] text-emerald-500">网页</span>
                  <span v-else-if="r.kind === 'map'" class="text-[10px] text-muted-foreground">宿主</span>
                </button>
              </div>
            </div>
          </div>
          <!-- ⋯ 菜单：低频操作收进来（外部的容器只有「纳入管理」）。触屏常显。 -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="icon-xs"
                class="absolute right-1 top-1 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                :disabled="busy[c.id]"
                :title="busy[c.id] ? '处理中…' : '更多操作'"
                @click.stop
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
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
                <DropdownMenuItem @click="onRename(c)">重命名</DropdownMenuItem>
                <DropdownMenuItem
                  v-if="hasBaseAction('export')"
                  @click="exportTarget = c"
                  >导出为包</DropdownMenuItem
                >
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
        <!-- 空态：轻引导，与标题行的 ＋/⋯ 呼应 -->
        <div
          v-if="!items.length && !loading"
          class="flex flex-col items-center gap-1.5 px-3 py-8 text-center"
        >
          <Container class="size-5 text-muted-foreground/40" />
          <p class="text-xs text-muted-foreground">暂无容器</p>
          <p class="text-[11px] text-muted-foreground/60">点上方 ＋ 新建，⋯ 里可纳入已有容器</p>
        </div>
      </div>

      <!-- 宿主终端快捷行：钉在底部，与 docker 服务摘要同属「容器之外的环境」区，
           样式对齐（平底 footer 行）。点击开/切宿主 tab；独立窗口入口收进 tab 右键菜单。 -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left hover:bg-accent/50"
        :class="activeGroup?.kind === 'host' ? 'bg-accent/50' : ''"
        title="宿主终端"
        @click="openHostTerm()"
      >
        <Monitor class="size-3.5 shrink-0 text-amber-500" />
        <span class="min-w-0 flex-1 truncate text-sm">宿主终端</span>
      </button>

      <!-- 服务摘要条：一行聚合（状态点 + 名称串），点击开管理面板、＋ 带新建意图。
           全部运行=绿 / 有停机=黄 / docker 不可达=红 / 无服务=灰。 -->
      <button
        type="button"
        class="group flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left hover:bg-accent/50"
        title="docker 配套服务（postgres/redis…，容器内按服务名访问）——点击管理"
        @click="emit('open-services')"
      >
        <img src="/docker.svg" alt="" class="size-3.5 shrink-0" />
        <span :class="['h-2 w-2 shrink-0 rounded-full', svcDotClass]" />
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ svcSummary }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          title="新建服务"
          @click.stop="emit('open-services', true)"
        >
          <Plus />
        </Button>
      </button>

      <!-- 侧栏收起行：环境区最底（服务摘要之下）——收/展动作统一钉在这个位置，
           与收缩态 rail 底部的展开键互为镜像。 -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        title="收起侧栏（窄边）"
        @click="collapsed = true"
      >
        <PanelLeftClose class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate text-xs">收起侧栏</span>
      </button>
      </template>
    </aside>

    <!-- 右侧终端主区：tab 栏 + 分屏，占满剩余空间 -->
    <div class="flex min-w-0 flex-1 flex-col">
      <div
        v-if="!props.popout && baseReady === false"
        class="flex items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
      >
        <span>{{ baseLabel }}未就绪 —— 新建容器前先去处理（{{ baseLabel }}管理）。</span>
        <Button variant="destructive" size="xs" class="ml-auto" @click="emit('open-base')">{{ baseLabel }}管理</Button>
      </div>

      <!-- 终端 tab 栏（顶部）：主要内容是终端，tab 栏常驻主区上方。每组一个 tab，
           色条=容器色，·N=pane 数（>1 才显示）。
           右键（触屏长按合成同款事件）弹菜单：独立窗口（popout 该容器/宿主的工作区，容器
           要 running）/ 隐藏（保留会话，会话对话框可恢复）/ 关闭（真杀）。
           最左「所有终端」：本机全部活跃终端会话（服务端扫描，跨窗口跨浏览器），常驻入口；
           手机：汉堡键开侧栏抽屉、tab 序列横向滚动（shrink-0 保单个 tab 不被压扁）、
           文件面板按钮固定右侧。
           min-h-7：桌面 28px 托底，= 有 tab 时 tab 项（text-xs + py-1.5）撑出的行高——groups
           全关/全隐藏时只剩图标按钮（无纵向 padding），不托底整条栏会塌到 ~14px。
           max-md:min-h-10：手机 40px，对应 max-md:py-2.5 + text-sm。 -->
      <div class="flex min-h-7 border-b border-border bg-muted/30 max-md:min-h-10">
        <button
          v-if="!props.popout"
          class="flex shrink-0 items-center border-r border-border/60 px-3 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground max-md:px-4 md:hidden"
          title="打开侧栏（容器列表）"
          @click="drawerOpen = true"
        >
          <MoreHorizontal class="size-3.5 max-md:size-5" />
        </button>
        <button
          class="flex shrink-0 items-center self-stretch border-r border-border/60 px-3 text-xs max-md:px-4 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title="所有终端（本机全部活跃会话，含其他窗口 / 浏览器打开的）"
          @click="showSessions = true"
        >
          <TerminalIcon class="size-3.5 max-md:size-5" />
        </button>
        <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto scroll-thin">
        <ContextMenu v-for="(g, idx) in groups" :key="g.id">
          <ContextMenuTrigger as-child>
            <div
              :draggable="!isPhone"
              @click="onTabClick(idx)"
              @dragstart="onTabDragStart($event, idx)"
              @dragover="onTabDragOver($event, idx)"
              @dragend="onTabDragEnd"
              @pointerdown="tabPointerDown"
              @pointermove="tabPointerMove"
              @pointerup="tabPointerCancel"
              @pointercancel="tabPointerCancel"
              :class="[
                // 多 tab 时逐个收缩（浏览器式）：桌面允许 flex 收缩 + truncate，max-w 防少
                // tab 时无限拉宽；min-w-0 是 truncate 生效前提。手机不收缩（shrink-0），
                // 横向滚动——窄屏压到几十像素不可读。
                'flex shrink-0 min-w-0 overflow-hidden cursor-pointer select-none items-center gap-2 border-r border-border/60 px-3 py-1.5 text-xs max-md:py-2.5 max-md:text-sm relative md:shrink md:max-w-44',
                idx === activeIdx && areaMode === 'terminal'
                  ? 'bg-card text-foreground shadow-[inset_0_-2px_0_0_var(--primary)] font-medium'
                  : 'text-muted-foreground hover:bg-accent/50',
                dragTabIdx === idx ? 'opacity-40' : '',
              ]"
              :title="groups.length > 1 ? '拖动排序 · 点击切换 · 右键更多' : '右键：新开一组 / 独立窗口 / 隐藏 / 关闭'"
            >
              <!-- 身份点：组内有叶子在输出（agent 干活中）时叠呼吸光晕（缩放+辉光，
                  keyframes 见 index.css 的 term-busy-*），停手 ~4s 即熄——运行状态的即时视觉信号。 -->
              <span class="relative flex h-1.5 w-1.5 shrink-0 max-md:h-2 max-md:w-2">
                <span
                  v-if="busyGroupIds.has(g.id)"
                  class="term-busy-halo absolute -inset-1 rounded-full"
                  :style="{ backgroundColor: tabDotColor(g), '--dot': tabDotColor(g) }"
                />
                <span
                  class="relative inline-flex h-1.5 w-1.5 rounded-full max-md:h-2 max-md:w-2"
                  :class="busyGroupIds.has(g.id) && 'term-busy-dot'"
                  :style="{ backgroundColor: tabDotColor(g), '--dot': tabDotColor(g) }"
                />
              </span>
              <span class="min-w-0 truncate">{{ groupLabel(g) }}<span v-if="leafCount(g.root) > 1" class="text-muted-foreground/60">·{{ leafCount(g.root) }}</span></span>
              <button
                @click.stop="closeGroupById(g.id)"
                class="ml-1 flex shrink-0 items-center rounded text-muted-foreground hover:bg-accent hover:text-destructive max-md:px-1 max-md:py-1 pointer-coarse:px-2 pointer-coarse:py-1"
                title="关闭终端组"
              ><X class="size-3 max-md:size-3.5" /></button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem @click="openNewGroup(g)">
              新开一组终端
            </ContextMenuItem>
            <ContextMenuSeparator />
            <!-- 无输出提醒（per 组，随组持久化）：agent 干完活/等输入时弹 toast。
                 默认开；跑 dev server 这类长驻进程的 tab 可关。 -->
            <ContextMenuCheckboxItem
              :checked="g.quietNotify !== false"
              @update:checked="(v: boolean | 'indeterminate') => (g.quietNotify = v === true)"
            >
              无输出时提醒
            </ContextMenuCheckboxItem>
            <!-- popout 是组级动作（给该容器/宿主开独立工作区），收在这里而不是 pane 头部。
                 容器要 running 才有意义（停着的容器 popout 出来是死终端）。 -->
            <ContextMenuItem
              v-if="g.kind === 'host' || containerRunning(g.containerId)"
              @click="openPopout(g.kind === 'host' ? HOST_ID : g.containerId)"
            >
              在独立窗口打开
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem @click="hideGroupById(g.id)">
              隐藏
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" @click="closeGroupById(g.id)">
              关闭
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        </div>
        <!-- 网络：active group 容器的 IP / 监听端口 / 映射端口收进下拉（原独立信息条）。
             宿主组没有网络信息，禁用置灰。popout 独立窗口同样有此入口。 -->
        <DropdownMenu v-if="activeGroup?.kind !== 'host'">
          <DropdownMenuTrigger as-child>
            <button
              class="flex items-center self-stretch border-l border-border/60 px-3 text-xs max-md:px-5"
              :class="
                activeContainer
                  ? 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                  : 'pointer-events-none opacity-30'
              "
              :title="`网络信息（${activeContainer?.displayName || activeContainer?.name || ''}）`"
            >
              <Network class="size-3.5 max-md:size-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <template v-if="activeContainer && activeContainer.state === 'running'">
              <DropdownMenuLabel class="text-xs font-normal text-muted-foreground">
                {{ activeContainer.displayName || activeContainer.name }}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                v-if="activeContainer.ip"
                class="font-mono text-xs"
                :title="copiedIp === activeContainer.ip ? '已复制' : '点击复制 IP'"
                @click="copyIp"
              >
                <Network class="size-3.5" />
                <span class="flex-1">{{ activeContainer.ip }}</span>
                <span class="text-[10px] text-muted-foreground">{{ copiedIp === activeContainer.ip ? '已复制' : '复制' }}</span>
              </DropdownMenuItem>
              <!-- web 端口：后端实测返回 HTML，Globe 标记，点击开浏览器 -->
              <DropdownMenuItem
                v-for="p in webPorts"
                :key="'w' + p"
                class="font-mono text-xs"
                :title="`已验证返回网页，点击打开 http://${activeContainer.ip}:${p}`"
                @click="openUrl(`http://${activeContainer.ip}:${p}`)"
              >
                <Globe class="size-3.5 !text-emerald-500" />
                <span class="flex-1">{{ p }}</span>
                <span class="text-[10px] text-emerald-500">网页</span>
              </DropdownMenuItem>
              <!-- 非 web 监听端口（ssh/db 等）：同样可点开，标记弱化 -->
              <DropdownMenuItem
                v-for="p in otherListenPorts"
                :key="'o' + p"
                class="font-mono text-xs"
                :title="`容器内监听 ${p}（未返回 HTML），点击打开 http://${activeContainer.ip}:${p}`"
                @click="openUrl(`http://${activeContainer.ip}:${p}`)"
              >
                <span class="size-3.5 text-center text-muted-foreground">:</span>
                <span class="flex-1">{{ p }}</span>
              </DropdownMenuItem>
              <!-- docker 映射端口（宿主侧访问） -->
              <DropdownMenuItem
                v-for="m in mappedPorts"
                :key="'m' + m.pub"
                class="font-mono text-xs"
                :title="`宿主端口 ${m.pub} → 容器 ${m.priv}，点击打开`"
                @click="openUrl(`http://127.0.0.1:${m.pub}`)"
              >
                <ArrowRightLeft class="size-3.5" />
                <span class="flex-1">{{ m.pub }} → {{ m.priv }}</span>
                <span class="text-[10px] text-muted-foreground">宿主</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                v-if="!activeContainer.ip && !webPorts.length && !otherListenPorts.length && !mappedPorts.length"
                class="text-xs text-muted-foreground"
                disabled
              >
                暂无网络信息
              </DropdownMenuItem>
            </template>
            <template v-else>
              <DropdownMenuItem class="text-xs text-muted-foreground" disabled>
                容器未运行
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          v-else
          class="flex items-center self-stretch border-l border-border/60 px-3 text-xs max-md:px-5 pointer-events-none opacity-30"
          title="宿主终端无网络信息"
        >
          <Network class="size-3.5 max-md:size-5" />
        </button>
        <button
          class="flex items-center gap-1 self-stretch border-l border-border/60 px-3 text-xs max-md:px-5"
          :class="showFiles ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'"
          :title="showFiles ? '关闭文件面板' : '打开文件面板（跟随终端目录）'"
          @click="showFiles = !showFiles"
        >
          <FolderOpen class="size-3.5 max-md:size-5" />
        </button>
      </div>

      <!-- 工作区：同区切换——文件 tab 栏激活时主区给编辑器，终端 tab 栏激活时给终端。
           （文件面板原在此行内与终端并列，已提为根级通栏列——见根容器尾部的 FilePanel。）
           两区在交换容器内 absolute inset-0 叠放、v-show 切换（终端组/编辑器面板
           各自全量保活，切回现场不丢）。 -->
      <div class="relative flex min-h-0 flex-1">
        <!-- 交换容器：编辑器区 / 终端区在此二选一占位 -->
        <div class="relative min-h-0 min-w-0 flex-1">
          <!-- 编辑器区：每个文件 tab 一个 FileEditorPane，全量常驻。
               非激活面板用 invisible（visibility:hidden）而不是 v-show（display:none）——
               monaco 的 automaticLayout 在容器塌成 0×0 时对带标记（json 校验 squiggle 等
               glyph margin 装饰）的编辑器做 layout 会死循环（实测整页冻结）。visibility
               隐藏保留布局盒，尺寸恒定，彻底绕开 0 尺寸 layout。 -->
          <div v-show="areaMode === 'editor' && editorTabs.length" class="absolute inset-0">
            <FileEditorPane
              v-for="(t, i) in editorTabs"
              :key="tabId(t)"
              :ref="(el) => setPaneRef(t, el)"
              class="absolute inset-0"
              :class="i === activeEditorIdx ? '' : 'invisible'"
              :container-id="t.containerId"
              :container-name="t.containerName"
              :path="t.path"
              :diff="t.diff"
              :line="t.line"
              :col="t.col"
              :active="areaMode === 'editor' && i === activeEditorIdx"
              @close="removeTab(t)"
              @open-normal="onOpenNormal(t)"
              @saved="onEditorSaved"
              @dirty="(v: boolean) => (tabDirty[tabId(t)] = v)"
            />
          </div>
          <div v-show="!(areaMode === 'editor' && editorTabs.length)" class="absolute inset-0 bg-zinc-950">
          <div
            v-for="(g, gIdx) in groups"
            :key="g.id"
            v-show="gIdx === activeIdx"
            class="absolute inset-0 flex"
          >
            <!-- 布局树根：TermLayoutNode 递归渲染叶子/split；所有组常驻 DOM，v-show 切换 -->
            <TermLayoutNode
              :node="g.root"
              :group="g"
              :active="gIdx === activeIdx"
              class="min-h-0 min-w-0 flex-1"
            />
          </div>
          <div
            v-if="!groups.length"
            class="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground"
          >
            <TerminalIcon class="size-8 opacity-40" />
            <p class="text-sm">{{ props.popout ? '该窗口还没有终端' : '点击左侧容器打开终端' }}</p>
            <p class="text-xs opacity-70">同一容器可左右/上下分屏（每组最多 {{ MAX_GROUP_PANES }} 块）；tab 右键随时新开一组</p>
          </div>
          </div>
        </div>
      </div>

      <!-- 文件 tab 栏（底部，VSCode 式）：每个 tab 一个常驻编辑器面板（v-show 保活）。
           色点=所属容器色（宿主琥珀），●=有未落盘改动（自动保存窗口内/冲突未决），
           对比徽章=git diff 只读态。主区同区切换：点文件 tab 主区给编辑器，
           点顶部终端 tab 主区给终端。主要内容是终端——没开文件时整条不渲染，
           不占终端区高度；激活样式用上缘色条（栏在底部，压边方向反转）。
           多 tab 收缩同终端 tab（浏览器式，桌面收缩/手机滚动）；右键菜单承载
           tab 管理（关闭系）+ 形态动作（编辑⇄预览/下载/普通打开）+ 复制路径。 -->
      <div v-if="editorTabs.length" class="flex min-h-7 items-stretch border-t border-border bg-muted/30 max-md:min-h-10">
        <ContextMenu v-for="(t, i) in editorTabs" :key="tabId(t)">
          <ContextMenuTrigger as-child>
            <div
              class="flex shrink-0 min-w-0 overflow-hidden cursor-pointer select-none items-center gap-2 border-r border-border/60 px-3 py-1.5 text-xs max-md:py-2.5 max-md:text-sm md:shrink md:max-w-56"
              :class="
                i === activeEditorIdx && areaMode === 'editor'
                  ? 'bg-card font-medium text-foreground shadow-[inset_0_2px_0_0_var(--primary)]'
                  : 'text-muted-foreground hover:bg-accent/50'
              "
              :title="`${t.containerName}:${t.path}`"
              @click="onFileTabClick(i)"
            >
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full max-md:h-2 max-md:w-2"
                :style="{ backgroundColor: t.containerId === HOST_ID ? '#f59e0b' : containerColor(t.containerId) }"
              />
              <span class="min-w-0 truncate">{{ t.path.slice(t.path.lastIndexOf('/') + 1) }}</span>
              <span
                v-if="t.diff"
                class="shrink-0 rounded bg-violet-500/15 px-1 text-[10px] font-medium text-violet-400"
                >对比</span
              >
              <span
                v-if="tabDirty[tabId(t)]"
                class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                title="有未落盘改动"
              />
              <button
                class="ml-1 flex shrink-0 items-center rounded text-muted-foreground hover:bg-accent hover:text-destructive max-md:px-1 max-md:py-1 pointer-coarse:px-2 pointer-coarse:py-1"
                title="关闭（未落盘改动会先自动保存）"
                @click.stop="closeFileTab(t)"
              >
                <X class="size-3 max-md:size-3.5" />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <!-- 形态动作：svg/md 编辑⇄预览切换（状态在 pane 内部，经 paneRefs 调）；
                 diff 态「以普通方式打开」（清 diff 转普通编辑）；可预览类型（图片/视频/
                 音频/PDF）的下载。编辑器面板无 header，动作全收在这里。 -->
            <ContextMenuItem v-if="['svg', 'md', 'markdown'].includes(extOf(t.path))" @click="paneRefs.get(tabId(t))?.toggleTextPreview?.()">
              编辑 ⇄ 预览
            </ContextMenuItem>
            <ContextMenuItem v-if="t.diff" @click="onOpenNormal(t)">
              以普通方式打开
            </ContextMenuItem>
            <ContextMenuItem v-if="previewKind(t.path)" @click="downloadTab(t)">
              下载
            </ContextMenuItem>
            <template v-if="t.diff || previewKind(t.path) || ['svg', 'md', 'markdown'].includes(extOf(t.path))">
              <ContextMenuSeparator />
            </template>
            <ContextMenuItem @click="copyTabPath(t)">
              复制容器路径
            </ContextMenuItem>
            <ContextMenuItem @click="copyTabHostPath(t)">
              复制实际路径
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" @click="closeFileTab(t)">
              关闭
            </ContextMenuItem>
            <ContextMenuItem :disabled="editorTabs.length <= 1" @click="closeFileTabsRange(t, 'other')">
              关闭其他
            </ContextMenuItem>
            <ContextMenuItem :disabled="i === 0" @click="closeFileTabsRange(t, 'left')">
              关闭左侧
            </ContextMenuItem>
            <ContextMenuItem :disabled="i === editorTabs.length - 1" @click="closeFileTabsRange(t, 'right')">
              关闭右侧
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <DesktopDialog
        v-if="desktopTarget"
        :container-id="desktopTarget.containerId"
        :container-name="desktopTarget.containerName"
        @close="desktopTarget = null"
      />
    </div>

    <!-- 右侧文件面板：通栏列（与主列平级、根 flex row 的第三个兄弟）——高度撑满整个
         视口（邮件客户端列表式），不被终端/文件 tab 栏压住。跟随 active group 第一个
         pane 的 cwd（可切 pane）。宿主组同样渲染：api.ts 按 HOST_ID 哨兵把文件请求切到
         /api/host-terminal/*。手机全屏覆盖（absolute inset-0，根容器 relative）：固定
         像素宽 + 分隔条在窄屏放不下，PaneDivider 跳过、filesW 不绑定；桌面原路径
         （filesW + PaneDivider）全保留，拖宽钳制的可用宽随之变成根容器宽。 -->
    <PaneDivider
      v-if="showFiles && !isPhone"
      @dragstart="(w: number) => onFilesDragStart(activeGroup, 1, w)"
      @drag="onFilesDrag"
    />
    <FilePanel
      v-if="showFiles"
      ref="filePanelRef"
      class="shrink-0 border-l border-border max-md:absolute max-md:inset-0 max-md:z-30 max-md:border-l-0 max-md:pt-safe md:static"
      :style="isPhone ? undefined : { width: filesW + 'px' }"
      :container-id="activeGroup ? activeGroup.containerId : ''"
      :container-name="activeGroup ? activeGroup.name : ''"
      :panes="filePanes"
      :term-id="fileTermId"
      :has-terminal="!!activeGroup"
      @close="showFiles = false"
      @open-file="onPanelOpenFile"
      @pane-pick="(t: string) => (filePaneIdx = filePanes.findIndex((x) => x.termId === t))"
    />
  </div>

  <CreateDialog
    v-if="showCreate"
    @created="showCreate = false; refresh()"
    @close="showCreate = false"
  />

  <ExportContainerDialog
    v-if="exportTarget"
    :container="exportTarget"
    @done="refresh(); exportTarget = null"
    @close="exportTarget = null"
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

  <!-- 重命名 = 显示名：tab / 侧栏 / 文件面板即时跟随，不影响容器真名，随时可改 -->
  <ConfirmDialog
    v-if="renameTarget"
    title="重命名容器"
    description="修改显示名（终端 tab、侧栏、文件面板都用它），不影响容器本身的名称。"
    confirm-text="重命名"
    :input="{ default: renameTarget.displayName || renameTarget.name, placeholder: renameTarget.name }"
    @confirm="doRename"
    @close="renameTarget = null"
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
    v-if="showBatch"
    :containers="
      selectableItems.map((c) => ({ id: c.id, label: c.displayName || c.name, ip: c.ip, state: c.state }))
    "
    @done="refresh()"
    @close="showBatch = false"
    @unauthorized="emit('unauthorized')"
  />

  <!-- 终端会话对话框：恢复本窗口隐藏的组 / 接入其他窗口浏览器的活跃会话 / 清理孤儿会话 -->
  <TermSessionsDialog
    v-if="showSessions"
    :hidden="hiddenGroups"
    :occupied="occupiedSet"
    :items="items"
    @restore="restoreHidden"
    @adopt="adoptSessions"
    @close="showSessions = false"
    @unauthorized="emit('unauthorized')"
  />
</template>
