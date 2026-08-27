<script setup lang="ts">
// 文件面板内嵌的「Git 变更」区块：面板当前目录位于 git 仓库内时展示分支与变更文件列表。
// path（面板当前目录）是唯一刷新键：跟随/手动导航、外部 locate 都只是换 path。
// 非仓库目录整块不渲染；结果含 repo:false 时缓存住，同一 path 下不再重复打（/etc 这类
// 目录不每 8s 白跑一次 rev-parse）。变更文件点击分流：普通条目抛 open-change（父级开
// diff 对比）、untracked 回退普通打开、折叠目录条目抛 locate-dir 进目录浏览。
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { getGitStatus, Unauthorized, type GitStatusView, type GitChange } from '@/lib/api'
import { GitBranch, ChevronDown, ChevronRight } from 'lucide-vue-next'

const props = defineProps<{
  containerId: string
  path: string
}>()
const emit = defineEmits<{
  (e: 'open-change', c: { absPath: string; oldAbsPath?: string; entry: GitChange }): void
  (e: 'open-file', path: string): void
  (e: 'locate-dir', path: string): void
}>()

const view = ref<GitStatusView | null>(null)
const err = ref('') // 温和降级：灰字提示，不进面板主错误条
const collapsed = ref(false) // 折叠态本地保存（path 变不清，切容器随 :key 重建复位）

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

// path / 容器变化立刻重查（含从仓库内走到仓库外的场景）
watch(
  () => [props.containerId, props.path],
  () => {
    notRepoKey = ''
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
function toAbs(rel: string): string {
  const top = view.value?.toplevel ?? ''
  return top === '/' ? `/${rel}` : `${top}/${rel.replace(/\/$/, '')}`
}
function onClick(c: GitChange) {
  if (c.file.endsWith('/')) {
    // untracked 折叠目录：进目录浏览（porcelain 对未跟踪目录默认折叠为 dir/）
    emit('locate-dir', toAbs(c.file))
    return
  }
  if (c.x === '?' && c.y === '?') {
    emit('open-file', toAbs(c.file)) // 无 HEAD 版本可对比，回退普通打开
    return
  }
  emit('open-change', {
    absPath: toAbs(c.file),
    oldAbsPath: c.oldFile ? toAbs(c.oldFile) : undefined,
    entry: c,
  })
}
</script>

<template>
  <!-- repo:false 时整块不渲染（v-if 在父级也判断，双保险） -->
  <div v-if="view?.repo" class="shrink-0 border-b border-border">
    <!-- 折叠头：分支 + 变更数 -->
    <button
      class="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/50"
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
    <!-- 变更列表：高度受限（可滚动，不挤压下方目录主体） -->
    <div v-if="!collapsed" class="scroll-thin max-h-72 overflow-y-auto">
      <p v-if="err" class="px-2.5 py-1 text-[11px] text-muted-foreground">{{ err }}</p>
      <p
        v-else-if="!view.changes?.length"
        class="px-2.5 py-1.5 text-[11px] text-muted-foreground"
        title="工作区与 HEAD 无差异"
      >
        无变更
      </p>
      <div
        v-for="c in view.changes"
        :key="c.file"
        class="flex cursor-pointer items-center gap-1.5 px-2.5 py-1 hover:bg-accent/50"
        :title="kindTitle(c)"
        @click="onClick(c)"
      >
        <span class="w-4 shrink-0 text-center font-mono text-[10px] font-semibold" :class="badgeOf(c).cls">{{
          badgeOf(c).text
        }}</span>
        <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="c.oldFile ? `${c.oldFile} → ${c.file}` : c.file">
          <template v-if="c.oldFile">{{ c.oldFile }} →</template> {{ c.file }}
        </span>
      </div>
    </div>
  </div>
  <p v-else-if="err" class="shrink-0 border-b border-border px-2.5 py-1 text-[11px] text-muted-foreground">
    git：{{ err }}
  </p>
</template>
