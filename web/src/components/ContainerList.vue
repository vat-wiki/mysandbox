<script setup lang="ts">
import { ref, reactive, computed, onMounted, onUnmounted, watch, nextTick, defineAsyncComponent, provide } from 'vue'
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
  startService,
  stopService,
  restartService,
  deleteService,
  unadoptService,
  updateServiceMeta,
  listTermActivity,
  termSessionKey,
  HOST_ID,
  serviceFileId,
  sshGroupId,
  sshTargetName,
  listSshTargets,
  type SshTargetView,
  getServiceListenPorts,
  Unauthorized,
  type ContainerView,
  type ResolveView,
  type ServiceView,
  type TermSessionView,
  type TermActivityView,
} from '@/lib/api'
import { trackServiceJobs } from '@/lib/serviceJobs'
import { directUrl, originIpish, serviceUrl } from '@/lib/proxy'
import {
  lastTermNotableOutput,
  termRunSpanMs,
  resetTermRun,
  snapTermBaseline,
  termContentChanged,
  forgetTerm,
  termActiveIds,
  QUIET_CONFIRM_MS,
  SUSTAIN_MS,
} from '@/lib/terminalActivity'
import { newId } from '@/lib/id'
import { containerColor, containerColorA, stateLabel } from '@/lib/utils'
import { baseLabel, hasBaseAction } from '@/lib/caps'
import { isPhone, isCoarse } from '@/composables/useDevice'
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
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { Terminal as TerminalIcon, MoreHorizontal, RefreshCw, X, FolderOpen, Monitor, Globe, Plus, Settings2, Network, ArrowRightLeft, ListChecks, Bot, Container, PanelLeftClose, PanelLeftOpen, ChevronDown } from 'lucide-vue-next'
import CreateDialog from '@/components/CreateDialog.vue'
import BatchDialog from '@/components/BatchDialog.vue'
import AiWorkspace from '@/components/AiWorkspace.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DeleteContainerDialog from '@/components/DeleteContainerDialog.vue'
import TermSessionsDialog from '@/components/TermSessionsDialog.vue'
import SshTargetsDialog from '@/components/SshTargetsDialog.vue'
import AdoptServiceDialog from '@/components/AdoptServiceDialog.vue'
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
  // 服务抽屉操作回传计数（App 透传）：抽屉里启停/删除/创建完成后 +1，侧栏即时跟刷。
  svcVersion?: number
}>()
const emit = defineEmits<{
  (e: 'unauthorized'): void
  (e: 'open-base'): void
  // 打开服务抽屉；create=true 表示来自 ＋（App 直开创建对话框，不拉抽屉）；
  // select=服务名表示来自卡片点击（抽屉打开即定位到该服务详情）
  (e: 'open-services', create?: boolean, select?: string): void
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
    kind:
      r.kind === 'host'
        ? ('host' as const)
        : r.kind === 'service'
          ? ('service' as const)
          : r.kind === 'ssh'
            ? ('ssh' as const)
            : undefined,
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

// —— SSH 终端目标（侧栏终端区的「本机之外」条目）——
// 只作终端延伸（非被管理对象）：加载一次 + 管理对话框增删后刷新，无轮询。
// 声明前置：popout 首屏种子的 watch（下方）要按它决定何时建 ssh 组。
const sshTargets = ref<SshTargetView[]>([])
async function refreshSshTargets() {
  try {
    sshTargets.value = (await listSshTargets()).targets
  } catch (e) {
    if (e instanceof Unauthorized) emit('unauthorized')
    // 失败静默：终端区照常（本机可用），目标列表下轮交互再试
  }
}

// —— 侧栏分区收展（系统容器/终端区，应用容器在下方服务段声明）——
// 三区同一交互语言：分区头整行点击收展 + localStorage 记忆。系统容器是主列表默认展开；
// 终端区（本机 + SSH 主机）低频，默认展开但可收。
const ctExpanded = ref(loadBool('mysandbox:ct-cards-open') || !('mysandbox:ct-cards-open' in localStorage))
watch(ctExpanded, (v) => {
  try {
    localStorage.setItem('mysandbox:ct-cards-open', v ? '1' : '0')
  } catch {
    /* localStorage 不可用就跳过 */
  }
})
const termExpanded = ref(loadBool('mysandbox:term-cards-open') || !('mysandbox:term-cards-open' in localStorage))
watch(termExpanded, (v) => {
  try {
    localStorage.setItem('mysandbox:term-cards-open', v ? '1' : '0')
  } catch {
    /* localStorage 不可用就跳过 */
  }
})
// 收起时的容器摘要：M 运行中（err 时交给上方错误条，摘要不重复）。
const ctSummary = computed(() => {
  const run = items.value.filter((c) => c.state === 'running').length
  return `${run} 运行中 · ${items.value.length - run} 已停止`
})

// —— 卡片拖拽排序（系统容器/应用容器/SSH 主机，桌面 only）——
// 顺序存各浏览器 localStorage（tab 布局同款约定）：拖拽是查看偏好，不值得进 sidecar。
// 列表 = 按序数组排（未知项按服务端相对序垫底），拖 over 时原地移动 + dragend 落盘。
const CARD_ORDER_KEYS = {
  ct: 'mysandbox:ct-order',
  svc: 'mysandbox:svc-order',
  ssh: 'mysandbox:ssh-order',
} as const
type CardKind = keyof typeof CARD_ORDER_KEYS
function loadOrder(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
const cardOrders = {
  ct: ref(loadOrder(CARD_ORDER_KEYS.ct)),
  svc: ref(loadOrder(CARD_ORDER_KEYS.svc)),
  ssh: ref(loadOrder(CARD_ORDER_KEYS.ssh)),
}
// 按序数组重排：order 里没有的项保持原相对序垫在后面（新容器/新目标自然追加）。
function orderBy<T>(list: T[], keyOf: (x: T) => string, order: string[]): T[] {
  if (!order.length) return list
  const idx = new Map(order.map((k, i) => [k, i]))
  return [...list].sort((a, b) => {
    const ia = idx.get(keyOf(a)) ?? Number.MAX_SAFE_INTEGER
    const ib = idx.get(keyOf(b)) ?? Number.MAX_SAFE_INTEGER
    return ia !== ib ? ia - ib : list.indexOf(a) - list.indexOf(b)
  })
}
const orderedItems = computed(() => orderBy(items.value, (c) => c.id, cardOrders.ct.value))
const orderedSvc = computed(() => orderBy(svcItems.value, (s) => s.name, cardOrders.svc.value))
const orderedSsh = computed(() => orderBy(sshTargets.value, (t) => t.name, cardOrders.ssh.value))

let dragCard: { kind: CardKind; key: string } | null = null
const dragCardKey = ref('')
function cardDragStart(e: DragEvent, kind: CardKind, key: string) {
  if (isPhone.value) return
  dragCard = { kind, key }
  dragCardKey.value = key
  try {
    e.dataTransfer?.setData('text/plain', key)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
  } catch {
    /* dataTransfer 不可用就纯视觉 */
  }
}
// 当前可视全量 key 序（排序数组只记拖过的卡，表达不了「拖到没动过的卡之间」——
// 每次以可视序为底稿做移动，得到的才是完整新序）。
function displayedKeys(kind: CardKind): string[] {
  return kind === 'ct'
    ? orderedItems.value.map((c) => c.id)
    : kind === 'svc'
      ? orderedSvc.value.map((s) => s.name)
      : orderedSsh.value.map((t) => t.name)
}
function cardDragOver(e: DragEvent, kind: CardKind, key: string) {
  if (!dragCard || dragCard.kind !== kind || dragCard.key === key) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const keys = displayedKeys(kind)
  const from = keys.indexOf(dragCard.key)
  const to = keys.indexOf(key)
  if (from < 0 || to < 0 || from === to) return
  keys.splice(from, 1)
  // 摘掉后再插到目标当前下标：向下拖 = 落到目标之后，向上拖 = 目标之前——两种方向
  // 都与目标相邻，其余卡整体滑移补位（FLIP 补间吃这个位移，见 flipPlay）
  keys.splice(to, 0, dragCard.key)
  const before = flipCapture(kind)
  cardOrders[kind].value = keys
  nextTick(() => flipPlay(kind, before))
}
// —— 卡片 FLIP 补间（拖拽排序的实时动效）：cross 到别的卡、顺序变化后，位移的卡从
// 旧位置滑到新位置——「实时排序」的观感来自这里。First-Last-Invert-Play：改动前记
// 各卡 rect（capture），Vue patch 后按位移反向平移再回弹到 0（play）。只动 transform
// 不碰布局；拖拽连跨多卡时每次 capture 拿到的是动画中的当前位置，补间自然接续。
const FLIP_MS = 200
function flipCapture(kind: CardKind): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>()
  const scope = document.querySelector<HTMLElement>(`[data-flip="${kind}"]`)
  if (!scope) return m
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[data-card-key]'))) {
    if (el.dataset.cardKey) m.set(el.dataset.cardKey, el.getBoundingClientRect())
  }
  return m
}
function flipPlay(kind: CardKind, before: Map<string, DOMRect>) {
  if (!before.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const scope = document.querySelector<HTMLElement>(`[data-flip="${kind}"]`)
  if (!scope) return
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[data-card-key]'))) {
    const r0 = el.dataset.cardKey ? before.get(el.dataset.cardKey) : undefined
    if (!r0) continue
    const r1 = el.getBoundingClientRect()
    const dx = r0.left - r1.left
    const dy = r0.top - r1.top
    if (!dx && !dy) continue
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px, ${dy}px)`
    void el.offsetWidth // 强制 reflow：起点生效后才开补间，否则两步合并成瞬移
    el.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
    el.style.transform = ''
    const done = (ev: TransitionEvent) => {
      if (ev.target !== el || ev.propertyName !== 'transform') return
      el.style.transition = ''
      el.removeEventListener('transitionend', done)
    }
    el.addEventListener('transitionend', done)
  }
}
function cardDragEnd(kind: CardKind) {
  if (!dragCard) return
  dragCard = null
  dragCardKey.value = ''
  // 落盘前剪掉已不存在的 key（容器/服务/目标删了不残留）；列表空时不剪（首载窗口防误清）
  const live = new Set(displayedKeys(kind))
  if (live.size) cardOrders[kind].value = cardOrders[kind].value.filter((k) => live.has(k))
  try {
    localStorage.setItem(CARD_ORDER_KEYS[kind], JSON.stringify(cardOrders[kind].value))
  } catch {
    /* localStorage 不可用就跳过 */
  }
}

// —— 分区高度拖拽（应用容器/终端区展开体，桌面 only）——
// maxHeight 拖的是「内容多时的滚动区上限」：内容少时分区自然矮，拖多了也只是 cap。
const sectionHeights = reactive({
  svc: loadNum('mysandbox:svc-h', 176), // 旧版固定 max-h-44 = 176px，沿用为默认
  term: loadNum('mysandbox:term-h', 208),
})
const asideRef = ref<HTMLElement | null>(null)
let secDrag: { kind: 'svc' | 'term'; startY: number; startH: number; max: number } | null = null
function secDragStart(e: PointerEvent, kind: 'svc' | 'term') {
  if (isPhone.value) return
  const aside = asideRef.value
  const avail = aside ? aside.clientHeight : 700
  secDrag = { kind, startY: e.clientY, startH: sectionHeights[kind], max: Math.max(120, avail - 340) }
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
function secDragMove(e: PointerEvent) {
  if (!secDrag) return
  // 向上拖 = 加高（吃掉上方容器区）；钳制下限保住一行卡片的可读性
  sectionHeights[secDrag.kind] = Math.min(Math.max(secDrag.startH + (secDrag.startY - e.clientY), 88), secDrag.max)
}
function secDragEnd() {
  if (!secDrag) return
  saveNum(secDrag.kind === 'svc' ? 'mysandbox:svc-h' : 'mysandbox:term-h', sectionHeights[secDrag.kind])
  secDrag = null
}
// termId -> Terminal 实例（close 时调 kill() 发 kill 帧真杀会话；无输出提醒的内容
// 基线调 screenHash() 取视口快照）。函数式 ref 挂/卸自动进出表；key 是稳定的 termId，
// 布局重排/塌缩不会错杀别的会话。
const termRefs = new Map<string, { kill(): void; screenHash?(): string | undefined }>()
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

// —— 收起态悬停即展（桌面鼠标形态 only）——
// rail 上停留片刻自动临时展开，划走立即收回。hoverExpand 是纯内存的临时态，不写
// localStorage——记住的「收起」偏好不变，松手即回 rail。展开/收回走 aside 既有的
// md:transition-[width] 宽度动画；展开中给直接子元素统一钉 md:[&>*]:w-64 终宽 +
// aside md:overflow-hidden，宽度动画期间内容按终宽布局、只做「揭示」，不逐帧重排
// （逐帧改断行/截断观感发抖）。要点：
// - 进栏延时 200ms 才展开：路过左缘/扫一下不弹；划出走即时收。
// - 显式点「收起侧栏」后压制一次悬停展开（鼠标还停在栏内，不压会刚收起又被撑开），
//   划走即解除。
// - 栏内来源的右键菜单/下拉（portal 在 body，DOM 上不属于 aside）：移入菜单会触发
//   aside 的 mouseleave——此刻不能收（收起会卸载触发元、弄丢菜单），挂起待全局
//   click/keydown（选中/Esc/点别处）再真正收回；期间鼠标回到栏内则取消挂起保持展开。
//   菜单开着时也不启动展开定时（展开同样会卸载 rail 触发元）。
const hoverExpand = ref(false)
const railMode = computed(() => collapsed.value && !isPhone.value && !hoverExpand.value)
const HOVER_EXPAND_DELAY = 200
let hoverTimer: ReturnType<typeof setTimeout> | null = null
let hoverSuppress = false
let hoverPendingOff: (() => void) | null = null
// 栏内打开、portal 到 body 的菜单/下拉（reka-ui 的 data-state=open 约定）
function sidebarMenuOpen(): Element | null {
  return document.querySelector('[role="menu"][data-state="open"],[role="listbox"][data-state="open"]')
}
function disarmHoverPending(keepOpen: boolean) {
  hoverPendingOff?.()
  hoverPendingOff = null
  if (!keepOpen) {
    hoverExpand.value = false
    hoverSuppress = false
  }
}
function armHoverPending() {
  if (hoverPendingOff) return
  const onDoc = () => disarmHoverPending(false)
  document.addEventListener('click', onDoc, true)
  document.addEventListener('keydown', onDoc, true)
  hoverPendingOff = () => {
    document.removeEventListener('click', onDoc, true)
    document.removeEventListener('keydown', onDoc, true)
  }
}
function clearHoverTimer() {
  if (hoverTimer) {
    clearTimeout(hoverTimer)
    hoverTimer = null
  }
}
function asideMouseEnter() {
  disarmHoverPending(true) // 回到栏内：挂起的收起作废，保持展开
  if (isPhone.value || isCoarse.value || !collapsed.value || hoverSuppress || sidebarMenuOpen()) return
  clearHoverTimer()
  hoverTimer = setTimeout(() => {
    hoverTimer = null
    if (!collapsed.value || hoverSuppress || sidebarMenuOpen()) return
    hoverExpand.value = true
  }, HOVER_EXPAND_DELAY)
}
function asideMouseLeave() {
  clearHoverTimer()
  if (!hoverExpand.value) {
    hoverSuppress = false
    return
  }
  if (sidebarMenuOpen()) {
    armHoverPending()
    return
  }
  disarmHoverPending(false)
}
function collapseSidebar() {
  disarmHoverPending(false)
  clearHoverTimer()
  collapsed.value = true
  hoverExpand.value = false
  hoverSuppress = true
}

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
// —— 终端动态标题（tab 标签）——
// 来源：shell 钩子（scripts/zshrc / 宿主 ~/.zshrc 的 preexec/precmd 发 OSC 2：执行中=
// 命令行、空闲=用户@主机:路径）与 TUI 应用（CC/opencode 自己发的任务标题）——服务端
// tmux set-titles on 转发 pane title → Terminal.vue onTitleChange / {type:'title'} 帧
// → 这里。纯内存态：重连时服务端补发 title 帧恢复，恢复不了（首连）回落默认组名。
// 值带更新时刻：多 pane 组取「最近更新」的那块当组标题（谁在动显示谁）。
const termTitles = ref<Record<string, { text: string; at: number }>>({})
provide(TERM_OPS, {
  split(group, termId, dir) {
    const fresh = newTermId()
    splitCwdFrom.set(fresh, termId)
    group.root = splitLeaf(group.root, termId, dir, fresh)
  },
  close(group, termId) {
    termRefs.get(termId)?.kill()
    delete termTitles.value[termId]
    const root = removeLeaf(group.root, termId)
    if (root) group.root = root
    else closeGroupById(group.id)
  },
  setRef(termId, el) {
    if (el) termRefs.set(termId, el as { kill(): void; screenHash?(): string | undefined })
    else termRefs.delete(termId)
  },
  cwdSourceOf(termId) {
    return splitCwdFrom.get(termId)
  },
  onTitle(_group, termId, title) {
    const t = title.trim()
    if (!t) return
    termTitles.value[termId] = { text: t, at: Date.now() }
  },
  titleOf(termId) {
    return termTitles.value[termId]?.text ?? ''
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
// AI 工具工作区（技能 / 模型接入）：主区级页面——文件 tab 栏的单例 tab（VSCode
// 设置页模式）。aiOpen = tab 存在（会话级，不持久化——「有事才出现」）；激活与否
// 由主区归属 mainView 表达（'ai'），与终端/文件天然互斥。Bot 钮与容器卡片
// 「AI 配置…」都是开它。
const aiOpen = ref(false)
function openAi() {
  aiOpen.value = true
  mainView.value = 'ai'
}
function openAiOverride(name: string) {
  aiOverrideFor.value = name
  openAi()
}
function closeAi() {
  aiOpen.value = false
  aiOverrideFor.value = null
  if (mainView.value === 'ai') mainView.value = 'terminal'
}
// 容器卡片菜单「AI 配置…」：覆盖模式打开（面板只显智能体配置页签，编辑该容器的覆盖绑定）。
const aiOverrideFor = ref<string | null>(null)
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
// 激活的文件 tab 下标：刷新后高亮回到刷新前正看的那个 tab（越界/坏值回落 0）。
const EDITOR_ACTIVE_KEY =
  props.popout && props.popoutTarget
    ? `mysandbox:editor-active-popout-${props.popoutTarget}`
    : 'mysandbox:editor-active'
function loadBool(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
function loadNum(key: string, dflt: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : dflt
  } catch {
    return dflt
  }
}
function saveNum(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(Math.round(v)))
  } catch {
    /* localStorage 不可用就跳过 */
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
const FILES_SIDEBAR_W = computed(() => (props.popout ? 0 : railMode.value ? 48 : 256))
function onFilesDrag(dx: number) {
  // 面板在右侧：向左拖（负 dx）变宽
  const w = filesDragStartW - dx
  filesW.value = Math.min(Math.max(w, 220), Math.max(220, filesDragAvailW - FILES_SIDEBAR_W.value - 380))
}
// 文件面板跟随哪个 pane（active group 内的序号；group 切换/结构变化时归零）。
const filePaneIdx = ref(0)
const activeGroup = computed(() => groups.value[activeIdx.value])
// 文件面板/编辑器/复制粘贴的目标 id：服务组加 's:' 前缀（api.ts filesBase 切
// /api/services/<name>/*），容器/宿主组原样（宿主即 HOST_ID 哨兵）。
function fileTargetId(g: TermGroup): string {
  return g.kind === 'service' ? serviceFileId(g.containerId) : g.containerId
}
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
    // SSH 组没有文件端点（远端 fs 不经本机 API）：切到该组时收起文件面板，
    // 面板按钮同步禁用（模板）。切回其他组不自动重开——保持用户上次显式选择。
    if (activeGroup.value?.kind === 'ssh' && showFiles.value) showFiles.value = false
  },
)
const filePanelRef = ref<InstanceType<typeof FilePanel> | null>(null)
// —— 文件面板浏览模式（下钻/展开）——
// FilePanel 是单实例跟随 activeGroup，但模式是「每个终端组自己的」而非全局：切 tab 随组
// 切换（FilePanel 只认 containerId，认不了组，所以状态上收在这里按组 id 记）。存
// sessionStorage：浏览器会话（标签页）内有效——跨标签页/窗口互不影响，会话结束即忘，
// 不做跨会话持久化。已关组的残留键几字节无害，不清理。
type FileBrowseMode = 'drill' | 'expand'
const FILE_BROWSE_KEY = 'mysandbox:file-browse-modes'
function loadFileBrowseModes(): Record<string, FileBrowseMode> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(FILE_BROWSE_KEY) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, FileBrowseMode>) : {}
  } catch {
    return {}
  }
}
const fileBrowseModes = reactive(loadFileBrowseModes())
const fileBrowseMode = computed<FileBrowseMode>(
  () => fileBrowseModes[activeGroup.value?.id ?? ''] ?? 'drill',
)
function setFileBrowseMode(m: FileBrowseMode) {
  const id = activeGroup.value?.id
  if (!id) return
  fileBrowseModes[id] = m
  try {
    sessionStorage.setItem(FILE_BROWSE_KEY, JSON.stringify(fileBrowseModes))
  } catch {
    /* sessionStorage 不可用（隐私模式等）就只留内存态 */
  }
}
// —— 文件 tab（VSCode 式多开）——
// 每个 tab 一个常驻 FileEditorPane（v-show 切换，保 Monaco 撤销栈/滚动位——同终端组机制）。
// diff 存在 = git 变更对比模式（只读快照分支）；line/col 来自终端 Ctrl+点击 `:行:列` 后缀。
// tab 身份 = containerId+path：diff/普通是同一 tab 的两种形态，重复打开即更新并激活。
// 主区归属（mainView）：三值互斥——'terminal' | 'file' | 'ai'。所有显示条件都是
// 对它的等式比较（结构上不可能两区同显），写入点只赋自己的值、不存在「清别人的
// 标志」。文件 tab 栏在上、终端 tab 栏在下，同区切换——点谁主区给谁；开文件切
// 'file'，动终端 tab 切 'terminal'，最后一个文件 tab 关掉时回落终端。
type EditorTab = {
  containerId: string
  containerName: string
  path: string
  diff?: { headPath?: string }
  line?: number
  col?: number
  // 一次性编辑请求（右键「编辑」）：pane 消费后 tab 标记即清（openFile 无 editing 时
  // 重置），localStorage 恢复也不带（loadEditorTabs 只挑字段）——编辑态不跨刷新。
  editing?: boolean
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
// 激活下标：从 localStorage 恢复并钳在有效范围（tab 列表可能已变/坏值回落 0）
const activeEditorIdx = ref(
  (() => {
    try {
      const n = Number(localStorage.getItem(EDITOR_ACTIVE_KEY))
      if (Number.isInteger(n) && n >= 0 && n < editorTabs.value.length) return n
    } catch {
      /* localStorage 不可用就落 0 */
    }
    return 0
  })(),
)
function loadMainView(): 'file' | 'terminal' {
  try {
    // 'ai' 不持久化（aiOpen 会话级）：落盘时已折成 'file'，这里只认 file/terminal
    return localStorage.getItem(EDITOR_AREA_KEY) === 'file' && editorTabs.value.length ? 'file' : 'terminal'
  } catch {
    return 'terminal'
  }
}
const mainView = ref<'terminal' | 'ai' | 'file'>(loadMainView())
watch(
  [editorTabs, activeEditorIdx, mainView],
  () => {
    try {
      localStorage.setItem(EDITOR_TABS_KEY, JSON.stringify(editorTabs.value))
      localStorage.setItem(EDITOR_AREA_KEY, mainView.value === 'ai' ? 'file' : mainView.value)
      localStorage.setItem(EDITOR_ACTIVE_KEY, String(activeEditorIdx.value))
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
// 各 tab 的形态（pane 上报）：tab 右键菜单的编辑/预览项按此判定——
// 渲染视图/只读态显示「编辑」；编辑会话中显示「预览」（md/svg 回渲染视图，
// 普通文件锁回只读）。
const tabMode = ref<Record<string, { editing: boolean; preview: boolean }>>({})
// pane 引用表：tab X 要先让 pane 冲刷未落改动（requestClose），冲完 pane 自己 emit close；
// enterEdit/showPreview 供 tab 上编辑/预览切换按钮调。
const paneRefs = new Map<string, { requestClose: () => void; enterEdit?: () => void; showPreview?: () => void }>()
function setPaneRef(t: EditorTab, el: unknown) {
  const key = tabId(t)
  if (el) paneRefs.set(key, el as { requestClose: () => void; enterEdit?: () => void; showPreview?: () => void })
  else paneRefs.delete(key)
}
function openFile(cId: string, cName: string, path: string, opts?: { diff?: { headPath?: string }; line?: number; col?: number; editing?: boolean }) {
  const i = editorTabs.value.findIndex((t) => t.containerId === cId && t.path === path)
  if (i >= 0) {
    // 同文件重复打开：刷新显示名/对比态/定位目标并激活（pane 内 watch 自行跟进）
    editorTabs.value[i] = { ...editorTabs.value[i], containerName: cName, diff: opts?.diff, line: opts?.line, col: opts?.col, editing: opts?.editing === true ? true : undefined }
    activeEditorIdx.value = i
  } else {
    editorTabs.value.push({ containerId: cId, containerName: cName, path, diff: opts?.diff, line: opts?.line, col: opts?.col, editing: opts?.editing === true ? true : undefined })
    activeEditorIdx.value = editorTabs.value.length - 1
  }
  mainView.value = 'file'
}
function onFileTabClick(i: number) {
  activeEditorIdx.value = i
  mainView.value = 'file'
}
// tab X：pane 冲刷后自己 close；这里不直接摘（冲刷失败/冲突要留在原处裁决）
function closeFileTab(t: EditorTab) {
  paneRefs.get(tabId(t))?.requestClose()
}
// Esc 关闭当前文件 tab（与 tab X 同链路：pane 先冲刷未落改动，冲突/失败时 tab
// 留在原处裁决，不丢数据）。焦点在 Monaco 正文里也生效（编辑完直接 Esc 保存关闭）：
// - Monaco 消费给自己的 Esc（关 find/建议框、内联补全隐藏、收选区/多光标——这些
//   keybinding 命中后都 preventDefault）让给它，defaultPrevented 即退；
// - Monaco 的 inputarea 是裸 textarea，其余 input（find widget 输入框等）/普通输入框/
//   contentEditable 的 Esc 第一职责在输入框自身，不抢；
// - Dialog/菜单/Select 弹层开着时 reka-ui 的 Esc 关弹层本身，不抢（弹层打开标记 =
//   其 content 的 data-state=open）；
// - 终端激活时 Esc 是普通键（vim/shell），整条不介入。
function onEscCloseFile(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.repeat) return
  if (mainView.value !== 'file' || !editorTabs.value.length) return
  const target = e.target
  if (target instanceof HTMLElement) {
    const inMonaco = !!target.closest('.monaco-editor')
    // Monaco 的输入 textarea 用 tagName 判（class 随版本变：inputarea / ime-text-area，
    // 实测本机 5.x 是 ime-text-area——class 判定曾让编辑器内 Esc 全部失效）；monaco 内
    // 唯一的 textarea 就是它，find widget 等输入框是 INPUT 标签，落下面的 else 分支。
    const isEditorBody = inMonaco && target.tagName === 'TEXTAREA'
    if (isEditorBody) {
      if (e.defaultPrevented) return
    } else if (target.isContentEditable || target.closest('input, textarea, select, .monaco-editor')) {
      return
    }
  }
  if (
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]',
    )
  )
    return
  e.preventDefault()
  const t = editorTabs.value[activeEditorIdx.value]
  if (t) closeFileTab(t)
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
  delete tabMode.value[tabId(t)]
  editorTabs.value.splice(i, 1)
  if (!editorTabs.value.length) mainView.value = 'terminal' // 最后一个文件 tab 关掉，主区还给终端
}
// tab 右键「编辑/预览」（状态感知项，pane 右下角按钮的第二入口）：先激活该 tab，
// 再按当前形态调 pane——渲染视图/只读进编辑，md/svg 源码态回预览。
function tabModeClick(t: EditorTab, i: number) {
  onFileTabClick(i)
  const p = paneRefs.get(tabId(t))
  const m = tabMode.value[tabId(t)]
  if (m?.editing && !m.preview) p?.showPreview?.()
  else p?.enterEdit?.()
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
// 卡片右键菜单「监听端口」二级菜单的行：web（实测返回 HTML）/ other（其余监听）/
// map（docker 宿主映射）三态合一，渲染与点击行为按 kind 分支——与 tab 栏网络下拉
// 同信息结构（原卡片端口浮层已收编进菜单）。
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
// 端口点击目标跟随控制台访问口径（web/src/lib/proxy.ts）：IP/localhost 打开控制台 →
// 直连容器 IP（代理上线前的原形式，宿主/tailscale 子网路由下可达）；经基域名打开 →
// 面板 Web 代理（server/proxy.ts，其他设备/其他网络也能访问，vhost 门面 subpath 兜底）。
// docker 宿主映射端口（历史形态，LXC 无）恒指宿主本机。
function portRowTarget(c: ContainerView, r: PortRow): string {
  return r.kind === 'map' ? `http://127.0.0.1:${r.port}` : serviceUrl('c', c.name, r.port, c.ip)
}
// 直连 IP:端口 打开（端口条目上的显式第二方式）：控制台经基域名打开时主点击走代理，
// 直连作为额外动作给出；IP/localhost 口径下主点击本就是直连，不重复给（directOpenExtra
// 为 false）。ip 未知（未运行/解析不出）同样无从直连。map 行（docker 宿主映射）本身
// 就是宿主直连形态，不参与。
const directOpenExtra = !originIpish()
function directPortUrl(c: ContainerView, port: number): string {
  return c.ip ? directUrl(c.ip, port) : ''
}
function portRowTitle(c: ContainerView, r: PortRow): string {
  const t = portRowTarget(c, r)
  if (r.kind === 'web') return `已验证返回网页，点击打开 ${t}`
  if (r.kind === 'map') return `宿主端口 ${r.port} → 容器 ${r.priv}，点击打开`
  return `容器内监听 ${r.port}（未返回 HTML），点击打开 ${t}`
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
// ->（文件则）开编辑器。首参放宽为最小结构形状：宿主组没有 ContainerView，只有
// {id: HOST_ID, name: '宿主'}；line/col 透传编辑器定位（同文件换行号靠 dialog 内 watch）。
async function locateContainerPath(
  c: { id: string; name: string; displayName?: string },
  path: string,
  kind: 'file' | 'dir',
  line?: number,
  col?: number,
) {
  // 有 group 聚焦、无则开一个（编辑器/面板都以终端组为锚）。组匹配按文件目标 id
  // （fileTargetId：服务组 = 's:'+名），让 Ctrl+点击/深链能锚到对应组。
  const gi = groups.value.findIndex((g) => fileTargetId(g) === c.id)
  if (gi >= 0) activeIdx.value = gi
  else if (c.id === HOST_ID) openHostTerm()
  else if (c.id.startsWith('s:')) {
    const sname = c.id.slice(2)
    const si = groups.value.findIndex((g) => g.kind === 'service' && g.containerId === sname)
    if (si >= 0) activeIdx.value = si
    else createGroup(sname, sname, 'service')
  } else openTerm(c)
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
  if (activeGroup.value) openFile(fileTargetId(activeGroup.value), activeGroup.value.name, p, o)
}

// 容器内 mysandbox 命令（web 终端 OSC 7677）：kind 未知 -> listFiles 探测（200=目录 /
// 400 not_a_directory 或 404 不存在=文件，编辑器侧对不存在的文件走新建态），
// 定位后聚焦来源 group、面板跟随来源 pane（termId -> DFS 序号）。
async function onOscOpen(group: TermGroup, termId: string, path: string) {
  if (group.kind) return // 宿主侧暂无 OSC 种子（container-cli 只种容器）；服务终端是 docker 容器，无文件联动
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
  // SSH 组没有路径解析端点（远端 fs 不经本机 API），Ctrl+点击不联动文件面板。
  if (group.kind === 'ssh') return
  const gi = groups.value.findIndex((g) => g.id === group.id)
  if (gi >= 0) activeIdx.value = gi
  filePaneIdx.value = Math.min(ordinalOf(group.root, termId), Math.max(leafCount(group.root) - 1, 0))
  // 路径解析：服务组走 /api/services/<name>/resolve（id 加 's:' 前缀）；host 组
  // containerId 即 HOST_ID 哨兵自动分流；容器组走 /api/containers/<id>/resolve。
  let r: ResolveView
  try {
    r = await resolveTermPath(
      group.kind === 'service' ? serviceFileId(group.containerId) : group.containerId,
      termId,
      raw,
    )
  } catch {
    return // 会话已收 / 容器已停等：静默（终端还在屏上，用户看得见状态）
  }
  const kind: 'file' | 'dir' = r.kind === 'dir' ? 'dir' : 'file'
  if (group.kind === 'host') {
    // 宿主组必在（点击来自组内活着的 Terminal），无 running 概念
    await locateContainerPath({ id: HOST_ID, name: '本机' }, r.path, kind, line, col)
    return
  }
  if (group.kind === 'service') {
    // 服务终端无「容器列表项」概念，直接以文件目标 id 定位（组锚定在 locateContainerPath 内）
    await locateContainerPath({ id: serviceFileId(group.containerId), name: group.name }, r.path, kind, line, col)
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
function createGroup(containerId: string, name: string, kind?: 'host' | 'service' | 'ssh', root?: LayoutNode): TermGroup {
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
  mainView.value = 'terminal' // 任何终端组动作（建组/恢复/接入）都意味着主区该归终端
  return g
}
// 组显示名：同容器多组并存时带稳定序号（dev·1 / dev·2 …），单一组就是原名。
// 序号是创建时定死的（seq），拖拽换位/关闭别的组都不会让「dev·2」换组。
function groupLabel(g: TermGroup): string {
  const peers = groups.value.filter((x) => x.containerId === g.containerId)
  if (peers.length <= 1) return g.name
  return `${g.name}·${g.seq ?? peers.indexOf(g) + 1}`
}
// 组动态标题：组内 pane 最近更新的非空标题（无 → ''）。多 pane 时「谁在动显示谁」
// （跑 CC 的 pane 会把标题推给整个 tab），静默组不覆盖。
// 注意主区 tab 标签**不用**它：tab 的职责是身份定位，容器名·序号恒定才认得出哪个 tab
// 是哪个容器（动态标题全是「claude "…"」「dev@dev:~」，多容器多 tab 时无归属可言）。
// 动态标题的正确展示位是 pane 头部（TermLayoutNode，逐 pane 可见）+ popout 窗口标题。
function groupDynamicLabel(g: TermGroup): string {
  let best = ''
  let at = 0
  for (const id of leafIds(g.root)) {
    const t = termTitles.value[id]
    if (t && t.at > at) {
      at = t.at
      best = t.text
    }
  }
  return best
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
// 点侧栏「本机」条目：开本机终端（PTY 由 server 管理，cwd=镜像目录）。全局唯一一个 group。
function openHostTerm() {
  if (isPhone.value) drawerOpen.value = false
  const i = groups.value.findIndex((g) => g.kind === 'host')
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(HOST_ID, '本机', 'host')
}

// 点 SSH 目标条目：开远程主机终端（PTY = script 包 ssh，会话在远端 tmux 专用 socket）。
// 同目标唯一 group；containerId 用 'ssh:'+名前缀（api.ts sshGroupId）隔离与容器名撞名。
function openSshTerm(t: SshTargetView) {
  if (isPhone.value) drawerOpen.value = false
  const id = sshGroupId(t.name)
  const i = groups.value.findIndex((g) => g.containerId === id)
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(id, t.name, 'ssh')
}

// 点服务卡片：进服务终端（docker exec，与容器「点击即进」同一交互语义）。
// 会话 = 宿主 tmux 上的 docker exec 窗口，跨 mysandbox 重启存活；想看详情走 ⋯ 详情。
function openServiceTerm(s: ServiceView) {
  if (isPhone.value) drawerOpen.value = false
  const i = groups.value.findIndex((g) => g.kind === 'service' && g.containerId === s.name)
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(s.name, s.displayName || s.name, 'service')
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
// popout 首屏种子：等首轮容器列表与 SSH 目标就绪再建组（名字要用 displayName）。
// 已有存档则跳过（刷新恢复语义）；目标容器不存在/已删则不种子，空态文案兜底、
// 修剪逻辑随后清档。popoutTarget 的 ssh 分支 = 'ssh:'+目标名（tab 右键菜单写入）。
watch(
  [() => itemsReady.value, sshTargets],
  ([ready]) => {
    if (!props.popout || !ready || groups.value.length) return
    if (props.popoutTarget === HOST_ID) {
      createGroup(HOST_ID, '本机', 'host')
      return
    }
    if (props.popoutTarget?.startsWith('ssh:')) {
      const t = sshTargets.value.find((x) => x.name === sshTargetName(props.popoutTarget!))
      if (t) createGroup(sshGroupId(t.name), t.name, 'ssh')
      return
    }
    const c = items.value.find((x) => x.id === props.popoutTarget)
    if (c) createGroup(c.id, c.displayName || c.name)
  },
  { immediate: true },
)
// popout 无 header，窗口标题是唯一身份标识：跟随当前组动态标题（popout 是单容器窗口，
// 动态标题不产生归属混淆——跑命令/CC 时浏览器 tab 实时变化），无动态标题回落组名。
const activeTitle = computed(() =>
  activeGroup.value ? groupDynamicLabel(activeGroup.value) || groupLabel(activeGroup.value) : '',
)
watch(
  () => activeTitle.value,
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
// SSH 目标管理对话框（侧栏终端区「添加 / 管理」入口）。
const showSshTargets = ref(false)
// 打开时剪掉容器已删的隐藏组：会话随容器消亡，留着只会恢复出连不上的空 tab。
watch(showSessions, (open) => {
  if (!open) return
  const valid = new Set(items.value.map((c) => c.id))
  const kept = hiddenGroups.value.filter((g) => {
    if (g.kind === 'host') return true
    if (g.kind === 'ssh') return sshTargets.value.some((t) => t.name === sshTargetName(g.containerId))
    if (g.kind === 'service') return svcItems.value.some((x) => x.name === g.containerId)
    return valid.has(g.containerId)
  })
  if (kept.length !== hiddenGroups.value.length) hiddenGroups.value = kept
})
// 本窗口已占用的会话 key（可见 + 隐藏的全部叶子）：对话框据此区分「已打开」/
// 「使用中」——不再从列表排除任何会话，扫到的全列（用户要的就是全集）。
// SSH 组的 cid 剥前缀：对话框侧的 termSessionKey 用后端真名（无前缀）。
const occupiedSet = computed(() => {
  const s = new Set<string>()
  for (const g of [...groups.value, ...hiddenGroups.value]) {
    const kind = g.kind === 'host' ? 'host' : g.kind === 'service' ? 'service' : g.kind === 'ssh' ? 'ssh' : 'container'
    const cid =
      g.kind === 'host' ? undefined : g.kind === 'ssh' ? sshTargetName(g.containerId) : g.containerId
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
  const svc = first.kind === 'service'
  const ssh = first.kind === 'ssh'
  const cid = host ? HOST_ID : ssh ? sshGroupId(first.containerId!) : first.containerId!
  const c = host || ssh ? undefined : items.value.find((x) => x.id === cid)
  const name = host
    ? '本机'
    : ssh
      ? first.containerId!
      : svc
        ? (svcItems.value.find((x) => x.name === cid)?.name ?? cid)
        : c
          ? c.displayName || c.name
          : cid
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
  createGroup(cid, name, host ? 'host' : svc ? 'service' : ssh ? 'ssh' : undefined, root)
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
  mainView.value = 'terminal' // 点终端 tab = 主区切回终端（同区切换）
}

// —— 卡片长按（触屏）= 右键 ——
// 与 tab 栏同一套合成机制（tabPointerDown 见上）：触屏没有 contextmenu 可依赖（iOS
// 完全没有），500ms 长按后合成 contextmenu，reka 的 ContextMenuTrigger 响应——桌面
// 右键与触屏长按汇成同一条路径。卡片右键菜单是全部管理动作的唯一入口（原 ⋯ 按钮
// 已退役），触屏可达性靠这里兜住。IP 复制键上不触发（closest('button')）；移动超
// 阈值（滑动列表）取消；合成后吞掉紧随的 click（长按松手不该顺手进终端）。
let cardLpTimer: ReturnType<typeof setTimeout> | null = null
let cardLpFired = false
let cardLpX = 0
let cardLpY = 0
function cardPointerDown(e: PointerEvent) {
  if (e.pointerType !== 'touch') return
  if ((e.target as HTMLElement).closest('button')) return
  cardPointerCancel()
  cardLpFired = false
  cardLpX = e.clientX
  cardLpY = e.clientY
  const el = e.currentTarget as HTMLElement
  cardLpTimer = setTimeout(() => {
    cardLpTimer = null
    cardLpFired = true
    el.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cardLpX, clientY: cardLpY }),
    )
  }, 500)
}
function cardPointerMove(e: PointerEvent) {
  if (cardLpTimer && Math.hypot(e.clientX - cardLpX, e.clientY - cardLpY) > 10) cardPointerCancel()
}
function cardPointerCancel() {
  if (cardLpTimer) {
    clearTimeout(cardLpTimer)
    cardLpTimer = null
  }
}
function cardClickSwallowed(): boolean {
  if (!cardLpFired) return false
  cardLpFired = false
  return true
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
    // 宿主/服务 group 不依赖容器存在，豁免（服务组的修剪在 refreshServices 里按服务表做）。
    if (groups.value.some((g) => !g.kind && !valid.has(g.containerId))) {
      groups.value = groups.value.filter((g) => g.kind || valid.has(g.containerId))
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

      // —— 侧栏 docker 服务分区（卡片 + 可收起）——
      // 服务与系统容器同一套卡片状态语言（色条身份色 + 明度即活性，无圆点），但作为
      // 低频配套收在底部环境区、可整体收起：分区头不带状态点（容器分区头同款），
      // 收起时的状态交给摘要文案（不可达红字、任务进行中有数）。展开/收起记
      // localStorage。管理动作以服务抽屉为主场——卡片右键（触屏长按）菜单收详情/
      // 复制连接/监听端口二级菜单/更新/启停重启这类就地快捷，与容器卡片同款交互。
      // 轮询自适应：闲时 5s（外部启停也能较快跟上），有任务进行中时 3s（任务进度/
      // 完成 toast 的及时性；任务 tail=0，payload 极小）。完成通知去重在
      // lib/serviceJobs.ts（服务面板打开时的独立轮询也喂它，天然只发一次）。
  const svcItems = ref<ServiceView[]>([])

// 抽屉里的操作（启停/删除/创建完成）经 App 计数回传：即时刷侧栏，不等下一拍轮询。
watch(
  () => props.svcVersion,
  () => {
    void refreshServices()
  },
)
  // 分区展开态：默认展开（首次见到的就是卡片形态），用户收起后随 localStorage 记忆。
  const svcExpanded = ref(
    (() => {
      try {
        return localStorage.getItem('mysandbox:svc-cards-open') !== '0'
      } catch {
        return true
      }
    })(),
  )
  watch(svcExpanded, (v) => {
    try {
      localStorage.setItem('mysandbox:svc-cards-open', v ? '1' : '0')
    } catch {
      /* localStorage 不可用就跳过 */
    }
  })
      // 卡片快捷操作（启停/重启）：与面板同 API；错误走 toast——侧栏错误条是容器列表的领地。
      const svcBusy = ref('')
      async function svcOp(name: string, fn: () => Promise<unknown>) {
        if (svcBusy.value) return
        svcBusy.value = name
        try {
          await fn()
          await refreshServices()
        } catch (e) {
          if (e instanceof Unauthorized) {
            emit('unauthorized')
            return
          }
          toast.error(e instanceof Error ? e.message : String(e))
        } finally {
          svcBusy.value = ''
        }
      }
      // 高频动作不进抽屉就地给：连接命令是服务的「第一用法」（容器内 psql -h pg 直连）。
      function copySvcConnect(s: ServiceView) {
        void copyTabText(s.connect[0] ?? '', '已复制连接命令')
      }
      // 删除（卡片右键菜单入口，确认框同服务抽屉语义）：留数据卷 = 仅删容器，同名
      // 重建可恢复；连数据 = 删卷，数据不可恢复，后端强制输名确认（ConfirmDialog
      // 的 confirmCue 解锁）。走 svcOp 复用 busy/刷新/错误处理。
      const pendingSvcDelete = ref<{ name: string; deleteData: boolean } | null>(null)
      async function doSvcDelete() {
        const p = pendingSvcDelete.value
        if (!p) return
        pendingSvcDelete.value = null
        await svcOp(p.name, () =>
          deleteService(p.name, { deleteData: p.deleteData, confirmName: p.deleteData ? p.name : undefined }),
        )
      }
      // 取消收编（收编容器没有删除项，右键菜单以此替代）：还原网络接入 + 清登记，
      // 容器本体不动。普通确认即可——不删任何东西，语义与删除的输名确认区分开。
      const pendingSvcUnadopt = ref('')
      async function doSvcUnadopt() {
        const name = pendingSvcUnadopt.value
        if (!name) return
        pendingSvcUnadopt.value = ''
        await svcOp(name, () => unadoptService(name))
      }
      // 收编入口（分区头 Import，与抽屉头部同款对话框）：外部 docker 容器纳入服务层。
      // ContainerList 自挂对话框（TermSessionsDialog 同模式）；成功 toast + 即时刷侧栏。
      const showSvcAdopt = ref(false)
      function onSvcAdopted(name: string) {
        toast.success(`已收编 ${name}，LXC 容器内按名字可达`)
        void refreshServices()
      }
      // 重命名 = 改显示名（meta.displayName）：侧栏卡片/终端 tab 用它，不动容器真名，
      // 随时可改。成功后同步已开服务终端组的名字快照（与容器 doRename 同语义）。
      const svcRenameTarget = ref<ServiceView | null>(null)
      async function doSvcRename(value: string | undefined) {
        const s = svcRenameTarget.value
        if (!s) return
        svcRenameTarget.value = null
        const displayName = value?.trim()
        if (!displayName) return
        await svcOp(s.name, async () => {
          await updateServiceMeta(s.name, { displayName })
          for (const g of groups.value) {
            if (g.kind === 'service' && g.containerId === s.name) g.name = displayName
          }
        })
      }
// null=未知（首拉前），false=docker 不可达
const svcReachable = ref<boolean | null>(null)
const svcJobsRunning = ref(0)
let svcTimer: ReturnType<typeof setInterval> | null = null
const SVC_IDLE_MS = 5000
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
    // running 集变化（启停/新建/更新完成）→ 立即补刷端口表，不等 15s 慢轮询
    const sig = v.items.filter((s) => s.running).map((s) => s.name).join(',')
    if (sig !== svcRunningSig) {
      svcRunningSig = sig
      void refreshSvcPorts()
    }
    // 服务已删的终端 group：会话随容器消亡，只从 UI 移除、不调 kill（容器侧同款语义）。
    // docker 不可达（false）时服务表是旧数据，不修组；首拉前（null）svcItems 不可信，同样跳过。
    if (
      svcReachable.value === true &&
      groups.value.some((g) => g.kind === 'service' && !svcItems.value.some((x) => x.name === g.containerId))
    ) {
      groups.value = groups.value.filter(
        (g) => g.kind !== 'service' || svcItems.value.some((x) => x.name === g.containerId),
      )
      if (activeIdx.value >= groups.value.length) activeIdx.value = Math.max(0, groups.value.length - 1)
    }
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
const svcSummary = computed(() => {
  if (svcReachable.value === false) return '运行时不可达'
  if (svcJobsRunning.value > 0) return `${svcJobsRunning.value} 个服务任务进行中…`
  const names = svcItems.value.map((s) => s.name)
  if (!names.length) return '暂无应用容器'
  const shown = names.slice(0, 3).join(' · ')
  return names.length > 3 ? `${shown} 等 ${names.length} 个` : shown
})

// —— 服务卡片右键菜单的「监听端口」——
// 应用容器监听端口走独立端点（宿主 /proc/<pid>/net 读容器网络命名空间，免 exec 的
// 镜像内依赖），15s 慢轮询覆盖全部 running 服务；refreshServices 发现 running 集
// 变化（启停/新建/更新完成）时立即补刷。web 端口（实测返回 HTML）标绿可点开，其余
// 平铺——postgres/redis 的 5432/6379 照展示：端口的意义是「看得见」，浏览器打不开无妨。
const svcPortsById = ref<Record<string, { ports: number[]; web: number[] }>>({})
let svcPortsTimer: ReturnType<typeof setInterval> | null = null
let svcPortsSeq = 0 // 竞态：慢轮询响应乱序时丢弃旧表
let svcRunningSig = '' // running 集签名：变化才触发即时补刷
async function refreshSvcPorts() {
  if (document.hidden) return
  const running = svcItems.value.filter((s) => s.running)
  if (!running.length) {
    svcPortsById.value = {}
    return
  }
  const seq = ++svcPortsSeq
  const rs = await Promise.allSettled(running.map((s) => getServiceListenPorts(s.name)))
  if (seq !== svcPortsSeq) return
  const next: Record<string, { ports: number[]; web: number[] }> = {}
  running.forEach((s, i) => {
    if (rs[i].status === 'fulfilled') next[s.name] = rs[i].value
  })
  svcPortsById.value = next
}
// 服务端口菜单行：只有 web / other 两态（服务不发布端口到宿主，无 map 行）。实测
// 监听优先（全预设通用）；扫描未回（刚启动等）回退手工登记的声明端口（custom 在
// state.json 手填 ports 的旧路径），声明端口没有 web 实测，一律按 other 展示。
type SvcPortRow = { kind: 'web' | 'other'; port: number }
function svcPortRows(s: ServiceView): SvcPortRow[] {
  const v = svcPortsById.value[s.name]
  if (!v || !v.ports.length) {
    return s.preset === 'custom' ? s.ports.map((p) => ({ kind: 'other' as const, port: p })) : []
  }
  const rows: SvcPortRow[] = v.web.map((p) => ({ kind: 'web' as const, port: p }))
  for (const p of v.ports) {
    if (!v.web.includes(p)) rows.push({ kind: 'other' as const, port: p })
  }
  return rows
}
function svcPortRowTarget(s: ServiceView, r: SvcPortRow): string {
  return serviceUrl('s', s.name, r.port, s.ip)
}
function svcPortRowTitle(s: ServiceView, r: SvcPortRow): string {
  const t = svcPortRowTarget(s, r)
  return r.kind === 'web' ? `已验证返回网页，点击打开 ${t}` : `容器内监听 ${r.port}（未返回 HTML），点击打开 ${t}`
}
// 直连 IP:端口（「直连打开」子菜单用）：仅域名口径下作为并列第二方式给出——IP 口径
// 主点击本就是直连，不重复给（directOpenExtra 为 false）；ip 未知同样无从直连。
function svcDirectPortUrl(s: ServiceView, port: number): string {
  return s.ip ? directUrl(s.ip, port) : ''
}

// —— 终端无输出提醒（agent 干完活/等输入）——
// 服务端（server/activity.ts）已在周期扫 tmux 输出，这里 5s 拉一次快照做提醒决策。
// 「在不在看」前端自判：可见 tab 是 v-show 常驻（WS 恒 attach），tmux 的 attached 完全
// 不代表用户在看——只有「当前激活 tab + 终端区」才算看。可见叶子的提醒资格 = 四道门槛
// 同时过（宁缺勿滥——误标比漏标烦人）：
//   - 在看：leftAt=WATCHING（正看着）永不命中；看过结果再走的人不被打扰（否则「看着
//     它跑完→切走」每次都误报）；
//   - 时刻：最后一次 prime 窗口后的输出发生在离开之后——prime 窗口（首帧后 3s，见
//     lib/terminalActivity）内的帧是打开动作自带的画面（attach 整屏重绘/新会话 prompt/
//     页面加载批量 attach），不算新内容；
//   - 活动段：agent 干活的形态特征是「连续输出持续一阵」——活动段跨度 ≥ SUSTAIN_MS
//     （1min，帧间隙 <3min 链同段）才算干过活；敲个 ls、dev server 吐两行日志这类
//     秒级输出不配打扰；
//   - 内容：当前视口画面 ≠ 离开时快照（markLeft 时 screenHash()）——重连还原、resize
//     重排这类「有帧但内容没变」的输出不配标。
// 「停了」要静默确认满 max(服务端阈值, QUIET_CONFIRM_MS=1min)——思考停顿 30s 不闪标。
// 命中不弹 toast（弹窗抢视线，已废），改 tab 身份点右上角常驻琥珀标：标在那儿等你
// 看，切回组即消——tmux bell 的专业形态。
// 隐藏组收不到流，用服务端 quiet + 反推的输出时刻对齐 leftAt（留扫描周期余量；无活动段
// 数据，门槛照旧）。开关 per 组（tab 右键「无输出时提醒」），随组进 localStorage。
const WATCHING = Number.POSITIVE_INFINITY
const leftAtByTerm = new Map<string, number>()
// 无输出提醒标（tab 身份点右上角琥珀点，tmux bell 形态）：groupId -> 最长安静时长
// （tooltip 用）。状态制——每拍轮询整体重算替换，不打断视线（原 toast 形态废弃：
// 弹窗抢焦点毁思绪，专业终端的 bell 就是「标在那儿等你看」）。
const quietAttention = ref<Map<string, number>>(new Map())
function attentionTitle(gId: string): string {
  const ms = quietAttention.value.get(gId) ?? 0
  return `已 ${Math.max(1, Math.round(ms / 1000))}s 无输出，可能已完成或在等你输入`
}
function markWatch(g: TermGroup) {
  for (const t of leafIds(g.root)) leftAtByTerm.set(t, WATCHING)
  // 消费提醒：标即时清（不等下一拍重算），旧活动段一并作废——否则链式跨度会让
  // 看过之后的小输出（敲个 ls）继承旧段凑满 sustain、误挂标。
  if (quietAttention.value.delete(g.id)) {
    for (const t of leafIds(g.root)) resetTermRun(t)
  }
}
function markLeft(g: TermGroup) {
  const now = Date.now()
  for (const t of leafIds(g.root)) {
    leftAtByTerm.set(t, now)
    // 离开时快照视口画面作内容基线；Terminal 没挂上（拿不到）就不设，内容门槛放行。
    snapTermBaseline(t, termRefs.get(t)?.screenHash?.())
  }
}
// 隐藏组里挂着提醒标的：tab 栏「所有终端」钮点琥珀点，对话框列表逐条描边。
const hiddenAttentionIds = computed(() => {
  const s = new Set<string>()
  for (const g of hiddenGroups.value) if (quietAttention.value.has(g.id)) s.add(g.id)
  return s
})
// 激活组 / 主区形态变化 = 「在看」关系变化。首跑（页面加载恢复的 tabs）统一落基线：
// 激活组在看，其余组从加载起就没看过（它们常驻挂载、此后有输出就能积资格）。
watch(
  () => [groups.value[activeIdx.value]?.id ?? '', mainView.value] as const,
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
  const kind =
    g.kind === 'host' ? 'host' : g.kind === 'service' ? 'service' : g.kind === 'ssh' ? 'ssh' : 'container'
  return termSessionKey(
    kind,
    g.kind === 'host' ? undefined : g.kind === 'ssh' ? sshTargetName(g.containerId) : g.containerId,
    t,
  )
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
  // 「停了」的确认窗：服务端阈值（15s）只是下限，实际 ≥1min 静默才算收尾（思考停顿不闪标）。
  const quietGate = Math.max(threshold * 1000, QUIET_CONFIRM_MS)
  // 状态制（非跳变制）：每拍整体重算「哪组该挂提醒标」。正看着的组 WATCHING 不命中；
  // 切回即 markWatch 清标，之后重新快照基线、内容没变就不再资格。
  const nextAttention = new Map<string, number>()
  for (const g of [...groups.value, ...hiddenGroups.value]) {
    if (g.quietNotify === false) continue
    const visible = groups.value.includes(g)
    let worstMs = 0
    for (const t of leafIds(g.root)) {
      const key = activityKeyOf(g, t)
      const leftAt = leftAtByTerm.get(t) ?? WATCHING
      let quiet = false
      let quietMs = 0
      if (visible) {
        const notable = lastTermNotableOutput(t)
        if (notable !== undefined && leftAt !== WATCHING) {
          quietMs = Date.now() - notable
          quiet =
            quietMs >= quietGate &&
            notable > leftAt &&
            termRunSpanMs(t) >= SUSTAIN_MS &&
            termContentChanged(t, termRefs.get(t)?.screenHash?.())
        }
      } else {
        const r = rowByKey.get(key)
        if (r?.state === 'quiet') {
          quietMs = r.quietSeconds * 1000
          // 服务端输出时刻反推（±一个扫描周期，留 6s 余量）：隐藏前就停了的不打扰
          quiet = Date.now() - quietMs > leftAt + 6000
        }
      }
      if (quiet) worstMs = Math.max(worstMs, quietMs)
    }
    if (worstMs > 0) nextAttention.set(g.id, worstMs)
  }
  quietAttention.value = nextAttention
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
  void refreshSshTargets()
  timer = setInterval(() => refresh(true), 5000)
  // 无输出提醒：popout 独立窗口也有自己的终端组，同样参与轮询。
  void refreshActivity()
  actTimer = setInterval(() => void refreshActivity(), ACTIVITY_MS)
  document.addEventListener('keydown', onEscCloseFile) // Esc 关闭当前文件 tab（见函数注释）
  if (!props.popout) {
    void refreshServices()
    armSvcTimer()
    void refreshAllPorts() // 首刷不等 15s：首屏卡片就有端口图标
    portsTimer = setInterval(() => void refreshAllPorts(), 15_000)
    void refreshSvcPorts()
    svcPortsTimer = setInterval(() => void refreshSvcPorts(), 15_000)
    document.addEventListener('visibilitychange', onVisChange)
  }
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (svcTimer) clearInterval(svcTimer)
  if (portsTimer) clearInterval(portsTimer)
  if (svcPortsTimer) clearInterval(svcPortsTimer)
  if (actTimer) clearInterval(actTimer)
  document.removeEventListener('keydown', onEscCloseFile)
  document.removeEventListener('visibilitychange', onVisChange)
  clearHoverTimer()
  disarmHoverPending(false)
})
</script>

<template>
  <div class="relative flex h-full min-h-0 gap-0">
    <!-- 左侧窄栏的信息架构：一个主体 + 底部环境区。
         「系统容器」是主列表（弱化小标签作分组头）；docker 服务是与容器同形态的卡片组，
         但作为低频配套收在底部环境区、可整体收起（分区头即摘要，状态点常显）。
         终端区（本机 + SSH 主机）钉在环境区底部——远程主机只是终端延伸，非被管理对象。
         模板/全局 hosts 等容器作用域的低频配置收进
         容器标题的 ⋯ 菜单。popout 独立窗口不渲染。
         手机（<768px）：侧栏转 overlay 抽屉（max-md:absolute + 遮罩），默认收起，
         汉堡入口在 tab 栏最左；桌面（≥768）恒为静态侧栏，抽屉相关类全部不命中。 -->
    <div
      v-if="!props.popout && drawerOpen"
      class="fixed inset-0 z-30 bg-black/50 md:hidden"
      @click="drawerOpen = false"
    />
    <aside
      v-if="!props.popout"
      ref="asideRef"
      class="flex w-56 shrink-0 flex-col border-r border-border bg-background max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[85vw] max-md:max-w-80 max-md:shadow-xl max-md:transition-transform md:overflow-hidden md:transition-[width] md:duration-200"
      :class="[drawerOpen ? '' : 'max-md:-translate-x-full', railMode ? 'md:w-12' : 'md:w-64 md:[&>*]:w-64']"
      @mouseenter="asideMouseEnter"
      @mouseleave="asideMouseLeave"
    >
      <!-- 收起态（窄边 rail，仅桌面；手机抽屉忽略 collapsed）：只留导航骨架——
            logo（点击展开，收缩后品牌仍在） / ＋ 新建 / 容器首字图标列（容器色淡染，
            title 带全名·状态·IP，右键 = 展开态卡片同款菜单）/ 底部环境区（配置菜单 ·
            宿主 · 服务 · 展开键）。列表异常给一枚提示点，点击展开并重试。
            悬停 rail 停留片刻自动临时展开（hoverExpand），划走即收回。 -->
      <template v-if="railMode">
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
          <ContextMenu v-for="c in items" :key="c.id">
            <ContextMenuTrigger as-child>
              <button
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
            </ContextMenuTrigger>
            <!-- 右键菜单与展开态卡片完全同款（改动请两处同步）：收起后没有卡片可右键，
                 这里的菜单是管理动作唯一入口。rail 仅桌面渲染，无需长按合成。 -->
            <ContextMenuContent>
              <template v-if="!c.managed && !c.adopted">
                <ContextMenuItem @click="onAdopt(c)">纳入管理</ContextMenuItem>
              </template>
              <template v-else>
                <ContextMenuItem v-if="c.state === 'running'" @click="onPower(c, 'stop')">停止</ContextMenuItem>
                <ContextMenuItem v-else @click="act(c.id, () => startContainer(c.id))">启动</ContextMenuItem>
                <ContextMenuItem
                  v-if="c.state === 'running'"
                  @click="desktopTarget = { containerId: c.id, containerName: c.displayName || c.name }"
                  >桌面</ContextMenuItem
                >
                <ContextMenuItem @click="onPower(c, 'restart')">重启</ContextMenuItem>
                <ContextMenuItem @click="onRename(c)">重命名</ContextMenuItem>
                <ContextMenuItem
                  title="本容器的专属网关配置（覆盖全局；清除后恢复跟随全局）"
                  @click="openAiOverride(c.name)"
                >
                  <Bot /> AI 配置…
                </ContextMenuItem>
                <ContextMenuItem v-if="hasBaseAction('export')" @click="exportTarget = c">导出为包</ContextMenuItem>
                <ContextMenuItem v-if="c.managed" class="text-destructive" @click="onDelete(c)">删除</ContextMenuItem>
              </template>
              <!-- 监听端口（三级菜单）：与展开态卡片同构——端口列表 → 每个端口的
                   打开方式（域名口径：代理打开 / IP 直连；IP 口径单层直点）。 -->
              <template v-if="c.state === 'running' && cardPortRows(c.id).length">
                <ContextMenuSeparator />
                <ContextMenuSub>
                  <ContextMenuSubTrigger>监听端口</ContextMenuSubTrigger>
                  <ContextMenuSubContent class="w-40">
                    <template v-for="r in cardPortRows(c.id)" :key="r.kind + r.port">
                      <ContextMenuItem
                        v-if="r.kind === 'map'"
                        :title="portRowTitle(c, r)"
                        @click="openUrl(`http://127.0.0.1:${r.port}`)"
                      >
                        <ArrowRightLeft class="size-3 shrink-0" />
                        <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }} → {{ r.priv }}</span>
                        <span class="shrink-0 text-[10px] text-muted-foreground">宿主</span>
                      </ContextMenuItem>
                      <ContextMenuSub v-else-if="directOpenExtra">
                        <ContextMenuSubTrigger>
                          <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                          <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }}</span>
                          <span v-if="r.kind === 'web'" class="shrink-0 text-[10px] text-emerald-500">网页</span>
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent class="w-36">
                          <ContextMenuItem
                            :title="`代理打开 ${serviceUrl('c', c.name, r.port, c.ip)}`"
                            @click="openUrl(serviceUrl('c', c.name, r.port, c.ip))"
                            >代理打开</ContextMenuItem
                          >
                          <ContextMenuItem
                            v-if="directPortUrl(c, r.port)"
                            :title="`IP 直连 ${directPortUrl(c, r.port)}`"
                            @click="openUrl(directPortUrl(c, r.port))"
                            >IP 直连</ContextMenuItem
                          >
                        </ContextMenuSubContent>
                      </ContextMenuSub>
                      <ContextMenuItem v-else :title="portRowTitle(c, r)" @click="openUrl(portRowTarget(c, r))">
                        <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                        <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }}</span>
                        <span v-if="r.kind === 'web'" class="shrink-0 text-[10px] text-emerald-500">网页</span>
                      </ContextMenuItem>
                    </template>
                  </ContextMenuSubContent>
                </ContextMenuSub>
              </template>
            </ContextMenuContent>
          </ContextMenu>
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
            title="本机终端"
            @click="openHostTerm()"
          >
            <Monitor class="size-4 text-amber-500" />
          </button>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg hover:bg-accent/50"
            :title="`应用容器（${svcSummary}）——点击管理`"
            @click="emit('open-services')"
          >
            <img src="/docker.svg" alt="" class="size-4" />
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
           上下叠着会互相竞争。分区头整行点击收/展（与应用容器/终端区同一交互语言），
           收起时头内带摘要。⟳ 刷新 / ＋ 新建（基座未就绪时禁用）/ ⋯ 低频配置 -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border py-1.5 pl-3 pr-1.5">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          :title="ctExpanded ? '收起容器列表' : '展开容器列表'"
          @click="ctExpanded = !ctExpanded"
        >
          <img src="/lxc.svg" alt="" class="size-3.5" /><span class="text-xs font-medium text-muted-foreground">系统容器</span>
          <span class="text-[10px] text-muted-foreground/70">{{ items.length }}</span>
          <span v-if="!ctExpanded" class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">{{ ctSummary }}</span>
          <ChevronDown
            class="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform"
            :class="ctExpanded ? 'rotate-180' : ''"
          />
        </button>
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
           低频操作仍收 ⋯。色条与 tab 栏同色呼应。卡片可拖拽排序（桌面，localStorage 记忆），
           FLIP 补间让被 cross 让位的卡实时滑移（flipCapture/flipPlay）。 -->
      <div v-if="ctExpanded" data-flip="ct" class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        <!-- 首屏加载骨架：只在列表还没数据时占位（轮询静默刷新不打这里） -->
        <template v-if="loading && !items.length">
          <Skeleton v-for="i in 3" :key="i" class="h-12 w-full rounded-lg" />
        </template>
        <ContextMenu v-for="c in orderedItems" :key="c.id">
          <ContextMenuTrigger as-child>
            <div
              class="group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 pl-3.5 transition-colors active:bg-accent"
              :class="[
                activeGroup?.containerId === c.id
                  ? 'border-border/60 bg-accent'
                  : 'border-transparent hover:bg-accent/40',
                dragCardKey === c.id ? 'opacity-40' : '',
              ]"
              :draggable="!isPhone"
              :data-card-key="c.id"
              @pointerdown="cardPointerDown"
              @pointermove="cardPointerMove"
              @pointercancel="cardPointerCancel"
              @pointerup="cardPointerCancel"
              @dragstart="cardDragStart($event, 'ct', c.id)"
              @dragover="cardDragOver($event, 'ct', c.id)"
              @dragend="cardDragEnd('ct')"
              @click="cardClickSwallowed() || openTerm(c)"
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
              <div class="flex min-w-0 items-center gap-1.5" :class="c.state !== 'running' ? 'opacity-60' : ''">
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
              </div>
            </div>
          </ContextMenuTrigger>
          <!-- 右键菜单（触屏长按同款）：低频操作收进来（外部的容器只有「纳入管理」），
               running 时末尾追加「代理地址」二级菜单。原 ⋯ 按钮退役——卡片右下角不再
               常驻控件，端口也不再有 hover 浮层，全部收编进这份菜单。 -->
          <ContextMenuContent>
            <template v-if="!c.managed && !c.adopted">
              <ContextMenuItem @click="onAdopt(c)">纳入管理</ContextMenuItem>
            </template>
            <template v-else>
              <ContextMenuItem v-if="c.state === 'running'" @click="onPower(c, 'stop')">停止</ContextMenuItem>
              <ContextMenuItem v-else @click="act(c.id, () => startContainer(c.id))">启动</ContextMenuItem>
              <ContextMenuItem
                v-if="c.state === 'running'"
                @click="desktopTarget = { containerId: c.id, containerName: c.displayName || c.name }"
                >桌面</ContextMenuItem
              >
              <ContextMenuItem @click="onPower(c, 'restart')">重启</ContextMenuItem>
              <ContextMenuItem @click="onRename(c)">重命名</ContextMenuItem>
              <ContextMenuItem
                title="本容器的专属网关配置（覆盖全局；清除后恢复跟随全局）"
                @click="openAiOverride(c.name)"
              >
                <Bot /> AI 配置…
              </ContextMenuItem>
              <ContextMenuItem v-if="hasBaseAction('export')" @click="exportTarget = c">导出为包</ContextMenuItem>
              <ContextMenuItem v-if="c.managed" class="text-destructive" @click="onDelete(c)">删除</ContextMenuItem>
            </template>
            <!-- 监听端口（三级菜单）：右键菜单 → 端口列表 → 每个端口的打开方式。
                 域名口径下每个端口再展开一级（代理打开 / IP 直连）；IP 口径没有代理
                 一路，端口本身就是直连、保持单层直点。web（实测返回 HTML）标绿；
                 docker 宿主映射（历史形态）本身即宿主直连，维持单项。 -->
            <template v-if="c.state === 'running' && cardPortRows(c.id).length">
              <ContextMenuSeparator />
              <ContextMenuSub>
                <ContextMenuSubTrigger>监听端口</ContextMenuSubTrigger>
                <ContextMenuSubContent class="w-40">
                  <template v-for="r in cardPortRows(c.id)" :key="r.kind + r.port">
                    <ContextMenuItem
                      v-if="r.kind === 'map'"
                      :title="portRowTitle(c, r)"
                      @click="openUrl(`http://127.0.0.1:${r.port}`)"
                    >
                      <ArrowRightLeft class="size-3 shrink-0" />
                      <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }} → {{ r.priv }}</span>
                      <span class="shrink-0 text-[10px] text-muted-foreground">宿主</span>
                    </ContextMenuItem>
                    <ContextMenuSub v-else-if="directOpenExtra">
                      <ContextMenuSubTrigger>
                        <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                        <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }}</span>
                        <span v-if="r.kind === 'web'" class="shrink-0 text-[10px] text-emerald-500">网页</span>
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent class="w-36">
                        <ContextMenuItem
                          :title="`代理打开 ${serviceUrl('c', c.name, r.port, c.ip)}`"
                          @click="openUrl(serviceUrl('c', c.name, r.port, c.ip))"
                          >代理打开</ContextMenuItem
                        >
                        <ContextMenuItem
                          v-if="directPortUrl(c, r.port)"
                          :title="`IP 直连 ${directPortUrl(c, r.port)}`"
                          @click="openUrl(directPortUrl(c, r.port))"
                          >IP 直连</ContextMenuItem
                        >
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                    <ContextMenuItem v-else :title="portRowTitle(c, r)" @click="openUrl(portRowTarget(c, r))">
                      <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                      <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }}</span>
                      <span v-if="r.kind === 'web'" class="shrink-0 text-[10px] text-emerald-500">网页</span>
                    </ContextMenuItem>
                  </template>
                </ContextMenuSubContent>
              </ContextMenuSub>
            </template>
          </ContextMenuContent>
        </ContextMenu>
        <!-- 空态：轻引导，与标题行的 ＋/⋯ 呼应 -->
        <div
          v-if="!items.length && !loading"
          class="flex flex-col items-center gap-1.5 px-3 py-8 text-center"
        >
          <Container class="size-5 text-muted-foreground/40" />
          <p class="text-xs text-muted-foreground">暂无容器</p>
          <p class="text-[11px] text-muted-foreground/60">点上方 ＋ 新建，右键卡片可纳入已有容器</p>
        </div>
      </div>

      <!-- docker 服务分区：与系统容器同形态、同一套状态语言的卡片组（色条=按服务名
           hash 的身份色，非 running=灰条+整卡降亮度），收在环境区、可整体收起（低频
           配套，默认展开但记忆用户选择）。分区头 = 弱化标签 + 计数（容器分区头同款，
           无状态点），整行点击展开/收起；收起时补一行摘要文案（任务进行中/不可达时
           要紧，不可达红字）。点击卡片进服务终端（与容器「点击即进」同语义），IP 点击
             复制，右键菜单收详情（服务抽屉）/连接命令/代理地址二级菜单/启停重启。
            列表高度可拖拽（顶部细把手，maxHeight 上限记忆 localStorage），卡片可拖拽排序。 -->
      <div class="shrink-0 border-t border-border">
        <div
          v-if="svcExpanded"
          class="h-1 cursor-row-resize transition-colors hover:bg-primary/30"
          title="拖拽调整列表高度"
          @pointerdown="secDragStart($event, 'svc')"
          @pointermove="secDragMove"
          @pointerup="secDragEnd"
          @pointercancel="secDragEnd"
        />
        <div class="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            :title="svcExpanded ? '收起服务列表' : '展开服务列表'"
            @click="svcExpanded = !svcExpanded"
          >
            <img src="/docker.svg" alt="" class="size-3.5 shrink-0" />
            <span class="text-xs font-medium text-muted-foreground">应用容器</span>
            <span class="text-[10px] text-muted-foreground/70">{{ svcItems.length }}</span>
            <span
              v-if="!svcExpanded"
              class="min-w-0 flex-1 truncate text-[11px]"
              :class="svcReachable === false ? 'text-destructive' : 'text-muted-foreground/70'"
              >{{ svcSummary }}</span
            >
            <ChevronDown
              class="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform"
              :class="svcExpanded ? 'rotate-180' : ''"
            />
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="收编外部容器（接入现有 docker 服务）"
            @click="showSvcAdopt = true"
          >
            <Plus />
          </Button>
        </div>
        <div
          v-if="svcExpanded"
          data-flip="svc"
          class="flex flex-col gap-0.5 overflow-y-auto scroll-thin px-2 pb-2"
          :style="{ maxHeight: sectionHeights.svc + 'px' }"
        >
          <p v-if="svcReachable === false" class="px-1.5 py-2 text-[11px] text-muted-foreground">
            运行时不可达
          </p>
          <template v-else>
            <ContextMenu v-for="s in orderedSvc" :key="s.name">
              <ContextMenuTrigger as-child>
                <div
                  class="group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border border-transparent px-2.5 py-2 pl-3.5 transition-colors hover:bg-accent/40 active:bg-accent"
                  :class="dragCardKey === s.name ? 'opacity-40' : ''"
                  :draggable="!isPhone"
                  :data-card-key="s.name"
                  @pointerdown="cardPointerDown"
                  @pointermove="cardPointerMove"
                  @pointercancel="cardPointerCancel"
                  @pointerup="cardPointerCancel"
                  @dragstart="cardDragStart($event, 'svc', s.name)"
                  @dragover="cardDragOver($event, 'svc', s.name)"
                  @dragend="cardDragEnd('svc')"
                  @click="cardClickSwallowed() || openServiceTerm(s)"
                >
                  <!-- 左缘色条：与容器卡片同一套状态语言——运行=按服务名 hash 的稳定身份色
                       （containerColor 同一机制，hover 恢复饱和），非 running=灰条；
                       非 running 卡片整体降亮度。明度即活性，精确状态悬停色条看。 -->
                  <span
                    class="absolute inset-y-2.5 left-0 w-[3px] rounded-full transition-all"
                    :class="s.running ? 'opacity-40 group-hover:opacity-90' : 'bg-muted-foreground/30'"
                    :style="s.running ? { backgroundColor: containerColor(s.name) } : undefined"
                    :title="stateLabel(s.state)"
                  />
                  <!-- 第一行：显示名优先（真名进 title/兜底）。非 running 整行降亮度。 -->
                  <div class="flex min-w-0 items-center gap-1.5" :class="s.running ? '' : 'opacity-60'">
                    <span class="min-w-0 truncate text-[13px] font-medium leading-snug text-foreground" :title="s.name">{{
                      s.displayName || s.name
                    }}</span>
                    <span
                      v-if="s.metaMissing"
                      class="shrink-0 text-amber-600"
                      title="sidecar 元数据缺失（state.json 被清过？），重建可恢复"
                      >⚠</span
                    >
                  </div>
                  <!-- 第二行：IP（点击复制，成功回显绿色）+ 描述/镜像。 -->
                  <div class="flex items-center gap-2 text-[11px] leading-snug text-muted-foreground" :class="s.running ? '' : 'opacity-50'">
                    <button
                      v-if="s.ip"
                      type="button"
                      class="shrink-0 font-mono tabular-nums transition-colors hover:text-foreground"
                      :class="copiedIp === s.ip ? 'text-emerald-500' : ''"
                      :title="copiedIp === s.ip ? '已复制' : '点击复制 IP'"
                      @click.stop="copyIpOf(s.ip)"
                      >{{ s.ip }}</button
                    >
                    <span v-else class="shrink-0 opacity-50">无 IP</span>
                    <span class="min-w-0 flex-1 truncate" :title="s.description || s.image">{{
                      s.description || s.image
                    }}</span>
                    <!-- 收编的外部容器：身份标记常驻（操作边界不同——无删除/更新，只有取消收编） -->
                    <Badge
                      v-if="s.adopted"
                      variant="outline"
                      class="shrink-0 border-transparent bg-muted text-[10px] text-muted-foreground"
                      title="收编的外部容器：原编排方仍管它的生命周期，这里只提供终端/文件/网络可达"
                      >收编</Badge
                    >
                  </div>
                </div>
              </ContextMenuTrigger>
              <!-- 右键菜单（触屏长按同款，与容器卡片同款交互）：详情 / 复制连接命令 /
                   代理地址二级菜单 / 启停重启。原 ⋯ 按钮退役。改配置/追新镜像在服务
                   抽屉「配置」页（compose 底账编辑 + 应用）。 -->
              <ContextMenuContent>
                <ContextMenuItem @click="emit('open-services', false, s.name)">详情</ContextMenuItem>
                <ContextMenuItem @click="svcRenameTarget = s">重命名</ContextMenuItem>
                <ContextMenuItem v-if="s.connect.length" @click="copySvcConnect(s)">复制连接命令</ContextMenuItem>
                <!-- 监听端口（三级菜单）：与容器卡片同构——端口列表 → 每个端口的打开
                     方式（域名口径：代理打开 / IP 直连；IP 口径单层直点）。实测监听扫描
                     （15s 慢轮询 + running 集变化即时补刷），扫描未回回退 custom 手工
                     登记端口。 -->
                <template v-if="s.running && svcPortRows(s).length">
                  <ContextMenuSeparator />
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>监听端口</ContextMenuSubTrigger>
                    <ContextMenuSubContent class="w-40">
                      <template v-for="r in svcPortRows(s)" :key="r.kind + r.port">
                        <ContextMenuSub v-if="directOpenExtra">
                          <ContextMenuSubTrigger>
                            <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                            <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }}</span>
                            <span v-if="r.kind === 'web'" class="shrink-0 text-[10px] text-emerald-500">网页</span>
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent class="w-36">
                            <ContextMenuItem
                              :title="`代理打开 ${serviceUrl('s', s.name, r.port, s.ip)}`"
                              @click="openUrl(serviceUrl('s', s.name, r.port, s.ip))"
                              >代理打开</ContextMenuItem
                            >
                            <ContextMenuItem
                              v-if="svcDirectPortUrl(s, r.port)"
                              :title="`IP 直连 ${svcDirectPortUrl(s, r.port)}`"
                              @click="openUrl(svcDirectPortUrl(s, r.port))"
                              >IP 直连</ContextMenuItem
                            >
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuItem v-else :title="svcPortRowTitle(s, r)" @click="openUrl(svcPortRowTarget(s, r))">
                          <Globe v-if="r.kind === 'web'" class="size-3 shrink-0 text-emerald-500" />
                          <span class="min-w-0 flex-1 font-mono tabular-nums">{{ r.port }}</span>
                          <span v-if="r.kind === 'web'" class="shrink-0 text-[10px] text-emerald-500">网页</span>
                        </ContextMenuItem>
                      </template>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                </template>
                <ContextMenuSeparator />
                <ContextMenuItem v-if="!s.running" @click="svcOp(s.name, () => startService(s.name))">启动</ContextMenuItem>
                <ContextMenuItem v-if="s.running" @click="svcOp(s.name, () => stopService(s.name))">停止</ContextMenuItem>
                <ContextMenuItem @click="svcOp(s.name, () => restartService(s.name))">重启</ContextMenuItem>
                <!-- 删除：留数据卷 / 连数据双入口，文案与确认语义同服务抽屉操作行；
                     收编容器不可删，给「取消收编」（还原网络 + 清登记，本体不动）。 -->
                <ContextMenuSeparator />
                <template v-if="s.adopted">
                  <ContextMenuItem class="text-destructive" @click="pendingSvcUnadopt = s.name">取消收编</ContextMenuItem>
                </template>
                <template v-else>
                  <ContextMenuItem @click="pendingSvcDelete = { name: s.name, deleteData: false }">删除（留数据卷）</ContextMenuItem>
                  <ContextMenuItem class="text-destructive" @click="pendingSvcDelete = { name: s.name, deleteData: true }"
                    >删除（连数据）</ContextMenuItem
                  >
                </template>
              </ContextMenuContent>
            </ContextMenu>
            <p v-if="!svcItems.length" class="px-1.5 py-2 text-[11px] text-muted-foreground">
              暂无应用容器，点 ＋ 新建
            </p>
          </template>
        </div>
      </div>

      <!-- 终端区：本机 + SSH 主机（远程主机只是终端延伸，非被管理对象——无文件面板/
           网络信息/批量操作，会话语义与宿主终端同构，见 server/sshTerminal.ts）。
           与系统容器/应用容器同款卡片语言：分区头整行收展（记忆 localStorage）、
           左缘色条卡片（本机=amber 恒亮，SSH=按名 hash 身份色，无运行态概念故恒饱和）、
           列表高度可拖拽、卡片可拖拽排序。＋ = 添加 SSH 主机 / 管理已有目标。
           独立窗口入口收进 tab 右键菜单。 -->
      <div class="shrink-0 border-t border-border">
        <div
          v-if="termExpanded"
          class="h-1 cursor-row-resize transition-colors hover:bg-primary/30"
          title="拖拽调整列表高度"
          @pointerdown="secDragStart($event, 'term')"
          @pointermove="secDragMove"
          @pointerup="secDragEnd"
          @pointercancel="secDragEnd"
        />
        <div class="flex items-center gap-2 py-1.5 pl-3 pr-1.5">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            :title="termExpanded ? '收起终端列表' : '展开终端列表'"
            @click="termExpanded = !termExpanded"
          >
            <Monitor class="size-3.5 shrink-0 text-amber-500" />
            <span class="text-xs font-medium text-muted-foreground">终端</span>
            <span class="text-[10px] text-muted-foreground/70">{{ 1 + sshTargets.length }}</span>
            <span v-if="!termExpanded" class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
              {{ sshTargets.length ? `${sshTargets.length} 台主机` : '添加 SSH 主机' }}
            </span>
            <ChevronDown
              class="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform"
              :class="termExpanded ? 'rotate-180' : ''"
            />
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="添加 SSH 主机 / 管理已有目标"
            @click="showSshTargets = true"
          >
            <Plus />
          </Button>
        </div>
        <div
          v-if="termExpanded"
          data-flip="ssh"
          class="flex flex-col gap-0.5 overflow-y-auto scroll-thin px-2 pb-2"
          :style="{ maxHeight: sectionHeights.term + 'px' }"
        >
          <!-- 本机卡片：宿主终端恒可用——色条 amber 恒饱和（与 tab 身份点同色） -->
          <div
            class="group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 pl-3.5 transition-colors active:bg-accent"
            :class="
              activeGroup?.kind === 'host'
                ? 'border-border/60 bg-accent'
                : 'border-transparent hover:bg-accent/40'
            "
            @click="openHostTerm()"
          >
            <span
              class="absolute inset-y-2.5 left-0 w-[3px] rounded-full bg-amber-500"
              title="本机终端"
            />
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="min-w-0 truncate text-[13px] font-medium leading-snug text-foreground">本机</span>
            </div>
            <div class="flex items-center gap-2 text-[11px] leading-snug text-muted-foreground">
              <span class="min-w-0 flex-1 truncate">宿主 shell · tmux 会话保留</span>
            </div>
          </div>
          <!-- SSH 主机卡片：无运行态概念（连接失败在终端里可见），色条恒用身份色 -->
          <div
            v-for="t in orderedSsh"
            :key="t.name"
            class="group relative flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 pl-3.5 transition-colors active:bg-accent"
            :class="[
              activeGroup?.containerId === sshGroupId(t.name)
                ? 'border-border/60 bg-accent'
                : 'border-transparent hover:bg-accent/40',
              dragCardKey === t.name ? 'opacity-40' : '',
            ]"
            :draggable="!isPhone"
            :data-card-key="t.name"
            :title="`SSH 终端：${t.user ? t.user + '@' : ''}${t.host}${t.port ? ':' + t.port : ''}`"
            @dragstart="cardDragStart($event, 'ssh', t.name)"
            @dragover="cardDragOver($event, 'ssh', t.name)"
            @dragend="cardDragEnd('ssh')"
            @click="openSshTerm(t)"
          >
            <span
              class="absolute inset-y-2.5 left-0 w-[3px] rounded-full"
              :style="{ backgroundColor: containerColor(t.name) }"
              :title="t.name"
            />
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="min-w-0 truncate text-[13px] font-medium leading-snug text-foreground">{{ t.name }}</span>
            </div>
            <div class="flex items-center gap-2 text-[11px] leading-snug text-muted-foreground">
              <span class="min-w-0 flex-1 truncate font-mono">{{
                `${t.user ? t.user + '@' : ''}${t.host}${t.port ? ':' + t.port : ''}`
              }}</span>
            </div>
          </div>
          <p v-if="!sshTargets.length" class="px-1.5 py-2 text-[11px] text-muted-foreground">
            暂无 SSH 主机，点 ＋ 添加
          </p>
        </div>
      </div>

      <!-- 侧栏收起行：环境区最底（docker 服务分区之下）——收/展动作统一钉在这个位置，
           与收缩态 rail 底部的展开键互为镜像。 -->
      <button
        type="button"
        class="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        title="收起侧栏（窄边）"
        @click="collapseSidebar"
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
            次位「AI 工具」：环境级全局面板常驻入口（不挂任何分区）；
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
          class="relative flex shrink-0 items-center self-stretch border-r border-border/60 px-3 text-xs max-md:px-4 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title="所有终端（本机全部活跃会话，含其他窗口 / 浏览器打开的）"
          @click="showSessions = true"
        >
          <TerminalIcon class="size-3.5 max-md:size-5" />
          <!-- 隐藏组挂着无输出提醒标：钮上点琥珀点，进对话框看是哪组。 -->
          <span
            v-if="hiddenAttentionIds.size"
            class="absolute right-1 top-1 inline-flex h-1.5 w-1.5 rounded-full bg-amber-400 ring-1 ring-background"
          />
        </button>
        <!-- AI 工具入口：环境级全局面板（技能中心/模型服务/智能体配置），与「所有终端」
             同为常驻全局钮——不挂任何分区（从容器分区头挪出，全局功能不借容器菜单位）。 -->
        <button
          class="flex shrink-0 items-center self-stretch border-r border-border/60 px-3 text-xs max-md:px-4 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title="AI 工具（技能中心 · 模型服务 · 智能体配置）"
          @click="openAi()"
        >
          <Bot class="size-3.5 max-md:size-5" />
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
                idx === activeIdx && mainView === 'terminal'
                  ? 'bg-card text-foreground shadow-[inset_0_-2px_0_0_var(--primary)] font-medium'
                  : 'text-muted-foreground hover:bg-accent/50',
                dragTabIdx === idx ? 'opacity-40' : '',
              ]"
              :title="groups.length > 1 ? '拖动排序 · 点击切换 · 右键更多' : '右键：新开一组 / 独立窗口 / 隐藏 / 关闭'"
            >
              <!-- 身份点：组内有叶子在输出（agent 干活中）时叠呼吸光晕（缩放+辉光，
                  keyframes 见 index.css 的 term-busy-*），停手 ~4s 即熄——运行状态的即时
                  视觉信号。光晕吃 prime 窗口后的有效输出：attach 重绘/初始 prompt 不点亮。 -->
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
                <!-- 无输出提醒标：常驻琥珀点（tmux bell 形态，不打断视线），切回组即消。 -->
                <span
                  v-if="quietAttention.has(g.id)"
                  class="absolute -right-1.5 -top-1.5 inline-flex h-1.5 w-1.5 rounded-full bg-amber-400 ring-1 ring-background"
                  :title="attentionTitle(g.id)"
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
            <!-- 无输出提醒（per 组，随组持久化）：agent 干完活/等输入时 tab 挂琥珀状态标
                 （不打断视线，切回即消）。默认开；跑 dev server 这类长驻进程的 tab 可关。
                 状态不用复选框（指示器预留位会把文字挤得与其他项不对齐）也不用字色，
                 直接复用 hover 高亮：开 = 常驻 bg-accent（hover 效果常亮），关 = 普通项。 -->
            <ContextMenuItem
              :class="g.quietNotify !== false && 'bg-accent text-accent-foreground'"
              :title="g.quietNotify !== false
                ? '已开启：切走后安静下来（可能已完成或等你输入）时挂琥珀标，切回即消。长驻进程 tab 可点此关闭'
                : '已关闭：点此开启'"
              @click="g.quietNotify = g.quietNotify === false"
            >
              无输出时提醒
            </ContextMenuItem>
            <!-- popout 是组级动作（给该容器/宿主/SSH 主机开独立工作区），收在这里而不是 pane 头部。
                 容器要 running 才有意义（停着的容器 popout 出来是死终端）；宿主/SSH 恒可。 -->
            <ContextMenuItem
              v-if="g.kind === 'host' || g.kind === 'ssh' || containerRunning(g.containerId)"
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
        <DropdownMenu v-if="activeGroup?.kind !== 'host' && activeGroup?.kind !== 'ssh'">
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
              <!-- web 端口：后端实测返回 HTML，Globe 标记，点击按口径直连/经代理打开；
                   域名口径下附「直连 IP:端口」第二打开方式（IP 口径主点击已是直连） -->
              <template v-for="p in webPorts" :key="'w' + p">
                <DropdownMenuItem
                  class="font-mono text-xs"
                  :title="`已验证返回网页，点击打开 ${serviceUrl('c', activeContainer.name, p, activeContainer.ip)}`"
                  @click="openUrl(serviceUrl('c', activeContainer.name, p, activeContainer.ip))"
                >
                  <Globe class="size-3.5 !text-emerald-500" />
                  <span class="flex-1">{{ p }}</span>
                  <span class="text-[10px] text-emerald-500">网页</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="directOpenExtra && directPortUrl(activeContainer, p)"
                  class="pl-8 font-mono text-xs text-muted-foreground"
                  :title="`直连打开 ${directPortUrl(activeContainer, p)}`"
                  @click="openUrl(directPortUrl(activeContainer, p))"
                >
                  <span class="size-3.5 text-center text-[10px]">↳</span>
                  <span class="flex-1">直连 {{ activeContainer.ip }}:{{ p }}</span>
                </DropdownMenuItem>
              </template>
              <!-- 非 web 监听端口（ssh/db 等）：同样可点开，标记弱化 -->
              <template v-for="p in otherListenPorts" :key="'o' + p">
                <DropdownMenuItem
                  class="font-mono text-xs"
                  :title="`容器内监听 ${p}，点击打开 ${serviceUrl('c', activeContainer.name, p, activeContainer.ip)}`"
                  @click="openUrl(serviceUrl('c', activeContainer.name, p, activeContainer.ip))"
                >
                  <span class="size-3.5 text-center text-muted-foreground">:</span>
                  <span class="flex-1">{{ p }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  v-if="directOpenExtra && directPortUrl(activeContainer, p)"
                  class="pl-8 font-mono text-xs text-muted-foreground"
                  :title="`直连打开 ${directPortUrl(activeContainer, p)}`"
                  @click="openUrl(directPortUrl(activeContainer, p))"
                >
                  <span class="size-3.5 text-center text-[10px]">↳</span>
                  <span class="flex-1">直连 {{ activeContainer.ip }}:{{ p }}</span>
                </DropdownMenuItem>
              </template>
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
          title="本机 / SSH 终端无网络信息"
        >
          <Network class="size-3.5 max-md:size-5" />
        </button>
        <button
          class="flex items-center gap-1 self-stretch border-l border-border/60 px-3 text-xs max-md:px-5"
          :class="[
            activeGroup?.kind === 'ssh'
              ? 'pointer-events-none opacity-30'
              : showFiles
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/50',
          ]"
          :title="activeGroup?.kind === 'ssh'
            ? 'SSH 主机暂无文件面板'
            : showFiles ? '关闭文件面板（跟随终端目录）' : '打开文件面板（跟随终端目录）'"
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
          <!-- AI 工具工作区：与文件编辑器同区切换（AI tab 激活 = 主区给它）。全尺寸
               页面——技能库/provider/工具分配/下发结果这些管理面板体量的内容在这里舒展。 -->
          <div v-show="mainView === 'ai'" class="absolute inset-0">
            <AiWorkspace
              :override-for="aiOverrideFor"
              @close="closeAi()"
              @changed="refresh()"
              @unauthorized="emit('unauthorized')"
            />
          </div>
          <div v-show="mainView === 'file' && editorTabs.length" class="absolute inset-0">
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
              :editing="t.editing === true"
              :active="mainView === 'file' && i === activeEditorIdx"
              @close="removeTab(t)"
              @open-normal="onOpenNormal(t)"
              @saved="onEditorSaved"
              @dirty="(v: boolean) => (tabDirty[tabId(t)] = v)"
              @mode="(m) => (tabMode[tabId(t)] = m)"
            />
          </div>
          <!-- 终端区可见 = 编辑器模式下没有可显示的东西（无文件 tab 且 AI 未激活）；
               条件必须与上面两个 v-show 互补，否则叠放时终端压住 AI 工作区。 -->
          <div v-show="mainView === 'terminal'" class="absolute inset-0 bg-zinc-950">
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
      <div v-if="editorTabs.length || aiOpen" class="flex min-h-7 items-stretch border-t border-border bg-muted/30 max-md:min-h-10">
        <!-- AI 工具 tab（单例，恒在文件 tab 最左）：Bot 钮打开的页面在这里落位，
             与文件 tab 平级互切；X 关闭整个 AI 工作区（覆盖模式一并清）。 -->
        <div
          class="flex shrink-0 cursor-pointer select-none items-center gap-2 border-r border-border/60 px-3 py-1.5 text-xs max-md:py-2.5 max-md:text-sm"
          :class="
            mainView === 'ai'
              ? 'bg-card font-medium text-foreground shadow-[inset_0_2px_0_0_var(--primary)]'
              : 'text-muted-foreground hover:bg-accent/50'
          "
          title="AI 工具（技能 / 模型接入）"
          @click="openAi()"
        >
          <Bot class="size-3.5 shrink-0 max-md:size-4" />
          <span class="min-w-0">AI 工具</span>
          <button
            class="ml-1 flex shrink-0 items-center rounded text-muted-foreground hover:bg-accent hover:text-destructive max-md:px-1 max-md:py-1 pointer-coarse:px-2 pointer-coarse:py-1"
            title="关闭 AI 工具页"
            @click.stop="closeAi()"
          >
            <X class="size-3 max-md:size-3.5" />
          </button>
        </div>
        <ContextMenu v-for="(t, i) in editorTabs" :key="tabId(t)">
          <ContextMenuTrigger as-child>
            <div
              class="flex shrink-0 min-w-0 overflow-hidden cursor-pointer select-none items-center gap-2 border-r border-border/60 px-3 py-1.5 text-xs max-md:py-2.5 max-md:text-sm md:shrink md:max-w-56"
              :class="
                i === activeEditorIdx && mainView === 'file'
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
            <!-- 形态动作：编辑/预览切换（状态感知——渲染视图/只读态显示「编辑」，
                 编辑会话中显示「预览」：md/svg 回渲染视图、普通文件锁回只读）；diff 态
                 「以普通方式打开」（清 diff 转普通编辑）；可预览类型（图片/视频/
                 音频/PDF）的下载。编辑器面板无 header，动作全收在这里。 -->
            <ContextMenuItem
              v-if="!tabMode[tabId(t)] || !tabMode[tabId(t)].editing || tabMode[tabId(t)].preview"
              @click="tabModeClick(t, i)"
            >
              编辑
            </ContextMenuItem>
            <ContextMenuItem v-else @click="tabModeClick(t, i)">
              预览
            </ContextMenuItem>
            <ContextMenuItem v-if="t.diff" @click="onOpenNormal(t)">
              以普通方式打开
            </ContextMenuItem>
            <ContextMenuItem v-if="previewKind(t.path)" @click="downloadTab(t)">
              下载
            </ContextMenuItem>
            <template v-if="tabMode[tabId(t)] || t.diff || previewKind(t.path)">
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
      :container-id="activeGroup ? fileTargetId(activeGroup) : ''"
      :container-name="activeGroup ? activeGroup.name : ''"
      :panes="filePanes"
      :term-id="fileTermId"
      :has-terminal="!!activeGroup"
      :browse-mode="fileBrowseMode"
      @browse-mode="setFileBrowseMode"
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

  <!-- 服务重命名 = 显示名：侧栏卡片/服务终端 tab 用它，不动容器真名（hosts 注入、
       连接命令仍按真名解析） -->
  <ConfirmDialog
    v-if="svcRenameTarget"
    title="重命名服务"
    description="修改显示名（侧栏卡片、服务终端 tab 用它），不影响服务本身的名称（容器内连接仍按真名解析）。"
    confirm-text="重命名"
    :input="{ default: svcRenameTarget.displayName || svcRenameTarget.name, placeholder: svcRenameTarget.name }"
    @confirm="doSvcRename"
    @close="svcRenameTarget = null"
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

  <!-- 应用容器删除（卡片右键菜单入口）：文案/输名确认与服务抽屉同款 -->
  <ConfirmDialog
    v-if="pendingSvcDelete"
    :title="pendingSvcDelete.deleteData ? `删除应用容器 ${pendingSvcDelete.name}（连数据）` : `删除应用容器 ${pendingSvcDelete.name}`"
    :description="
      pendingSvcDelete.deleteData
        ? `将停止并删除容器与数据卷 ${pendingSvcDelete.name}，数据不可恢复。`
        : `将停止并删除容器 ${pendingSvcDelete.name}，数据卷保留（同名重建可恢复数据）。`
    "
    :destructive="true"
    :input="pendingSvcDelete.deleteData ? { placeholder: '输入服务名确认', confirmCue: pendingSvcDelete.name } : undefined"
    @confirm="doSvcDelete"
    @close="pendingSvcDelete = null"
  />

  <!-- 应用容器取消收编（收编容器的右键菜单入口）：不删本体，普通确认即可 -->
  <ConfirmDialog
    v-if="pendingSvcUnadopt"
    :title="`取消收编 ${pendingSvcUnadopt}`"
    description="将把该容器移出服务网络并清除登记，恢复为普通外部容器（容器本体与数据不动，LXC 内按名字解析随之消失）。"
    confirm-text="取消收编"
    variant="destructive"
    @confirm="doSvcUnadopt"
    @close="pendingSvcUnadopt = ''"
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
    :attention-ids="hiddenAttentionIds"
    :occupied="occupiedSet"
    :items="items"
    @restore="restoreHidden"
    @adopt="adoptSessions"
    @close="showSessions = false"
    @unauthorized="emit('unauthorized')"
  />

  <!-- 收编外部容器（应用容器分区头 Import 入口）：外部 docker 容器纳入服务层 -->
  <AdoptServiceDialog
    v-if="showSvcAdopt"
    @adopted="onSvcAdopted"
    @close="showSvcAdopt = false"
  />

  <!-- SSH 主机管理：添加 / 从 ~/.ssh/config 候选导入 / 删除（目标存 sidecar） -->
  <SshTargetsDialog
    v-if="showSshTargets"
    @changed="refreshSshTargets()"
    @open="openSshTerm($event)"
    @close="showSshTargets = false"
    @unauthorized="emit('unauthorized')"
  />
</template>
