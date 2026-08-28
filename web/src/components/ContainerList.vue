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
  getListenPorts,
  getHostCwd,
  resolveTermPath,
  listServices,
  listServiceJobs,
  HOST_ID,
  Unauthorized,
  type ContainerView,
  type ResolveView,
  type ServiceView,
} from '@/lib/api'
import { trackServiceJobs } from '@/lib/serviceJobs'
import { newId } from '@/lib/id'
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
import { Terminal as TerminalIcon, MoreHorizontal, RefreshCw, X, FolderOpen, CheckCheck, Monitor, Globe, AppWindow, Plus, Database, Settings2, Network } from 'lucide-vue-next'
import CreateDialog from '@/components/CreateDialog.vue'
import BatchDialog from '@/components/BatchDialog.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import DeleteContainerDialog from '@/components/DeleteContainerDialog.vue'
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
  (e: 'open-hosts'): void
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
function newTermId(): string {
  return newId()
}
function newGroupId(): string {
  return newId()
}
// 一个 group = 一个容器终端组，root 是布局树（类型与操作见 lib/termlayout.ts）：
// 叶子 = 一个独立 termId/会话，split = 同方向多块嵌套（row 左右 / col 上下），任意组合。
// kind='host' 为宿主终端组（PTY 由 server 管理，cwd=镜像目录，containerId 为哨兵 '__host__'）。
function loadTabs(): { groups: TermGroup[]; activeIdx: number } {
  try {
    const raw = localStorage.getItem(TABS_KEY)
    if (!raw) return { groups: [], activeIdx: 0 }
    const p = JSON.parse(raw) as Record<string, unknown>
    const arr = Array.isArray(p.groups) ? p.groups : []
    const groups: TermGroup[] = []
    for (const g of arr) {
      if (!g || typeof g !== 'object') continue
      const o = g as Record<string, unknown>
      if (typeof o.containerId !== 'string') continue
      let root = normalizeRoot(o.root)
      if (!root) {
        // 旧版迁移：v3 扁平 panes（横向一排）/ v2 单 termId -> 包成叶子或横向二分以上。
        const ids = Array.isArray(o.panes)
          ? o.panes
              .filter(
                (pn): pn is { termId: string } =>
                  !!pn && typeof (pn as { termId?: unknown }).termId === 'string',
              )
              .map((pn) => pn.termId)
          : typeof o.termId === 'string'
            ? [o.termId]
            : []
        if (!ids.length) continue
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
      groups.push({
        id: typeof o.id === 'string' ? o.id : newGroupId(),
        containerId: o.containerId,
        name: typeof o.name === 'string' ? o.name : o.containerId,
        kind: o.kind === 'host' ? ('host' as const) : undefined,
        seq: typeof o.seq === 'number' && o.seq >= 1 ? o.seq : undefined,
        root,
      })
    }
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
const savedTabs = loadTabs()
const groups = ref<TermGroup[]>(savedTabs.groups)
const activeIdx = ref(savedTabs.activeIdx)
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
provide(TERM_OPS, {
  split(group, termId, dir) {
    group.root = splitLeaf(group.root, termId, dir, newTermId())
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
  onOscOpen,
  onLinkOpen,
  dividerStart,
  dividerDrag,
  ordinalOf,
  groupLabel,
})

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
// 面板宽度（像素制，拖动独立于终端 pane 的比例制 grows）。
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
// 文件编辑器目标（v1 单编辑器：已有目标时轻提示换文件需先关）。
// diff 存在 = git 变更对比模式（FileEditorDialog 走 getGitDiff 只读快照分支）。
// line/col 来自终端 Ctrl+点击的 `:行:列` 后缀（Monaco 定位用）。
const editorTarget = ref<{
  containerId: string
  containerName: string
  path: string
  diff?: { headPath?: string }
  line?: number
  col?: number
} | null>(null)
// 桌面查看目标：null 关；打开时存容器 id/显示名。
const desktopTarget = ref<{ containerId: string; containerName: string } | null>(null)
function openFile(cId: string, cName: string, path: string, diff?: { headPath?: string }) {
  if (editorTarget.value) {
    err.value = '已有文件在编辑，先关闭它再打开新文件'
    return
  }
  editorTarget.value = diff ? { containerId: cId, containerName: cName, path, diff } : { containerId: cId, containerName: cName, path }
}
// git 面板点变更条目：以 diff 对比模式打开（FilePanelGit 组装好绝对路径）。
function onOpenChange(cId: string, cName: string, c: { absPath: string; oldAbsPath?: string }) {
  openFile(cId, cName, c.absPath, c.oldAbsPath ? { headPath: c.oldAbsPath } : {})
}
// diff 对话框「以普通方式打开」：清 diff 标记，dialog 的 watch(diff) 自动重走普通加载。
function onOpenNormal() {
  if (editorTarget.value) {
    const { containerId, containerName, path } = editorTarget.value
    editorTarget.value = { containerId, containerName, path }
  }
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
// 监听端口分组展示：web 端口（后端实测返回 HTML）直接平铺高亮可点；
// 其余（ssh/db/redis 等非网页）折叠进「其他 N」，点开才显示——初衷是快速打开网页。
const listenPorts = ref<number[]>([])
const webPorts = ref<number[]>([])
const showOtherPorts = ref(false)
let listenSeq = 0 // 竞态：切 group 时丢弃慢响应
const ipCopied = ref(false)
let ipCopyTimer: ReturnType<typeof setTimeout> | null = null
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
  } catch {
    if (seq !== listenSeq) return
    listenPorts.value = [] // 容器刚停/权限等：静默置空
    webPorts.value = []
  }
}
watch(
  () => [activeGroup.value?.containerId, activeContainer.value?.state],
  () => {
    showOtherPorts.value = false // 换容器收起折叠组
    void loadListenPorts()
  },
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
  const ids = leafIds(g.root)
  const termId = ids[Math.min(filePaneIdx.value, ids.length - 1)]
  if (!termId) return
  try {
    const r = await getHostCwd(termId)
    if (seq !== hostCwdSeq) return
    hostCwd.value = r.cwd
  } catch {
    if (seq !== hostCwdSeq) return
    hostCwd.value = '' // 会话未建/已收（显式 kill）等：静默置空
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
    editorTarget.value = { containerId: c.id, containerName: c.displayName || c.name, path, line, col }
  }
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
function createGroup(containerId: string, name: string, kind?: 'host'): TermGroup {
  // seq = 同容器现有组的最大序号 + 1（稳定身份，不随关闭/排序变化）
  let seq = 0
  for (const x of groups.value) {
    if (x.containerId === containerId) seq = Math.max(seq, x.seq ?? 1)
  }
  const g: TermGroup = { id: newGroupId(), containerId, name, kind, seq: seq + 1, root: { kind: 'leaf', termId: newTermId() } }
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
  return g
}
// 组显示名：同容器多组并存时带稳定序号（dev·1 / dev·2 …），单一组就是原名。
// 序号是创建时定死的（seq），拖拽换位/关闭别的组都不会让「dev·2」换组。
function groupLabel(g: TermGroup): string {
  const peers = groups.value.filter((x) => x.containerId === g.containerId)
  if (peers.length <= 1) return g.name
  return `${g.name}·${g.seq ?? peers.indexOf(g) + 1}`
}
// 手动新开一组（tab 栏「＋」）：同当前容器/宿主的全新组。侧栏点容器是「聚焦已有组」，
// 这里是「再开一组」——单组分屏满 MAX_GROUP_PANES 块后想要更多终端，走这个显式动作。
function openNewGroup() {
  const g = activeGroup.value
  if (!g) return
  createGroup(g.containerId, g.name, g.kind)
}
// 点容器「终端」：该容器已有 group 则聚焦，否则建组（避免重复打开堆积）。
// 想要同容器多个独立 shell -> 在 pane 头部点左右 / 上下分屏。
// 首参为最小结构形状（locateContainerPath 宿主分支复用，见其注释）。
function openTerm(c: { id: string; name: string; displayName?: string }) {
  const i = groups.value.findIndex((g) => g.containerId === c.id)
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(c.id, c.displayName || c.name)
}
// 点侧栏「宿主」条目：开宿主终端（PTY 由 server 管理，cwd=镜像目录）。全局唯一一个 group。
function openHostTerm() {
  const i = groups.value.findIndex((g) => g.kind === 'host')
  if (i >= 0) {
    activeIdx.value = i
    return
  }
  createGroup(HOST_ID, '宿主', 'host')
}

// ---- 独立窗口（popout）----
// 在新浏览器窗口打开某容器/宿主的纯终端工作区（App 按 ?popout= 渲染无侧栏形态）。
// 新窗口首屏自动开一个全新终端组，之后随意左右/上下分屏；布局存独立 key，
// 与主窗口互不影响；tmux 会话按 termId 归属，刷新窗口即可恢复。
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
// 重命名 = 改显示名（meta.displayName）：tab/侧栏/文件面板全用它，随时可改、不动容器真名。
// 成功后同步已开终端组的名字快照（组内 pane 头、文件面板 label 都读它）。
const renameTarget = ref<ContainerView | null>(null)
function onRename(c: ContainerView) {
  renameTarget.value = c
}
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

onMounted(() => {
  refresh()
  timer = setInterval(() => refresh(true), 5000)
  if (!props.popout) {
    void refreshServices()
    armSvcTimer()
  }
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  if (hostCwdTimer) clearInterval(hostCwdTimer)
  if (svcTimer) clearInterval(svcTimer)
})
</script>

<template>
  <div class="flex h-full min-h-0 gap-0">
    <!-- 左侧窄栏的信息架构：一个主体 + 两个辅助。
         「容器」是全侧栏唯一的标题 + 唯一的列表；宿主终端是钉在顶部的单行快捷入口；
         docker 服务是底部的摘要条（不以行的形态出现，避免形成第二个并列清单）。
         模板/全局 hosts 等容器作用域的低频配置收进容器标题的 ⋯ 菜单。popout 独立窗口不渲染。 -->
    <aside v-if="!props.popout" class="flex w-56 shrink-0 flex-col border-r border-border md:w-64">
      <!-- 品牌块：纯身份标识，居中。系统健康不做常驻展示——引擎/连接出问题时终端连不上，
           tmux 连接错误自然会暴露问题，不值得为小概率状态占一眼。 -->
      <div class="flex h-10 shrink-0 items-center justify-center gap-2 border-b border-border px-3">
        <img src="/logo.svg" alt="" class="size-5" />
        <span class="text-sm font-semibold tracking-tight">MySandbox</span>
      </div>

      <!-- 宿主终端快捷行：单行入口、不做分区标题（图标 + 文字自解释）。
           点击开/切宿主 tab，hover 出独立窗口按钮。 -->
      <div class="border-b border-border p-1">
        <div
          class="group flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
          :class="{ 'bg-accent/70': activeGroup?.kind === 'host' }"
          role="button"
          tabindex="0"
          title="宿主终端（镜像目录）"
          @click="openHostTerm()"
          @keydown.enter.prevent="openHostTerm()"
        >
          <Monitor class="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span class="min-w-0 flex-1 truncate text-sm">宿主终端</span>
          <span class="shrink-0 text-[10px] text-muted-foreground">镜像目录</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            title="在独立窗口打开宿主终端"
            @click.stop="openPopout(HOST_ID)"
          >
            <AppWindow />
          </Button>
        </div>
      </div>

      <!-- 容器分区标题：唯一的强标题。⟳ 刷新 / ＋ 新建（基座未就绪时禁用）/ ⋯ 低频配置 -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border py-2 pl-3 pr-1.5">
        <span class="text-sm font-semibold">容器</span>
        <span class="text-xs text-muted-foreground">{{ items.length }}</span>
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
            <DropdownMenuContent align="end" class="w-40">
              <DropdownMenuItem @click="emit('open-base')">
                <Settings2 /> {{ baseLabel }}管理
              </DropdownMenuItem>
              <DropdownMenuItem @click="emit('open-hosts')">
                <Network /> 全局 hosts
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
                <DropdownMenuItem v-if="c.state === 'running'" @click="openPopout(c.id)"
                  >在独立窗口打开</DropdownMenuItem
                >
                <DropdownMenuItem @click="onPower(c, 'restart')">重启</DropdownMenuItem>
                <DropdownMenuItem @click="onRename(c)">重命名</DropdownMenuItem>
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

      <!-- 服务摘要条：一行聚合（状态点 + 名称串），点击开管理面板、＋ 带新建意图。
           全部运行=绿 / 有停机=黄 / docker 不可达=红 / 无服务=灰。 -->
      <button
        type="button"
        class="group flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-left hover:bg-accent/50"
        title="docker 配套服务（postgres/redis…，容器内按服务名访问）——点击管理"
        @click="emit('open-services')"
      >
        <Database class="size-3.5 shrink-0 text-muted-foreground" />
        <span :class="['h-2 w-2 shrink-0 rounded-full', svcDotClass]" />
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ svcSummary }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          title="新建服务"
          @click.stop="emit('open-services', true)"
        >
          <Plus />
        </Button>
      </button>
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

      <!-- tab 栏：每组一个 tab，色条=容器色，·N=pane 数（>1 才显示） -->
      <div class="flex items-stretch border-b border-border bg-muted/30">
        <div
          v-for="(g, idx) in groups"
          :key="g.id"
          draggable="true"
          @click="activeIdx = idx"
          @dragstart="onTabDragStart($event, idx)"
          @dragover="onTabDragOver($event, idx)"
          @dragend="onTabDragEnd"
          :class="[
            'flex cursor-pointer items-center gap-2 border-r border-border px-3 py-1.5 text-xs',
            idx === activeIdx ? 'bg-card text-foreground' : 'text-muted-foreground hover:bg-accent/50',
            dragTabIdx === idx ? 'opacity-40' : '',
          ]"
          :title="groups.length > 1 ? '拖动排序 · 点击切换' : ''"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            :style="{ backgroundColor: g.kind === 'host' ? '#f59e0b' : containerColor(g.containerId) }"
          />
          <span class="font-mono">{{ groupLabel(g) }}<span v-if="leafCount(g.root) > 1" class="text-muted-foreground/60">·{{ leafCount(g.root) }}</span></span>
          <button
            @click.stop="closeGroupById(g.id)"
            class="ml-1 text-muted-foreground hover:text-destructive"
            title="关闭终端组"
          >✕</button>
        </div>
        <span class="ml-auto self-center px-3 text-xs text-muted-foreground">{{ groups.length }} 个终端组</span>
        <button
          class="flex items-center self-stretch border-l border-border px-3 text-xs"
          :class="
            activeGroup
              ? 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              : 'pointer-events-none opacity-30'
          "
          title="新开一组终端（当前容器/宿主的独立 tab）"
          @click="openNewGroup()"
        >
          <Plus class="size-3.5" />
        </button>
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
        <!-- web 端口：实测返回 HTML，高亮 + Globe 标记，一键打开 -->
        <template v-if="webPorts.length">
          <span class="shrink-0 select-none opacity-50">·</span>
          <button
            v-for="p in webPorts"
            :key="'w' + p"
            class="flex shrink-0 items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-emerald-500 hover:bg-emerald-500/25 hover:text-emerald-400"
            :title="`已验证返回网页，点击打开 http://${activeContainer.ip}:${p}`"
            @click="openUrl(`http://${activeContainer.ip}:${p}`)"
          >
            <Globe class="size-3" />{{ p }}
          </button>
        </template>
        <!-- 非 web 监听端口：折叠进「其他 N」，点开平铺（弱化样式仍可点） -->
        <template v-if="otherListenPorts.length">
          <span v-if="!webPorts.length" class="shrink-0 select-none opacity-50">·</span>
          <button
            v-if="!showOtherPorts"
            class="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            :title="`${otherListenPorts.length} 个非网页监听端口（ssh/db 等），点击展开`"
            @click="showOtherPorts = true"
          >
            其他 {{ otherListenPorts.length }} ▸
          </button>
          <template v-else>
            <button
              v-for="p in otherListenPorts"
              :key="'o' + p"
              class="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              :title="`容器内监听 ${p}（未返回 HTML），点击打开 http://${activeContainer.ip}:${p}`"
              @click="openUrl(`http://${activeContainer.ip}:${p}`)"
            >
              :{{ p }}
            </button>
            <button
              key="collapse"
              class="shrink-0 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
              title="收起非网页端口"
              @click="showOtherPorts = false"
            >
              ▸
            </button>
          </template>
        </template>
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
          <p class="text-xs opacity-70">同一容器可左右/上下分屏（每组最多 {{ MAX_GROUP_PANES }} 块）；tab 栏「＋」随时新开一组</p>
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
          @open-change="(c) => activeGroup && onOpenChange(activeGroup.containerId, activeGroup.name, c)"
          @pane-pick="(t: string) => (filePaneIdx = filePanes.findIndex((x) => x.termId === t))"
        />
      </div>

      <FileEditorDialog
        v-if="editorTarget"
        :key="editorTarget.containerId + editorTarget.path"
        :container-id="editorTarget.containerId"
        :container-name="editorTarget.containerName"
        :path="editorTarget.path"
        :diff="editorTarget.diff"
        :line="editorTarget.line"
        :col="editorTarget.col"
        @close="editorTarget = null"
        @open-normal="onOpenNormal"
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
    v-if="batchSel"
    :ids="batchSel.ids"
    :names="batchSel.names"
    @done="refresh(); clearSelection()"
    @close="batchSel = null"
    @unauthorized="emit('unauthorized')"
    @open-hosts="emit('open-hosts')"
  />
</template>
