<script setup lang="ts">
// 右侧文件面板：跟随终端 pane 的 cwd 展示目录内容（tmux 查询），可逐级浏览、点文件
// 抛 open-file 给父级开编辑器，右键 新建文件/新建文件夹/重命名/删除。跟随与手动浏览
// 互斥：手动导航（点目录/输路径/外部定位）暂停跟随，恢复条一键回到终端所在目录。
// 文件夹的行点击语义由浏览模式决定（下钻=进入目录 / 展开=原位展开不下钻），顶栏可切。
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
  registryAddSkill,
  searchFiles,
  Unauthorized,
  ApiError,
  HOST_ID,
  SVC_FILE_PREFIX,
  SSH_ID_PREFIX,
  type FileEntry,
  type FilesView,
  type FileClipboard,
  type SearchHit,
} from '@/lib/api'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { onSandboxEvent, setWatchDirs, type SandboxEvent } from '@/lib/events'
import { gatePoll } from '@/lib/linkQuality'
import { openCodeServer } from '@/lib/codeserver'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import FilePanelGit from '@/components/FilePanelGit.vue'
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
  Loader2,
  ClipboardPaste,
  Copy,
  BookPlus,
  MoreHorizontal,
  Pencil,
  FolderInput,
  FolderTree,
  CaseSensitive,
  Regex,
  Package,
  Search,
  SquareCode,
} from 'lucide-vue-next'

const props = defineProps<{
  containerId: string
  containerName: string
  // active group 的 pane 列表（label 供 >1 pane 时下拉显示），termId 为当前跟随源。
  panes: { termId: string; label: string }[]
  termId: string | null
  hasTerminal: boolean
  // 浏览模式：下钻（点文件夹进入目录）/ 展开（点文件夹原位展开，不下钻）。
  // 父组件按终端组持有（sessionStorage），本组件只消费 + 上抛切换。
  browseMode: 'drill' | 'expand'
  // 受限账户视图（GuestConsole）传入：收掉 owner 专属入口（Code Server、添加为技能）
  // ——对应端点对账户身份 403，入口不渲染而非点了报错。安全边界在后端，这只是 UX。
  restricted?: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  // opts.diff 存在 = git 变更对比形态（Git 变更区块点击上抛；目录列表点文件不传）。
  // opts.editing = 文件行/右键「编辑」直接落编辑态；diff 打开不受影响。
  // opts.line = 内容搜索命中行：编辑器打开后跳到该行（revealTarget）。
  (e: 'open-file', path: string, opts?: { diff?: { headPath?: string }; editing?: boolean; line?: number }): void
  // 当前展示目录变化（跟随 cwd、手动导航、静默轮询都算）：父层同步 /files URL query。
  (e: 'path-change', path: string): void
  (e: 'pane-pick', termId: string): void
  (e: 'browse-mode', mode: 'drill' | 'expand'): void
}>()

// 跟随模式：path 跟着终端 cwd 走。手动导航置 false（容器 id 冻结到 manualContainerId，
// 因手动只发生在同容器内换路径；切容器时父组件会换 props，watch 里回跟随态）。
const follow = ref(true)
const manualContainerId = ref(props.containerId)
const path = ref('')

// —— 面板视图（文件 / Git）：Git 不再是文件列表底部的小 dock，而是占满面板的独立页 ——
type PanelView = 'files' | 'git'
const PANEL_VIEW_KEY = 'mysandbox:file-panel-view'
function loadPanelView(): PanelView {
  try {
    return localStorage.getItem(PANEL_VIEW_KEY) === 'git' ? 'git' : 'files'
  } catch {
    return 'files'
  }
}
const panelView = ref<PanelView>(loadPanelView())
function setPanelView(v: PanelView) {
  if (panelView.value === v) return
  panelView.value = v
  try {
    localStorage.setItem(PANEL_VIEW_KEY, v)
  } catch {
    /* localStorage 不可用就跳过 */
  }
  if (v === 'git') nextTick(() => gitRef.value?.refresh())
}

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

// 在 Code Server 打开：仅真容器目标（宿主/服务 s:/SSH ssh: 无 code-server 可言）。
// 带当前目录作工作区（?folder=），「看着文件面板一键升到 IDE」的最短动线。
// restricted（受限账户视图）：code-server 端点对账户 403，入口直接不渲染而非点了报错。
const canCodeServer = computed(() => {
  if (props.restricted) return false
  const id = targetId()
  return id !== HOST_ID && !id.startsWith(SVC_FILE_PREFIX) && !id.startsWith(SSH_ID_PREFIX)
})
function openInCodeServer(folder?: string | null): void {
  openCodeServer({ id: targetId(), name: props.containerName, folder: folder ?? (path.value || null) })
}

// —— 添加为技能（pull 反向：就地收进库）——把一个含 SKILL.md 的目录直接收进技能库
// （拷一份静态快照，与来源解耦；此后任何目标都能「安装技能」拉它，更新在技能中心）。
// 服务组没有可解析的来源形态，不出现入口。
const regBusy = ref(false)
// 同名技能覆盖确认（pending 的来源路径）
const overwriteSkill = ref<{ from: string } | null>(null)
const canRegistry = computed(() => !props.restricted && !targetId().startsWith('s:'))
// 当前目录本身是技能（含 SKILL.md）→ 工具栏露出「就地添加」快捷钮。
const hasSkillMd = computed(() => entries.value.some((e) => e.name === 'SKILL.md' && e.type === 'file'))

// —— 「添加为技能」的右键门控 ——只有含 SKILL.md 的目录才是技能，菜单项跟着出现
// （与工具栏 hasSkillMd 同一门控，非技能目录的右键恢复纯净）。判定优先吃现成数据：
// 当前目录看 hasSkillMd、已展开目录看展开缓存，都没有才异步探一次并缓存结果
// （探过即不再探，失败按非技能目录处理）。路径是容器相对的，切容器随 expanded 一起清。
const skillDirs = reactive(new Set<string>())
const skillProbeSeq = new Map<string, number>()
function hasSkillMdIn(list: FileEntry[]): boolean {
  return list.some((e) => e.name === 'SKILL.md' && e.type === 'file')
}
function isSkillDir(p: string): boolean {
  if (p === path.value) return hasSkillMd.value
  const st = expanded.get(p)
  if (st?.entries.length) return hasSkillMdIn(st.entries)
  return skillDirs.has(p)
}
function probeSkillDir(p: string) {
  if (p === path.value || expanded.get(p)?.entries.length || skillProbeSeq.has(p)) return
  const seq = (skillProbeSeq.get(p) ?? 0) + 1
  skillProbeSeq.set(p, seq)
  void listFiles(targetId(), p)
    .then((v) => {
      if (seq === skillProbeSeq.get(p) && hasSkillMdIn(v.entries)) skillDirs.add(p)
    })
    .catch(() => {}) // 探测失败当作非技能目录：菜单不出该项即可
}

async function registerSkillFrom(fromPath: string) {
  // from 形态：宿主 = 绝对路径；容器 = <名>:/home/dev/…（resolveSyncSource 两种都吃）。
  const from = isHost.value ? fromPath : `${targetId()}:${fromPath}`
  regBusy.value = true
  try {
    const r = await registryAddSkill(from)
    toast(`已添加：${r.name}（快照——更新在技能中心）`)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    // 同名覆盖确认走 ConfirmDialog：原生 confirm 在手机上就是浏览器弹框，样式不可控
    if (msg.includes('已有同名')) overwriteSkill.value = { from }
    else toast.error(msg)
  } finally {
    regBusy.value = false
  }
}

// 覆盖库里的同名技能：用户在 ConfirmDialog 里点了覆盖才真正发第二次请求
async function doOverwriteSkill() {
  const p = overwriteSkill.value
  overwriteSkill.value = null
  if (!p) return
  regBusy.value = true
  try {
    const r = await registryAddSkill(p.from, true)
    toast(`已覆盖添加：${r.name}`)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    regBusy.value = false
  }
}

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
// 相对当前目录的路径：面板当前目录恒显示在面包屑上，弹窗提示/「复制相对路径」用它——
// 绝对路径（容器 rootfs 前缀 / 宿主 home 前缀）太长，看不出操作落点。不在当前目录
// 子树下的（防御）原样返回。
function relPathOf(p: string): string {
  if (p === path.value) return '.'
  if (path.value === '/') return p.replace(/^\//, '')
  return p.startsWith(`${path.value}/`) ? p.slice(path.value.length + 1) : p
}

// —— 跨面板复制粘贴（文件/文件夹通用）——
// 剪贴板是模块级单例（api.ts）：复制后切到目标容器/宿主的文件面板粘贴，支持
// 容器↔宿主↔容器与同容器跨目录。目标冲突由服务端 409 报错（不覆盖）。
const clip = ref<FileClipboard | null>(getFileClipboard())

// —— 多选（VS Code 式）：普通点击 = 打开/进入/展开（随浏览模式）并清空选中；Ctrl/⌘ 点击 = 加入/移出选中；
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
// 命中行在多选集内（多选态）：单目标动作（编辑/下载/复制路径/重命名/删除）整体禁用，
// 只留「复制选中 N 项」——否则菜单暗示只作用于这一行，实际选中集还在，语义混乱。
function isMultiHit(row: EntryRow): boolean {
  return selected.value.has(row.path) && selected.value.size > 1
}
const ctxMulti = computed(() => !!ctxTarget.value && isMultiHit(ctxTarget.value))
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

// —— 拖拽移动（HTML5 DnD）——
// 拖行 = 移动（mv 语义，非复制）：命中行在多选集内 = 整个选中集一起拖（VS Code 语义），
// 否则该行。落点 = 面板内带 data-drop-dir 的元素（目录行 / 面包屑段 / 上一级）+ 列表
// 空白（= 落进当前目录），根节点上统一委托判定。实现走 renameEntry 的 toDir 扩展：
// 服务端一条 mv/rename 完成，原子、无复制中间态。跨容器移动不做（那要 tar 管道 +
// 删源两步非原子，仍走「复制 → 切面板 → 粘贴」），拖入外部文件/文本也不接。
const MOVE_TYPE = 'application/x-mysandbox-move' // 值 = JSON：拖动条目完整路径数组
const MOVE_FROM_PREFIX = 'application/x-mysandbox-move-from-' // 值 = 源容器 id（hex）
// dataTransfer 在 dragover 阶段只暴露 types 读不到 getData，源容器 id 编进 type 才能悬停
// 时校验「同容器才可落」。type 会被浏览器小写化，base64 有大小写会坏，用 hex 编码。
function idToHex(s: string): string {
  return [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
function hexToId(h: string): string {
  const bytes = new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)))
  return new TextDecoder().decode(bytes)
}
function moveFromType(id: string): string {
  return MOVE_FROM_PREFIX + idToHex(id)
}
// 客户端算父目录（拖拽移动的「已在目标目录」判定用；与 files.ts 服务端同名同语义）。
function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}
// 同窗口拖拽的实时载荷（dragover 校验用）。拖拽是浏览器模态操作，本窗口一次只有一场
// 拖拽；跨窗口（弹窗面板 ↔ 主窗口）拿不到它，paths 到 drop 时才从 dataTransfer 读。
let dragPayload: { containerId: string; paths: string[] } | null = null
// 面板根元素 ref（拖拽落点委托 + dragleave 的 relatedTarget 判界用）。
const rootEl = ref<HTMLElement | null>(null)
// 当前悬停落点：dragOverDir = 目录路径（对应目录行/面包屑/上一级高亮）；dragOverBlank =
// 列表空白（整列表轻染 = 松手落进当前目录）。
const dragOverDir = ref<string | null>(null)
const dragOverBlank = ref(false)
function clearDragOver() {
  dragOverDir.value = null
  dragOverBlank.value = false
}
function onDragStartRow(row: EntryRow, ev: DragEvent) {
  const paths =
    selected.value.has(row.path) && selected.value.size > 1
      ? entryPaths.value.filter((p) => selected.value.has(p))
      : [row.path]
  dragPayload = { containerId: targetId(), paths }
  const dt = ev.dataTransfer
  if (!dt) return
  dt.effectAllowed = 'move'
  dt.setData(MOVE_TYPE, JSON.stringify(paths))
  dt.setData(moveFromType(dragPayload.containerId), '1')
}
function onDragEndRow() {
  // 只在源元素触发：落没落下（含拖出面板/Esc 取消）都清实时态
  dragPayload = null
  clearDragOver()
}
// 拖拽源解析：type 里带我们标记的源容器 id 才认（OS 文件/纯文本拖入不接）。
function dragSourceOf(ev: DragEvent): { containerId: string; paths: string[] } | null {
  const dt = ev.dataTransfer
  if (!dt) return null
  const types = Array.from(dt.types)
  if (!types.includes(MOVE_TYPE)) return null
  let containerId: string | null = null
  for (const t of types) {
    if (t.startsWith(MOVE_FROM_PREFIX)) {
      try {
        containerId = hexToId(t.slice(MOVE_FROM_PREFIX.length))
        break
      } catch {
        return null
      }
    }
  }
  if (!containerId) return null
  return { containerId, paths: dragPayload?.containerId === containerId ? dragPayload.paths : [] }
}
// 落点校验：同容器 + 落点不在拖动源子树内（目录拖进自己/子孙 = mv 自嵌套，服务端也拒）。
function canDropOn(dir: string, src: { containerId: string; paths: string[] }): boolean {
  if (src.containerId !== targetId()) return false
  return !src.paths.some((p) => dir === p || dir.startsWith(`${p}/`))
}
// 落点委托（面板根）：dragover 从事件目标找最近的 [data-drop-dir]，找不到再看
// [data-drop-blank]（列表体）。命中才 preventDefault——否则浏览器显示禁止光标、drop 不来。
function onPanelDragOver(ev: DragEvent) {
  const src = dragSourceOf(ev)
  if (!src) return
  clearDragOver() // 悬停点变了（特别是移入无效落点）旧的就得灭；ref 同值写不触发渲染
  const el = (ev.target as HTMLElement | null)?.closest?.('[data-drop-dir]') as HTMLElement | null
  const dir = el?.getAttribute('data-drop-dir') ?? null
  if (dir ? canDropOn(dir, src) : canDropOn(path.value, src)) {
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    if (dir) dragOverDir.value = dir
    else dragOverBlank.value = true
  }
}
function onPanelDragLeave(ev: DragEvent) {
  // 进子元素也冒泡 dragleave：relatedTarget 还在面板内就不清
  if (ev.relatedTarget && rootEl.value?.contains(ev.relatedTarget as Node)) return
  clearDragOver()
}
function onPanelDrop(ev: DragEvent) {
  const dir = dragOverDir.value
  const blank = dragOverBlank.value
  clearDragOver()
  const src = dragSourceOf(ev)
  if ((!dir && !blank) || !src) return
  ev.preventDefault()
  // 跨窗口拖拽此刻才读得到 paths；同窗口用实时载荷
  let paths = src.paths
  if (!paths.length && ev.dataTransfer) {
    try {
      const v: unknown = JSON.parse(ev.dataTransfer.getData(MOVE_TYPE))
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) paths = v as string[]
    } catch {
      paths = []
    }
  }
  void moveEntries(paths, dir ?? path.value)
}
// 执行移动：先过滤（已在目标目录的无事可做；自嵌套报错），逐项 mv，部分失败汇总
// （同 pasteInto 的循环手法）。
function moveEntries(paths: string[], dir: string) {
  if (!paths.length || !dir) return
  const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1) || p
  const movable: string[] = []
  let selfNested = 0
  for (const p of paths) {
    if (dir === p || dir.startsWith(`${p}/`)) selfNested++
    else if (parentOf(p) !== dir) movable.push(p)
  }
  if (!movable.length) {
    if (selfNested) toast.error('不能把目录移动到它自己（或其子目录）里')
    return
  }
  const id = targetId()
  const total = movable.length
  const run = (async () => {
    const failed: string[] = []
    for (const p of movable) {
      try {
        await renameEntry(id, p, nameOf(p), dir)
        // 被移动目录的展开状态按旧路径记，随迁作废
        const prefix = `${p}/`
        for (const k of [...expanded.keys()]) if (k === p || k.startsWith(prefix)) expanded.delete(k)
      } catch (e) {
        failed.push(`${nameOf(p)}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failed.length === total) throw new Error(failed[0])
    selected.value = new Set() // 选中按旧路径记，移动后不成立
    selAnchor = null
    refresh()
    if (failed.length)
      toast.warning(`其余 ${total - failed.length} 项已移动；失败：${failed.join('；')}`)
    return total === 1 ? `已移动「${nameOf(movable[0])}」到 ${dir}` : `已移动 ${total - failed.length}/${total} 项到 ${dir}`
  })()
  toast.promise(run, {
    loading:
      total === 1 ? `正在移动「${nameOf(movable[0])}」到 ${dir}…` : `正在移动 ${total} 项到 ${dir}…`,
    success: (msg: string) => msg,
    error: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  })
}

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

// 静默轮询在途闸：同 followCheck——exec 变慢时 3s 一拍的静默列表不叠加。非静默
// （导航/刷新）不受闸：那是用户主动动作，且 seq 竞态防护已保证慢响应被丢弃。
let silentLoading = false
async function loadDir(p: string, opts: { silent?: boolean } = {}) {
  if (opts.silent && silentLoading) return
  const seq = ++loadSeq
  if (!opts.silent) {
    navOps++
    loading.value = true
  } else {
    silentLoading = true
  }
  try {
    const v = await listFiles(targetId(), p)
    if (seq !== loadSeq) return // 过期响应
    // 静默轮询发出后目标目录被导航换掉：丢弃，防止列表回跳旧目录
    if (opts.silent && p !== path.value) return
    path.value = v.path
    hostPath.value = v.hostPath ?? null
    emit('path-change', v.path)
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
    if (opts.silent) silentLoading = false
  }
}

// 跟随的三层来源（快→慢）：
// 1) OSC 7（acceptCwd）：shell 集成事件流（zsh precmd 出提示符即上报），cd 生效即达，
//    免查——路径由事件自带，只 loadDir 一次；
// 2) 回车 nudge（nudgeCwd）：onData 的 \r 上抛，250ms 后查一次（老容器/SSH/宿主等
//    无 OSC 7 的会话把体感压到亚秒级）；
// 3) 1s 轻轮询（followCheck）：兜底长命令（脚本里 cd 赶不上回车那拍）与无钩子环境。
// 右键菜单/操作弹窗开着时整体跳过：列表被换会让 ctxTarget 指向已不存在的条目对象、
// 菜单打开瞬间列表被替换（用户正对着菜单里的「重命名」列表却变了）。
function followGuard(): string | null {
  if (menuOpen.value || nameDialog.value || delTarget.value) return null
  if (!follow.value || !props.termId) return null
  return props.containerId
}
// 在途闸：1s 轮询不盯上一拍有没有回来。getTermCwd 是容器内 exec，exec 变慢（宿主
// 负载/容器忙）时固定间隔会无界叠加出请求雪崩——attach 进程越积越多、服务被打满、
// 页面所有 API pending 整体假死。跳过本拍即可：间隔自动退化为「最慢一拍」，物理上
// 叠不起来。tick/nudgeCwd 共用同闸（同一时刻至多一个 cwd 查询在飞）。
// 在途期间又来了检查诉求（切换终端/nudge/轮询撞车）：不丢，记 pending 闸释放后补跑
// ——切换那一拍的检查若被丢掉，新目标要等 5s 兜底轮询才被看见（实测秒级延迟主源）。
let followBusy = false
let followPending = false
async function followCheck() {
  if (followBusy) {
    followPending = true
    return
  }
  if (menuOpen.value || nameDialog.value || delTarget.value) return
  if (!follow.value || !props.termId || !props.containerId) return
  followBusy = true
  try {
    // 发请求瞬间锚定 props 快照：切换刚落地时两组 props 可能还没到齐（termId 先行、
    // 目标容器后到），拿旧容器查新 pane 的 not_found 是错配拍——props 已变的立即用
    // 当前 props 重查一次，仍 404 才算会话真没就绪；期间 props 变了的结果一律作废
    // （pending 补跑自会用新 props 重来）。
    const at = `${props.containerId}|${props.termId}`
    let r
    try {
      r = await getTermCwd(props.containerId, props.termId)
    } catch (e) {
      if (e instanceof Unauthorized) {
        emit('close')
        return
      }
      if (
        e instanceof ApiError &&
        e.code === 'not_found' &&
        `${props.containerId}|${props.termId}` !== at
      ) {
        r = await getTermCwd(props.containerId, props.termId)
      } else {
        throw e
      }
    }
    if (`${props.containerId}|${props.termId}` !== at) return
    noSession.value = false
    // 查询在途期间跟随被关掉（手动导航/locate/reveal）：这份 cwd 是旧跟随目标的遗物，
    // 回写会把刚定位好的面板拽走——与 loadSeq/sig 同类的过期响应守卫
    if (!follow.value) return
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
  } finally {
    followBusy = false
    if (followPending) {
      followPending = false
      void followCheck()
    }
  }
}
// 回车驱动的即时检查（终端 onData 的 \r 上抛 → ContainerList 转发到这里）：cd 提交后
// 壳立即改 cwd，250ms 后查一次基本必中——把「体感同步」从 1s 级压到亚秒级。长命令
// （构建脚本里 cd）赶不上这一次，由 1s 轮询兜底。连续回车去重，只保留最后一次。
let nudgeTimer: ReturnType<typeof setTimeout> | null = null
function nudgeCwd() {
  if (nudgeTimer) clearTimeout(nudgeTimer)
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null
    void followCheck()
  }, 250)
}
// OSC 7 直达（终端 parser 捕获 → ContainerList 只在被跟随 pane 上报时转发到这里）：
// shell 出提示符即上报 cwd，cd 生效即到达——路径随事件自带，免 getTermCwd 那次 exec，
// 纯事件驱动。zshrc 发的是原样路径，理论上他方 shell 集成可能给 percent 编码形态
// （已在 Terminal.vue 侧解码）。
function acceptCwd(p: string) {
  if (!followGuard()) return
  if (p === path.value) return
  noSession.value = false
  void loadDir(p)
}
async function tick() {
  if (tickBusy) {
    tickPending = true // 上一拍在途：不丢，跑完补一拍（同 followCheck 的 pending）
    return
  }
  tickBusy = true
  try {
    await followCheck()
    if (path.value) void loadDir(path.value, { silent: true })
    // 展开的子目录跟着静默刷新（per-dir 签名，内容没变零 DOM 变更）。
    for (const [p, st] of expanded) {
      if (st.open) void loadExpanded(p, true)
    }
  } finally {
    tickBusy = false
    if (tickPending) {
      tickPending = false
      void tick()
    }
  }
}
let tickBusy = false
let tickPending = false

let pollTimer: ReturnType<typeof setInterval> | null = null
let followTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tick() // 立即一次（首帧就有内容）
  // 事件驱动为主（file-changed → 即时静默刷新），30s 对账兜底（watcher 断链/事件丢失/
  // s:/ssh 这类 watch 不了的目标）；cwd 跟随的 1s 轮询降为 5s——容器有 OSC 7 事件与
  // 回车 nudge 直达，慢轮询只剩无集成环境（宿主/SSH/老容器）的兜底职责。
  pollTimer = setInterval(gatePoll(tick, 30_000, { hidden: true }), 30_000)
  // 弱网/隐藏拉长实际频率；跟随的即时性靠 OSC 7 + 回车 nudge，此 timer 是兜底
  followTimer = setInterval(gatePoll(() => void followCheck(), 5_000, { hidden: true }), 5_000)
  disposeEvents = onSandboxEvent(onFileEvent)
})
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (followTimer) clearInterval(followTimer)
  if (nudgeTimer) clearTimeout(nudgeTimer)
  disposeEvents?.()
  setWatchDirs(watchOwner, null)
})

// —— 文件变化事件（server/fileWatch.ts 的 fs.watch → events 总线）——
// watch 声明跟随视图状态：当前目录 + 展开的子目录（全部要即时感知变化的目标）。
// target 为 s:/ssh: 时服务端跳过（watch 不了），30s 对账轮询兜底。
let disposeEvents: (() => void) | null = null
const watchOwner = `panel-${Math.random().toString(36).slice(2)}`
function syncWatches() {
  const target = targetId()
  if (!target || !path.value) {
    setWatchDirs(watchOwner, null)
    return
  }
  const dirs = [path.value, ...[...expanded].filter(([, st]) => st.open).map(([p]) => p)]
  setWatchDirs(watchOwner, { target, dirs })
}
function onFileEvent(e: SandboxEvent) {
  if (e.type !== 'file-changed' || e.target !== targetId()) return
  if (e.dir === path.value) void loadDir(e.dir, { silent: true })
  else if (expanded.get(e.dir)?.open) void loadExpanded(e.dir, true)
}

// 切容器（props 变）：无论之前是否手动，都回到跟随态，立刻查新 pane 的 cwd 定位目录
// （tick 里的静默刷新因 path 已清自然跳过，等效一次 followCheck）。
watch(
  () => props.containerId,
  () => {
    follow.value = true
    path.value = '' // 连路径一起清：在途静默响应的 p 比对落空被丢弃，不把旧容器列表写进新容器
    hostPath.value = null
    entries.value = []
    expanded.clear() // 展开状态不跨容器保留（路径是容器相对的，撞名纯属巧合）
    skillDirs.clear() // 右键门控的探测缓存同路径体系，一并清
    skillProbeSeq.clear()
    lastSig = '' // 防止旧签名恰好压住新容器的首拉
    q.value = '' // 搜索是当前目录视图，切容器一并清掉
    tick()
  },
)
// 切 pane（termId 变）：只需重查 cwd（cwd 变了 loadDir 自会拉列表；cwd 没变列表同目
// 录无需刷新），不必走整个 tick。followCheck 自带在途 pending，不会被丢拍。
watch(
  () => props.termId,
  () => {
    if (follow.value) void followCheck()
  },
)
// 路径变化（跟随跳转/手动导航/面包屑）：下钻模式 = 树展开整体收起（展开是「当前目录
// 视图」的形态，换了目录旧展开没有意义）；展开模式 = 只剪掉不在新目录子树里的展开状态
// ——留着不可见子树的唯一效果是每 3s 一轮无谓的静默刷新，剪掉后回到上级/再进子目录时
// 展开原样保留，树浏览上下文连续。静默轮询写回同值不触发 watch，展开原样保留。
watch(path, (np) => {
  if (props.browseMode === 'drill') expanded.clear()
  else pruneExpanded(np)
  selected.value = new Set() // 换目录清空多选（选中是当前目录视图的形态，同展开）
  selAnchor = null
})

// —— 浏览模式（下钻 / 展开）——
// 文件夹「点行」的语义二选一：下钻 = 进入目录（导航，原默认）；展开 = 原位展开/收起
// （VS Code 树语义，不动当前目录）。行首 chevron/文件夹图标热区在两种模式下都是原位
// 展开——切换的是「点行」。状态按终端组归父组件持有（sessionStorage 存，会话内有效），
// 这里 prop 进 / 事件出，面板自己不存、挂卸无感。
// 切换即上抛，状态落地在父组件（按终端组 + sessionStorage）。
function toggleBrowseMode() {
  emit('browse-mode', props.browseMode === 'drill' ? 'expand' : 'drill')
}

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
    emit('open-file', p, { editing: true })
  }
}
function goParent() {
  if (path.value === '/') return
  const i = path.value.lastIndexOf('/')
  openDir(i <= 0 ? '/' : path.value.slice(0, i))
}
// 父目录路径（拖拽落点：拖到「上一级」按钮 = 移动到上级目录）。
const parentPath = computed(() => {
  const p = path.value
  if (!p || p === '/') return null
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
})
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
onBeforeUnmount(() => {
  crumbRO?.disconnect()
  resetSearchState() // 在途搜索请求作废 + 清防抖 timer
})
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

// 外部定位入口（CLI open / 父组件请求）：直接展示某容器某目录，默认暂停跟随。
// pauseOnSame=false 用于**挂载时**从 URL 恢复路径（刷新）：`?path=` 是面板自己写进
// 路由的，不是用户「我要看这个目录」的意图——原先无条件暂停会让每次刷新都留在
// 「已暂停跟随」态，表现为跟随功能时灵时不灵。
function locate(containerId: string, p: string, opts: { pauseOnSame?: boolean } = {}) {
  setPanelView('files')
  manualContainerId.value = containerId
  const pause = opts.pauseOnSame ?? true
  follow.value = containerId !== props.containerId ? true : !pause
  loadDir(p)
}

// 外部定位（文件形态）：跟随「当前看的文件」——定位到所在目录 + 树内展开到该文件 +
// 行闪烁高亮。展开模式且文件在当前树内 = 原位展开祖先链（浏览上下文不动）；树外/下钻
// 模式 = 导航到所在目录（与 locate 同语义）。reveal 是一次明确的外部定位，暂停 cwd
// 跟随（同 locate——否则轮询会把面板拽回终端 cwd，与编辑器互相打架）。
const revealPath = ref('')
let revealTimer: ReturnType<typeof setTimeout> | null = null
async function revealFile(containerId: string, filePath: string) {
  setPanelView('files')
  const dir = filePath.slice(0, filePath.lastIndexOf('/')) || '/'
  manualContainerId.value = containerId
  // 恒暂停跟随（不像 locate 靠「容器不同=组即将切换」回跟随态）：reveal 的目标就是
  // 这个文件目录，不是新 pane 的 cwd——不能给在途 followCheck 任何回写 cwd 的机会
  follow.value = false
  // 搜索态会把目标行过滤/排走（展开模式尤其明显）：reveal 换的是浏览上下文，
  // 顺带清掉搜索态，保证目标行可见。
  q.value = ''
  resetSearchState()
  revealPath.value = filePath
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(() => (revealPath.value = ''), 2400)
  // 展开模式的树内文件：把根到所在目录的祖先链逐层展开（已展开的跳过，别的不收起，
  // 用户自己展开的结构是浏览上下文）；否则导航到所在目录，文件即顶层条目。
  const prefix = path.value === '/' ? '/' : `${path.value}/`
  if (props.browseMode === 'expand' && path.value && (dir === path.value || dir.startsWith(prefix))) {
    const rel = dir === path.value ? '' : dir.slice(prefix.length)
    let cur = path.value
    const need: string[] = []
    for (const seg of rel ? rel.split('/') : []) {
      cur = cur === '/' ? `/${seg}` : `${cur}/${seg}`
      if (!expanded.get(cur)?.open) {
        expanded.set(cur, { open: true, loading: true, entries: [], err: '', sig: '' })
        need.push(cur)
      }
    }
    await Promise.all(need.map((p) => loadExpanded(p, false)))
  } else {
    await loadDir(dir)
  }
  await nextTick()
  rootEl.value
    ?.querySelector(`[data-path="${CSS.escape(filePath)}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
defineExpose({ locate, revealFile, refresh, nudgeCwd, acceptCwd })

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
  if (ctxTarget.value?.entry.type === 'dir' && canRegistry.value) probeSkillDir(ctxTarget.value.path)
}
// 触屏行内 ⋯ 菜单（手机右键不可达）：与 ContextMenu 同一批动作/处理器，只是入口不同。
function onRowMenu(row: EntryRow) {
  ctxTarget.value = row
  if (row.entry.type === 'dir' && canRegistry.value) probeSkillDir(row.path)
}
// 命名弹窗：mode 区分三个操作；entry 为重命名/删除目标。err 是异步结果回显。
// dir = 新建的父目录：右键/⋯ 命中文件夹时建在该文件夹内（VS Code 同语义），
// 空白处/顶栏按钮不传 = 当前目录。开弹窗时捕获，不依赖存活的 ctxTarget。
const nameDialog = ref<null | { mode: 'newFile' | 'newDir' | 'rename'; dir?: string }>(null)
// 新建目标：右键命中文件夹 = 该文件夹，其余 = 当前目录（undefined 即 path.value）。
function newEntryDir(): string | undefined {
  return ctxTarget.value?.entry.type === 'dir' ? ctxTarget.value.path : undefined
}
// 命名弹窗的 desc：rename = 目标相对路径；新建 = 目标目录相对路径带尾斜杠
// （当前目录 ./，根 /，子目录 src/）——绝对路径太长看不清落点，相对路径一眼定位，
// 完整位置抬头看面包屑即可。
const nameDialogDesc = computed(() => {
  const d = nameDialog.value
  if (!d) return ''
  if (d.mode === 'rename') return relPathOf(ctxTarget.value?.path ?? '')
  const dir = d.dir ?? path.value
  return dir === '/' ? '/' : `${relPathOf(dir)}/`
})
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

// 工具行的新建入口：清掉条目右键留下的目标，落到当前目录。
function startCreate(mode: 'newFile' | 'newDir') {
  ctxTarget.value = null
  nameDialog.value = { mode }
}

// —— 名称搜索：两套语义随浏览模式（渲染分支见 rows）——
// 下钻：当前目录内相关度排序平铺——命中前排 + 高亮，未命中不过滤、稳定垫后（跳文件优先）。
// 展开：目录树内过滤、保层级——只留命中条目与其祖先目录，目录名命中则子树照旧。
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
// needle 参数化：名称搜索传 q（小写化）、内容搜索命中行传 pattern（正则模式不高亮，
// 传空串走全不命中分支）。
function nameSegs(name: string, needle: string): { t: string; hit: boolean }[] {
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

// —— 内容搜索（grep，服务端视图）——
// 与文件名搜索共用一个输入框：名称侧即时排序/过滤，输入达到 MIN_QUERY 后再并行跑
// 服务端 grep，命中按文件分组显示在文件列表上方。点命中行 emit open-file 带 line +
// editing（md/svg 默认预览态，跳行只在源码态有意义，必须 editing:true 强制进源码）。
// MIN_QUERY 只约束 grep（1 个字符的递归搜索噪声太大）。
const searchHits = ref<SearchHit[] | null>(null) // null = 无结果态（未搜/已清）
const searchLoading = ref(false)
const searchErr = ref('')
const searchTruncated = ref(false)
const searchCs = ref(false) // 大小写敏感（默认否）
const searchRe = ref(false) // 正则模式（默认固定串）
const searchDeps = ref(false) // 含依赖目录（默认剪 .git/node_modules 等）
const MIN_QUERY = 2
// 内容搜索激活 = 内容分组显示（文件列表仍保留，渲染分支判它，一处收口）。
const contentActive = computed(() => q.value.trim().length >= MIN_QUERY)

let searchCtl: AbortController | null = null
let searchTimer: ReturnType<typeof setTimeout> | null = null
let searchSeq = 0 // 过期响应守卫（loadSeq 同手法，防 abort 竞态漏网）
function resetSearchState() {
  searchCtl?.abort()
  searchCtl = null
  if (searchTimer) {
    clearTimeout(searchTimer)
    searchTimer = null
  }
  searchHits.value = null
  searchLoading.value = false
  searchErr.value = ''
  searchTruncated.value = false
}
async function runContentSearch() {
  const needle = q.value.trim()
  if (needle.length < MIN_QUERY) {
    resetSearchState()
    return
  }
  const my = ++searchSeq
  searchCtl?.abort()
  const ctl = new AbortController()
  searchCtl = ctl
  searchLoading.value = true
  searchErr.value = ''
  try {
    const v = await searchFiles(
      targetId(),
      path.value,
      needle,
      { cs: searchCs.value, re: searchRe.value, deps: searchDeps.value },
      ctl.signal,
    )
    if (my !== searchSeq) return
    searchHits.value = v.hits
    searchTruncated.value = v.truncated
    searchLoading.value = false
  } catch (e) {
    if (my !== searchSeq || ctl.signal.aborted) return // 换词/换路径/换容器的过期响应，静默丢弃
    searchLoading.value = false
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    searchErr.value = e instanceof Error ? e.message : String(e)
  }
}
function scheduleContentSearch() {
  if (q.value.trim().length < MIN_QUERY) {
    resetSearchState()
    return
  }
  searchCtl?.abort()
  if (searchTimer) clearTimeout(searchTimer)
  // debounce 期间就进入 loading 并丢掉上一词的命中：合并搜索后内容分组常驻，
  // 否则新查询会先闪一下旧结果/「无匹配」，看起来像搜索失灵。
  searchHits.value = null
  searchLoading.value = true
  searchErr.value = ''
  searchTruncated.value = false
  searchTimer = setTimeout(runContentSearch, 300)
}
// path 进依赖 = 搜索作用域就是当前目录，导航即按新目录重搜（旧结果过期丢弃）；容器 id
// 兜底（切容器 watch 已清 q，q 变化会触发本 watch，双保险）。开关变化即重搜。
watch([q, searchCs, searchRe, searchDeps, path, () => props.containerId], scheduleContentSearch)

// 结果按文件分组（服务端 flat hits，客户端分组纯展示）：保持服务端返回序（grep 递归序）。
const contentGroups = computed(() => {
  const out: { path: string; name: string; dir: string; hits: SearchHit[] }[] = []
  const byPath = new Map<string, { path: string; name: string; dir: string; hits: SearchHit[] }>()
  for (const h of searchHits.value ?? []) {
    let g = byPath.get(h.path)
    if (!g) {
      const i = h.path.lastIndexOf('/')
      const dir = i < 0 ? '' : h.path.slice(0, i) // 根下文件无 dir（slice(0,-1) 会剪名尾）
      g = { path: h.path, name: h.path.split('/').pop() ?? h.path, dir, hits: [] }
      byPath.set(h.path, g)
      out.push(g)
    }
    g.hits.push(h)
  }
  return out
})
// 命中行相对路径 -> 当前目录下的绝对路径（open-file 汇聚点吃绝对路径）。
function hitAbsPath(rel: string): string {
  return path.value === '/' ? `/${rel}` : `${path.value}/${rel}`
}

// —— 目录展开（行内树形视图）——
// 点行首 chevron 或文件夹图标 = 原位展开子内容，子目录可继续层层展开（两种模式下都
// 可用，展开热区与行点击分工明确）；「点行」的语义随浏览模式 browseMode：下钻 = 进入
// 目录（原导航不变），展开 = 整行即展开/收起。展开状态按完整路径记（子层会出现与顶层
// 同名的条目，路径才唯一）；换目录的收尾随模式（见上方 path watch），搜索时收起、只按
// 相关度平铺——树展开与搜索排序混排会让人迷失层级。
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
// watch 声明跟随视图状态（目录导航/展开收起/切容器都重发）——expanded 在下文声明，
// 注册放在声明之后（TS 的 use-before-declare 不吃提升）。
watch([path, () => props.containerId], syncWatches)
watch(expanded, syncWatches)
const expandSeq = new Map<string, number>()

// 展开模式的换目录收尾（path watch 调）：剪掉不在 newPath 子树里的展开状态——当前目录
// 自身的保留（从展开中的目录点面包屑进去，子层照旧展开）。
function pruneExpanded(newPath: string) {
  const prefix = newPath === '/' ? '/' : `${newPath}/`
  for (const p of [...expanded.keys()]) {
    if (p !== newPath && !p.startsWith(prefix)) expanded.delete(p)
  }
}

// 当前目录下拼完整路径（rows 顶层搜索平铺用；新建的目标目录见 nameDialog.dir）。
function joinPath(name: string): string {
  return path.value === '/' ? `/${name}` : `${path.value}/${name}`
}

// 静默刷新在途闸（同 loadDir）：per-dir 记账，exec 变慢时不叠加。
const expandBusy = new Set<string>()
async function loadExpanded(p: string, silent: boolean) {
  const st = expanded.get(p)
  if (!st) return
  if (silent && expandBusy.has(p)) return
  const seq = (expandSeq.get(p) ?? 0) + 1
  expandSeq.set(p, seq)
  if (!silent) st.loading = true
  else expandBusy.add(p)
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
    else expandBusy.delete(p)
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

// 行点击语义（随浏览模式）：下钻 = 目录进目录；展开 = 目录原位展开/收起（不下钻）。
// link 先试目录后回退文件、文件抛 open-file——本就不是下钻语义，两种模式一致。
// 下钻模式下想原位看子内容，点行首 chevron/文件夹图标热区即可（见下方展开热区）。
function openRow(row: EntryRow) {
  if (row.entry.type === 'dir') {
    if (props.browseMode === 'expand') toggleExpand(row)
    else openDir(row.path)
  } else if (row.entry.type === 'link') void openLink(row.path)
  else emit('open-file', row.path, { editing: true })
}

// 平面化渲染模型：主列表 + 各展开目录的子内容（递归，带缩进层级），v-for 直接吃它。
// 搜索随浏览模式分两套（与两种浏览模型同构）：
// - 下钻：单目录相关度排序平铺（displayEntries，未命中不过滤垫后）——跳转文件优先；
// - 展开：树内过滤、保层级（VS Code filter-on-type 语义）——只留命中条目与其祖先目录，
//   目录名命中则整个子树照旧（树是正在搭建的浏览上下文，搜索不该把它拍平换掉）。
// 目录行先占位再递归，子树全不命中就连子层一起 splice 回收（目录行必须渲染在子层之前）。
// sigOf 吃 FilesView（子目录视图同构，签名复用）。
const rows = computed<TreeRow[]>(() => {
  const needle = q.value.trim().toLowerCase()
  if (needle && props.browseMode === 'drill') {
    return displayEntries.value.map((e) => ({
      kind: 'entry' as const,
      entry: e,
      path: joinPath(e.name),
      depth: 0,
    }))
  }
  const out: TreeRow[] = []
  const walk = (list: FileEntry[], parent: string, depth: number): boolean => {
    let any = false
    for (const e of list) {
      const p = parent === '/' ? `/${e.name}` : `${parent}/${e.name}`
      const hit = !needle || e.name.toLowerCase().includes(needle)
      if (e.type !== 'dir') {
        if (hit) {
          out.push({ kind: 'entry', entry: e, path: p, depth })
          any = true
        }
        continue
      }
      const st = expanded.get(p)
      const at = out.length
      out.push({ kind: 'entry', entry: e, path: p, depth }) // 占位：目录行在子层之前
      let sub = false
      if (st?.open) {
        if (st.err) {
          out.push({ kind: 'err', path: p, depth: depth + 1, msg: st.err })
          sub = true
        } else if (!st.entries.length) {
          if (!st.loading) {
            out.push({ kind: 'empty', path: p, depth: depth + 1 })
            sub = true
          }
        } else {
          sub = walk(st.entries, p, depth + 1)
        }
      }
      if (needle && !hit && !sub) out.splice(at, out.length - at)
      else any = true
    }
    return any
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
      const dir = d.dir ?? path.value
      await createEntry(id, dir === '/' ? `/${name}` : `${dir}/${name}`, d.mode === 'newDir' ? 'dir' : 'file')
      // 建进了非当前目录（右键文件夹的新建）：目录在展开树里就立即重拉，别等 3s 轮询
      if (dir !== path.value && expanded.get(dir)?.open) void loadExpanded(dir, false)
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
  <!-- 拖拽落点委托挂根：dragover/dragleave/drop 统一判定（见脚本「拖拽移动」节） -->
  <div
    ref="rootEl"
    class="flex h-full min-h-0 flex-col bg-card"
    @dragover="onPanelDragOver"
    @dragleave="onPanelDragLeave"
    @drop="onPanelDrop"
  >
    <!-- 路径行属于整个面板（文件 / Git 共用）：目录在上，视图切换在面板底部。 -->
    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2 max-md:h-11">
      <button
        v-if="path && path !== '/'"
        class="shrink-0 rounded text-muted-foreground hover:text-foreground"
        :class="dragOverDir === parentPath ? 'bg-accent text-foreground' : ''"
        :data-drop-dir="parentPath ?? undefined"
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
            :class="[
              i === visibleCrumbs.length - 1
                ? 'text-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              dragOverDir === c.p ? 'bg-accent text-foreground' : '',
            ]"
            :data-drop-dir="i === visibleCrumbs.length - 1 ? null : c.p"
            @click="i === visibleCrumbs.length - 1 ? startEditPath() : openDir(c.p)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <span v-else class="min-w-0 flex-1 font-mono text-[11px] text-muted-foreground">…</span>
      <select
        v-if="panes.length > 1"
        class="max-w-20 shrink-0 rounded border border-border bg-background px-1 py-0.5 text-[10px] text-muted-foreground"
        title="跟随哪个终端的目录"
        :value="termId ?? undefined"
        @change="emit('pane-pick', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="p in panes" :key="p.termId" :value="p.termId">{{ p.label }}</option>
      </select>
      <!-- 路径行只负责导航与关闭；目录操作统一下沉到搜索下方的工具行。 -->
      <button
        type="button"
        class="flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/50 hover:text-foreground max-md:size-9"
        title="关闭文件面板"
        aria-label="关闭文件面板"
        @click="emit('close')"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <template v-if="panelView === 'files'">
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

    <!-- 搜索行：一个输入框同时承担文件名过滤与内容 grep。名称侧即时响应；内容侧输入
         达到 2 个字符后自动执行，命中分组显示在文件列表上方。Esc/✕ 清空。 -->
    <div v-if="hasTerminal" class="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-2">
      <Search class="size-3.5 shrink-0 text-muted-foreground/60" />
      <input
        v-model="q"
        class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        placeholder="搜索文件名或内容…"
        title="文件名即时过滤；输入至少 2 个字符后同时搜索文件内容"
        @keydown.esc="q = ''"
      />
      <!-- 内容搜索三开关：输入不足 2 字符时隐藏，达到阈值后与 grep 同时生效。 -->
      <template v-if="contentActive">
        <button
          class="shrink-0"
          :class="searchCs ? 'text-sky-400' : 'text-muted-foreground/60 hover:text-foreground'"
          title="区分大小写"
          @click="searchCs = !searchCs"
        >
          <CaseSensitive class="size-3.5" />
        </button>
        <button
          class="shrink-0"
          :class="searchRe ? 'text-sky-400' : 'text-muted-foreground/60 hover:text-foreground'"
          title="正则表达式（默认固定字符串）"
          @click="searchRe = !searchRe"
        >
          <Regex class="size-3.5" />
        </button>
        <button
          class="shrink-0"
          :class="searchDeps ? 'text-sky-400' : 'text-muted-foreground/60 hover:text-foreground'"
          title="包含 node_modules/venv 等依赖目录"
          @click="searchDeps = !searchDeps"
        >
          <Package class="size-3.5" />
        </button>
      </template>
      <button
        v-if="q"
        class="shrink-0 text-muted-foreground hover:text-foreground"
        title="清除搜索"
        @click="q = ''"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <!-- 目录工具行：浏览模式用带文字的切换钮明确语义，其余目录操作直接露出。 -->
    <div
      v-if="hasTerminal"
      class="flex h-8 shrink-0 items-center gap-0.5 border-b border-border bg-muted/10 px-1.5 max-md:h-10"
    >
      <button
        type="button"
        class="flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] transition-colors max-md:h-8"
        :class="
          browseMode === 'expand'
            ? 'bg-sky-500/10 text-sky-400 hover:bg-sky-500/15'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
        "
        :aria-pressed="browseMode === 'expand'"
        :title="
          browseMode === 'expand'
            ? '展开模式：点击文件夹原位展开/收起，不进入目录（点击切换回下钻模式）'
            : '下钻模式：点击文件夹进入目录（点击切换为展开模式）'
        "
        @click="toggleBrowseMode"
      >
        <FolderTree v-if="browseMode === 'expand'" class="size-3.5" />
        <FolderInput v-else class="size-3.5" />
        <span>{{ browseMode === 'expand' ? '展开' : '下钻' }}</span>
      </button>
      <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
      <div class="ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto scroll-thin">
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="loading"
          title="刷新"
          aria-label="刷新"
          @click="refresh"
        >
          <RefreshCw class="size-3.5" :class="{ 'animate-spin': loading }" />
        </button>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="!path"
          title="新建文件"
          aria-label="新建文件"
          @click="startCreate('newFile')"
        >
          <FilePlus class="size-3.5" />
        </button>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="!path"
          title="新建文件夹"
          aria-label="新建文件夹"
          @click="startCreate('newDir')"
        >
          <FolderPlus class="size-3.5" />
        </button>
        <button
          v-if="clip"
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="!path"
          :title="clipLabel"
          :aria-label="clipLabel"
          @click="pasteInto(path)"
        >
          <ClipboardPaste class="size-3.5" />
        </button>
        <button
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="!path || path === '/'"
          title="下载当前文件夹"
          aria-label="下载当前文件夹"
          @click="downloadDir"
        >
          <Download class="size-3.5" />
        </button>
        <button
          v-if="canCodeServer"
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="!path"
          title="在 Code Server 打开当前目录"
          aria-label="在 Code Server 打开当前目录"
          @click="openInCodeServer()"
        >
          <SquareCode class="size-3.5" />
        </button>
        <button
          v-if="canRegistry && hasSkillMd"
          type="button"
          class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-35 max-md:size-8"
          :disabled="regBusy || !path"
          :title="regBusy ? '添加中…' : '添加为技能'"
          :aria-label="regBusy ? '添加中…' : '添加为技能'"
          @click="registerSkillFrom(path)"
        >
          <BookPlus class="size-3.5" />
        </button>
      </div>
    </div>

    <!-- 列表体：ContextMenu 包裹，右键新建/重命名/删除 -->
    <ContextMenu @update:open="(v: boolean) => (menuOpen = v)">
      <ContextMenuTrigger as-child>
        <!-- 空白落点：拖到非目录行/空白处松手 = 移动到当前目录（整列表轻染提示） -->
        <div
          data-drop-blank
          class="scroll-thin min-h-0 flex-1 overflow-y-auto"
          :class="dragOverBlank ? 'bg-accent/20' : ''"
          @contextmenu="onCtxMenu"
        >
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
            <!-- 展开模式的搜索是过滤语义：全不命中时树被滤空，给个明确空态（下钻的排序
                 语义永远有行，走不到这） -->
            <p
              v-else-if="q.trim() && !contentActive && !rows.length && !loading"
              class="px-3 py-6 text-center text-xs text-muted-foreground"
            >
              无匹配条目
            </p>

            <!-- 内容命中放在文件列表之前：内容搜索通常递归整个目录，放在全部文件行之后
                 会被下钻模式的排序列表埋掉。名称侧仍保留原有过滤/排序语义。 -->
            <div v-if="contentActive" class="border-b border-border">
              <div class="flex h-7 items-center gap-1.5 border-b border-border bg-muted/20 px-2.5 text-[11px] text-muted-foreground">
                <FileText class="size-3 shrink-0" />
                <span class="font-medium">内容</span>
                <template v-if="searchLoading">
                  <Loader2 class="size-3 animate-spin" />
                  <span>搜索中…</span>
                </template>
                <span v-else-if="contentGroups.length">{{ contentGroups.length }} 个文件</span>
                <span v-else class="text-muted-foreground/60">无匹配</span>
                <span v-if="searchTruncated" class="ml-auto text-muted-foreground/70">仅前 500 条</span>
              </div>
              <p v-if="searchErr" class="m-2 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
                {{ searchErr }}
              </p>
              <template v-else-if="contentGroups.length">
                <template v-for="g in contentGroups" :key="'sg:' + g.path">
                  <button
                    class="flex w-full items-center gap-2 py-1.5 pl-2.5 pr-2.5 text-left hover:bg-accent/50"
                    :title="hitAbsPath(g.path)"
                    @click="emit('open-file', hitAbsPath(g.path))"
                  >
                    <FileText class="size-3.5 shrink-0 text-muted-foreground" />
                    <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                      <span v-if="g.dir" class="text-muted-foreground">{{ g.dir }}/</span>
                      <template v-for="(s, i) in nameSegs(g.name, q.trim().toLowerCase())" :key="i">
                        <span v-if="s.hit" class="rounded bg-primary/20 px-0.5 font-semibold text-primary">{{ s.t }}</span>
                        <template v-else>{{ s.t }}</template>
                      </template>
                    </span>
                    <span class="shrink-0 text-[10px] text-muted-foreground">{{ g.hits.length }}</span>
                  </button>
                  <button
                    v-for="h in g.hits"
                    :key="'sh:' + g.path + ':' + h.line + ':' + h.text"
                    class="flex w-full items-center gap-2 py-1 pl-9 pr-2.5 text-left font-mono text-xs hover:bg-accent/50"
                    :title="`${g.path}:${h.line}`"
                    @click="emit('open-file', hitAbsPath(h.path), { line: h.line, editing: true })"
                  >
                    <span class="w-8 shrink-0 text-right text-[10px] text-muted-foreground/70">{{ h.line }}</span>
                    <span class="min-w-0 flex-1 truncate">
                      <template v-for="(s, i) in nameSegs(h.text, searchRe ? '' : q.trim().toLowerCase())" :key="i">
                        <span v-if="s.hit" class="rounded bg-primary/20 px-0.5 font-semibold text-primary">{{ s.t }}</span>
                        <template v-else>{{ s.t }}</template>
                      </template>
                    </span>
                  </button>
                </template>
              </template>
            </div>
            <div
              v-if="contentActive && rows.length"
              class="flex h-7 items-center gap-1.5 border-b border-border bg-muted/20 px-2.5 text-[11px] text-muted-foreground"
            >
              <Folder class="size-3 shrink-0" />
              <span class="font-medium">文件</span>
            </div>
            <!-- 行 = 树平面化结果（rows）：主列表 + 各展开目录的子内容。点行 = 打开/进入/
                 展开（随浏览模式），Ctrl/⌘ 点行 = 加入/移出多选、Shift 点行 = 从锚点范围选
                 （VS Code 式，选中集供「复制」整体带走）；点行首 chevron 或文件夹图标 =
                 原位展开子目录（.stop 防止触发行点击）；文件行用等宽占位保持名字列对齐。 -->
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
                :data-drop-dir="row.entry.type === 'dir' ? row.path : null"
                draggable="true"
                class="flex cursor-pointer items-center gap-2 py-1.5 pr-2.5 max-md:py-2.5"
                :class="[
                  selected.has(row.path) ? 'bg-accent hover:bg-accent/70' : 'hover:bg-accent/50',
                  dragOverDir === row.path ? 'bg-primary/15 ring-1 ring-inset ring-primary/50' : '',
                  // reveal 高亮（跟随当前看的文件）：与选中（accent）区分开的 primary 淡底，
                  // 出现即定位反馈，2.4s 后 revealPath 清空自动退场
                  revealPath === row.path ? 'bg-primary/15 ring-1 ring-inset ring-primary/30' : '',
                ]"
                :style="{ paddingLeft: `${ROW_BASE + row.depth * ROW_INDENT}px` }"
                @click="onRowClick(row, $event)"
                @dragstart="onDragStartRow(row, $event)"
                @dragend="onDragEndRow"
              >
                <!-- 展开热区 = chevron + 文件夹图标整体（含中间空隙）：点哪都是展开/收起，
                     间隙不再漏给行点击；hover 双双变亮 + cursor 暗示整块可点，展开态 chevron
                     常亮（收起态淡灰）。文件/link 行用等宽占位（w-4 + 行 gap + 图标 = 38px）
                     保持名字列对齐。 -->
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
                  <template v-for="(s, i) in nameSegs(row.entry.name, q.trim().toLowerCase())" :key="i">
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
                    <DropdownMenuItem v-if="row.entry.type === 'file'" :disabled="isMultiHit(row)" @click="emit('open-file', row.path, { editing: true })">
                      <Pencil /> 编辑
                    </DropdownMenuItem>
                    <!-- 与 ContextMenu 同动作：目录行直达 Code Server（触屏右键不可达的补偿入口）。 -->
                    <DropdownMenuItem v-if="row.entry.type === 'dir' && canCodeServer" :disabled="isMultiHit(row)" @click="openInCodeServer(row.path)">
                      <SquareCode /> 在 Code Server 打开
                    </DropdownMenuItem>
                    <template v-if="row.entry.type === 'dir' && canRegistry && isSkillDir(row.path)">
                      <DropdownMenuItem :disabled="regBusy || isMultiHit(row)" @click="registerSkillFrom(row.path)">
                        <BookPlus /> 添加为技能
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </template>
                    <DropdownMenuItem :disabled="isMultiHit(row)" @click="download(row)">
                      <Download /> 下载
                    </DropdownMenuItem>
                    <DropdownMenuItem @click="copyToClipboard(row)">
                      <ClipboardPaste /> {{ copyLabel(row) }}
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="!isHost" :disabled="isMultiHit(row)" @click="copyText(row.path, '已复制容器路径')">
                      <Copy /> 复制容器路径
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isMultiHit(row)" @click="copyText(relPathOf(row.path), '已复制相对路径')">
                      <Copy /> 复制相对路径
                    </DropdownMenuItem>
                    <DropdownMenuItem v-if="hostPathOf(row)" :disabled="isMultiHit(row)" @click="copyRowHostPath(row)">
                      <Copy /> 复制实际路径
                    </DropdownMenuItem>
                    <DropdownMenuItem :disabled="isMultiHit(row)" @click="onRowMenu(row); nameDialog = { mode: 'rename' }">
                      <PenLine /> 重命名
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="destructive" :disabled="isMultiHit(row)" @click="onRowMenu(row); delTarget = row">
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
          <ContextMenuItem v-if="ctxTarget.entry.type === 'file'" :disabled="ctxMulti" @click="emit('open-file', ctxTarget.path, { editing: true })">
            编辑
          </ContextMenuItem>
          <!-- 在 Code Server 打开：目录行/当前目录右键直达（带该目录作 ?folder= 工作区）。
               仅真容器目标（canCodeServer），文件行不给——文件走上面的「编辑」。 -->
          <ContextMenuItem v-if="ctxTarget.entry.type === 'dir' && canCodeServer" :disabled="ctxMulti" @click="openInCodeServer(ctxTarget.path)">
            在 Code Server 打开
          </ContextMenuItem>
          <!-- 添加为技能：只对含 SKILL.md 的目录显示（isSkillDir 门控），文案与工具栏按钮一致。
               separator 放项下不放上——目录没有「编辑」项，放上方它会贴住菜单顶缘。 -->
          <template v-if="ctxTarget.entry.type === 'dir' && canRegistry && isSkillDir(ctxTarget.path)">
            <ContextMenuItem :disabled="regBusy || ctxMulti" @click="registerSkillFrom(ctxTarget.path)">
              添加为技能
            </ContextMenuItem>
            <ContextMenuSeparator />
          </template>
          <ContextMenuItem @click="copyToClipboard(ctxTarget)">
            {{ copyLabel(ctxTarget) }}
          </ContextMenuItem>
          <ContextMenuItem v-if="!isHost" :disabled="ctxMulti" @click="copyText(ctxTarget.path, '已复制容器路径')">
            复制容器路径
          </ContextMenuItem>
          <ContextMenuItem :disabled="ctxMulti" @click="copyText(relPathOf(ctxTarget.path), '已复制相对路径')">
            复制相对路径
          </ContextMenuItem>
          <ContextMenuItem v-if="hostPathOf(ctxTarget)" :disabled="ctxMulti" @click="copyRowHostPath(ctxTarget)">
            复制实际路径
          </ContextMenuItem>
          <ContextMenuItem :disabled="ctxMulti" @click="download(ctxTarget)">
            下载
          </ContextMenuItem>
          <ContextMenuItem :disabled="ctxMulti" @click="nameDialog = { mode: 'rename' }">
            重命名
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" :disabled="ctxMulti" @click="delTarget = ctxTarget">
            删除
          </ContextMenuItem>
          <ContextMenuItem v-if="clip && ctxTarget.entry.type === 'dir'" @click="pasteInto(ctxTarget.path)">
            粘贴到该文件夹
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <!-- 空白处右键 = 当前目录：「在 Code Server 打开当前目录」与工具栏按钮同动作。
             命中条目时不给（目录行有自己的项，避免同菜单两个近义项）。 -->
        <ContextMenuItem v-if="!ctxTarget && canCodeServer && path" @click="openInCodeServer()">
          在 Code Server 打开当前目录
        </ContextMenuItem>
        <ContextMenuItem v-if="clip" :disabled="!path" @click="pasteInto(path)">
          粘贴到当前目录
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path || path === '/'" @click="downloadDir">
          下载当前文件夹
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newFile', dir: newEntryDir() }">
          新建文件
        </ContextMenuItem>
        <ContextMenuItem :disabled="!path" @click="nameDialog = { mode: 'newDir', dir: newEntryDir() }">
          新建文件夹
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
    </template>

    <!-- 独立 Git 视图：占满面板剩余高度（内部再分变更/历史）。始终挂载以保留页签与滚动状态，
         v-show 切换；条目点击仍以 diff 形态开编辑器 tab。 -->
    <div v-show="panelView === 'git'" class="min-h-0 flex-1">
      <FilePanelGit
        v-if="hasTerminal && path"
        ref="gitRef"
        class="h-full"
        :key="targetId()"
        :container-id="targetId()"
        :path="path"
        @open-change="
          (t) => emit('open-file', t.path, { diff: t.headPath ? { headPath: t.headPath } : {} })
        "
        @navigate="openDir"
      />
      <p v-else class="px-3 py-8 text-center text-xs text-muted-foreground">先在左侧打开终端</p>
    </div>

    <!-- 视图切换固定在面板底部：目录是上下文，文件/Git 是同一目录的两种看板。 -->
    <div
      class="flex h-10 shrink-0 items-stretch border-t border-border bg-muted/30 max-md:h-11"
      :title="containerName"
    >
      <button
        type="button"
        class="relative flex flex-1 items-center justify-center text-xs transition-colors"
        :class="
          panelView === 'files'
            ? 'bg-card font-medium text-foreground shadow-[inset_0_2px_0_0_var(--primary)]'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
        "
        :aria-pressed="panelView === 'files'"
        @click="setPanelView('files')"
      >
        文件
      </button>
      <button
        type="button"
        class="relative flex flex-1 items-center justify-center text-xs transition-colors"
        :class="
          panelView === 'git'
            ? 'bg-card font-medium text-foreground shadow-[inset_0_2px_0_0_var(--primary)]'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground'
        "
        :aria-pressed="panelView === 'git'"
        @click="setPanelView('git')"
      >
        Git
      </button>
    </div>

    <!-- 命名弹窗（新建/重命名共用） -->
    <NameDialog
      v-if="nameDialog"
      :title="nameDialog.mode === 'rename' ? '重命名' : nameDialog.mode === 'newDir' ? '新建文件夹' : '新建文件'"
      :desc="nameDialogDesc"
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
    <!-- 同名技能覆盖确认 -->
    <ConfirmDialog
      v-if="overwriteSkill"
      title="覆盖同名技能"
      description="技能库里已有同名条目，覆盖会用当前目录的快照替换它。"
      confirm-text="覆盖"
      variant="destructive"
      :busy="regBusy"
      @confirm="doOverwriteSkill"
      @close="overwriteSkill = null"
    />
  </div>
</template>
