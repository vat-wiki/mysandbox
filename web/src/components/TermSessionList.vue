<script setup lang="ts">
// 全局终端会话列表（TermSessionsDialog / 侧栏终端区 / rail「所有终端」popover 三处共用）。
// 主体 = 服务端扫到的**全部**活跃会话（运行中容器 + 宿主 + 服务 + SSH，跨窗口跨浏览器）：
// 本窗口已打开的标「已打开」、其他窗口正连着的标「使用中」，谁都不排除——接入 = 用该
// 会话的 termId 建组（termId 不变 → 后端 attach 回原会话，滚动历史/进程现场全保留）。
// 末尾附带本窗口隐藏组的恢复（tab 右键「隐藏」），以及结束会话（真杀 tmux 会话，别的
// 窗口里它就断了）。挂载即扫一轮、无轮询（扫描是跨容器 exec 风暴）——刷新走手动。
// 布局恢复的取舍：同容器多会话「全部接入」合并成一个 row 分屏组（≤4 块）；跨窗口拿不回
// 原分屏树——布局是各窗口自己的 localStorage 状态，不是服务端状态。
import { ref, computed, onMounted, watch } from 'vue'
import { ChevronDown, RefreshCw, Trash2 } from 'lucide-vue-next'
import {
  listTermSessions,
  killTermSession,
  termSessionKey,
  Unauthorized,
  type ContainerView,
  type TermSessionView,
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { MAX_GROUP_PANES, leafCount, type TermGroup } from '@/lib/termlayout'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{
  // 本窗口隐藏的终端组（父级已在打开时剪掉容器已删的）
  hidden: TermGroup[]
  // 隐藏组里挂着「无输出提醒」标的组 id：行内身份点描琥珀边，与 tab 上的琥珀点同义
  attentionIds?: Set<string>
  // 本窗口已占用的会话 key（可见 + 隐藏组的全部叶子）：列表里标「已打开」，不排除任何会话
  occupied: Set<string>
  items: ContainerView[]
  // bare：不渲染内部「活跃会话」头——侧栏把本组件升格为独立分区、自带同款分区头，
  // 内部头只服务对话框 / rail popover 两个形态。
  bare?: boolean
  // scanKey：外部触发重新扫描（侧栏分区头的 ⟳），计数变化即扫一轮。
  scanKey?: number
}>()
const emit = defineEmits<{
  (e: 'restore', g: TermGroup): void
  (e: 'adopt', sessions: TermSessionView[]): void
  (e: 'unauthorized'): void
  // 会话总数上报：侧栏分区头显示计数用（对话框 / rail 不订阅）。
  (e: 'count', n: number): void
}>()

// ---- 服务端会话扫描 ----
const sessions = ref<TermSessionView[]>([])
const loading = ref(false)
const err = ref('')
async function load() {
  loading.value = true
  err.value = ''
  try {
    sessions.value = (await listTermSessions()).sessions
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(
  () => props.scanKey,
  () => {
    if (props.scanKey !== undefined) void load()
  },
)
watch(sessions, (s) => emit('count', s.length), { immediate: true })

// 隐藏组的显示名：隐藏列表里没有「同容器还有几组」的上下文，序号直接带上（隐藏的组
// 多半本来就带着 dev·2 这类序号）。
function hiddenLabel(g: TermGroup): string {
  return g.seq ? `${g.name}·${g.seq}` : g.name
}
// 会话归属地（确认文案用）：宿主 / 容器 / 服务 / SSH 主机显示名，容器已删则退回 id。
function sessionWhere(s: TermSessionView): string {
  if (s.kind === 'host') return '本机'
  if (s.kind === 'ssh') return s.containerId || 'SSH 主机'
  if (s.kind === 'service') return s.containerId || '服务'
  const c = props.items.find((x) => x.id === s.containerId)
  return (c ? c.displayName || c.name : s.containerId) || '?'
}

// ---- 远端会话按容器/宿主/服务/SSH 主机分组 ----
interface RemoteRow {
  host: boolean
  key: string
  service?: boolean
  containerId?: string
  name: string
  color: string
  sessions: TermSessionView[]
}

const remoteRows = computed<RemoteRow[]>(() => {
  // 不做排除：服务端扫到的会话全列。本窗口已打开的标「已打开」（接入按钮同时保留——
  // 重复接入会在同 tmux 会话上多挂一个 attach 客户端，合法且现场一致）。
  const list = sessions.value
  const rows = new Map<string, RemoteRow>()
  const rowFor = (s: TermSessionView): RemoteRow => {
    const k =
      s.kind === 'host'
        ? 'host'
        : s.kind === 'ssh'
          ? `x:${s.containerId}`
          : s.kind === 'service'
            ? `s:${s.containerId}`
            : `c:${s.containerId}`
    let r = rows.get(k)
    if (!r) {
      if (s.kind === 'host') {
        r = { host: true, key: k, name: '本机', color: '#f59e0b', sessions: [] }
      } else if (s.kind === 'ssh') {
        // SSH 会话本体在远端 tmux（server/sshTerminal.ts）：目标名即身份，色沿用名字 hash。
        r = {
          host: false,
          key: k,
          containerId: s.containerId,
          name: s.containerId || 'SSH 主机',
          color: containerColor(s.containerId ?? ''),
          sessions: [],
        }
      } else if (s.kind === 'service') {
        r = {
          host: false,
          key: k,
          service: true,
          containerId: s.containerId,
          name: s.containerId || '服务',
          color: containerColor(s.containerId ?? ''),
          sessions: [],
        }
      } else {
        const c = props.items.find((x) => x.id === s.containerId)
        r = {
          host: false,
          key: k,
          containerId: s.containerId,
          name: c ? c.displayName || c.name : s.containerId || '?',
          color: containerColor(s.containerId ?? ''),
          sessions: [],
        }
      }
      rows.set(k, r)
    }
    return r
  }
  // 排序：本机置顶 → SSH 主机 → 已知容器按列表序 → 容器已删的垫底 → 服务最后
  for (const s of list) if (s.kind === 'host') rowFor(s).sessions.push(s)
  for (const s of list) if (s.kind === 'ssh') rowFor(s).sessions.push(s)
  for (const c of props.items)
    for (const s of list) if (s.kind === 'container' && s.containerId === c.id) rowFor(s).sessions.push(s)
  for (const s of list)
    if (s.kind === 'container' && !props.items.some((c) => c.id === s.containerId))
      rowFor(s).sessions.push(s)
  for (const s of list) if (s.kind === 'service') rowFor(s).sessions.push(s)
  return [...rows.values()]
})

// ---- 组折叠：同组大量无标题 shell（dev@dev:~ 刷屏）平铺没有信息量——组行可折叠，
// 首次出现 ≤3 个会话自动展开、更多默认收起（对话框/侧栏/rail 同规则）----
const GROUP_AUTO_OPEN = 3
const openGroups = ref(new Set<string>())
const knownGroups = new Set<string>()
watch(remoteRows, (rows) => {
  for (const r of rows) {
    if (!knownGroups.has(r.key)) {
      knownGroups.add(r.key)
      if (r.sessions.length <= GROUP_AUTO_OPEN) openGroups.value.add(r.key)
    }
  }
}, { immediate: true })
function groupToggle(key: string) {
  if (openGroups.value.has(key)) openGroups.value.delete(key)
  else openGroups.value.add(key)
}

function relTime(ms: number): string {
  if (!ms) return ''
  const sec = Math.max(1, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}时`
  return `${Math.floor(h / 24)}天`
}

// ---- 结束会话（孤儿清理）----
const killTarget = ref<TermSessionView | null>(null)
async function doKill() {
  const t = killTarget.value
  if (!t) return
  killTarget.value = null
  try {
    await killTermSession(t)
    await load()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}
</script>

<template>
  <p
    v-if="err"
    class="mx-2 my-1 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
  >{{ err }}</p>

  <!-- 全部活跃会话（服务端扫描，含本窗口已打开的）＝主体。
       行为模型：整行点击 = 接入（组行 = 全部接入），破坏性动作（结束）hover 才浮现——
       窄栏（侧栏/rail）下常驻按钮会把标题挤成「…」，触屏（对话框 max-md）常显。 -->
  <div v-if="!bare" class="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
    <span>活跃会话</span>
    <span v-if="sessions.length" class="text-[10px] font-normal text-muted-foreground/70">{{ sessions.length }}</span>
    <Button
      variant="ghost"
      size="icon-xs"
      class="ml-auto size-5"
      :disabled="loading"
      title="重新扫描"
      @click="load"
    >
      <RefreshCw :class="loading ? 'animate-spin' : ''" />
    </Button>
  </div>
  <div v-if="loading && !sessions.length" class="px-2 pb-2 text-xs text-muted-foreground/70">扫描中…</div>
  <div v-else-if="!remoteRows.length" class="px-2 pb-2 text-xs text-muted-foreground/70">无</div>
  <div v-for="row in remoteRows" :key="row.containerId ?? 'host'" class="pb-0.5">
    <!-- 组行：身份色条 + 名字 + 折叠 chevron + 计数（侧栏卡片同款语言）。
         多会话组：点名字/箭头 = 展开收起，hover 浮现「全部接入」；单会话组：整行 = 接入。 -->
    <div class="group/grp relative mx-1 flex min-w-0 items-center gap-1 rounded-md py-1 pl-3.5 pr-2 transition-colors hover:bg-accent/40">
      <span class="absolute inset-y-1 left-0 w-[3px] rounded-full" :style="{ backgroundColor: row.color }" />
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1 text-left"
        :title="row.sessions.length > 1 ? (openGroups.has(row.key) ? '收起' : '展开') : '点击接入'"
        @click="row.sessions.length > 1 ? groupToggle(row.key) : emit('adopt', row.sessions)"
      >
        <ChevronDown
          v-if="row.sessions.length > 1"
          class="size-3 shrink-0 text-muted-foreground transition-transform"
          :class="openGroups.has(row.key) ? 'rotate-180' : ''"
        />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ row.name }}</span>
      </button>
      <button
        v-if="row.sessions.length > 1"
        type="button"
        class="hidden shrink-0 text-[10px] text-muted-foreground hover:text-foreground group-hover/grp:inline"
        title="合并为一个分屏组"
        @click="emit('adopt', row.sessions.slice(0, MAX_GROUP_PANES))"
      >全部接入</button>
      <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{{ row.sessions.length }}</span>
    </div>
    <template v-if="openGroups.has(row.key)">
      <div
        v-for="s in row.sessions"
        :key="`${s.backend ?? 'tmux'}:${s.termId}`"
        class="group/srow mx-1 ml-3.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 pl-2 pr-1.5 transition-colors hover:bg-accent/40"
        :title="`点击接入：${s.title || s.cwd || '未命名会话'}`"
        @click="emit('adopt', [s])"
      >
        <span
          class="min-w-0 flex-1 truncate font-mono text-xs"
          :class="s.title ? 'text-foreground/75' : 'text-muted-foreground'"
        >{{ s.title || s.cwd || '…' }}</span>
        <Badge
          v-if="occupied.has(termSessionKey(s.kind, s.containerId, s.termId))"
          variant="outline"
          class="shrink-0 border-transparent bg-primary/15 px-1 text-[10px] text-primary"
        >已打开</Badge>
        <Badge
          v-if="s.backend === 'msmux'"
          variant="outline"
          class="shrink-0 border-transparent bg-violet-500/15 px-1 text-[10px] text-violet-500"
          title="由 msmux 管理的会话"
        >mux</Badge>
        <Badge
          v-else-if="s.attached > 0"
          variant="outline"
          class="shrink-0 border-transparent bg-emerald-500/15 px-1 text-[10px] text-emerald-500"
        >使用中</Badge>
        <span class="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{{ relTime(s.created) }}</span>
        <span
          class="shrink-0 cursor-pointer text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/srow:opacity-100 max-md:opacity-100"
          title="结束会话"
          @click.stop="killTarget = s"
        >
          <Trash2 class="size-3.5" />
        </span>
      </div>
    </template>
  </div>

  <!-- 本窗口隐藏的终端组：藏在末尾，空则整块不显示；整行点击 = 恢复 -->
  <template v-if="hidden.length">
    <div class="mt-2 border-t border-border px-2 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
      隐藏（{{ hidden.length }}）
    </div>
    <div
      v-for="g in hidden"
      :key="g.id"
      class="group/hrow mx-1 flex min-w-0 cursor-pointer items-center gap-2 rounded-md py-1.5 pl-3 pr-2 transition-colors hover:bg-accent/40"
      :title="`点击恢复：${hiddenLabel(g)}`"
      @click="emit('restore', g)"
    >
      <span
        class="h-2 w-2 shrink-0 rounded-full"
        :class="props.attentionIds?.has(g.id) && 'ring-2 ring-amber-400 ring-offset-1 ring-offset-popover'"
        :style="{ backgroundColor: g.kind === 'host' ? '#f59e0b' : containerColor(g.containerId) }"
      />
      <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="hiddenLabel(g)">{{ hiddenLabel(g) }}</span>
      <span class="shrink-0 text-[10px] text-muted-foreground">{{ leafCount(g.root) }} 窗格</span>
      <span class="hidden shrink-0 text-[10px] text-muted-foreground group-hover/hrow:inline">恢复</span>
    </div>
  </template>

  <ConfirmDialog
    v-if="killTarget"
    title="结束会话"
    :description="`结束 ${sessionWhere(killTarget)} 的会话？进程会被终止。`"
    confirm-text="结束会话"
    variant="destructive"
    @confirm="doKill"
    @close="killTarget = null"
  />
</template>
