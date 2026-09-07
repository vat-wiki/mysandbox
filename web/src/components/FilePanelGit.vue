<script setup lang="ts">
// 文件面板内嵌的「Git 变更」区块：面板当前目录位于 git 仓库内时展示分支与变更文件列表。
// path（面板当前目录）是唯一刷新键：跟随/手动导航、外部 locate 都只是换 path。
// 非仓库目录整块不渲染；结果含 repo:false 时缓存住，同一 path 下不再重复打（/etc 这类
// 目录不每 8s 白跑一次 rev-parse）。条目可点：点文件行抛 open-change（拼 toplevel 绝对
// 路径 + R 旧路径作 headPath），父级接 openFile 以 diff 形态开 tab；目录行仍是折叠开关。
// 视图双模式：list 平铺（服务端 -uall 保证全是单个文件、无目录条目）/ tree 目录树
// （前端按相对路径聚合；纯 untracked 子树默认折叠——大 untracked 目录不刷屏，同 git
// porcelain / VSCode 的折叠展示习惯）。模式存 localStorage，跨窗口一致。
// dock 高度可拖（PaneDivider 夹在折叠头与列表之间），像素值 localStorage 持久化。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  getGitStatus,
  getGitBranches,
  gitCheckout,
  gitFetch,
  gitPull,
  gitPush,
  gitBranchDelete,
  Unauthorized,
  type GitStatusView,
  type GitChange,
  type GitBranchesView,
} from '@/lib/api'
import { GitBranch, ChevronDown, ChevronRight, List, FolderTree, Folder, Plus, Check, Trash2, RefreshCw } from 'lucide-vue-next'
import PaneDivider from '@/components/PaneDivider.vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Input } from '@/components/ui/input'

const props = defineProps<{
  containerId: string
  path: string
}>()

const emit = defineEmits<{
  (e: 'open-change', target: { path: string; headPath?: string }): void
}>()

const view = ref<GitStatusView | null>(null)
const err = ref('') // 温和降级：灰字提示，不进面板主错误条
// 折叠态本地保存（path 变不清，切容器随 :key 重建复位）。dock 在面板底部（VSCode 源代码
// 管理式），默认展开、高度定档：变更数在折叠头徽章上仍可见，收起省列表高度。
const collapsed = ref(false)

// —— 视图模式（平铺 / 目录树），localStorage 持久化 ——
type GitViewMode = 'list' | 'tree'
const VIEW_KEY = 'mysandbox:git-panel-view'
function loadViewMode(): GitViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'list'
  } catch {
    return 'list'
  }
}
const viewMode = ref<GitViewMode>(loadViewMode())
function setMode(m: GitViewMode) {
  if (viewMode.value === m) return
  viewMode.value = m
  try {
    localStorage.setItem(VIEW_KEY, m)
  } catch {
    /* localStorage 不可用就跳过 */
  }
}

let gitSeq = 0
let inFlight = false // 门闩：上一发没回来不发下一发（慢仓不排队堆积）
let notRepoKey = '' // repo:false 结果的缓存键（path 变化才失效）

async function fetchStatus() {
  if (!props.path || inFlight) return
  if (notRepoKey === props.path) return // 已确认非仓库，等 path 变化再试
  const seq = ++gitSeq
  inFlight = true
  try {
    const v = await getGitStatus(props.containerId, props.path)
    if (seq !== gitSeq) return // 过期响应
    if (!v.repo) {
      notRepoKey = props.path
      view.value = null
      return
    }
    view.value = v
    err.value = ''
  } catch (e) {
    if (seq !== gitSeq) return
    if (e instanceof Unauthorized) return // 会话过期由面板统一处理，这里静默
    // git 状态是辅助信息：失败只灰字提示，不打断目录浏览
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    inFlight = false
  }
}

function refresh() {
  notRepoKey = '' // 强刷清非仓库缓存（外链 locate 到刚 git init 的目录也能立刻看到）
  void fetchStatus()
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void fetchStatus()
  timer = setInterval(fetchStatus, 8000) // 比 cwd 的 3s 慢一档：变更状态低频变化
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// path / 容器变化立刻重查（含从仓库内走到仓库外的场景）；树折叠状态一并复位
watch(
  () => [props.containerId, props.path],
  () => {
    notRepoKey = ''
    collapsedDirs.value = new Set()
    seenDirs.clear()
    void fetchStatus()
  },
)

defineExpose({ refresh })

// 状态徽章：字母 + 语义色（M 黄 / A 绿 / D 红 / R 紫 / T 青 / U 橙 / ?? 灰）。
const BADGE: Record<string, string> = {
  M: 'text-amber-500',
  A: 'text-emerald-500',
  D: 'text-destructive',
  R: 'text-violet-400',
  T: 'text-cyan-400',
  U: 'text-orange-500',
  '??': 'text-muted-foreground',
}
function badgeOf(c: GitChange): { text: string; cls: string } {
  if (c.x === '?' && c.y === '?') return { text: '??', cls: BADGE['??'] }
  // 取「更有信息量」的一列：index 态优先，纯工作区改动落 y
  const ch = c.x !== '?' ? c.x : c.y
  return { text: ch, cls: BADGE[ch] ?? BADGE.M }
}
function kindTitle(c: GitChange): string {
  const t: Record<string, string> = {
    M: '已修改',
    A: '新增',
    D: '已删除',
    R: '重命名',
    T: '类型变更',
    U: '合并冲突',
    '??': '未跟踪',
  }
  return t[badgeOf(c).text] ?? '已修改'
}

// —— 条目点击：以 git 对比形态打开 ——
// 相对路径拼 toplevel 变容器内绝对路径（openFile/readFile 链路只认绝对路径）；
// R/C 的旧路径经 headPath 传给 diff 端点（HEAD 侧取旧版本 + 标题「旧 → 新」）。
function absOf(rel: string): string {
  const t = view.value?.toplevel ?? ''
  return t === '/' ? `/${rel}` : `${t}/${rel}`
}
function openChange(c: GitChange) {
  emit('open-change', {
    path: absOf(c.file),
    ...(c.oldFile ? { headPath: absOf(c.oldFile) } : {}),
  })
}

// —— 分支菜单（低频操作刻意收进 popover，平时不占面板注意力）——
// 点头部分支名弹出（同 VSCode 状态栏分支入口的心智模型）。为压心智负担，浮层只围绕
// 「找到分支 → 切过去」一件事组织：顶部输入框搜索过滤、输不中现有名字即变新建入口
//（quick pick 模式，无独立创建按钮行）；删除挂在本行 hover 上（默认不占视觉）；fetch
// 收进「远端」段标题的刷新钮（作用点即展示点，仓库没配远端时整段不渲染）；底部只留
// 拉取/推送一对当前分支操作（pull 恒 --ff-only 分叉即拒；push 无上游且恰一个远端时
// 自动 -u 建跟踪）。切换/检出成功关窗并 refresh()；fetch 原地刷列表；pull/push 刷状态
//（ahead/behind）；失败把 git stderr 原话留在窗内，窗不关。
const branchOpen = ref(false)
const branches = ref<GitBranchesView | null>(null)
const branchLoading = ref(false)
const branchErr = ref('')
const branchFilter = ref('')
const busy = ref(false) // 全部分支动作共用一个忙碌位（同一菜单互斥足够）
const fetching = ref(false) // 仅刷新钮的转圈反馈（fetch 可能要等网络几秒）

watch(branchOpen, (open) => {
  if (open) {
    branchErr.value = ''
    branchFilter.value = ''
    branches.value = null // 清上次打开的残留（path 可能已变）
    void fetchBranches()
  }
})

async function fetchBranches() {
  branchLoading.value = true
  try {
    branches.value = await getGitBranches(props.containerId, props.path)
  } catch (e) {
    if (e instanceof Unauthorized) return
    branchErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    branchLoading.value = false
  }
}

// 通用动作包装：busy 互斥 + git 错误原话留窗。after 决定成功后的联动：
// close = 关窗并刷面板状态（切换/新建/检出）；list = 原地刷分支列表（fetch/删分支）；
// status = 刷面板状态（pull/push 影响 ahead/behind）
async function runBranchAction(act: () => Promise<unknown>, after: 'close' | 'list' | 'status') {
  if (busy.value) return
  branchErr.value = ''
  busy.value = true
  try {
    await act()
    if (after === 'close') {
      branchOpen.value = false
      branchFilter.value = ''
      refresh()
    } else if (after === 'list') {
      void fetchBranches()
    } else {
      refresh()
    }
  } catch (e) {
    if (e instanceof Unauthorized) return
    branchErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

// —— 列表派生：搜索过滤 + 远端「待检出」过滤（本地已有对应者的不重复展示）——
const localNames = computed(() => branches.value?.branches ?? [])
const remoteAll = computed(() => branches.value?.remotes ?? [])
function filterHit(s: string): boolean {
  const f = branchFilter.value.trim().toLowerCase()
  return !f || s.toLowerCase().includes(f)
}
const filteredLocals = computed(() => localNames.value.filter(filterHit))
const filteredRemotes = computed(() =>
  remoteAll.value.filter((r) => !localNames.value.includes(r.slice(r.indexOf('/') + 1)) && filterHit(r)),
)
// 新建候选：输入非空且不与任何本地分支/远端短名精确重名（重名时列表里已能点到）
const createCandidate = computed(() => {
  const f = branchFilter.value.trim()
  return f && !localNames.value.includes(f) && !remoteAll.value.includes(f) ? f : ''
})

// 输入框回车：精确命中本地分支 = 切过去；命中远端短名 = 检出；否则按新建处理
function onFilterEnter() {
  const f = branchFilter.value.trim()
  if (!f) return
  if (localNames.value.includes(f)) switchTo(f)
  else if (remoteAll.value.includes(f)) checkoutRemote(f)
  else createBranch()
}
function createBranch() {
  const name = branchFilter.value.trim()
  if (name) void runBranchAction(() => gitCheckout(props.containerId, props.path, name, { create: true }), 'close')
}
const switchTo = (b: string) => runBranchAction(() => gitCheckout(props.containerId, props.path, b), 'close')
const checkoutRemote = (r: string) =>
  runBranchAction(() => gitCheckout(props.containerId, props.path, r, { remote: true }), 'close')
const deleteBranch = (b: string) => runBranchAction(() => gitBranchDelete(props.containerId, props.path, b), 'list')
const fetchRemotes = async () => {
  fetching.value = true
  try {
    await runBranchAction(() => gitFetch(props.containerId, props.path), 'list')
  } finally {
    fetching.value = false
  }
}
const pullCurrent = () => runBranchAction(() => gitPull(props.containerId, props.path), 'status')
const pushCurrent = () => runBranchAction(() => gitPush(props.containerId, props.path), 'status')

// —— dock 高度拖拽（PaneDivider 夹在折叠头与列表之间）：dock 在底部，向上拖（delta<0）
// 变高；像素值持久化 localStorage，跨容器/跨窗口一致（:key 重建也读同一份）。 ——
const H_KEY = 'mysandbox:git-panel-h'
const H_MIN = 80
const H_MAX = 480
function loadH(): number {
  try {
    const v = Number(localStorage.getItem(H_KEY))
    return v >= H_MIN && v <= H_MAX ? v : 160
  } catch {
    return 160
  }
}
const gitH = ref(loadH())
let hDragStart = 0
function onHDragStart() {
  hDragStart = gitH.value
}
function onHDrag(delta: number) {
  gitH.value = Math.min(Math.max(hDragStart - delta, H_MIN), H_MAX)
}
function persistH() {
  try {
    localStorage.setItem(H_KEY, String(gitH.value))
  } catch {
    /* localStorage 不可用就跳过 */
  }
}

// —— 树视图：从变更文件的相对路径聚合目录树（纯前端，8s 轮询重建一次，≤1000 条廉价） ——
interface TreeNode {
  name: string // 目录段名（不带斜杠）
  path: string // 相对 toplevel 的 posix 路径，带尾 /
  dirs: TreeNode[] // 子目录（聚合后按名排序）
  files: GitChange[] // 本目录直属变更文件（聚合后按文件名排序）
  fileCount: number // 子树变更文件总数（后序聚合）
  allUntracked: boolean // 子树全部为 ??（后序聚合；新目录默认折叠的依据）
}

function fileNameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function buildTree(changes: GitChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: [], files: [], fileCount: 0, allUntracked: true }
  const dirMap = new Map<string, TreeNode>([['', root]])
  const dirOf = (p: string): TreeNode => {
    const hit = dirMap.get(p)
    if (hit) return hit
    const slash = p.slice(0, -1).lastIndexOf('/') // p 形如 "a/b/"，父是 "a/" 或 ""
    const parent = dirOf(slash < 0 ? '' : p.slice(0, slash + 1))
    const node: TreeNode = { name: p.slice(slash + 1, -1), path: p, dirs: [], files: [], fileCount: 0, allUntracked: true }
    dirMap.set(p, node)
    parent.dirs.push(node)
    return node
  }
  for (const c of changes) {
    const i = c.file.lastIndexOf('/')
    dirOf(i < 0 ? '' : c.file.slice(0, i + 1)).files.push(c)
  }
  // 后序：先排子再聚合（排序也在此处一并完成）
  const aggregate = (d: TreeNode): boolean => {
    d.dirs.sort((a, b) => a.name.localeCompare(b.name))
    d.files.sort((a, b) => fileNameOf(a.file).localeCompare(fileNameOf(b.file)))
    let n = d.files.length
    let all = true
    for (const c of d.files) if (c.x !== '?' || c.y !== '?') all = false
    for (const s of d.dirs) {
      const sub = aggregate(s)
      n += s.fileCount
      if (!sub) all = false
    }
    d.fileCount = n
    d.allUntracked = all && n > 0
    return d.allUntracked
  }
  aggregate(root)
  return root
}

const tree = computed(() => buildTree(view.value?.changes ?? []))

// 折叠集合（Set 整体替换触发响应）。默认规则只对「首次出现」的目录应用（seenDirs 记账）：
// 8s 轮询不会把用户手动展开的 untracked 目录重新折叠回去。
const collapsedDirs = ref(new Set<string>())
const seenDirs = new Set<string>()

// 扁平行流：目录行 + 可见文件行（跳过折叠目录的子树）
interface TreeRow {
  key: string
  depth: number
  dir?: TreeNode
  change?: GitChange
}
const rows = computed<TreeRow[]>(() => {
  const out: TreeRow[] = []
  const walk = (d: TreeNode, depth: number) => {
    for (const s of d.dirs) {
      out.push({ key: s.path, depth, dir: s })
      if (!collapsedDirs.value.has(s.path)) walk(s, depth + 1)
    }
    for (const c of d.files) out.push({ key: c.file, depth, change: c })
  }
  walk(tree.value, 0)
  return out
})

function toggleDir(p: string) {
  const next = new Set(collapsedDirs.value)
  if (next.has(p)) next.delete(p)
  else next.add(p)
  collapsedDirs.value = next
}

// 数据到达后给新目录应用默认折叠态（同 path 下幂等）
watch(view, (v) => {
  if (!v?.repo) return
  const apply = (d: TreeNode) => {
    for (const s of d.dirs) {
      if (!seenDirs.has(s.path)) {
        seenDirs.add(s.path)
        if (s.allUntracked) collapsedDirs.value.add(s.path)
      }
      apply(s)
    }
  }
  apply(tree.value)
})
</script>

<template>
  <!-- repo:false 时整块不渲染（v-if 在父级也判断，双保险）。dock 在面板底部：border-t -->
  <div v-if="view?.repo" class="shrink-0 border-t border-border">
    <!-- 折叠头：折叠钮 + 分支菜单触发（点分支名弹 popover，低频操作不占注意力）+ 变更数 +
         视图切换。原先整条头都是一个折叠按钮，现把分支名拆出来作分支菜单入口（button 不可
         嵌套 button）；模式按钮同理留在折叠按钮外。 -->
    <div class="flex items-center">
      <button
        class="flex shrink-0 items-center py-1.5 pl-2.5 pr-1 hover:bg-accent/50"
        :title="collapsed ? '展开' : '折叠'"
        @click="collapsed = !collapsed"
      >
        <component :is="collapsed ? ChevronRight : ChevronDown" class="size-3 shrink-0 text-muted-foreground" />
      </button>
      <Popover v-model:open="branchOpen">
        <PopoverTrigger as-child>
          <button
            class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left hover:bg-accent/50"
            title="切换 / 新建分支"
          >
            <GitBranch class="size-3 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" :title="view.label">{{
              view.label
            }}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" :side-offset="6" class="w-64 p-2">
          <!-- 单输入双职：搜索过滤分支；输不中现有名字即成新建入口（无独立创建按钮行） -->
          <Input
            v-model="branchFilter"
            class="mb-1.5 h-7 bg-muted/50 px-2 text-xs md:text-xs"
            placeholder="搜索或新建分支…"
            spellcheck="false"
            autocomplete="off"
            @keydown.enter.prevent="onFilterEnter"
          />
          <p v-if="branchLoading && !branches" class="px-1 py-1 text-[11px] text-muted-foreground">加载中…</p>
          <p
            v-else-if="branches && !localNames.length && !remoteAll.length"
            class="px-1 py-1 text-[11px] text-muted-foreground"
          >
            没有分支（空仓库），输入名字创建第一个
          </p>
          <div v-else class="scroll-thin max-h-56 overflow-y-auto">
            <!-- 新建入口：只在输入了不重名的名字时出现 -->
            <button
              v-if="createCandidate"
              class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              :disabled="busy"
              title="创建并切换"
              @click="createBranch()"
            >
              <Plus class="size-3 shrink-0" />
              <span class="min-w-0 flex-1 truncate">创建并切换到「{{ createCandidate }}」</span>
            </button>
            <template v-for="b in filteredLocals" :key="b">
              <!-- 当前分支：纯展示（不可切到自己），Check 占位对齐其余行名字 -->
              <div
                v-if="b === branches?.current"
                class="flex items-center gap-1.5 rounded bg-accent/40 px-1.5 py-1 font-mono text-xs text-foreground"
              >
                <Check class="size-3 shrink-0" />
                <span class="min-w-0 flex-1 truncate" :title="b">{{ b }}</span>
              </div>
              <!-- 其余本地分支：点击切换，hover 出删除（-d 安全删，未合并的 git 拒绝） -->
              <div v-else class="group flex items-center rounded hover:bg-accent/50">
                <button
                  class="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  :disabled="busy"
                  @click="switchTo(b)"
                >
                  <Check class="size-3 shrink-0 opacity-0" />
                  <span class="min-w-0 flex-1 truncate" :title="b">{{ b }}</span>
                </button>
                <button
                  class="mr-1 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:text-destructive group-hover:opacity-100 disabled:pointer-events-none disabled:opacity-50"
                  :title="`删除分支 ${b}`"
                  :disabled="busy"
                  @click="deleteBranch(b)"
                >
                  <Trash2 class="size-3" />
                </button>
              </div>
            </template>
            <!-- 远端：段标题即 fetch 作用点（刷新钮），条目点击检出为本地跟踪分支 -->
            <template v-if="remoteAll.length">
              <p class="mt-1 flex items-center gap-1 px-1.5 text-[10px] text-muted-foreground/70">
                <span>远端</span>
                <button
                  class="ml-auto rounded p-0.5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  :disabled="busy"
                  title="获取远端更新（fetch --all --prune）"
                  @click="fetchRemotes()"
                >
                  <RefreshCw class="size-3" :class="{ 'animate-spin': fetching }" />
                </button>
              </p>
              <button
                v-for="r in filteredRemotes"
                :key="r"
                class="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-xs text-muted-foreground/80 hover:bg-accent/50 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                :disabled="busy"
                :title="`检出 ${r} 为本地分支`"
                @click="checkoutRemote(r)"
              >
                <Check class="size-3 shrink-0 opacity-0" />
                <span class="min-w-0 flex-1 truncate">{{ r }}</span>
              </button>
              <p v-if="!filteredRemotes.length" class="px-1.5 py-1 text-[10px] text-muted-foreground/50">
                没有待检出的远端分支
              </p>
            </template>
          </div>
          <!-- 底部只留当前分支的拉取/推送（仓库没配远端时整行隐藏；fetch 在远端段标题） -->
          <div v-if="remoteAll.length" class="mt-1.5 flex items-center gap-1 border-t border-border pt-1.5">
            <button
              class="flex-1 rounded bg-muted/50 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              :disabled="busy"
              title="拉取当前分支（pull --ff-only，分叉会拒绝）"
              @click="pullCurrent()"
            >
              拉取
            </button>
            <button
              class="flex-1 rounded bg-muted/50 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              :disabled="busy"
              title="推送当前分支（无上游时自动建立跟踪）"
              @click="pushCurrent()"
            >
              推送
            </button>
          </div>
          <!-- 失败（切换冲突/push 被拒等）把 git stderr 原话留在窗内，窗不关 -->
          <p v-if="branchErr" class="mt-1 whitespace-pre-line px-1 text-[11px] text-destructive">{{ branchErr }}</p>
        </PopoverContent>
      </Popover>
      <span class="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
        {{ view.truncated ? '999+' : (view.changes?.length ?? 0) }}
      </span>
      <div class="flex shrink-0 items-center gap-0.5 pr-1.5">
        <button
          class="rounded p-0.5"
          :class="viewMode === 'list' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'"
          title="平铺列表"
          @click="setMode('list')"
        >
          <List class="size-3" />
        </button>
        <button
          class="rounded p-0.5"
          :class="viewMode === 'tree' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'"
          title="目录树"
          @click="setMode('tree')"
        >
          <FolderTree class="size-3" />
        </button>
      </div>
    </div>
    <!-- 高度拖动条（折叠时无列表可调，一并隐藏）+ 变更列表（默认展开；高度可拖，
         80–480px 记 localStorage——太矮没存在感，太高又挤压目录主体） -->
    <template v-if="!collapsed">
      <PaneDivider vertical @dragstart="onHDragStart" @drag="onHDrag" @dragend="persistH" />
      <div class="scroll-thin overflow-y-auto" :style="{ height: gitH + 'px' }">
        <p v-if="err" class="px-2.5 py-1 text-[11px] text-muted-foreground">{{ err }}</p>
        <p
          v-else-if="!view.changes?.length"
          class="px-2.5 py-1.5 text-[11px] text-muted-foreground"
          title="工作区与 HEAD 无差异"
        >
          无变更
        </p>
        <!-- 平铺：全路径逐文件（服务端 -uall，untracked 目录已展开为单个文件）；点行开对比 -->
        <template v-else-if="viewMode === 'list'">
          <div
            v-for="c in view.changes"
            :key="c.file"
            class="flex cursor-pointer items-center gap-1.5 px-2.5 py-1 hover:bg-accent/50"
            :title="`${kindTitle(c)} · 点击查看对比`"
            @click="openChange(c)"
          >
            <span class="w-4 shrink-0 text-center font-mono text-[10px] font-semibold" :class="badgeOf(c).cls">{{
              badgeOf(c).text
            }}</span>
            <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="c.oldFile ? `${c.oldFile} → ${c.file}` : c.file">
              <template v-if="c.oldFile">{{ c.oldFile }} →</template> {{ c.file }}
            </span>
          </div>
        </template>
        <!-- 目录树：目录行聚合子树计数、点击折叠；文件行只显段名、点行开对比（完整路径进 title） -->
        <template v-else>
          <template v-for="r in rows" :key="r.key">
            <button
              v-if="r.dir"
              class="flex w-full items-center gap-1.5 py-1 pr-2.5 text-left hover:bg-accent/50"
              :style="{ paddingLeft: 8 + r.depth * 12 + 'px' }"
              :title="`${r.dir.fileCount} 个变更文件${r.dir.allUntracked ? '（全部未跟踪）' : ''}`"
              @click="toggleDir(r.dir.path)"
            >
              <component
                :is="collapsedDirs.has(r.dir.path) ? ChevronRight : ChevronDown"
                class="size-3 shrink-0 text-muted-foreground"
              />
              <Folder class="size-3 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ r.dir.name }}</span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground/70">{{ r.dir.fileCount }}</span>
            </button>
            <div
              v-else
              class="flex cursor-pointer items-center gap-1.5 py-1 pr-2.5 hover:bg-accent/50"
              :style="{ paddingLeft: 8 + r.depth * 12 + 'px' }"
              :title="
                r.change
                  ? r.change.oldFile
                    ? `${kindTitle(r.change)} · 点击查看对比 · ${r.change.oldFile} → ${r.change.file}`
                    : `${kindTitle(r.change)} · 点击查看对比 · ${r.change.file}`
                  : ''
              "
              @click="r.change && openChange(r.change)"
            >
              <span
                class="w-4 shrink-0 text-center font-mono text-[10px] font-semibold"
                :class="r.change ? badgeOf(r.change).cls : ''"
              >
                {{ r.change ? badgeOf(r.change).text : '' }}
              </span>
              <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ r.change ? fileNameOf(r.change.file) : '' }}</span>
            </div>
          </template>
        </template>
      </div>
    </template>
  </div>
  <p v-else-if="err" class="shrink-0 border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
    git：{{ err }}
  </p>
</template>
