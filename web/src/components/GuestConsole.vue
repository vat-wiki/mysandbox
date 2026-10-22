<script setup lang="ts">
// 受限账户的精简工作区：白名单容器的终端 + 文件面板（+文件编辑），仅此而已。
// 与 ContainerList 的关系：刻意不复用（ContainerList 深 CEO 化的管理面——服务/AI/
// 批量/宿主终端等对账户全是 403），独立轻量壳直接组装 Terminal/FilePanel/
// FileEditorPane 三个既有组件；安全边界在后端 hook（deny-by-default），这里只做 UX。
// 鉴权失败（token 被撤销等）emit unauthorized 由 App 清凭证弹回 TokenGate。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  listContainers,
  clearAccountToken,
  Unauthorized,
  type ContainerView,
} from '@/lib/api'
import { gatePoll } from '@/lib/linkQuality'
import { newId } from '@/lib/id'
import { containerColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import Terminal from '@/components/Terminal.vue'
import FilePanel from '@/components/FilePanel.vue'
import FileEditorPane from '@/components/FileEditorPane.vue'
import { Plus, FolderOpen, LogOut, X } from 'lucide-vue-next'

const props = defineProps<{
  accountName: string
  containers: string[] // 白名单（登录时下发，列表拉取失败时的兜底）
}>()
const emit = defineEmits<{ (e: 'unauthorized'): void }>()

function isUnauth(e: unknown): boolean {
  return e instanceof Unauthorized
}

// —— 容器列表（后端按白名单过滤后的视图，含状态/displayName）——
const items = ref<ContainerView[]>([])
const listErr = ref(false)
async function refresh() {
  try {
    const r = await listContainers()
    items.value = r.items
    listErr.value = false
  } catch (e) {
    if (isUnauth(e)) return emit('unauthorized')
    listErr.value = true
  }
}
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void refresh()
  timer = setInterval(gatePoll(refresh, 5_000), 5_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

// 展示名：后端列表命中用 displayName；拉不到（断连瞬间）退 props 白名单名。
const railItems = computed(() => {
  if (items.value.length) {
    return items.value.map((c) => ({
      id: c.name,
      name: c.displayName || c.name,
      running: c.state === 'running',
    }))
  }
  return props.containers.map((n) => ({ id: n, name: n, running: false }))
})
const stateOf = (id: string): string =>
  items.value.find((c) => c.name === id)?.state ?? ''

// —— 终端 tabs：全账户扁平一份（跨容器），termId 持久化 → 刷新重挂原会话 ——
interface GuestTerm {
  containerId: string
  containerName: string
  termId: string
}
const TERMS_KEY = 'mysandbox:guest-terms-v1'
const terms = ref<GuestTerm[]>(loadTerms())
const activeIdx = ref(0)
function loadTerms(): GuestTerm[] {
  try {
    const raw = JSON.parse(localStorage.getItem(TERMS_KEY) ?? '[]') as GuestTerm[]
    // 白名单可能已收缩：剔除不再允许的容器 tab（后端也会 403，这里是不让死 tab 出现）
    return raw.filter((t) => props.containers.includes(t.containerId))
  } catch {
    return []
  }
}
watch(terms, (v) => localStorage.setItem(TERMS_KEY, JSON.stringify(v)), { deep: true })

const activeTerm = computed(() => terms.value[activeIdx.value] ?? null)

function openContainer(id: string) {
  const idx = terms.value.findIndex((t) => t.containerId === id)
  if (idx >= 0) return (activeIdx.value = idx)
  const c = items.value.find((x) => x.name === id)
  terms.value.push({
    containerId: id,
    containerName: c?.displayName || id,
    termId: newId(), // crypto.randomUUID 只在 secure context 有——IP 口径 http 访问走 newId 兜底（lib/id.ts）
  })
  activeIdx.value = terms.value.length - 1
}

// termId -> Terminal 组件实例（✕ 关 tab 时发 kill 帧真杀会话，与 ContainerList 同语义）
const termRefs = new Map<string, InstanceType<typeof Terminal>>()
function setTermRef(termId: string, el: unknown) {
  if (el) termRefs.set(termId, el as InstanceType<typeof Terminal>)
  else termRefs.delete(termId)
}
function closeTerm(idx: number) {
  const t = terms.value[idx]
  if (!t) return
  termRefs.get(t.termId)?.kill()
  termRefs.delete(t.termId)
  terms.value.splice(idx, 1)
  if (activeIdx.value >= terms.value.length) activeIdx.value = terms.value.length - 1
}

// —— 文件面板 + 编辑器 ——
const showFiles = ref(false)
const browseMode = ref<'drill' | 'expand'>('drill')
const filePaneTermId = ref<string | null>(null)
// pane 跟随：单 pane 组即当前 tab 的 termId；聚焦/切换 tab 时对齐。
watch(
  () => activeTerm.value?.termId,
  (t) => (filePaneTermId.value = t ?? null),
  { immediate: true },
)
interface GuestEditor {
  containerId: string
  containerName: string
  path: string
}
const editors = ref<GuestEditor[]>([])
const activeEditor = ref(0)
function openEditor(p: string) {
  const t = activeTerm.value
  if (!t) return
  const i = editors.value.findIndex((e) => e.containerId === t.containerId && e.path === p)
  if (i >= 0) return (activeEditor.value = i)
  editors.value.push({ containerId: t.containerId, containerName: t.containerName, path: p })
  activeEditor.value = editors.value.length - 1
}
// 文件面板 open-file 汇聚点：桌面编辑器覆盖列打开；手机面板是全屏覆盖层，开完编辑器
// 要把面板收回去（window 不能进模板表达式，收拢成方法）。
function openFileFromPanel(p: string) {
  openEditor(p)
  if (window.innerWidth < 768) showFiles.value = false
}
function closeEditor(i: number) {
  editors.value.splice(i, 1)
  if (activeEditor.value >= editors.value.length) activeEditor.value = editors.value.length - 1
}

function logout() {
  clearAccountToken()
  emit('unauthorized')
}
</script>

<template>
  <div class="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <!-- 顶栏：品牌 + 身份 + 登出。受限视图无侧栏管理块，品牌块即唯一标识 -->
    <header class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
      <img src="/logo.svg" alt="" class="size-4" />
      <span class="text-sm font-semibold tracking-tight">MySandbox</span>
      <span class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
        受限 · {{ accountName }}
      </span>
      <span class="ml-auto text-[11px] text-muted-foreground">
        {{ railItems.length }} 个授权容器
      </span>
      <Button variant="ghost" size="icon-xs" title="退出登录" @click="logout">
        <LogOut />
      </Button>
    </header>

    <div class="relative flex min-h-0 flex-1">
      <!-- 容器栏：授权容器一览（状态点 + 名），点选开/切终端。手机收窄成横向 chips -->
      <aside class="hidden w-44 shrink-0 flex-col overflow-y-auto border-r p-1.5 md:flex">
        <button
          v-for="c in railItems"
          :key="c.id"
          type="button"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/50"
          :class="activeTerm?.containerId === c.id ? 'bg-accent' : ''"
          @click="openContainer(c.id)"
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :class="stateOf(c.id) === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'"
          />
          <span class="h-3.5 w-1 shrink-0 rounded" :style="{ background: containerColor(c.id) }" />
          <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
        </button>
        <p v-if="!railItems.length" class="px-2 py-4 text-xs text-muted-foreground">
          没有授权容器，请联系管理员。
        </p>
        <p v-if="listErr" class="px-2 py-2 text-[11px] text-amber-600 dark:text-amber-400">
          列表拉取失败，显示缓存
        </p>
      </aside>

      <div class="flex min-h-0 flex-1 flex-col">
        <!-- 手机容器 chips（桌面走左侧栏） -->
        <div class="flex shrink-0 gap-1 overflow-x-auto border-b p-1.5 md:hidden">
          <button
            v-for="c in railItems"
            :key="c.id"
            type="button"
            class="flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
            :class="activeTerm?.containerId === c.id ? 'bg-accent' : ''"
            @click="openContainer(c.id)"
          >
            <span
              class="size-1.5 rounded-full"
              :class="stateOf(c.id) === 'running' ? 'bg-emerald-500' : 'bg-muted-foreground/40'"
            />
            {{ c.name }}
          </button>
        </div>

        <!-- 终端 tabs -->
        <div class="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5">
          <button
            v-for="(t, i) in terms"
            :key="t.termId"
            type="button"
            class="group flex max-w-40 items-center gap-1 rounded px-2 py-1 text-xs"
            :class="i === activeIdx ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'"
            :title="t.containerName"
            @click="activeIdx = i"
          >
            <span class="h-2.5 w-1 shrink-0 rounded" :style="{ background: containerColor(t.containerId) }" />
            <span class="min-w-0 flex-1 truncate">{{ t.containerName }}</span>
            <X
              class="size-3 shrink-0 opacity-0 group-hover:opacity-60 hover:!opacity-100"
              @click.stop="closeTerm(i)"
            />
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            :disabled="!activeTerm"
            :title="activeTerm ? '新建终端' : '先选择容器'"
            @click="activeTerm && openContainer(activeTerm.containerId)"
          >
            <Plus />
          </Button>
          <div class="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-xs"
              :disabled="!activeTerm"
              :title="activeTerm ? '文件面板' : '先选择容器'"
              @click="showFiles = !showFiles"
            >
              <FolderOpen />
            </Button>
          </div>
        </div>

        <!-- 终端主体：v-show 常驻（断开/重连与 ContainerList 同语义），无 tab 时给空态 -->
        <div v-if="terms.length" class="relative min-h-0 flex-1">
          <Terminal
            v-for="(t, i) in terms"
            v-show="i === activeIdx"
            :key="t.termId"
            :ref="(el) => setTermRef(t.termId, el)"
            class="h-full"
            :id="t.containerId"
            :name="t.containerName"
            :term-id="t.termId"
            :active="i === activeIdx"
          />
        </div>
        <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p class="text-sm">从左侧选择一个授权容器开始</p>
          <p class="text-xs">终端会话在服务端保持，刷新页面自动重连</p>
        </div>
      </div>

      <!-- 文件面板：桌面右列，手机全屏覆盖 -->
      <FilePanel
        v-if="showFiles && activeTerm"
        class="shrink-0 border-l max-md:absolute max-md:inset-0 max-md:z-30 max-md:w-full"
        :style="undefined"
        :container-id="activeTerm.containerId"
        :container-name="activeTerm.containerName"
        :panes="[{ termId: activeTerm.termId, label: activeTerm.containerName }]"
        :term-id="filePaneTermId"
        :has-terminal="true"
        :browse-mode="browseMode"
        restricted
        @browse-mode="browseMode = $event"
        @close="showFiles = false"
        @open-file="openFileFromPanel"
        @pane-pick="(t: string) => (filePaneTermId = t)"
      />

      <!-- 编辑器覆盖列：桌面右半，手机全屏。多文件 tab 条 + FileEditorPane -->
      <div
        v-if="editors.length"
        class="absolute inset-y-0 right-0 z-20 flex w-1/2 flex-col border-l bg-background max-md:inset-0 max-md:w-full"
      >
        <div class="flex h-8 shrink-0 items-center gap-0.5 border-b px-1.5">
          <button
            v-for="(e, i) in editors"
            :key="`${e.containerId}:${e.path}`"
            type="button"
            class="flex max-w-48 items-center gap-1 rounded px-2 py-1 text-xs"
            :class="i === activeEditor ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/50'"
            :title="`${e.containerName}:${e.path}`"
            @click="activeEditor = i"
          >
            <span class="min-w-0 flex-1 truncate">{{ e.path.slice(e.path.lastIndexOf('/') + 1) }}</span>
            <X class="size-3 shrink-0 opacity-60 hover:opacity-100" @click.stop="closeEditor(i)" />
          </button>
          <X
            class="ml-auto size-3.5 shrink-0 text-muted-foreground hover:text-foreground"
            title="关闭全部"
            @click="editors = []"
          />
        </div>
        <FileEditorPane
          v-for="(e, i) in editors"
          v-show="i === activeEditor"
          :key="`${e.containerId}::${e.path}`"
          class="min-h-0 flex-1"
          :container-id="e.containerId"
          :container-name="e.containerName"
          :path="e.path"
          :active="i === activeEditor"
          @close="closeEditor(i)"
        />
      </div>
    </div>
  </div>
</template>
