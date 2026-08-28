<script setup lang="ts">
// 终端会话对话框（tab 栏右上角归档图标）。三块能力：
//   1) 恢复本窗口隐藏的终端组——tab 右键「隐藏」收进来的，恢复 = 原样插回，会话一直活着；
//   2) 列出服务端扫到的**全部**活跃会话（运行中容器 + 宿主），本窗口已打开的标「已打开」、
//      其他窗口正连着的标「使用中」，谁都不排除——接入 = 用该会话的 termId 建组（termId
//      不变 → 后端 attach 回原会话，滚动历史/进程现场全保留）；
//   3) 结束不再需要的会话（真杀 tmux 会话，别的窗口里它就断了）。
// 布局恢复的取舍：同容器多会话「全部接入」合并成一个 row 分屏组（≤4 块）；跨窗口拿不回
// 原分屏树——布局是各窗口自己的 localStorage 状态，不是服务端状态。
import { ref, computed, onMounted } from 'vue'
import { TerminalSquare, RefreshCw, Trash2 } from 'lucide-vue-next'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const props = defineProps<{
  // 本窗口隐藏的终端组（父级已在打开时剪掉容器已删的）
  hidden: TermGroup[]
  // 本窗口已占用的会话 key（可见 + 隐藏组的全部叶子）：列表里标「已打开」，不排除任何会话
  occupied: Set<string>
  items: ContainerView[]
}>()
const emit = defineEmits<{
  (e: 'restore', g: TermGroup): void
  (e: 'adopt', sessions: TermSessionView[]): void
  (e: 'close'): void
  (e: 'unauthorized'): void
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

// 隐藏组的显示名：隐藏列表里没有「同容器还有几组」的上下文，序号直接带上（隐藏的组
// 多半本来就带着 dev·2 这类序号）。
function hiddenLabel(g: TermGroup): string {
  return g.seq ? `${g.name}·${g.seq}` : g.name
}
// 会话归属地（确认文案用）：宿主 / 容器显示名，容器已删则退回 id。
function sessionWhere(s: TermSessionView): string {
  if (s.kind === 'host') return '宿主'
  const c = props.items.find((x) => x.id === s.containerId)
  return (c ? c.displayName || c.name : s.containerId) || '?'
}

// ---- 远端会话按容器/宿主分组 ----
interface RemoteRow {
  host: boolean
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
    const k = s.kind === 'host' ? 'host' : `c:${s.containerId}`
    let r = rows.get(k)
    if (!r) {
      if (s.kind === 'host') {
        r = { host: true, name: '宿主', color: '#f59e0b', sessions: [] }
      } else {
        const c = props.items.find((x) => x.id === s.containerId)
        r = {
          host: false,
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
  // 排序：宿主置顶（与侧栏一致）→ 已知容器按列表序 → 容器已删的垫底
  for (const s of list) if (s.kind === 'host') rowFor(s).sessions.push(s)
  for (const c of props.items)
    for (const s of list) if (s.kind === 'container' && s.containerId === c.id) rowFor(s).sessions.push(s)
  for (const s of list)
    if (s.kind === 'container' && !props.items.some((c) => c.id === s.containerId))
      rowFor(s).sessions.push(s)
  return [...rows.values()]
})

function relTime(ms: number): string {
  if (!ms) return ''
  const sec = Math.max(1, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
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
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <TerminalSquare class="size-4" /> 终端会话
        </DialogTitle>
      </DialogHeader>

      <p
        v-if="err"
        class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >{{ err }}</p>

      <div class="-mx-1 max-h-[55vh] overflow-y-auto px-1 scroll-thin">
        <!-- 本窗口隐藏的终端组：空则整块不显示（没隐藏过的人不该看到这个概念） -->
        <template v-if="hidden.length">
          <div class="px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
            隐藏（{{ hidden.length }}）
          </div>
          <div
            v-for="g in hidden"
            :key="g.id"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
          >
            <span
              class="h-2 w-2 shrink-0 rounded-full"
              :style="{ backgroundColor: g.kind === 'host' ? '#f59e0b' : containerColor(g.containerId) }"
            />
            <span class="min-w-0 flex-1 truncate font-mono text-sm" :title="hiddenLabel(g)">{{ hiddenLabel(g) }}</span>
            <span class="shrink-0 text-[10px] text-muted-foreground">{{ leafCount(g.root) }} 窗格</span>
            <Button variant="outline" size="xs" class="shrink-0" @click="emit('restore', g)">恢复</Button>
          </div>
        </template>

        <!-- 全部活跃会话（服务端扫描，含本窗口已打开的） -->
        <div
          class="flex items-center gap-2 border-t border-border px-2 pb-1 pt-3 text-xs font-semibold text-muted-foreground"
          :class="hidden.length ? 'mt-3' : ''"
        >
          <span>活跃会话</span>
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
        <div v-for="row in remoteRows" :key="row.containerId ?? 'host'" class="pb-1">
          <div class="flex items-center gap-2 px-2 py-1">
            <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: row.color }" />
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ row.name }}</span>
            <span class="shrink-0 text-[10px] text-muted-foreground">{{ row.sessions.length }}</span>
            <Button
              v-if="row.sessions.length > 1"
              variant="ghost"
              size="xs"
              class="h-6 shrink-0 text-xs text-muted-foreground"
              title="合并为一个分屏组"
              @click="emit('adopt', row.sessions.slice(0, MAX_GROUP_PANES))"
            >全部接入</Button>
          </div>
          <div
            v-for="s in row.sessions"
            :key="s.termId"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
          >
            <span
              class="min-w-0 flex-1 truncate pl-4 font-mono text-xs text-muted-foreground"
              :title="s.cwd"
            >{{ s.cwd || '…' }}</span>
            <Badge
              v-if="occupied.has(termSessionKey(s.kind, s.containerId, s.termId))"
              variant="outline"
              class="shrink-0 border-transparent bg-primary/15 text-[10px] text-primary"
            >已打开</Badge>
            <Badge
              v-else-if="s.attached > 0"
              variant="outline"
              class="shrink-0 border-transparent bg-emerald-500/15 text-[10px] text-emerald-500"
            >使用中</Badge>
            <span class="shrink-0 text-[10px] text-muted-foreground/70">{{ relTime(s.created) }}</span>
            <Button variant="outline" size="xs" class="shrink-0" @click="emit('adopt', [s])">接入</Button>
            <Button
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground hover:text-destructive"
              title="结束会话"
              @click="killTarget = s"
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        v-if="killTarget"
        title="结束会话"
        :description="`结束 ${sessionWhere(killTarget)} 的会话？进程会被终止。`"
        confirm-text="结束会话"
        variant="destructive"
        @confirm="doKill"
        @close="killTarget = null"
      />
    </DialogContent>
  </Dialog>
</template>
