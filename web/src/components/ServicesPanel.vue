<script setup lang="ts">
// docker 服务抽屉：右侧滑入的 master-detail「服务工作台」，与侧栏服务卡片分区配套。
// 分工：侧栏卡片 = 每日一眼（状态/IP/描述 + 启停重启快捷）；本抽屉 = 中频深度操作——
// 拿连接命令与 env 凭据、看日志、启停重启、创建（ServiceCreateDialog 表单）、删除。
// 形态取抽屉而非居中 modal：服务是配角，工作台要能「探进来瞄一眼连接串就回去」，
// 不值得每次打断整个界面；也取代旧版「桌面 9 列表格 + 手机卡片」双渲染。
// 左栏清单：进行中的创建任务置顶（点开看日志/取消），服务项一行一态；右侧选中项
// 详情（连接/凭据/元信息/日志常驻，不再藏进行内展开行）。任务完成自动选中产出的
// 服务；失败/取消的任务留在左栏供查错。完成 toast 由 lib/serviceJobs.ts 全局去重。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  listServices,
  startService,
  stopService,
  restartService,
  deleteService,
  getServiceLogs,
  listServiceJobs,
  getServiceJob,
  cancelServiceJob,
  Unauthorized,
  type ServiceView,
  type ServicesStatus,
  type ServiceJobView,
} from '@/lib/api'
import { trackServiceJobs } from '@/lib/serviceJobs'
import { serviceUrl } from '@/lib/proxy'
import { stateLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
// 裸用 reka 原语而非 ui/dialog 的 DialogContent：抽屉形态（右侧全高）与居中定位类
// 全面相悖，反覆盖不如直接自绘；焦点陷阱/Esc/遮罩点击关等 a11y 行为由原语自带。
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ServiceCreateDialog from '@/components/ServiceCreateDialog.vue'
import { LoaderCircle, Check, X, Ban, RefreshCw, Plus, Globe } from 'lucide-vue-next'

// initialCreate=true：侧栏 ＋ 带新建意图——抽屉一打开就弹创建表单（普通入口不弹）。
// initialSelect：侧栏卡片点击带来的服务名——打开即定位到该服务详情。
const props = defineProps<{ initialCreate?: boolean; initialSelect?: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const items = ref<ServiceView[]>([])
const status = ref<ServicesStatus | null>(null)
const busyName = ref('')
const err = ref('')
const copied = ref('')
const showCreate = ref(!!props.initialCreate)
const pendingDelete = ref<{ name: string; deleteData: boolean } | null>(null)

// —— 选中态（互斥）：服务名 或 创建任务 id ——
const selService = ref(props.initialSelect ?? '')
const selJob = ref('')
const sel = computed(() => items.value.find((s) => s.name === selService.value) ?? null)
const job = computed(() => jobs.value.find((j) => j.id === selJob.value) ?? null)
// 「打开」端口列表：仅自定义预设且在跑（postgres/redis/mysql 的端口不是 HTTP）。
// 提成 computed：模板插槽里对 sel 的窄化会失效（vue-tsc 限制），表达式内引用它最稳。
const openPorts = computed<number[]>(() =>
  sel.value?.running && sel.value.preset === 'custom' ? sel.value.ports : [],
)
// 删除入口（详情操作行收进下拉）：script 内取 sel 免模板窄化问题。
function askDelete(deleteData: boolean) {
  const s = sel.value
  if (!s) return
  pendingDelete.value = { name: s.name, deleteData }
}
// 启停/重启统一入口（模板内联箭头拿不到 sel 的非空窄化，收进 script 最稳）。
function svcAction(kind: 'start' | 'stop' | 'restart') {
  const s = sel.value
  if (!s) return
  const name = s.name
  const fn =
    kind === 'start' ? () => startService(name) : kind === 'stop' ? () => stopService(name) : () => restartService(name)
  void op(name, fn)
}

// —— 日志：服务名 -> 内容（选中即拉，3s 跟刷；切换选中不清缓存，回来即显）——
const logs = ref<Record<string, string>>({})
watch(
  selService,
  (n) => {
    if (n) void ensureLog(n)
  },
  { immediate: true },
)
async function ensureLog(name: string) {
  if (logs.value[name] != null) return
  try {
    const v = await getServiceLogs(name)
    logs.value[name] = v.logs || '（无输出）'
  } catch (e) {
    logs.value[name] = `（拉取失败：${e instanceof Error ? e.message : String(e)}）`
  }
}
// 手动立即刷新当前选中服务的日志。
async function reloadSelLog() {
  const n = selService.value
  if (!n) return
  try {
    const v = await getServiceLogs(n)
    logs.value[n] = v.logs || '（无输出）'
  } catch {
    /* 下轮再试 */
  }
}
// 已加载过的日志每轮轮询跟刷一次（单个失败静默）。
async function refreshOpenLogs() {
  const names = Object.keys(logs.value)
  if (!names.length) return
  await Promise.all(
    names.map(async (n) => {
      try {
        const v = await getServiceLogs(n)
        logs.value[n] = v.logs || '（无输出）'
      } catch {
        /* 下轮再试 */
      }
    }),
  )
}

function selectService(name: string) {
  selJob.value = ''
  selService.value = name
}
function selectJob(j: ServiceJobView) {
  selService.value = ''
  selJob.value = j.id
}
watch(selJob, (id) => {
  if (id) void pullJobLog()
})
const fullLog = ref<string[]>([])
async function pullJobLog() {
  if (!selJob.value) return
  try {
    fullLog.value = (await getServiceJob(selJob.value)).log
  } catch {
    /* 拉取失败保留旧内容 */
  }
}

// —— 服务表 / 状态 ——
async function refresh() {
  try {
    const v = await listServices()
    items.value = v.items
    status.value = v.status
    // 选中校正：目标服务没了（删除/外部清理）回落到第一个；泛入口打开时默认选第一个。
    if (!v.items.some((s) => s.name === selService.value)) {
      selService.value = v.items[0]?.name ?? ''
    } else if (!selService.value && !selJob.value) {
      selService.value = v.items[0]?.name ?? ''
    }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

// —— 创建任务 ——
// 3s 轮询（侧栏另有独立轮询；两者喂同一 trackServiceJobs 去重通知）。
// seenDoneIds：上轮已见终态集合——出现新终态时刷服务表；done 且有产出 → 自动选中
// 该服务（创建场景的期待动线），error/canceled 留在左栏任务段供点开查错。
const jobs = ref<ServiceJobView[]>([])
const railJobs = computed(() =>
  jobs.value.filter((j) => j.state === 'running' || j.state === 'error' || j.state === 'canceled').slice(0, 3),
)
let jobsTimer: ReturnType<typeof setInterval> | null = null
let seenDoneIds = new Set<string>()
async function refreshJobs() {
  try {
    const v = await listServiceJobs(60)
    jobs.value = v.jobs
    trackServiceJobs(v.jobs)
    const doneIds = new Set(v.jobs.filter((j) => j.state !== 'running').map((j) => j.id))
    const fresh = [...doneIds].filter((id) => !seenDoneIds.has(id))
    if (seenDoneIds.size > 0 && fresh.length) {
      await refresh()
      for (const id of fresh) {
        const j = v.jobs.find((x) => x.id === id)
        if (j?.state === 'done' && j.result) selectService(j.result.name)
      }
    }
    seenDoneIds = doneIds
    if (selJob.value) void pullJobLog() // 展开中的任务日志跟刷
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    /* 任务列表拉取失败不打扰主流程（docker 抖动），下轮再试 */
  }
}

async function cancelJob(j: ServiceJobView) {
  err.value = ''
  try {
    await cancelServiceJob(j.id)
    await refreshJobs()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e) // 如「已过拉取阶段，无法取消」
  }
}

async function op(name: string, fn: () => Promise<unknown>) {
  if (busyName.value) return
  busyName.value = name
  err.value = ''
  try {
    await fn()
    await refresh()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busyName.value = ''
  }
}

// 打开服务端口：跟随控制台口径——IP/localhost 口径直连服务 IP，基域名口径经面板
// Web 代理（见 lib/proxy.ts 与 server/proxy.ts）。仅 HTTP/WS 服务适用。
function openServicePort(s: ServiceView, port: number) {
  window.open(serviceUrl('s', s.name, port, s.ip), '_blank', 'noopener')
}

function fmtDate(v: string): string {
  const d = new Date(v)
  return isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN', { hour12: false })
}

async function copyVal(v: string) {
  try {
    await navigator.clipboard.writeText(v)
    copied.value = v
    setTimeout(() => (copied.value = ''), 1500)
  } catch {
    /* 非 HTTPS / 无权限：静默 */
  }
}

async function confirmDelete() {
  const p = pendingDelete.value
  if (!p) return
  pendingDelete.value = null
  await op(p.name, () =>
    deleteService(p.name, { deleteData: p.deleteData, confirmName: p.deleteData ? p.name : undefined }),
  )
}

function stateCls(s: ServiceView): string {
  if (s.running) return 'text-emerald-600'
  if (s.state === 'restarting') return 'text-amber-600'
  return 'text-muted-foreground'
}

onMounted(() => {
  refresh()
  refreshJobs()
  jobsTimer = setInterval(() => {
    void refreshJobs()
    void refreshOpenLogs()
  }, 3000)
})
onUnmounted(() => {
  if (jobsTimer) clearInterval(jobsTimer)
})
</script>

<template>
  <DialogRoot :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />
      <!-- 右侧滑入抽屉：全高、xl 上限宽度，手机全宽 -->
      <DialogContent
        class="fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-full flex-col overflow-hidden border-l bg-background shadow-lg outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right sm:max-w-xl"
      >
        <!-- 头：标题 + 关闭 -->
        <div class="flex shrink-0 items-center gap-2.5 border-b px-4 py-3">
          <img src="/docker.svg" alt="" class="size-4 shrink-0" />
          <div class="min-w-0 flex-1">
            <DialogTitle class="text-sm leading-tight font-semibold">docker 服务</DialogTitle>
            <DialogDescription class="text-xs text-muted-foreground">
              配套服务（postgres/redis…）：固定 IP 直连，容器内按服务名访问（hosts 自动注入）
            </DialogDescription>
          </div>
          <DialogClose as-child>
            <Button variant="ghost" size="icon-xs" title="关闭"><X /></Button>
          </DialogClose>
        </div>

        <!-- 状态行：docker/网络/服务池 + 环境告警（不可达/网络/镜像源） -->
        <div class="shrink-0 space-y-1 border-b px-4 py-2 text-xs text-muted-foreground">
          <p>
            <template v-if="status">
              docker {{ status.reachable ? `可达（${status.version ?? '?'}）` : '不可达' }}
              <template v-if="status.reachable">
                · 网络 {{ status.network.name }}（{{ status.network.subnet ?? '?' }}<template v-if="status.network.bridgeOk">，就绪</template>）
                · 服务池 {{ status.pool.from }}–{{ status.pool.to }}（已用 {{ status.pool.assigned.length }}）
              </template>
            </template>
            <template v-else>加载中…</template>
          </p>
          <p v-if="status?.error" class="text-destructive">{{ status.error }}</p>
          <p v-if="status?.network.detail" class="text-amber-600">{{ status.network.detail }}</p>
          <p v-if="status?.registryMirrors?.length === 0" class="text-amber-600">
            daemon 未配置 registry-mirrors——Docker Hub 直连在受限网络下常缓慢/失败；可在 /etc/docker/daemon.json
            配置后重启 docker（私有 registry 不受影响）。
          </p>
        </div>
        <p v-if="err" class="shrink-0 border-b px-4 py-1.5 text-xs text-destructive">{{ err }}</p>

        <!-- docker 不可达：整区降级 -->
        <div
          v-if="status && !status.reachable"
          class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
        >
          <p class="text-sm text-muted-foreground">docker 不可达——服务面板暂不可用，容器管理不受影响。</p>
          <Button variant="outline" size="sm" @click="refresh">重试</Button>
        </div>

        <!-- 主体：左栏清单（手机变横滚 chips）+ 右侧详情 -->
        <div v-else class="flex min-h-0 flex-1 max-md:flex-col">
          <div
            class="scroll-thin flex w-44 shrink-0 flex-col overflow-y-auto border-r max-md:w-full max-md:flex-row max-md:items-center max-md:gap-1.5 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-r-0 max-md:border-b max-md:px-2 max-md:py-2"
          >
            <!-- 创建任务段：running + 失败/取消（done 由自动选中承接，不占清单） -->
            <div v-if="railJobs.length" class="shrink-0 max-md:contents">
              <p class="px-1 pt-2 pb-1 text-[10px] font-medium text-muted-foreground/70 max-md:hidden">创建任务</p>
              <button
                v-for="j in railJobs"
                :key="j.id"
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent max-md:shrink-0 max-md:rounded-full max-md:border max-md:px-2.5 max-md:py-1"
                :class="selJob === j.id ? 'bg-accent' : ''"
                :title="j.state === 'error' ? (j.error || j.statusText) : j.statusText"
                @click="selectJob(j)"
              >
                <LoaderCircle v-if="j.state === 'running'" class="size-3 shrink-0 animate-spin text-muted-foreground" />
                <X v-else-if="j.state === 'error'" class="size-3 shrink-0 text-destructive" />
                <Ban v-else class="size-3 shrink-0 text-muted-foreground" />
                <span class="min-w-0">
                  <span class="block truncate text-xs font-medium">{{ j.name }}</span>
                  <span class="block truncate text-[10px] text-muted-foreground max-md:hidden">{{
                    j.state === 'running' ? j.statusText : j.state === 'error' ? '创建失败' : '已取消'
                  }}</span>
                </span>
              </button>
            </div>

            <!-- 服务段 -->
            <div class="flex min-w-0 flex-1 flex-col max-md:contents">
              <p class="px-1 pt-2 pb-1 text-[10px] font-medium text-muted-foreground/70 max-md:hidden">服务</p>
              <button
                v-for="s in items"
                :key="s.name"
                type="button"
                class="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent max-md:shrink-0 max-md:rounded-full max-md:border max-md:px-2.5 max-md:py-1"
                :class="selService === s.name ? 'bg-accent' : ''"
                @click="selectService(s.name)"
              >
                <span
                  :class="[
                    'size-1.5 shrink-0 rounded-full',
                    s.running ? 'bg-emerald-500' : s.state === 'restarting' ? 'bg-amber-500' : 'bg-muted-foreground/40',
                  ]"
                  :title="stateLabel(s.state)"
                />
                <span class="min-w-0">
                  <span class="block truncate text-xs font-medium" :title="s.name">{{ s.name }}</span>
                  <span class="block truncate text-[10px] text-muted-foreground max-md:hidden"
                    >{{ s.preset }} · {{ stateLabel(s.state) }}</span
                  >
                </span>
                <span v-if="s.metaMissing" class="shrink-0 text-amber-600" title="sidecar 元数据缺失（state.json 被清过？），重建可恢复">⚠</span>
              </button>
              <p v-if="!items.length" class="px-2 py-2 text-[11px] text-muted-foreground max-md:hidden">还没有服务</p>
            </div>

            <!-- 手机：新建 chip（桌面入口在底部动作行） -->
            <button
              type="button"
              class="hidden shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground max-md:flex"
              @click="showCreate = true"
            >
              <Plus class="size-3" /> 新建
            </button>

            <!-- 底部动作：刷新 + 新建 -->
            <div class="shrink-0 border-t p-2 max-md:hidden">
              <div class="flex gap-1.5">
                <Button variant="outline" size="sm" class="flex-1" title="刷新服务与任务" @click="refresh()">
                  <RefreshCw />
                </Button>
                <Button variant="outline" size="sm" class="flex-1" @click="showCreate = true">
                  <Plus /> 新建服务
                </Button>
              </div>
            </div>
          </div>

          <!-- 详情：选中的创建任务 / 选中的服务 / 空态 -->
          <div class="scroll-thin min-w-0 flex-1 overflow-y-auto">
            <!-- 任务详情：状态 + 进度 + 日志 + 取消 -->
            <div v-if="job" class="space-y-3 p-4">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <LoaderCircle v-if="job.state === 'running'" class="size-4 shrink-0 animate-spin text-muted-foreground" />
                <Check v-else-if="job.state === 'done'" class="size-4 shrink-0 text-emerald-600" />
                <X v-else-if="job.state === 'error'" class="size-4 shrink-0 text-destructive" />
                <Ban v-else class="size-4 shrink-0 text-muted-foreground" />
                <h3 class="min-w-0 truncate text-base font-semibold">创建 {{ job.name }}</h3>
                <Badge variant="outline" class="shrink-0 font-normal">{{ job.image }}</Badge>
              </div>
              <p class="text-xs" :class="job.state === 'error' ? 'text-destructive' : 'text-muted-foreground'">
                {{ job.state === 'error' ? (job.error || job.statusText) : job.statusText }}
              </p>
              <div v-if="job.state === 'running' && job.cancellable">
                <Button variant="outline" size="sm" @click="cancelJob(job)">取消任务</Button>
              </div>
              <pre class="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">{{
                job.state === 'running' ? (job.logTail ?? []).join('\n') || '准备中…' : fullLog.join('\n') || '（无输出）'
              }}</pre>
            </div>

            <!-- 服务详情 -->
            <div v-else-if="sel" class="space-y-4 p-4">
              <div class="space-y-2">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    :class="[
                      'h-2 w-2 shrink-0 rounded-full',
                      sel.running ? 'bg-emerald-500' : sel.state === 'restarting' ? 'bg-amber-500' : 'bg-muted-foreground/40',
                    ]"
                    :title="stateLabel(sel.state)"
                  />
                  <h3 class="min-w-0 truncate text-base font-semibold" :title="sel.name">{{ sel.name }}</h3>
                  <Badge variant="outline" class="shrink-0 font-normal">{{ sel.preset }}</Badge>
                  <span class="shrink-0 text-xs" :class="stateCls(sel)" :title="sel.status">{{ stateLabel(sel.state) }}</span>
                </div>
                <p v-if="sel.description" class="text-xs text-muted-foreground">{{ sel.description }}</p>
                <div class="flex flex-wrap items-center gap-1.5">
                  <Button
                    v-if="!sel.running"
                    variant="outline"
                    size="sm"
                    :disabled="!!busyName"
                    :title="busyName === sel.name ? '处理中…' : ''"
                    @click="svcAction('start')"
                    >启动</Button
                  >
                  <Button
                    v-else
                    variant="outline"
                    size="sm"
                    :disabled="!!busyName"
                    :title="busyName === sel.name ? '处理中…' : ''"
                    @click="svcAction('stop')"
                    >停止</Button
                  >
                  <Button variant="outline" size="sm" :disabled="!!busyName" @click="svcAction('restart')">重启</Button>
                  <!-- 打开：只对自定义预设给出——postgres/redis/mysql 的端口不是 HTTP，浏览器代理进不去 -->
                  <Button
                    v-for="p in openPorts"
                    :key="'open' + p"
                    variant="outline"
                    size="sm"
                    @click="sel && openServicePort(sel, p)"
                  >
                    <Globe class="size-3.5" /> 打开 {{ p }}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="ml-auto text-destructive hover:text-destructive"
                        :disabled="!!busyName"
                        >删除</Button
                      >
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem @click="askDelete(false)">删除服务（数据卷保留）</DropdownMenuItem>
                      <DropdownMenuItem class="text-destructive" @click="askDelete(true)">删除服务（连数据）</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              <!-- 连接命令：一级信息，点复制 -->
              <div v-if="sel.connect.length" class="space-y-1.5">
                <p class="text-[11px] font-medium text-muted-foreground">连接命令（容器内执行，点击复制）</p>
                <button
                  v-for="c in sel.connect"
                  :key="c"
                  type="button"
                  class="block w-full cursor-pointer rounded-md border bg-background/60 p-2 text-left font-mono text-xs break-all hover:bg-muted/50"
                  :title="copied === c ? '已复制' : '点击复制'"
                  @click="copyVal(c)"
                >
                  {{ copied === c ? '已复制 ✓' : c }}
                </button>
              </div>
              <p v-else class="text-xs text-muted-foreground">无现成连接命令——自定义镜像参考下方环境变量。</p>

              <!-- env 全量凭据：token = 宿主完整权限，鉴权边界在 token 上，UI 直接展示 -->
              <div v-if="Object.keys(sel.env).length" class="space-y-1.5">
                <p class="text-[11px] font-medium text-muted-foreground">环境变量（凭据，点击值复制）</p>
                <div class="divide-y rounded-md border">
                  <div
                    v-for="(v, k) in sel.env"
                    :key="k"
                    class="flex flex-col gap-0.5 px-3 py-1.5 font-mono text-xs sm:flex-row sm:gap-3"
                  >
                    <span class="shrink-0 truncate text-muted-foreground sm:w-44">{{ k }}</span>
                    <button
                      type="button"
                      class="min-w-0 cursor-pointer text-left break-all hover:underline"
                      :title="copied === String(v) ? '已复制' : '点击复制'"
                      @click="copyVal(String(v))"
                    >
                      {{ copied === String(v) ? '已复制' : v }}
                    </button>
                  </div>
                </div>
              </div>

              <!-- 元信息 -->
              <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-xs">
                <span class="text-muted-foreground">IP</span>
                <button
                  v-if="sel.ip"
                  type="button"
                  class="min-w-0 cursor-pointer text-left font-mono tabular-nums hover:underline"
                  :title="copied === sel.ip ? '已复制' : '点击复制'"
                  @click="copyVal(sel.ip)"
                >
                  {{ copied === sel.ip ? '已复制' : sel.ip }}
                </button>
                <span v-else class="text-muted-foreground">—</span>
                <span class="text-muted-foreground">镜像</span>
                <span class="min-w-0 truncate font-mono" :title="sel.image">{{ sel.image }}</span>
                <span class="text-muted-foreground">数据卷</span>
                <span class="min-w-0 truncate font-mono" :title="sel.volume ?? '无数据卷'">{{ sel.volume ?? '—' }}</span>
                <template v-if="sel.createdAt">
                  <span class="text-muted-foreground">创建于</span>
                  <span>{{ fmtDate(sel.createdAt) }}</span>
                </template>
                <template v-if="sel.command?.length">
                  <span class="text-muted-foreground">命令</span>
                  <span class="min-w-0 truncate font-mono" :title="sel.command.join(' ')">{{ sel.command.join(' ') }}</span>
                </template>
              </div>

              <!-- 日志：常驻块（选中即拉、3s 跟刷），不再藏进行内展开行 -->
              <div class="space-y-1.5">
                <div class="flex items-center gap-2">
                  <p class="text-[11px] font-medium text-muted-foreground">日志（3s 自动跟随）</p>
                  <Button variant="ghost" size="icon-xs" class="ml-auto" title="立即刷新" @click="reloadSelLog">
                    <RefreshCw class="size-3.5" />
                  </Button>
                </div>
                <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">{{ logs[sel.name] ?? '加载中…' }}</pre>
              </div>
            </div>

            <!-- 空态 -->
            <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <img src="/docker.svg" alt="" class="size-8 opacity-30" />
              <p class="text-sm text-muted-foreground">{{ items.length ? '选择左侧服务查看详情' : '还没有配套服务' }}</p>
              <p class="text-xs text-muted-foreground/60">起一个 postgres，容器里就能 psql -h pg 直连</p>
              <Button size="sm" class="mt-2" @click="showCreate = true">新建服务</Button>
            </div>
          </div>
        </div>

        <ConfirmDialog
          v-if="pendingDelete"
          :title="pendingDelete.deleteData ? `删除服务 ${pendingDelete.name}（连数据）` : `删除服务 ${pendingDelete.name}`"
          :description="
            pendingDelete.deleteData
              ? `将停止并删除容器与数据卷 ${pendingDelete.name}，数据不可恢复。`
              : `将停止并删除容器 ${pendingDelete.name}，数据卷保留（同名重建可恢复数据）。`
          "
          :destructive="true"
          :input="pendingDelete.deleteData ? { placeholder: '输入服务名确认', confirmCue: pendingDelete.name } : undefined"
          @confirm="confirmDelete"
          @close="pendingDelete = null"
        />

        <ServiceCreateDialog v-if="showCreate" @created="showCreate = false; refreshJobs(); refresh()" @close="showCreate = false" />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
