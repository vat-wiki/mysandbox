<script setup lang="ts">
// 文件面板内嵌的「Git 变更」区块：面板当前目录位于 git 仓库内时展示分支与变更文件列表。
// path（面板当前目录）是唯一刷新键：跟随/手动导航、外部 locate 都只是换 path。
// 非仓库目录整块不渲染；结果含 repo:false 时缓存住，同一 path 下不再重复打（/etc 这类
// 目录不每 8s 白跑一次 rev-parse）。列表纯展示：条目不可点，点开文件走上方目录列表。
// 视图双模式：list 平铺（服务端 -uall 保证全是单个文件、无目录条目）/ tree 目录树
// （前端按相对路径聚合；纯 untracked 子树默认折叠——大 untracked 目录不刷屏，同 git
// porcelain / VSCode 的折叠展示习惯）。模式存 localStorage，跨窗口一致。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { getGitStatus, Unauthorized, type GitStatusView, type GitChange } from '@/lib/api'
import { GitBranch, ChevronDown, ChevronRight, List, FolderTree, Folder } from 'lucide-vue-next'

const props = defineProps<{
  containerId: string
  path: string
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
    <!-- 折叠头：分支 + 变更数 + 视图切换。模式按钮放在折叠按钮外（button 不可嵌套 button） -->
    <div class="flex items-center">
      <button
        class="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2.5 text-left hover:bg-accent/50"
        @click="collapsed = !collapsed"
      >
        <component :is="collapsed ? ChevronRight : ChevronDown" class="size-3 shrink-0 text-muted-foreground" />
        <GitBranch class="size-3 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" :title="view.label">{{
          view.label
        }}</span>
        <span class="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
          {{ view.truncated ? '999+' : (view.changes?.length ?? 0) }}
        </span>
      </button>
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
    <!-- 变更列表：默认展开、高度定档 h-40（可滚动）——太矮没存在感，太高又挤压目录主体 -->
    <div v-if="!collapsed" class="scroll-thin h-40 overflow-y-auto">
      <p v-if="err" class="px-2.5 py-1 text-[11px] text-muted-foreground">{{ err }}</p>
      <p
        v-else-if="!view.changes?.length"
        class="px-2.5 py-1.5 text-[11px] text-muted-foreground"
        title="工作区与 HEAD 无差异"
      >
        无变更
      </p>
      <!-- 平铺：全路径逐文件（服务端 -uall，untracked 目录已展开为单个文件） -->
      <template v-else-if="viewMode === 'list'">
        <div
          v-for="c in view.changes"
          :key="c.file"
          class="flex items-center gap-1.5 px-2.5 py-1"
          :title="kindTitle(c)"
        >
          <span class="w-4 shrink-0 text-center font-mono text-[10px] font-semibold" :class="badgeOf(c).cls">{{
            badgeOf(c).text
          }}</span>
          <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="c.oldFile ? `${c.oldFile} → ${c.file}` : c.file">
            <template v-if="c.oldFile">{{ c.oldFile }} →</template> {{ c.file }}
          </span>
        </div>
      </template>
      <!-- 目录树：目录行聚合子树计数、点击折叠；文件行只显段名（完整路径进 title） -->
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
            class="flex items-center gap-1.5 py-1 pr-2.5"
            :style="{ paddingLeft: 8 + r.depth * 12 + 'px' }"
            :title="
              r.change
                ? r.change.oldFile
                  ? `${kindTitle(r.change)} · ${r.change.oldFile} → ${r.change.file}`
                  : `${kindTitle(r.change)} · ${r.change.file}`
                : ''
            "
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
  </div>
  <p v-else-if="err" class="shrink-0 border-t border-border px-2.5 py-1 text-[11px] text-muted-foreground">
    git：{{ err }}
  </p>
</template>
