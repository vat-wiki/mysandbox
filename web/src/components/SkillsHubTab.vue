<script setup lang="ts">
// 技能中心（AI 工具面板页签）。**技能库是个人技能池**——就几个、都是自己挑的，
// 用大卡片铺开：名称/描述在卡面，操作收敛两级——
// ① 卡面 = 名称 + 状态（amber「未安装」/ N 处计数 / 全局徽标 / 红调缺失）+ 描述，零杂音；
// ② 安装是显式动作：头部「全局安装」开弹框多选技能、双向同步（勾上 = 装到
//    ~/.agents/skills 铺本机+全部容器，取消勾选 = 移除）；卡脚「安装」开安装弹框——
//    本机 + 运行中容器混成一棵目录树（各端 home 起步，展开懒加载；停着的容器列不了
//    目录故不出现），整行点击 = 选落点、可多选（选中高亮 + ✓，不满屏勾选框）：命中
//    既有位置并进该规则（沿用其范围），没命中的新建规则（范围由弹框底部「新位置范围」
//    chip 统一管）。全局与按位置两套入口不冲突——底层都是同一条规则模型，全局只是
//    to=~/.agents/skills + all=true 的特例。
// ③ 卡头右上 ⋯ 菜单收低频动作：更新（显式重拉快照并分发）、移除（confirm）。
// ④ 位置治理（查看/范围切换/卸载/清缺失）收敛进卡头「N 处」计数弹出的轻量
//    Popover——一行一个位置，就地操作；不设独立的规则清单面板（库缺失残留
//    自愈：同步的有效集 = 与库的交集，残留无害）。
// 库语义：静态快照——来源改动不自动进库，更新/入库/出库都是显式动作且自带分发。
// 安装位置订阅库：库一变自动跟走；容器新建/重启全自动追平。规则 CRUD 的响应即
// 全量同步（hubView 顺带跑），卸载后的清理、孤儿收回都在这一次同步里落地。
import { ref, computed, onMounted } from 'vue'
import {
  getSkillHub,
  getSkillInventory,
  getSkillRegistry,
  getAiView,
  registryAddSkill,
  registryRemoveSkill,
  registryUpdateSkill,
  registryCheckSkillUpdates,
  registryProbeGit,
  registryImportGit,
  addSkillRule,
  updateSkillRule,
  syncSkills,
  listContainers,
  listFiles,
  HOST_ID,
  Unauthorized,
  type SkillHubView,
  type SkillRuleResult,
  type SkillInventoryView,
  type SkillInventoryLocation,
  type SkillRegistryItem,
  type SkillGitCandidate,
  type SkillUpdateCheckResult,
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  RefreshCw,
  Trash2,
  FolderSync,
  FolderOpen,
  Globe,
  Plus,
  CornerDownRight,
  Library,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  SearchCheck,
  Folder,
  MoreHorizontal,
  Check,
  X,
} from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import SkillPickList from '@/components/SkillPickList.vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

// 全局位置（铺本机 + 全部受管容器）的唯一真身——~/.claude/skills 是指向它的软链
// （seedHome/模板落地），规则只认真身。
const GLOBAL_TO = '~/.agents/skills'

const hub = ref<SkillHubView | null>(null)
const inv = ref<SkillInventoryView | null>(null)
const invLoading = ref(false)
const invErr = ref('')
const err = ref('')

async function load() {
  err.value = ''
  try {
    hub.value = await getSkillHub()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

async function loadInv() {
  invLoading.value = true
  invErr.value = ''
  try {
    inv.value = await getSkillInventory()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    invErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    invLoading.value = false
  }
}

const reg = ref<SkillRegistryItem[] | null>(null)
const regErr = ref('')

async function loadReg() {
  regErr.value = ''
  try {
    reg.value = await getSkillRegistry()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    regErr.value = e instanceof Error ? e.message : String(e)
  }
}

onMounted(() => {
  void load()
  void loadInv()
  void loadReg()
})

function fail(e: unknown) {
  if (e instanceof Unauthorized) {
    emit('unauthorized')
    return
  }
  err.value = e instanceof Error ? e.message : String(e)
}

// —— 技能 ↔ 安装位置（规则）——

// 规则的声明技能集（视图 skills 含库里缺失的条目）。
function declaredOf(r: SkillRuleResult): string[] {
  return r.skills.map((s) => s.name)
}

// 某技能已安装到的位置（规则）。
function rulesOf(name: string): SkillRuleResult[] {
  return (hub.value?.rules ?? []).filter((r) => declaredOf(r).includes(name))
}

// 单条规则的库缺失残留数（popover amber 计数；残留自愈——同步有效集 = 与库的交集）。
function ruleMissing(r: SkillRuleResult): number {
  return r.skills.filter((k) => !k.ok).length
}

// —— 卡面状态 ——

// 装到几处（= 含它的规则数）。
function installedCount(s: SkillRegistryItem): number {
  return rulesOf(s.name).length
}

// 范围切换：本机 + 全部容器 ⇄ 仅已有该项目的机器。
async function toggleScope(r: SkillRuleResult) {
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { all: !r.all })
  } catch (e) {
    fail(e)
  }
}

// 卸载 = 从该位置摘掉当前技能（规则保留——位置级删除在底部安装位置条）。
// 响应即全量同步，摘掉的下一次清理从容器收回。
const unloadingRule = ref('')
async function unloadSkill(r: SkillRuleResult, name: string) {
  if (unloadingRule.value) return
  unloadingRule.value = r.id
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, {
      skills: declaredOf(r).filter((n) => n !== name),
    })
    toast(`已卸载：${name} ✕ ${r.to}（下次同步从容器清理）`)
  } catch (e) {
    fail(e)
  } finally {
    unloadingRule.value = ''
  }
}

// 卡上「安装」（卡脚右下角主按钮）：开安装弹框——本机 + 运行中容器混成一棵目录树，
// 整行点击 = 选落点、可多选。
const installOpenFor = ref<string | null>(null)
const nfBusy = ref(false)

function openInstall(name: string) {
  installOpenFor.value = name
  installErr.value = ''
  void ensureTree()
}

async function doInstall(name: string) {
  if (!pickedCount.value || nfBusy.value) return
  nfBusy.value = true
  err.value = ''
  installErr.value = ''
  try {
    // 按选中落点逐条落规则：命中既有规则并进（全量替换语义）；没命中的新建。
    // 每次调用的响应都是 hubView（顺带跑过一次全量同步），留最后一帧刷视图。
    let latest: SkillHubView | null = null
    let touched = 0
    for (const pick of [...pickedPaths.value]) {
      const to = pick.to
      const rule = (hub.value?.rules ?? []).find((r) => r.to === to)
      if (rule) {
        const declared = declaredOf(rule)
        if (declared.includes(name)) continue
        latest = await updateSkillRule(rule.id, { skills: [...declared, name] })
      } else {
        latest = await addSkillRule(to, pick.all, [name])
      }
      touched++
    }
    if (latest) hub.value = latest
    installOpenFor.value = null
    toast(`已安装：${name} → ${touched} 处`)
  } catch (e) {
    fail(e)
    installErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    nfBusy.value = false
  }
}

// 卡头「N 处」计数弹出的位置 Popover（key = 技能名，同时只开一个）。
const spotsFor = ref<string | null>(null)

// 全局安装 = 库技能铺到 ~/.agents/skills（~/.claude/skills 软链到它）——本机 +
// 全部受管容器。入口收在头部「全局安装」按钮：弹框里库技能多选、双向同步——勾上 =
// 装，取消勾选 = 从全局摘掉（规则/位置保留，下次同步从各处清理）。保存是一次规则
// 技能集替换（PATCH skills），范围顺手拉回 all=true（规则可能被范围切换动过）；
// 库里已缺失的残留不在列表里、保持原样（清理走卡头「N 处」popover 的「清缺失」）。
const globalOpen = ref(false)
const globalBusy = ref(false)
const globalErr = ref('')
const globalPicked = ref<string[]>([])
// 打开时刻的全局集——保存时对比算增量（toast 报 新增/移除）。
const globalInitial = ref<string[]>([])

const globalRule = computed(() => (hub.value?.rules ?? []).find((r) => r.to === GLOBAL_TO))
const globalCount = computed(() => (globalRule.value ? declaredOf(globalRule.value).length : 0))

function openGlobal() {
  globalInitial.value = globalRule.value ? declaredOf(globalRule.value) : []
  globalPicked.value = [...globalInitial.value]
  globalErr.value = ''
  globalOpen.value = true
}

function toggleGlobalPick(name: string, on: boolean) {
  globalPicked.value = on ? [...globalPicked.value, name] : globalPicked.value.filter((n) => n !== name)
}

async function saveGlobal() {
  if (globalBusy.value) return
  globalBusy.value = true
  globalErr.value = ''
  try {
    const picked = [...globalPicked.value]
    const added = picked.filter((n) => !globalInitial.value.includes(n))
    const removed = globalInitial.value.filter((n) => !picked.includes(n))
    if (globalRule.value) {
      hub.value = await updateSkillRule(globalRule.value.id, { all: true, skills: picked })
    } else if (picked.length) {
      hub.value = await addSkillRule(GLOBAL_TO, true, picked)
    } else {
      globalOpen.value = false
      return
    }
    globalOpen.value = false
    const parts = [added.length ? `新增 ${added.length}` : '', removed.length ? `移除 ${removed.length}` : ''].filter(Boolean)
    toast(parts.length ? `全局安装已更新（${parts.join('，')}）${removed.length ? '——移除的下次同步从各处清理' : ''}` : '全局技能集未变化')
  } catch (e) {
    fail(e)
    globalErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    globalBusy.value = false
  }
}

// —— 安装弹框的目录树（file API：宿主 HOST_ID / 运行中容器，停着列不了） ——

// 树节点：根 = 本机 + 各运行中容器；目录子节点展开时懒加载（只列目录）。
// parent 用 '' 表示根的直接子级（Vue 模板键值不能含 undefined 对比）。
interface TreeNode {
  key: string // 唯一键：`<targetId>|<path>`
  targetId: string // listFiles 的 id（HOST_ID / 容器名）
  targetLabel: string
  path: string // 绝对路径（容器 /home/dev/x，宿主 /home/leon/x）
  to: string // 规则 to 形式（~ 归一，全局唯一——跨端同名目录即同一条规则）
  loaded: boolean
  expanded: boolean
  children: TreeNode[]
  loading: boolean
  error: string
}

const treeRoots = ref<TreeNode[]>([])
const treeReady = ref(false)
const treeErr = ref('')
const installErr = ref('')
const nfAll = ref(true) // 本批「新位置」的范围（勾选 = 本机 + 全部受管容器）
const expanded = ref<Set<string>>(new Set()) // 展开的节点 key
const checked = ref<Set<string>>(new Set()) // 勾选（= 落点）的 to 集合
const hostHome = ref('')

// 树的扁平索引（key → 节点），渲染递归组件用不到、勾选联动与规则命中判断用。
const treeIndex = computed(() => {
  const m = new Map<string, TreeNode>()
  const walk = (n: TreeNode) => {
    m.set(n.key, n)
    n.children.forEach(walk)
  }
  treeRoots.value.forEach(walk)
  return m
})

// 勾选的落点，带每条的范围（既有规则沿用其范围；新位置用 nfAll）。
interface PickDest {
  to: string
  all: boolean
  existing: boolean
  targetLabel: string
  path: string
}
const pickedPaths = computed<PickDest[]>(() => {
  const rules = hub.value?.rules ?? []
  const out: PickDest[] = []
  for (const to of checked.value) {
    const rule = rules.find((r) => r.to === to)
    const node = treeIndex.value.get(toKey(to))
    out.push({
      to,
      all: rule ? rule.all : nfAll.value,
      existing: !!rule,
      targetLabel: node?.targetLabel ?? '',
      path: node?.path ?? to,
    })
  }
  return out.sort((a, b) => a.to.localeCompare(b.to))
})
const pickedCount = computed(() => pickedPaths.value.length)

// 展开可见的节点（扁平化渲染，缩进按深度——免递归组件）。
interface VisibleNode {
  node: TreeNode
  depth: number
}
const visibleNodes = computed<VisibleNode[]>(() => {
  const out: VisibleNode[] = []
  const walk = (n: TreeNode, depth: number) => {
    out.push({ node: n, depth })
    if (expanded.value.has(n.key)) n.children.forEach((c) => walk(c, depth + 1))
  }
  treeRoots.value.forEach((r) => walk(r, 0))
  return out
})

// 该技能是否已装在 to（行置灰——重复安装无意义）。
function installedAt(name: string, to: string): boolean {
  return rulesOf(name).some((r) => r.to === to)
}

// to 是否已被选为落点（行高亮 + 右侧 ✓）。
function picked(to: string): boolean {
  return checked.value.has(to)
}

// 勾选集按 to 记；展开/懒加载按节点 key 记。
function toKey(to: string): string {
  return `to:${to}`
}

async function ensureTree() {
  if (treeReady.value) return
  treeErr.value = ''
  try {
    const [ctrs, ai] = await Promise.all([listContainers(), getAiView()])
    hostHome.value = ai.hostHome
    // 文件 API 只对运行中容器可用（exec）；本机恒在首位。
    treeRoots.value = [
      makeRoot(HOST_ID, '本机', hostHome.value || '/'),
      ...ctrs.items
        .filter((c) => c.state === 'running')
        .map((c) => makeRoot(c.id, c.displayName || c.name, '/home/dev')),
    ]
    treeReady.value = true
    // 预展开各根（首屏即见 home 直下的目录，勾选不用多点一层）。
    expanded.value = new Set(treeRoots.value.map((r) => r.key))
    await Promise.all(treeRoots.value.map((r) => expandNode(r)))
  } catch (e) {
    if (e instanceof Unauthorized) emit('unauthorized')
    else treeErr.value = e instanceof Error ? e.message : String(e)
  }
}

function makeRoot(targetId: string, targetLabel: string, home: string): TreeNode {
  return {
    key: `${targetId}|${home}`,
    targetId,
    targetLabel,
    path: home,
    to: toOf(targetId, home), // 宿主 home 探不中落到 '/' 时 to 不归一（= '/' 本身）
    loaded: false,
    expanded: true,
    children: [],
    loading: false,
    error: '',
  }
}

// 路径（容器绝对 /home/dev/x，宿主绝对 /home/leon/x）→ 规则 to（~ 形式，全局唯一）。
function toOf(targetId: string, p: string): string {
  if (targetId === HOST_ID) {
    const home = hostHome.value
    return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
  }
  const home = '/home/dev'
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
}

async function expandNode(node: TreeNode) {
  if (node.loaded || node.loading) return
  node.loading = true
  node.error = ''
  try {
    const v = await listFiles(node.targetId, node.path)
    node.children = v.entries
      .filter((e) => e.type === 'dir')
      .map((e) => ({
        key: `${node.targetId}|${joinPath(node.path, e.name)}`,
        targetId: node.targetId,
        targetLabel: node.targetLabel,
        path: joinPath(node.path, e.name),
        to: toOf(node.targetId, joinPath(node.path, e.name)),
        loaded: false,
        expanded: false,
        children: [],
        loading: false,
        error: '',
      }))
    node.loaded = true
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    node.error = e instanceof Error ? e.message : String(e)
  } finally {
    node.loading = false
  }
}

function toggleExpand(node: TreeNode) {
  const next = new Set(expanded.value)
  if (next.has(node.key)) {
    next.delete(node.key)
    expanded.value = next
    return
  }
  next.add(node.key)
  expanded.value = next
  if (!node.loaded) void expandNode(node) // 没加载过才拉目录（已加载的纯开关）
}

function toggleCheck(node: TreeNode) {
  const next = new Set(checked.value)
  if (next.has(node.to)) next.delete(node.to)
  else next.add(node.to)
  checked.value = next
}

function joinPath(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}

// —— 行 ⋯ 菜单：更新 / 移除 ——

// 显式更新（库是静态快照：来源改动不自动进库，这是来源 → 库的唯一更新通道）。
// 服务端先比对内容指纹——来源没变幂等返回（不重写库、不空转分发），变了才重拉 +
// 全量分发（订阅侧只认库，装出去的自动跟走）。
const updatingSkill = ref('')
async function updateSkill(s: SkillRegistryItem) {
  if (updatingSkill.value) return
  updatingSkill.value = s.name
  err.value = ''
  try {
    const r = await registryUpdateSkill(s.name)
    if (r.changed) {
      const containers = r.sync?.rules.flatMap((x) => x.containers) ?? []
      const bad = containers.filter((c) => !c.ok)
      if (bad.length) {
        toast.error(`库已更新，分发部分失败：${bad.map((f) => `${f.name === '__host__' ? '本机' : f.name} — ${f.error}`).join('；')}`)
      } else {
        toast(`已更新：${s.name}（已按安装位置分发）`)
      }
      await Promise.all([load(), loadReg(), loadInv()])
    } else {
      toast(`来源无变化：${s.name} 已是最新`)
    }
    // 更新过（或确认无变化）= 库与来源一致——检查徽标随之消掉。
    checkRes.value = { ...checkRes.value, [s.name]: { name: s.name, status: 'same' } }
  } catch (e) {
    fail(e)
  } finally {
    updatingSkill.value = ''
  }
}

// —— 头部「检查更新」：批量只读指纹比对，结果按卡标徽标（不改动任何东西）——

const checkRes = ref<Record<string, SkillUpdateCheckResult>>({})
const checking = ref(false)
const changedCount = computed(() => Object.values(checkRes.value).filter((r) => r.status === 'changed').length)

async function checkAll() {
  if (checking.value) return
  checking.value = true
  err.value = ''
  try {
    const { results } = await registryCheckSkillUpdates()
    const next: Record<string, SkillUpdateCheckResult> = {}
    for (const r of results) next[r.name] = r
    checkRes.value = next
    const changed = results.filter((r) => r.status === 'changed').length
    const failedItems = results.filter((r) => r.status === 'error')
    const failed = failedItems.length
    // 失败原因直接进 toast（首行摘要）——细节点卡片「检查失败」徽标看原文。
    const reasons = failedItems.map((r) => `${r.name}：${(r.message ?? '未知错误').split('\n')[0]}`).join('；')
    if (!results.length) toast('库是空的——先「添加」收技能进库')
    else if (changed) toast(`检查完成：${changed} 个有更新${failed ? `，${failed} 个检查失败（点卡片徽标看原因）` : ''}`)
    else if (failed) toast.error(`${failed} 个检查失败（点卡片「检查失败」徽标看原因）`, { description: reasons.slice(0, 300) })
    else toast('检查完成：全部已是最新')
  } catch (e) {
    fail(e)
  } finally {
    checking.value = false
  }
}

const delReg = ref<SkillRegistryItem | null>(null)
async function doDeleteReg() {
  const s = delReg.value
  if (!s) return
  delReg.value = null
  err.value = ''
  try {
    reg.value = await registryRemoveSkill(s.name)
    toast(`已移除：${s.name}（已安装到各处的会在下次同步时从容器清理）`)
    await load()
  } catch (e) {
    fail(e)
  }
}

// —— 添加面板（头部 Popover）：扫描 / 目录 / git 三来源 ——

const showImport = ref(false)
const importMode = ref<'loose' | 'dir' | 'git'>('dir')
function toggleImport(v: boolean) {
  showImport.value = v
  if (v && looseTotal.value) importMode.value = 'loose'
}
const impDir = ref('')
const impUrl = ref('')
const impCandidates = ref<SkillGitCandidate[] | null>(null)
const impPicked = ref('')
const impBusy = ref(false)

async function submitImportDir() {
  const from = impDir.value.trim()
  if (!from) return
  impBusy.value = true
  err.value = ''
  try {
    const r = await registryAddSkill(from)
    toast(`${r.replaced ? '已覆盖添加' : '已添加'}：${r.name}（快照——更新用行上 ⋯ 菜单）`)
    impDir.value = ''
    await loadReg()
  } catch (e) {
    fail(e)
  } finally {
    impBusy.value = false
  }
}

async function probeGit() {
  const url = impUrl.value.trim()
  if (!url) return
  impBusy.value = true
  err.value = ''
  try {
    const r = await registryProbeGit(url)
    impCandidates.value = r.candidates
    impPicked.value = r.candidates[0]?.path ?? ''
    if (!r.candidates.length) toast('仓库里没探测到技能（找 SKILL.md）')
  } catch (e) {
    fail(e)
  } finally {
    impBusy.value = false
  }
}

async function doImportGit() {
  const url = impUrl.value.trim()
  if (!url || !impPicked.value) return
  impBusy.value = true
  err.value = ''
  try {
    const r = await registryImportGit(url, impPicked.value)
    toast(`${r.replaced ? '已覆盖添加' : '已添加'}：${r.name}（快照——更新用行上 ⋯ 菜单）`)
    impUrl.value = ''
    impCandidates.value = null
    impPicked.value = ''
    await loadReg()
  } catch (e) {
    fail(e)
  } finally {
    impBusy.value = false
  }
}

// 从扫描行添加。thenGlobal = 添加后并进全局位置（一步到位装到本机 + 全部容器）。
// 同名 → 确认后覆盖（确认框记住 thenGlobal，覆盖后继续装到本机 + 全部容器）。
const regConfirm = ref<{ from: string; name: string; thenGlobal?: boolean } | null>(null)
async function addToRegistry(loc: SkillInventoryLocation, dir: string, spot: string, thenGlobal = false) {
  const from = (loc.kind === 'host' ? '~' : `${loc.name}:~`) + `/${spot}/${dir}`
  try {
    const r = await registryAddSkill(from)
    toast(`已添加：${r.name}`)
    if (thenGlobal) await ensureGlobalHas(r.name)
    await Promise.all([loadReg(), load()])
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('已有同名')) regConfirm.value = { from, name: dir, thenGlobal }
    else fail(e)
  }
}
async function doConfirmRegistry() {
  const c = regConfirm.value
  if (!c) return
  regConfirm.value = null
  try {
    const r = await registryAddSkill(c.from, true)
    toast(`已覆盖添加：${c.name}`)
    if (c.thenGlobal) await ensureGlobalHas(r.name)
    await Promise.all([loadReg(), load()])
  } catch (e) {
    fail(e)
  }
}

async function ensureGlobalHas(name: string) {
  let view = hub.value
  if (!view) {
    view = await getSkillHub()
    hub.value = view
  }
  const g = view.rules.find((t) => t.to === GLOBAL_TO)
  if (g) {
    const declared = declaredOf(g)
    if (!declared.includes(name)) hub.value = await updateSkillRule(g.id, { skills: [...declared, name] })
  } else {
    hub.value = await addSkillRule(GLOBAL_TO, true, [name])
  }
  toast(`已装到本机 + 全部容器（${GLOBAL_TO}）`)
}

// —— 扫描页数据源（本机/容器里已装、未纳管的技能） ——

interface InvSpotRow {
  spot: string
  skills: SkillInventoryLocation['skills']
}
const looseTotal = computed(
  () => inv.value?.locations.reduce((n, l) => n + l.skills.filter((s) => !s.managed).length, 0) ?? 0,
)
// 只展示带未纳管技能的位置（已纳管的位置没有筛选价值）。
const invLocations = computed<SkillInventoryLocation[]>(() => {
  const locs = inv.value?.locations ?? []
  return locs
    .map((l) => ({ ...l, skills: l.skills.filter((s) => !s.managed) }))
    .filter((l) => l.skills.length > 0)
})
function spotRows(loc: SkillInventoryLocation): InvSpotRow[] {
  const map = new Map<string, InvSpotRow>()
  for (const s of loc.skills) {
    let row = map.get(s.spot)
    if (!row) {
      row = { spot: s.spot, skills: [] }
      map.set(s.spot, row)
    }
    row.skills.push(s)
  }
  return [...map.values()]
}

// —— 立即同步（动作分发/启动追平之外的手动兜底）——
const syncing = ref(false)
async function syncNow() {
  if (syncing.value) return
  syncing.value = true
  err.value = ''
  try {
    const r = await syncSkills()
    const containers = r.rules.flatMap((x) => x.containers)
    const bad = containers.filter((c) => !c.ok)
    if (bad.length) {
      toast.error(`skills 同步部分失败：${bad.map((f) => `${f.name === '__host__' ? '本机' : f.name} — ${f.error}`).join('；')}`)
    } else {
      const changed = containers.reduce((n, c) => n + c.changed, 0)
      const removed = containers.reduce((n, c) => n + c.removed, 0)
      const parts = [changed ? `更新 ${changed} 个文件` : '', removed ? `清理 ${removed} 个陈旧` : ''].filter(Boolean)
      toast(`skills 已同步${parts.length ? '：' + parts.join('，') : '：全部已是最新'}`)
    }
    await Promise.all([load(), loadInv(), loadReg()])
  } catch (e) {
    fail(e)
  } finally {
    syncing.value = false
  }
}

// 清掉规则里库里已缺失的残留成员（库出库/目录被外部删后的死引用）。
async function cleanMissing(r: SkillRuleResult) {
  const keep = r.skills.filter((k) => k.ok).map((k) => k.name)
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { skills: keep })
  } catch (e) {
    fail(e)
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <p
      v-if="err"
      class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >{{ err }}</p>

    <!-- ① 技能收藏架：大卡片铺开，状态零折叠——名称/描述/位置/来源全在卡面，操作零弹层 -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Library class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">技能库</span>
        <span
          class="shrink-0 cursor-help text-muted-foreground/50"
          title="个人技能池——每张卡一件技能。日常装到项目：文件面板进到目录点 📚「安装技能」就地装（人在哪装到哪）；这里管库本身：全局安装一键铺开、卡脚「安装」集中补装、卡头「N 处」管位置、⋯ 菜单管更新/移除。来源改动不自动进库，更新走显式动作；位置订阅库，库一变装出去的自动跟走。"
        ><Info class="size-3.5" /></span>
        <div class="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          class="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          title="管理全局技能集：勾选 = 装到 ~/.agents/skills（本机 + 全部受管容器），取消勾选 = 移除"
          @click="openGlobal"
        >
          <Globe class="size-3.5" /> 全局安装<span v-if="globalCount" class="text-[10px] text-muted-foreground">·{{ globalCount }}</span>
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          title="立即同步（平时随动作分发/启动追平/建容器补发；这里是手动兜底）"
          :disabled="syncing"
          @click="syncNow"
        >
          <FolderSync :class="syncing ? 'animate-pulse' : ''" />
        </Button>
        <Button
          variant="ghost"
          size="xs"
          class="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          title="逐个比对来源与库的内容指纹（git 源查远端 commit 快路径），有更新的卡片标「有更新」——只比对，不动库不分发"
          :disabled="checking"
          @click="checkAll"
        >
          <Loader2 v-if="checking" class="size-3.5 animate-spin" />
          <SearchCheck v-else class="size-3.5" /> 检查更新<span
            v-if="changedCount"
            class="text-[10px] text-amber-600 dark:text-amber-400"
          >·{{ changedCount }}</span>
        </Button>
        <Popover :open="showImport" @update:open="toggleImport">
          <PopoverTrigger as-child>
            <Button variant="ghost" size="xs" class="h-6 shrink-0 gap-1 px-1.5 text-[11px]">
              <Plus class="size-3.5" /> 添加<span
                v-if="looseTotal"
                class="text-[10px] text-amber-600 dark:text-amber-400"
              >·{{ looseTotal }}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" class="w-96">
            <div class="flex gap-1">
              <button
                type="button"
                class="rounded border px-2 py-0.5 text-[11px] transition-colors"
                :class="importMode === 'loose' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line text-muted-foreground hover:text-foreground'"
                @click="importMode = 'loose'"
              >扫描<span v-if="looseTotal" class="text-amber-600 dark:text-amber-400"> ·{{ looseTotal }}</span></button>
              <button
                type="button"
                class="rounded border px-2 py-0.5 text-[11px] transition-colors"
                :class="importMode === 'dir' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line text-muted-foreground hover:text-foreground'"
                @click="importMode = 'dir'"
              >从目录</button>
              <button
                type="button"
                class="rounded border px-2 py-0.5 text-[11px] transition-colors"
                :class="importMode === 'git' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line text-muted-foreground hover:text-foreground'"
                @click="importMode = 'git'"
              >从 git 仓库</button>
            </div>
            <template v-if="importMode === 'loose'">
              <div class="mt-2 flex items-center gap-2">
                <span class="min-w-0 flex-1 text-[10px] leading-relaxed text-muted-foreground/70">
                  本机和各容器里已有的技能——一键收进库。
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  :disabled="invLoading"
                  @click="loadInv"
                >
                  <RefreshCw class="size-3" :class="invLoading ? 'animate-spin' : ''" /> 重扫
                </Button>
              </div>
              <p v-if="invErr" class="mt-1 text-[11px] text-destructive">{{ invErr }}</p>
              <p v-if="!invLocations.length" class="mt-1 text-[11px] text-muted-foreground/70">没有待纳管的技能——扫到的都已在库里。</p>
              <div v-for="loc in invLocations" :key="loc.name" class="mt-1.5">
                <div class="flex items-center gap-2">
                  <span
                    class="size-2 shrink-0 rounded-full"
                    :style="{ backgroundColor: loc.kind === 'host' ? 'var(--color-primary)' : containerColor(loc.name) }"
                  />
                  <span class="text-xs font-medium">{{ loc.kind === 'host' ? '本机' : loc.name }}</span>
                  <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
                    {{ loc.skills.length }}
                  </Badge>
                </div>
                <div v-if="!loc.ok" class="text-[11px] text-destructive">{{ loc.error }}</div>
                <div v-for="row in spotRows(loc)" :key="row.spot" class="pl-3">
                  <div class="font-mono text-[10px] text-muted-foreground/70" title="skills 目录位置">~/{{ row.spot }}</div>
                  <div v-for="s in row.skills" :key="s.dir" class="flex items-baseline gap-2 pl-3">
                    <span class="shrink-0 font-mono text-[11px]">{{ s.name }}</span>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="shrink-0 text-muted-foreground hover:text-foreground"
                      title="收进技能库（快照）"
                      @click="addToRegistry(loc, s.dir, row.spot)"
                    >
                      <Library class="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="shrink-0 text-muted-foreground hover:text-foreground"
                      title="收进库并装到本机 + 全部容器（~/.agents/skills）"
                      @click="addToRegistry(loc, s.dir, row.spot, true)"
                    >
                      <CornerDownRight class="size-3" />
                    </Button>
                  </div>
                </div>
              </div>
            </template>
            <template v-else-if="importMode === 'dir'">
              <div class="mt-2 flex gap-2">
                <Input
                  v-model="impDir"
                  placeholder="技能目录（须含 SKILL.md）：mytest:~/proj/…/xxx 或 ~/path/to/xxx"
                  class="h-8 flex-1 font-mono text-xs"
                  @keydown.enter="submitImportDir"
                />
                <Button size="sm" class="h-8 shrink-0" :disabled="impBusy || !impDir.trim()" @click="submitImportDir">添加</Button>
              </div>
              <p class="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
                拷一份快照进库，与来源解耦；要更新点卡片上的「更新」。
              </p>
            </template>
            <template v-else>
              <div class="mt-2 flex gap-2">
                <Input
                  v-model="impUrl"
                  placeholder="git 仓库地址：https://github.com/user/repo"
                  class="h-8 flex-1 font-mono text-xs"
                  @keydown.enter="probeGit"
                />
                <Button size="sm" class="h-8 shrink-0" :disabled="impBusy || !impUrl.trim()" @click="probeGit">
                  {{ impBusy ? '探测中…' : impCandidates ? '重扫' : '探测' }}
                </Button>
              </div>
              <div v-if="impCandidates" class="mt-1.5">
                <p v-if="!impCandidates.length" class="text-[11px] text-muted-foreground/70">没探测到技能（找 SKILL.md）</p>
                <label
                  v-for="c in impCandidates"
                  :key="c.path"
                  class="flex cursor-pointer items-center gap-2 text-[11px]"
                >
                  <Checkbox :model-value="impPicked === c.path" @update:model-value="(v) => (impPicked = v ? c.path : '')" />
                  <span class="font-mono">{{ c.name }}</span>
                  <span class="text-muted-foreground">{{ c.path === '.' ? 'repo 根' : c.path }}</span>
                </label>
                <Button size="sm" class="mt-1.5 h-7" :disabled="impBusy || !impPicked" @click="doImportGit">导入选中</Button>
              </div>
              <p class="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
                导入 = 快照（版本在仓库侧）；要更新点卡片上的「更新」。库内同名会提示覆盖。
              </p>
            </template>
          </PopoverContent>
        </Popover>
      </div>

      <!-- 空库 / 报错 -->
      <div v-if="regErr" class="px-3 py-4 text-center text-[11px] text-destructive">{{ regErr }}</div>
      <div v-else-if="!reg?.length" class="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
        还没有添加任何技能——点「添加」从扫描/本地目录/git 仓库收进库。
      </div>

      <!-- 技能收藏架：大卡片铺开——名称 + 描述 + 卡脚（右 ⋯ 菜单 / 安装主钮：
           安装位置 · 更新 · 移除），卡面零杂音 -->
      <div v-else class="grid gap-3 px-4 py-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
        <div
          v-for="s in reg"
          :key="s.name"
          class="relative flex flex-col gap-2.5 overflow-hidden rounded-xl border p-4 transition-colors"
          :class="!s.exists ? 'border-destructive/30 bg-destructive/5' : 'hover:border-line hover:bg-accent/20'"
        >
          <!-- 卡头：名称 + 状态 + 「N 处」位置 popover + 右上 ⋯ 菜单（更新 · 移除） -->
          <div class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 truncate font-mono text-sm font-medium" :class="!s.exists ? 'text-destructive/80 line-through' : ''">{{ s.name }}</span>
            <Loader2 v-if="updatingSkill === s.name" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            <span
              v-else-if="s.exists && !installedCount(s)"
              class="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
              title="还没装到任何位置——头部「全局安装」一键铺开，或卡脚「安装」指定落点"
            >未安装</span>
            <span
              v-if="s.exists && installedAt(s.name, GLOBAL_TO)"
              class="shrink-0 cursor-help rounded border border-primary/40 bg-primary/10 px-1 text-[10px] text-primary"
              title="已全局安装（~/.agents/skills，本机 + 全部受管容器）——头部「全局安装」统一管理"
            >全局</span>
            <Badge
              v-if="!s.exists"
              variant="outline"
              class="shrink-0 border-transparent bg-destructive/10 px-1 text-[10px] text-destructive"
            >缺失</Badge>
            <!-- 检查更新结果（头部批量检查按卡标注；「更新」成功后自动消掉） -->
            <span
              v-if="checkRes[s.name]?.status === 'changed'"
              class="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-400"
              title="来源有更新——⋯ 菜单「更新」拉取并分发（更新前会再比对，不白拉）"
            >有更新</span>
            <!-- 检查失败：可点开看原因（tooltip 藏着等于没有——点开 popover 显原文） -->
            <Popover v-else-if="checkRes[s.name]?.status === 'error'">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="shrink-0 cursor-pointer rounded border border-dashed border-muted-foreground/30 px-1 text-[10px] text-muted-foreground/60 transition-colors hover:border-destructive/40 hover:text-destructive"
                  title="查看失败原因"
                >检查失败</button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" class="w-80 p-2">
                <p class="px-1 pb-1 text-[10px] text-muted-foreground">检查失败 · {{ s.name }}</p>
                <p class="scroll-thin max-h-40 overflow-y-auto whitespace-pre-wrap [overflow-wrap:anywhere] px-1 font-mono text-[11px] leading-relaxed text-destructive/90">{{ checkRes[s.name]?.message || '未知错误' }}</p>
              </PopoverContent>
            </Popover>
            <div class="flex-1" />
            <!-- 「N 处」计数：弹出该技能的位置 popover（查看/切范围/清缺失/卸载）——
                 位置治理就地完成，不设独立规则清单面板 -->
            <Popover
              v-if="s.exists && installedCount(s)"
              :open="spotsFor === s.name"
              @update:open="(v: boolean) => (spotsFor = v ? s.name : null)"
            >
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="shrink-0 rounded text-[10px] text-muted-foreground/50 transition-colors hover:text-foreground"
                  title="安装位置——点范围 chip 切换，✕ 卸载该处"
                >{{ installedCount(s) }} 处</button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" class="w-80 p-2">
                <div
                  v-for="r in rulesOf(s.name)"
                  :key="r.id"
                  class="flex items-center gap-1 rounded-md px-1.5 py-1 -mx-1 hover:bg-accent/40"
                >
                  <span class="min-w-0 flex-1 truncate font-mono text-[11px]" :title="r.to">{{ r.to }}</span>
                  <button
                    v-if="ruleMissing(r)"
                    type="button"
                    class="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[9px] text-amber-600 dark:text-amber-400"
                    title="库里已不存在的残留引用——点击清掉"
                    @click="cleanMissing(r)"
                  >{{ ruleMissing(r) }} 缺失</button>
                  <button
                    type="button"
                    class="shrink-0 rounded border px-1 py-0.5 text-[9px] transition-colors"
                    :class="r.all
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
                    :title="r.all ? '装进本机 + 全部受管容器——点击改为仅已有该项目的机器' : '只装已有该项目的机器——点击改回本机 + 全部容器'"
                    @click="toggleScope(r)"
                  >
                    {{ r.all ? '本机+全部容器' : '有该项目' }}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    class="shrink-0 text-muted-foreground/50 hover:text-destructive"
                    title="从该位置卸载（位置保留，下次同步从容器清理）"
                    :disabled="!!unloadingRule"
                    @click="unloadSkill(r, s.name)"
                  >
                    <Loader2 v-if="unloadingRule === r.id" class="animate-spin" />
                    <X v-else />
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-xs" class="shrink-0 text-muted-foreground/70 hover:text-foreground" title="更多操作">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end">
                <DropdownMenuItem
                  :disabled="!!updatingSkill"
                  :title="!s.exists ? '从来源重拉快照恢复（来源还在的话）' : '从来源重拉快照并全量分发（来源改动不自动进库——这是唯一更新通道）'"
                  @click="updateSkill(s)"
                >
                  <RefreshCw /> {{ updatingSkill === s.name ? '更新中…' : '更新' }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" title="移除（已安装到各处的会在下次同步时从容器清理）" @click="delReg = s">
                  <Trash2 /> 移除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <!-- 描述：完整铺开（卡片够大，不折叠不藏气泡） -->
          <p v-if="s.description" class="text-xs leading-relaxed text-muted-foreground">{{ s.description }}</p>

          <!-- 卡脚：左来源备忘 / 右「安装」开目录树弹框管指定落点（全局安装挪去头部后，
               这是卡上唯一安装入口——用动作词，不叫「选择位置…」描述实现）。全局安装
               统一走头部按钮 + 弹框（多选双向同步），卡面只以「全局」徽标示状态。 -->
          <div class="mt-auto flex items-center gap-1 border-t pt-2.5">
            <span
              class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/40"
              :title="s.from"
            >{{ s.from }}</span>
            <Button
              v-if="s.exists"
              variant="outline"
              size="xs"
              class="h-6 shrink-0 gap-1 px-2.5 text-[11px]"
              title="安装到指定位置——弹框目录树里选（本机/容器、可多选）"
              @click="openInstall(s.name)"
            >
              <FolderOpen class="size-3" /> 安装
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 安装弹框：本机 + 运行中容器混成一棵目录树（各端 home 起步，展开懒加载），
         整行点击 = 选落点、可多选——命中既有位置的并进该规则（沿用其范围），没命中的
         新建规则（范围由「新位置范围」chip 统一管）。规则 to 是 ~ 形式全局唯一，跨端
         选同名目录自然并成一处（弹框内每行展示归一后的 to，所见即所得）。 -->
    <Dialog :open="!!installOpenFor" @update:open="(v: boolean) => v || (installOpenFor = null)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>安装 · {{ installOpenFor }}</DialogTitle>
          <DialogDescription>
            日常装到项目：到文件面板进目录点 📚 就地装（人在哪装到哪）。这里是集中补装——点目录行选落点，可多选
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-2">
          <p v-if="treeErr" class="text-xs text-destructive">{{ treeErr }}</p>
          <p v-else-if="!treeReady" class="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
            <Loader2 class="size-3 animate-spin" /> 读取目录树…
          </p>
          <!-- 目录树：根行 = 机器（本机/容器），子行 = 目录。整行点击 = 选中/取消
               （VS Code 扩展多选那套，不用满屏勾选框）；展开收起只走左侧箭头。 -->
          <div v-else class="scroll-thin max-h-72 min-h-12 overflow-y-auto rounded border bg-card">
            <button
              v-for="{ node, depth } in visibleNodes"
              :key="node.key"
              type="button"
              class="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-[11px] transition-colors"
              :class="[
                picked(node.to) ? 'bg-primary/10' : 'hover:bg-accent/40',
                installedAt(installOpenFor ?? '', node.to) ? 'opacity-50' : '',
              ]"
              :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
              :title="installedAt(installOpenFor ?? '', node.to)
                ? '已安装在这里'
                : picked(node.to)
                  ? '取消该落点'
                  : '选为安装落点'"
              @click="installedAt(installOpenFor ?? '', node.to) || toggleCheck(node)"
            >
              <!-- 展开箭头是唯一展开入口（点行是选落点），已加载的纯开关 -->
              <span
                class="flex size-4 shrink-0 cursor-pointer items-center justify-center text-muted-foreground/60 hover:text-foreground"
                :title="expanded.has(node.key) ? '收起' : '展开'"
                @click.stop="toggleExpand(node)"
              >
                <component :is="expanded.has(node.key) ? ChevronDown : ChevronRight" class="size-3" />
              </span>
              <Folder class="size-3 shrink-0 text-muted-foreground/70" />
              <!-- 根行 = 机器名（+ to 备忘），子行 = 目录名 -->
              <span class="min-w-0 flex-1 truncate" :class="depth === 0 ? 'font-medium' : 'font-mono'">
                {{ depth === 0 ? node.targetLabel : node.path.split('/').pop() }}
                <span v-if="depth === 0" class="ml-1 font-mono text-[10px] font-normal text-muted-foreground/50">{{ node.to }}</span>
              </span>
              <Loader2 v-if="node.loading" class="size-3 shrink-0 animate-spin text-muted-foreground" />
              <span v-else-if="node.error" class="shrink-0 text-[10px] text-destructive" :title="node.error">列不出</span>
              <span
                v-else-if="installedAt(installOpenFor ?? '', node.to)"
                class="shrink-0 text-[9px] text-muted-foreground/60"
              >已装</span>
              <Check v-else-if="picked(node.to)" class="size-3 shrink-0 text-primary" />
            </button>
          </div>

          <!-- 已选落点摘要：既有位置沿用其范围；新位置范围由底部 chip 统一管 -->
          <div v-if="pickedCount" class="space-y-1 rounded-md border bg-muted/20 p-2">
            <div
              v-for="p in pickedPaths"
              :key="p.to"
              class="flex items-center gap-1.5 text-[11px]"
            >
              <button
                type="button"
                class="size-3.5 shrink-0 cursor-pointer rounded-full bg-muted-foreground/25 leading-none text-[9px] hover:bg-destructive/60"
                title="取消该落点"
                @click="checked = new Set([...checked].filter((x) => x !== p.to))"
              >✕</button>
              <span class="min-w-0 flex-1 truncate font-mono">{{ p.to }}</span>
              <span
                class="shrink-0 rounded border px-1 py-0.5 text-[9px]"
                :class="p.all
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
              >{{ p.all ? '本机+全部容器' : '有该项目' }}</span>
            </div>
          </div>

          <!-- 新位置范围（只影响没命中既有规则的落点），沿用范围 chip 切换语言 -->
          <div class="flex items-center justify-between gap-2">
            <span class="text-[11px] text-muted-foreground" title="既有位置沿用其原范围，不受此影响">新位置范围</span>
            <button
              type="button"
              class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition-colors"
              :class="nfAll
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
              @click="nfAll = !nfAll"
            >{{ nfAll ? '本机+全部容器' : '有该项目' }}</button>
          </div>
          <p v-if="installErr" class="text-xs text-destructive">{{ installErr }}</p>
        </div>

        <div class="flex justify-end gap-2">
          <Button variant="outline" size="xs" :disabled="nfBusy" @click="installOpenFor = null">取消</Button>
          <Button size="xs" :disabled="nfBusy || !pickedCount" @click="doInstall(installOpenFor ?? '')">
            {{ nfBusy ? '安装中…' : `安装（${pickedCount}）` }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <!-- 全局安装弹框：库技能多选、双向同步——勾上 = 装到 ~/.agents/skills（本机+
         全部受管容器），取消勾选 = 从全局摘掉（下次同步清理）。保存 = 一次规则
         技能集替换（PATCH），响应即全量同步。按位置安装与它不冲突——底层同一条
         规则模型，全局只是 to=~/.agents/skills + all=true 的特例。 -->
    <Dialog :open="globalOpen" @update:open="(v: boolean) => v || (globalOpen = false)">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>全局安装</DialogTitle>
          <DialogDescription class="font-mono">
            {{ GLOBAL_TO }}（~/.claude/skills 软链到它）· 本机 + 全部受管容器
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-2">
          <!-- 库技能多选列表：与文件面板「AI 配置 → 技能」共用组件（行形状/过滤/空态单源） -->
          <SkillPickList
            :skills="reg"
            :picked="globalPicked"
            empty-text="技能库是空的——先用头部「添加」把技能收进库。"
            @toggle="toggleGlobalPick"
          >
            <template #error>
              <p v-if="globalErr" class="text-xs text-destructive">{{ globalErr }}</p>
            </template>
          </SkillPickList>
          <p class="text-[11px] leading-snug text-muted-foreground/70">
            勾选 = 安装，取消勾选 = 从全局移除（下次同步从各处清理）；保存即全量同步。
          </p>
        </div>

        <div class="flex justify-end gap-2">
          <Button variant="outline" size="xs" :disabled="globalBusy" @click="globalOpen = false">取消</Button>
          <Button size="xs" :disabled="globalBusy" @click="saveGlobal">
            {{ globalBusy ? '保存中…' : '保存' }}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      v-if="regConfirm"
      title="覆盖添加"
      :description="`技能库里已有「${regConfirm.name}」。用 ${regConfirm.from} 的内容覆盖它？${regConfirm.thenGlobal ? '覆盖后会继续装到本机 + 全部容器。' : ''}`"
      confirm-text="覆盖"
      variant="destructive"
      @confirm="doConfirmRegistry"
      @close="regConfirm = null"
    />
    <ConfirmDialog
      v-if="delReg"
      title="移除技能"
      :description="`把「${delReg.name}」从技能库移除？安装位置里对它的引用会变成「缺失」，下次同步时从对应容器清理。`"
      confirm-text="移除"
      variant="destructive"
      @confirm="doDeleteReg"
      @close="delReg = null"
    />
  </div>
</template>
