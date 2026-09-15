<script setup lang="ts">
// docker 服务抽屉：右侧滑入的单服务详情（inspector），与侧栏服务卡片分区配套。
// 分工：侧栏卡片 = 服务清单 + 切换器（抽屉开着时点别的卡片，内容直接跟着换——
// initialSelect 变化即跟随，抽屉内部不再放列表，"抽屉里还有个列表"与侧栏重复且怪）。
// 信息分层展示（一口气全铺开心智负担太重）：
//   一层（常看）= 名称/状态/操作 + 连接命令 + IP，直接给；
//   二层（偶看）= 环境变量凭据 + 元信息，折叠默认收；
//   二点五层（改配置）= compose 底账（CodeEditor + 应用）——文件是唯一配置真相，
//     保存即 compose up -d（与终端手改等价）；无底账的旧版服务出迁移入口；
//   三层（排障）= 日志，折叠默认收，点开才拉取、开着才跟刷（顺带省轮询）。
// 创建任务以顶部横幅出现（仅进行中/失败/取消可见，点开看日志/取消），完成自动选中
// 产出的服务。创建表单已退役（AI 时代服务经 compose 目录/agent 产生），完成 toast 由
// lib/serviceJobs.ts 去重。
import { ref, computed, watch, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import {
  listServices,
  startService,
  stopService,
  restartService,
  deleteService,
  unadoptService,
  getServiceLogs,
  getServiceListenPorts,
  getServiceConfig,
  applyServiceConfig,
  stackServiceAction,
  listServiceJobs,
  getServiceJob,
  cancelServiceJob,
  Unauthorized,
  type ServiceView,
  type ServicesStatus,
  type ServiceConfigView,
  type ServiceJobView,
} from '@/lib/api'
import { trackServiceJobs, requestServiceMigrate } from '@/lib/serviceJobs'
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
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import InfoHint from '@/components/InfoHint.vue'
import { LoaderCircle, Check, X, Ban, RefreshCw, Globe, ChevronRight, Maximize2, Minimize2 } from 'lucide-vue-next'

// Monaco 壳懒加载（monaco 本体是共享 chunk，多入口不重复下载——见 CodeEditor.vue 头注）。
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))

// initialSelect：侧栏卡片点击带来的服务名——打开或已打开时定位到该服务。
const props = defineProps<{ initialSelect?: string }>()
const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void }>()

const items = ref<ServiceView[]>([])
const status = ref<ServicesStatus | null>(null)
const busyName = ref('')
const err = ref('')
const copied = ref('')
const pendingDelete = ref<{ name: string; deleteData: boolean } | null>(null)
const pendingUnadopt = ref('')

// —— 选中服务（单一；侧栏卡片是切换器，props 变化即跟随）——
const selService = ref(props.initialSelect ?? '')
const sel = computed(() => items.value.find((s) => s.name === selService.value) ?? null)
watch(
  () => props.initialSelect,
  (v) => {
    if (v && v !== selService.value) selService.value = v
  },
)
// 换服务：折叠层归位（日志/配置懒加载随之失效，不预取）；监听端口立即重扫。
watch(selService, () => {
  openInfo.value = false
  openCfg.value = false
  openStack.value = false
  openLog.value = false
  cfgZoom.value = false
  cfg.value = null
  cfgYaml.value = ''
  void refreshListen()
})

// —— 分层折叠态 ——
const openInfo = ref(false)
const openCfg = ref(false)
const openStack = ref(false)
const openLog = ref(false)
const envCount = computed(() => (sel.value ? Object.keys(sel.value.env).length : 0))

// —— 配置底账（compose.yaml）：文件是唯一配置真相 ——
// 展开才拉取（省轮询）；应用 = 把编辑器内容 POST 回去（后端校验写盘 + compose up）。
// dirty（编辑未保存）与 drift（文件与容器不一致）分开提示；Ctrl+S 走 CodeEditor 的 save 事件。
const cfg = ref<ServiceConfigView | null>(null)
const cfgYaml = ref('')
const cfgErr = ref('')
const cfgLoading = ref(false)
const applying = ref(false)
const cfgDirty = computed(() => cfg.value != null && cfgYaml.value !== cfg.value.yaml)
// 配置编辑器放大态：同一编辑器实例在「抽屉内嵌」与「全屏覆盖」两种形态间切换
//（class 切换不重建，编辑内容/光标/撤销栈全保留；automaticLayout 负责重排）。
const cfgZoom = ref(false)
watch([selService, openCfg], ([name, open]) => {
  if (open && name) void loadCfg(name)
})
async function loadCfg(name: string) {
  cfgLoading.value = true
  cfgErr.value = ''
  try {
    const v = await getServiceConfig(name)
    cfg.value = v
    cfgYaml.value = v.yaml ?? ''
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    cfgErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    cfgLoading.value = false
  }
}
async function applyCfg(build = false) {
  const name = selService.value
  if (!name || applying.value || cfg.value?.yaml == null) return
  applying.value = true
  cfgErr.value = ''
  try {
    await applyServiceConfig(name, cfgYaml.value, build)
    // 文件已被后端落盘（应用校验通过）：以编辑器内容为新基准，drift 等任务完成后由刷新归零。
    cfg.value = { ...cfg.value, yaml: cfgYaml.value, drift: true }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    cfgErr.value = e instanceof Error ? e.message : String(e) // 坏 yaml 的校验报错，内联回显
  } finally {
    applying.value = false
  }
}

// —— 多容器项目的成员策展（加入列表 / 设为入口）——
const stackBusy = ref('')
async function stackAction(service: string, patch: { listed?: boolean; entry?: boolean }) {
  const name = selService.value
  if (!name || stackBusy.value) return
  stackBusy.value = service
  err.value = ''
  try {
    await stackServiceAction(name, service, patch)
    await refresh()
    emit('changed')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    stackBusy.value = ''
  }
}

// —— 日志：懒加载（点开才拉）+ 开着才 3s 跟刷；缓存按服务名留着，重开免拉 ——
const logs = ref<Record<string, string>>({})
watch(
  [selService, openLog],
  ([name, open]) => {
    if (open && name) void ensureLog(name)
  },
  { immediate: true },
)
async function ensureLog(name: string) {
  if (logs.value[name] != null) return
  await fetchLog(name)
}
async function fetchLog(name: string) {
  try {
    const v = await getServiceLogs(name)
    logs.value[name] = v.logs || '（无输出）'
  } catch (e) {
    logs.value[name] = `（拉取失败：${e instanceof Error ? e.message : String(e)}）`
  }
}
// 立即刷新当前展开的日志（手动按钮）。
async function refreshSelLog() {
  const n = selService.value
  if (!n) return
  await fetchLog(n)
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
    } else if (!selService.value) {
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

// —— 创建任务横幅：进行中/失败/取消才出现（done 由自动选中承接）——
const jobs = ref<ServiceJobView[]>([])
const kindLabel: Record<ServiceJobView['kind'], string> = { create: '创建', apply: '应用', migrate: '迁移', adopt: '收编接管' }
const activeJobs = computed(() =>
  jobs.value.filter((j) => j.state === 'running' || j.state === 'error' || j.state === 'canceled').slice(0, 3),
)
const expandedJob = ref('')
const fullLog = ref<string[]>([])
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
      // 选中服务的任务落定（创建/应用/迁移都改容器或底账）→ 配置页开着就重载（drift 归零）。
      const touchedSel = fresh.some((id) => {
        const j = v.jobs.find((x) => x.id === id)
        return j && j.name === selService.value && j.state === 'done'
      })
      if (touchedSel && openCfg.value) void loadCfg(selService.value)
      for (const id of fresh) {
        const j = v.jobs.find((x) => x.id === id)
        if (j?.state === 'done' && j.result) {
          selService.value = j.result.name
          emit('changed') // 新服务落定，侧栏即时跟上
        }
      }
    }
    seenDoneIds = doneIds
    if (expandedJob.value) void pullJobLog()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    /* 任务列表拉取失败不打扰主流程（docker 抖动），下轮再试 */
  }
}
function toggleJobLog(j: ServiceJobView) {
  expandedJob.value = expandedJob.value === j.id ? '' : j.id
  if (expandedJob.value) void pullJobLog()
}
async function pullJobLog() {
  if (!expandedJob.value) return
  try {
    fullLog.value = (await getServiceJob(expandedJob.value)).log
  } catch {
    /* 拉取失败保留旧内容 */
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
    emit('changed') // 通知 App 让侧栏即时跟刷，不等下一拍轮询
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

// 启停/重启统一入口（模板内联箭头拿不到 sel 的非空窄化，收进 script 最稳）。
function svcAction(kind: 'start' | 'stop' | 'restart') {
  const s = sel.value
  if (!s) return
  const name = s.name
  const fn =
    kind === 'start' ? () => startService(name) : kind === 'stop' ? () => stopService(name) : () => restartService(name)
  void op(name, fn)
}

// 删除入口（操作行收进下拉）：script 内取 sel 免模板窄化问题。
function askDelete(deleteData: boolean) {
  const s = sel.value
  if (!s) return
  pendingDelete.value = { name: s.name, deleteData }
}

async function confirmDelete() {
  const p = pendingDelete.value
  if (!p) return
  pendingDelete.value = null
  await op(p.name, () =>
    deleteService(p.name, { deleteData: p.deleteData, confirmName: p.deleteData ? p.name : undefined }),
  )
}

// 取消收编：还原网络接入 + 清 meta，容器本体不动（收编容器没有删除操作）。
function askUnadopt() {
  const s = sel.value
  if (s?.adopted) pendingUnadopt.value = s.name
}

async function confirmUnadopt() {
  const name = pendingUnadopt.value
  if (!name) return
  pendingUnadopt.value = ''
  await op(name, () => unadoptService(name))
}

// 打开服务端口：跟随控制台口径——IP/localhost 口径直连服务 IP，基域名口径经面板
// Web 代理（见 lib/proxy.ts 与 server/proxy.ts）。
function openServicePort(s: ServiceView, port: number) {
  window.open(serviceUrl('s', s.name, port, s.ip), '_blank', 'noopener')
}

// —— 监听端口（实测）：随 3s 轮询跟刷，只刷选中的 running 服务 ——
// 「打开」按钮的端口表以此为主：实测监听优先（全预设通用），未扫到时回退手工登记
// 的声明端口（custom 手填 state.json ports 的旧路径）。
const listen = ref<{ ports: number[]; web: number[] } | null>(null)
let listenSeq = 0
async function refreshListen() {
  const s = items.value.find((x) => x.name === selService.value)
  const seq = ++listenSeq
  if (!s || !s.running) {
    listen.value = null
    return
  }
  try {
    const r = await getServiceListenPorts(s.name)
    if (seq === listenSeq) listen.value = r
  } catch {
    if (seq === listenSeq) listen.value = null // 刚停/扫描失败：置空，下轮再试
  }
}
const openPorts = computed(() => {
  const s = sel.value
  if (!s || !s.running) return []
  const detected = listen.value?.ports ?? []
  if (detected.length) return detected
  return s.preset === 'custom' ? s.ports : []
})

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

function stateCls(s: ServiceView): string {
  if (s.running) return 'text-emerald-600'
  if (s.state === 'restarting') return 'text-amber-600'
  return 'text-muted-foreground'
}

onMounted(() => {
  refresh()
  refreshJobs()
  void refreshListen()
  jobsTimer = setInterval(() => {
    void refreshJobs()
    void refresh() // 服务状态跟着轮询：抽屉开着时外部启停（docker CLI 等）也即时反映
    void refreshListen() // 监听端口跟着轮询：容器内新起的应用端口自动出现
    // 日志只在「日志层展开」时跟刷；展开中的任务日志跟着拉。
    if (openLog.value && selService.value) void fetchLog(selService.value)
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
      <!-- 右侧滑入抽屉：单服务详情（宽度 xl——配置编辑器/凭据/项目成员都吃宽度） -->
      <DialogContent
        class="fixed inset-y-0 right-0 z-50 flex h-dvh w-full max-w-full flex-col overflow-hidden border-l bg-background shadow-lg outline-none duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-right sm:max-w-xl"
      >
        <!-- 头：标识 + 关闭（收编入口在侧栏分区头——抽屉是单服务详情，不放清单级动作） -->
        <div class="flex shrink-0 items-center gap-2.5 border-b px-4 py-3">
          <img src="/docker.svg" alt="" class="size-4 shrink-0" />
          <DialogTitle class="min-w-0 flex-1 text-sm leading-tight font-semibold">应用容器</DialogTitle>
          <DialogClose as-child>
            <Button variant="ghost" size="icon-xs" title="关闭"><X /></Button>
          </DialogClose>
        </div>

        <!-- 创建任务横幅：仅进行中/失败/取消出现，不占常驻版面 -->
        <div v-if="activeJobs.length" class="shrink-0 space-y-1.5 border-b bg-muted/40 px-4 py-2">
          <div v-for="j in activeJobs" :key="j.id" class="space-y-1">
            <div class="flex items-center gap-2 text-xs">
              <LoaderCircle v-if="j.state === 'running'" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              <Check v-else-if="j.state === 'done'" class="size-3.5 shrink-0 text-emerald-600" />
              <X v-else-if="j.state === 'error'" class="size-3.5 shrink-0 text-destructive" />
              <Ban v-else class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="shrink-0 font-medium">{{ kindLabel[j.kind] }} {{ j.name }}</span>
              <span
                class="min-w-0 flex-1 truncate text-muted-foreground"
                :class="j.state === 'error' ? 'text-destructive' : ''"
                :title="j.state === 'error' ? (j.error || j.statusText) : j.statusText"
              >
                {{ j.state === 'running' ? j.statusText : j.state === 'error' ? `${kindLabel[j.kind]}失败：${j.error || j.statusText}` : '已取消' }}
              </span>
              <Button variant="ghost" size="xs" class="shrink-0" @click="toggleJobLog(j)">
                {{ expandedJob === j.id ? '收起日志' : '日志' }}
              </Button>
              <Button
                v-if="j.state === 'running' && j.cancellable"
                variant="ghost"
                size="xs"
                class="shrink-0"
                @click="cancelJob(j)"
                >取消</Button
              >
            </div>
            <pre
              v-if="expandedJob === j.id"
              class="max-h-40 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs break-all whitespace-pre-wrap"
            >{{ j.state === 'running' ? (j.logTail ?? []).join('\n') || '准备中…' : fullLog.join('\n') || '（无输出）' }}</pre>
          </div>
        </div>
        <p v-if="err" class="shrink-0 border-b px-4 py-1.5 text-xs text-destructive">{{ err }}</p>

        <!-- 主体 -->
        <div class="scroll-thin min-w-0 flex-1 overflow-y-auto">
          <!-- docker 不可达：整区降级 -->
          <div
            v-if="status && !status.reachable"
            class="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
          >
            <p class="text-sm text-muted-foreground">运行时不可达，暂无法管理。</p>
            <Button variant="outline" size="sm" @click="refresh">重试</Button>
          </div>

          <!-- 空态 -->
          <div v-else-if="!sel" class="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <img src="/docker.svg" alt="" class="size-8 opacity-30" />
            <p class="text-sm text-muted-foreground">暂无应用容器</p>
            <p class="max-w-xs text-xs leading-relaxed text-muted-foreground/60">
              放一份 compose.yaml 再 <span class="font-mono">docker compose up -d</span>，
              或经侧栏收编入口纳入现有容器。
            </p>
            <InfoHint label="服务来源说明">
              <p>服务来自两处：</p>
              <p>① 目录注册——往 <span class="font-mono">~/.config/mysandbox/compose/&lt;名&gt;/</span> 放一份 compose.yaml 再 <span class="font-mono">docker compose up -d</span>（agent 干这事最顺手）；</p>
              <p>② 收编——侧栏「应用容器」分区头的 Inbox 入口纳入现有容器。</p>
            </InfoHint>
          </div>

          <!-- 服务详情（分层） -->
          <div v-else class="space-y-3 p-4">
            <!-- 一层：身份 + 操作（状态由彩色文字承担，不加点——颜色重复编码） -->
            <div class="space-y-2">
              <div class="flex min-w-0 flex-wrap items-center gap-2">
                <h3 class="min-w-0 truncate text-base font-semibold" :title="sel.name">{{ sel.displayName || sel.name }}</h3>
                <Badge variant="outline" class="shrink-0 font-normal">{{ sel.preset === 'adopted' ? '收编' : sel.preset }}</Badge>
                <span
                  v-if="sel.adopted === false && sel.hasCompose === false"
                  class="shrink-0 text-amber-600"
                  title="旧版创建、没有 compose 底账——配置页可一键迁移"
                  >旧版 · 待迁移</span
                >
                <span v-if="sel.metaMissing" class="shrink-0 text-amber-600" title="sidecar 元数据缺失（state.json 被清过？）">⚠</span>
                <span class="shrink-0 text-xs" :class="stateCls(sel)" :title="sel.status">{{ stateLabel(sel.state) }}</span>
              </div>
              <p v-if="sel.description" class="text-xs text-muted-foreground">{{ sel.description }}</p>
              <div class="flex flex-wrap items-center gap-1.5">
                <!-- 未创建（目录里只有 compose.yaml 还没 up）：起停无意义，提示为主 -->
                <span v-if="sel.state === 'absent'" class="text-xs text-muted-foreground">
                  底账在、容器未创建——配置页应用一次即可
                </span>
                <Button
                  v-else-if="!sel.running"
                  variant="outline"
                  size="sm"
                  :disabled="!!busyName"
                  :title="busyName === sel.name ? '处理中…' : ''"
                  @click="svcAction('start')"
                  >启动</Button
                >
                <Button v-else variant="outline" size="sm" :disabled="!!busyName" @click="svcAction('stop')"
                  >停止</Button
                >
                <Button v-if="sel.state !== 'absent'" variant="outline" size="sm" :disabled="!!busyName" @click="svcAction('restart')">重启</Button>
                <!-- 更新/重建已退役：追新镜像 = 配置页改 image 版本 + 应用；本地 build 迭代 =
                     构建并应用（up -d --build）。compose 幂等收敛，没有「镜像身份漂移」心智。 -->
                <!-- 打开：端口表来自实测监听扫描（3s 跟刷，全预设通用），未扫到时回退
                     custom 手工登记端口。非 HTTP 端口浏览器打不开无妨（尽力而为）。 -->
                <Button
                  v-for="p in openPorts"
                  :key="'open' + p"
                  variant="outline"
                  size="sm"
                  @click="sel && openServicePort(sel, p)"
                >
                  <Globe class="size-3.5" /> 打开 {{ p }}
                </Button>
                <!-- 收编容器不能删（不是我们的对象）：取消收编 = 还原网络 + 清登记，
                     容器本体不动（adopted 栈也走这里——整栈一起摘）。 -->
                <Button
                  v-if="sel.adopted"
                  variant="ghost"
                  size="sm"
                  class="ml-auto text-destructive hover:text-destructive"
                  :disabled="!!busyName"
                  @click="askUnadopt"
                  >取消收编</Button
                >
                <DropdownMenu v-else>
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
                      <DropdownMenuItem @click="askDelete(false)">删除（留数据卷）</DropdownMenuItem>
                      <DropdownMenuItem class="text-destructive" @click="askDelete(true)">删除（连数据）</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <!-- 一层：连接（服务的第一用法，直接给） -->
            <div class="space-y-1.5">
              <p class="text-[11px] font-medium text-muted-foreground">连接</p>              <div v-if="sel.connect.length" class="space-y-1">
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
              <p v-else class="text-xs text-muted-foreground">无现成连接命令</p>
              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <span class="shrink-0">IP</span>
                <button
                  v-if="sel.ip"
                  type="button"
                  class="cursor-pointer font-mono tabular-nums transition-colors hover:text-foreground hover:underline"
                  :title="copied === sel.ip ? '已复制' : '点击复制'"
                  @click="copyVal(sel.ip)"
                >
                  {{ copied === sel.ip ? '已复制' : sel.ip }}
                </button>
                <span v-else>—</span>
              </div>
            </div>

            <!-- 一点五层：多容器项目成员（默认收）——入口/加入列表/成员状态 -->
            <div v-if="sel.stackServices && sel.stackServices.length > 1" class="border-t pt-2">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                @click="openStack = !openStack"
              >
                <ChevronRight class="size-3.5 shrink-0 transition-transform" :class="openStack ? 'rotate-90' : ''" />
                项目成员（{{ sel.stackServices.length }}）
                <span class="font-normal text-muted-foreground/60">入口 {{ sel.stackServices.find((s) => s.entry)?.name }}</span>
              </button>
              <div v-if="openStack" class="divide-y rounded-md border">
                <div
                  v-for="s in sel.stackServices"
                  :key="s.container"
                  class="flex items-center gap-2 px-3 py-1.5"
                >
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    :class="s.running ? 'bg-emerald-500' : 'bg-muted-foreground/30'"
                  />
                  <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="s.container">{{ s.name }}</span>
                  <span class="shrink-0 text-[10px]" :class="s.running ? 'text-emerald-600' : 'text-muted-foreground'">
                    {{ stateLabel(s.state) }}
                  </span>
                  <Button
                    v-if="!s.entry"
                    variant="ghost"
                    size="xs"
                    class="shrink-0 text-[11px]"
                    :disabled="!!stackBusy"
                    title="把这张卡片的锚点（终端/文件/日志/端口）换到这个服务上"
                    @click="stackAction(s.name, { entry: true })"
                  >设为入口</Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    class="shrink-0 text-[11px]"
                    :class="s.listed ? 'text-muted-foreground' : ''"
                    :disabled="!!stackBusy"
                    :title="s.listed ? '从侧栏列表移出（管理关系保留）' : '在侧栏为它单开一张卡片'"
                    @click="stackAction(s.name, { listed: !s.listed })"
                  >{{ s.listed ? '移出列表' : '加入列表' }}</Button>
                </div>
              </div>
            </div>

            <!-- 二层：环境变量凭据 + 元信息（默认收） -->
            <div class="border-t pt-2">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                @click="openInfo = !openInfo"
              >
                <ChevronRight class="size-3.5 shrink-0 transition-transform" :class="openInfo ? 'rotate-90' : ''" />
                凭据与详情
                <span v-if="envCount" class="font-normal text-muted-foreground/60">{{ envCount }} 项</span>
              </button>
              <div v-if="openInfo" class="space-y-3 pt-1.5">
                <div v-if="Object.keys(sel.env).length" class="space-y-1.5">
                  <p class="text-[11px] text-muted-foreground">环境变量</p>
                  <div class="divide-y rounded-md border">
                    <div
                      v-for="(v, k) in sel.env"
                      :key="k"
                      class="flex flex-col gap-0.5 px-3 py-1.5 font-mono text-xs sm:flex-row sm:gap-3"
                    >
                      <span class="shrink-0 truncate text-muted-foreground sm:w-40">{{ k }}</span>
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
                <div class="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 text-xs">
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
              </div>
            </div>

            <!-- 二点五层：配置底账（compose.yaml）——文件是唯一配置真相，默认收 -->
            <div class="border-t pt-2">
              <div class="flex items-center">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  @click="openCfg = !openCfg"
                >
                  <ChevronRight class="size-3.5 shrink-0 transition-transform" :class="openCfg ? 'rotate-90' : ''" />
                  配置（compose.yaml）
                  <span v-if="cfgDirty" class="shrink-0 font-normal text-amber-600">未保存</span>
                  <span v-else-if="cfg?.drift" class="shrink-0 font-normal text-amber-600">待应用</span>
                </button>
                <Button v-if="openCfg" variant="ghost" size="icon-xs" title="重新读取文件" @click="selService && loadCfg(selService)">
                  <RefreshCw class="size-3.5" />
                </Button>
              </div>

              <!-- adopted 栈：原文件只读展示（编辑/应用归原编排方）——必须在 adopted 分支前 -->
              <div v-if="openCfg && cfg && cfg.readonly" class="space-y-2 pt-1.5">
                <div class="flex items-start gap-1.5">
                  <p class="flex-1 text-xs text-muted-foreground">
                    收编的 compose 栈——配置回原文件改，这里重启栈生效。
                  </p>
                  <InfoHint label="原底账路径">
                    <p class="font-mono break-all">{{ cfg.path }}</p>
                    <p>面板不做第二份可编辑副本。</p>
                  </InfoHint>
                </div>
                <p v-if="cfgLoading" class="py-6 text-center text-xs text-muted-foreground">读取中…</p>
                <CodeEditor
                  v-else
                  :model-value="cfgYaml"
                  language="yaml"
                  class="h-72 rounded-md border"
                  :options="{ readOnly: true }"
                />
              </div>

              <!-- 收编容器没有底账（生命周期归它自己的编排方） -->
              <p v-else-if="openCfg && sel.adopted" class="pt-1.5 text-xs text-muted-foreground">
                收编容器没有 compose 底账——配置归原编排方管。
              </p>

              <!-- 旧版创建（无底账）：迁移入口 -->
              <div v-else-if="openCfg && cfg && cfg.yaml == null" class="space-y-2 pt-1.5">
                <div class="flex items-start gap-1.5">
                  <p class="flex-1 text-xs text-muted-foreground">
                    旧版创建、没有 compose 底账——迁移后才能「编辑 + 应用」。
                  </p>
                  <InfoHint label="迁移语义说明">
                    <p>迁移按当前容器形状生成底账 <span class="font-mono break-all">{{ cfg.path }}</span>，然后由 compose 接管。</p>
                    <p>数据卷无损；容器会重建一次，短暂中断。</p>
                  </InfoHint>
                </div>
                <Button size="sm" :disabled="!!busyName || applying" @click="sel && requestServiceMigrate(sel)">迁移到 compose 底账</Button>
              </div>

              <!-- 编辑 + 应用 -->
              <div v-else-if="openCfg && cfg && cfg.yaml != null" class="space-y-2 pt-1.5">
                <p class="truncate text-[11px] text-muted-foreground" :title="cfg.path">
                  <span class="font-mono">{{ cfg.path }}</span>
                  <span class="ml-1.5 text-muted-foreground/60">终端手改此文件 + docker compose up -d 等价</span>
                </p>
                <p v-if="cfgLoading" class="py-6 text-center text-xs text-muted-foreground">读取中…</p>
                <!-- 放大 = 外层容器从抽屉内嵌切到全屏覆盖（fixed）；同一编辑器实例不重建。 -->
                <div
                  v-else
                  :class="
                    cfgZoom
                      ? 'fixed inset-3 z-[70] flex flex-col overflow-hidden rounded-lg border bg-zinc-900 shadow-2xl'
                      : 'relative overflow-hidden rounded-md border'
                  "
                  @keydown.capture.esc.prevent="cfgZoom = false"
                >
                  <!-- 放大态工具条：路径/dirty 状态 + 应用动作原样可用 + 退出 -->
                  <div v-if="cfgZoom" class="flex shrink-0 items-center gap-2 border-b px-2 py-1.5">
                    <span class="truncate font-mono text-[11px] text-muted-foreground" :title="cfg.path">{{ cfg.path }}</span>
                    <span v-if="cfgDirty" class="shrink-0 text-[11px] text-amber-600">未保存</span>
                    <span v-else-if="cfg.drift" class="shrink-0 text-[11px] text-amber-600">待应用</span>
                    <span class="min-w-0 flex-1" />
                    <span class="shrink-0 text-[11px] text-muted-foreground/60">Esc 或</span>
                    <Button variant="ghost" size="icon-xs" title="收起" @click="cfgZoom = false">
                      <Minimize2 class="size-3.5" />
                    </Button>
                  </div>
                  <CodeEditor
                    v-model="cfgYaml"
                    language="yaml"
                    :class="cfgZoom ? 'min-h-0 flex-1' : 'h-96'"
                    @save="applyCfg(false)"
                  />
                  <div v-if="cfgZoom" class="flex shrink-0 flex-wrap items-center gap-1.5 border-t px-2 py-1.5">
                    <Button size="sm" :disabled="applying || (!cfgDirty && !cfg.drift)" @click="applyCfg(false)">
                      <LoaderCircle v-if="applying" class="size-3.5 animate-spin" /> 应用
                    </Button>
                    <Button v-if="cfg.hasBuild" size="sm" variant="outline" :disabled="applying" @click="applyCfg(true)">
                      <LoaderCircle v-if="applying" class="size-3.5 animate-spin" /> 构建并应用
                    </Button>
                    <span v-if="cfgDirty" class="text-[11px] text-amber-600">有未保存修改——应用以编辑器内容为准</span>
                    <span v-else-if="cfg.drift" class="text-[11px] text-amber-600">文件与容器不一致，应用后收敛</span>
                  </div>
                  <!-- 内嵌态：放大入口浮在编辑器右上角 -->
                  <Button
                    v-if="!cfgZoom"
                    variant="ghost"
                    size="icon-xs"
                    class="absolute right-1.5 top-1.5 z-10 bg-zinc-900/80 text-muted-foreground hover:text-foreground"
                    title="放大编辑"
                    @click="cfgZoom = true"
                  >
                    <Maximize2 class="size-3.5" />
                  </Button>
                </div>
                <div v-if="!cfgZoom" class="flex flex-wrap items-center gap-1.5">
                  <Button size="sm" :disabled="applying || (!cfgDirty && !cfg.drift)" @click="applyCfg(false)">
                    <LoaderCircle v-if="applying" class="size-3.5 animate-spin" /> 应用
                  </Button>
                  <Button v-if="cfg.hasBuild" size="sm" variant="outline" :disabled="applying" @click="applyCfg(true)">
                    <LoaderCircle v-if="applying" class="size-3.5 animate-spin" /> 构建并应用
                  </Button>
                  <span v-if="cfgDirty" class="text-[11px] text-amber-600">有未保存修改——应用以编辑器内容为准</span>
                  <span v-else-if="cfg.drift" class="text-[11px] text-amber-600">文件与容器不一致，应用后收敛</span>
                </div>
              </div>
              <p v-if="openCfg && cfgErr" class="pt-1.5 text-xs text-destructive">{{ cfgErr }}</p>
            </div>

            <!-- 三层：日志（默认收，点开才拉、开着才跟刷） -->
            <div class="border-t pt-2">
              <div class="flex items-center">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  @click="openLog = !openLog"
                >
                  <ChevronRight class="size-3.5 shrink-0 transition-transform" :class="openLog ? 'rotate-90' : ''" />
                  日志
                  <span v-if="openLog" class="font-normal text-muted-foreground/60">自动跟随</span>
                </button>
                <Button v-if="openLog" variant="ghost" size="icon-xs" title="立即刷新" @click="refreshSelLog">
                  <RefreshCw class="size-3.5" />
                </Button>
              </div>
              <pre
                v-if="openLog"
                class="mt-1.5 max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
              >{{ logs[sel.name] ?? '加载中…' }}</pre>
            </div>
          </div>
        </div>

        <!-- 底部状态行：docker 环境信息沉底（不属于任何一个服务） -->
        <div class="shrink-0 space-y-0.5 border-t px-4 py-2 text-[11px] text-muted-foreground">
          <p>
            <template v-if="status">
              运行时 {{ status.reachable ? (status.version ?? '可达') : '不可达' }}
              <template v-if="status.reachable">
                · {{ status.network.name }} {{ status.network.subnet ?? '' }}
                · 池 {{ status.pool.from }}–{{ status.pool.to }} · 已用 {{ status.pool.assigned.length }}
              </template>
            </template>
            <template v-else>加载中…</template>
          </p>
          <p v-if="status?.error" class="text-destructive">{{ status.error }}</p>
          <p v-if="status?.network.detail" class="text-amber-600">{{ status.network.detail }}</p>
          <p v-if="status?.registryMirrors?.length === 0" class="flex items-start gap-1.5 text-amber-600">
            <span class="flex-1">未配置 registry-mirrors——受限网络下 Docker Hub 直连常失败。</span>
            <InfoHint label="registry-mirrors 说明">
              <p>可在 <span class="font-mono">/etc/docker/daemon.json</span> 配置 <span class="font-mono">registry-mirrors</span> 后重启 docker。</p>
              <p>私有 registry 不受影响。</p>
            </InfoHint>
          </p>
        </div>

        <ConfirmDialog
          v-if="pendingDelete"
          :title="pendingDelete.deleteData ? `删除应用容器 ${pendingDelete.name}（连数据）` : `删除应用容器 ${pendingDelete.name}`"
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

        <ConfirmDialog
          v-if="pendingUnadopt"
          :title="`取消收编 ${pendingUnadopt}`"
          description="将移出服务网络并清除登记，恢复为普通外部容器——容器与数据不动，hosts 解析随之消失。"
          confirm-text="取消收编"
          variant="destructive"
          @confirm="confirmUnadopt"
          @close="pendingUnadopt = ''"
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
