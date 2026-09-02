<script setup lang="ts">
// docker 服务面板：配套服务（数据库等）的列表 / 启停 / 日志 / 删除 / 新建。
// 服务 = mysandbox 启动的单容器 docker 服务（label 标记），固定 IP 直连、不发布端口，
// LXC 容器经 hosts 注入按服务名访问（LXC 在自有桥 mysandbox0 上，与 mysandbox-lan 经宿主
// 路由互通）。头部状态行展示 docker 可达性与服务网络就绪态；创建走后台任务，
// 表格上方任务区展示进度/日志/取消，完成通知由 lib/serviceJobs.ts 全局去重发 toast。
import { ref, onMounted, onUnmounted } from 'vue'
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
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ServiceCreateDialog from '@/components/ServiceCreateDialog.vue'
import { LoaderCircle, Check, X, Ban } from 'lucide-vue-next'

// initialCreate=true：来自侧栏服务摘要条的 ＋ ——面板一打开就弹新建对话框（普通入口只展示管理面板）。
const props = defineProps<{ initialCreate?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const items = ref<ServiceView[]>([])
const status = ref<ServicesStatus | null>(null)
const busyName = ref('')
const err = ref('')
const copied = ref('')
const showCreate = ref(!!props.initialCreate)
// 行内日志：服务名 -> 日志内容（null = 未加载）。展开期间随 3s 轮询自动刷新，
// 不用反复手动点「日志」拿新输出。
const logs = ref<Record<string, string>>({})
// 删除确认：null 关闭；{name, deleteData} 打开
const pendingDelete = ref<{ name: string; deleteData: boolean } | null>(null)
// 行内详情展开（连接命令 + env 凭据 + 描述/命令）：服务名 -> 展开。刻意不做嵌套
// 弹窗——「⋯菜单 → 弹窗 → 关弹窗」的交互层数没必要，与日志一样就地展开。
const expandedInfo = ref('')

// —— 创建任务 ——
// 面板打开期间 3s 轮询（侧栏另有独立轮询；两者喂同一 trackServiceJobs 去重通知）。
// expandedJob：展开日志的任务 id；全量日志按需 getServiceJob（列表轮询只带 60 行预览）。
// seenDoneIds：上轮已见的终态集合——出现新终态（创建成功/失败）时刷一次服务表。
const jobs = ref<ServiceJobView[]>([])
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
    if (seenDoneIds.size > 0 && [...doneIds].some((id) => !seenDoneIds.has(id))) void refresh()
    seenDoneIds = doneIds
    if (expandedJob.value && v.jobs.some((j) => j.id === expandedJob.value)) {
      try {
        fullLog.value = (await getServiceJob(expandedJob.value)).log
      } catch {
        /* 日志拉取失败保留旧内容 */
      }
    }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    /* 任务列表拉取失败不打扰主流程（docker 抖动），下轮再试 */
  }
}

async function toggleJobLog(j: ServiceJobView) {
  if (expandedJob.value === j.id) {
    expandedJob.value = ''
    return
  }
  expandedJob.value = j.id
  try {
    fullLog.value = (await getServiceJob(j.id)).log
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
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

async function refresh() {
  try {
    const v = await listServices()
    items.value = v.items
    status.value = v.status
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
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

async function toggleLogs(s: ServiceView) {
  if (logs.value[s.name] != null) {
    delete logs.value[s.name]
    return
  }
  try {
    const v = await getServiceLogs(s.name)
    logs.value[s.name] = v.logs || '（无输出）'
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  }
}

// 已展开的日志每轮轮询跟着刷一次（单个失败静默，下轮再试）。
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

function toggleInfo(s: ServiceView) {
  expandedInfo.value = expandedInfo.value === s.name ? '' : s.name
}

// 首选连接命令（每预设至多一条）；空串 = 无现成命令（自定义镜像）。
function primaryConnect(s: ServiceView): string {
  return s.connect[0] ?? ''
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
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-6xl">
      <DialogHeader>
        <DialogTitle>docker 服务</DialogTitle>
        <DialogDescription>
          配套服务（postgres/redis…）：固定 IP 直连，容器内按服务名访问（hosts 自动注入），不发布端口到宿主。
        </DialogDescription>
      </DialogHeader>

      <div v-if="status" class="space-y-1 text-xs text-muted-foreground">
        <p>
          docker {{ status.reachable ? `可达（${status.version ?? '?'}）` : '不可达' }}
          <template v-if="status.reachable">
            · 网络 {{ status.network.name }}（{{ status.network.subnet ?? '?' }}）
            <template v-if="status.network.bridgeOk">· 网络就绪</template>
          </template>
          · 服务池 {{ status.pool.from }}–{{ status.pool.to }}（已用 {{ status.pool.assigned.length }}）
        </p>
        <p v-if="status.error" class="text-destructive">{{ status.error }}</p>
        <p v-if="status.network.detail" class="text-amber-600">{{ status.network.detail }}</p>
        <p v-if="status.registryMirrors?.length === 0" class="text-amber-600">
          daemon 未配置 registry-mirrors——Docker Hub 直连在受限网络下常缓慢/失败；可在 /etc/docker/daemon.json
          配置后重启 docker（私有 registry 不受影响）。
        </p>
      </div>

      <div v-if="!status?.reachable" class="space-y-2">
        <p class="text-sm text-muted-foreground">
          docker 不可达——服务面板暂不可用，容器管理不受影响。
        </p>
        <Button variant="outline" size="sm" @click="refresh">重试</Button>
      </div>

      <div v-else class="space-y-2">
        <!-- 创建任务区：running 行可看日志/取消；终态行保留最近结果（error 摘要 title 全文）。
             数据来自 3s 轮询；完成通知由 trackServiceJobs 全局去重，面板只管展示。 -->
        <div v-if="jobs.length" class="space-y-1.5">
          <div
            v-for="j in jobs"
            :key="j.id"
            class="rounded-md border px-2 py-1.5"
          >
            <div class="flex items-center gap-2">
              <LoaderCircle v-if="j.state === 'running'" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              <Check v-else-if="j.state === 'done'" class="size-3.5 shrink-0 text-emerald-600" />
              <X v-else-if="j.state === 'error'" class="size-3.5 shrink-0 text-destructive" />
              <Ban v-else class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="shrink-0 text-sm font-medium">{{ j.name }}</span>
              <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground" :title="j.error ?? j.statusText">
                {{ j.state === 'error' ? (j.error || j.statusText) : j.statusText }}
              </span>
              <Button
                v-if="j.state === 'running' && j.cancellable"
                variant="ghost"
                size="xs"
                class="shrink-0"
                @click="cancelJob(j)"
              >
                取消
              </Button>
              <Button variant="ghost" size="xs" class="shrink-0" @click="toggleJobLog(j)">
                {{ expandedJob === j.id ? '收起日志' : '日志' }}
              </Button>
            </div>
            <div v-if="expandedJob === j.id" class="mt-1.5">
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed">{{
                expandedJob === j.id ? fullLog.join('\n') : (j.logTail ?? []).join('\n')
              }}</pre>
            </div>
          </div>
        </div>

        <div class="flex items-center justify-between">
          <Button variant="outline" size="sm" @click="refresh">刷新</Button>
          <Button size="sm" @click="showCreate = true">新建服务</Button>
        </div>

        <div v-if="items.length === 0" class="rounded-md border p-6 text-center text-sm text-muted-foreground">
          还没有服务。点「新建服务」起一个 postgres 试试——容器里就能 <code>psql -h pg</code> 直连。
        </div>

        <!-- 服务表：桌面 9 列表格；手机卡片化（md:hidden/md:block 双渲染，数据源相同）。
             连接命令是一级信息（用面板 primarily 就是「拿连接串」），直接进列、点击复制，
             不再藏进 ⋯ → 详情；env 全量凭据仍在详情行。 -->
        <div v-if="items.length" class="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名称</TableHead>
                <TableHead>连接</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>镜像</TableHead>
                <TableHead>IP</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>卷</TableHead>
                <TableHead>描述</TableHead>
                <TableHead class="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
            <template v-for="s in items" :key="s.name">
              <TableRow>
                <TableCell class="font-medium">
                  {{ s.name }}
                  <span v-if="s.metaMissing" title="sidecar 元数据缺失（state.json 被清过？），重建可恢复" class="text-amber-600"> ⚠</span>
                </TableCell>
                <TableCell class="max-w-80">
                  <button
                    v-if="primaryConnect(s)"
                    type="button"
                    class="block w-full cursor-pointer truncate text-left font-mono text-xs hover:underline"
                    :title="`${primaryConnect(s)}（点击复制）`"
                    @click="copyVal(primaryConnect(s))"
                  >
                    {{ copied === primaryConnect(s) ? '已复制 ✓' : primaryConnect(s) }}
                  </button>
                  <button
                    v-else
                    type="button"
                    class="cursor-pointer text-xs text-muted-foreground hover:underline"
                    title="无现成连接命令——点看 env 详情"
                    @click="toggleInfo(s)"
                  >
                    —（点看 env）
                  </button>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" class="font-normal">{{ s.preset }}</Badge>
                </TableCell>
                <TableCell class="max-w-40 truncate font-mono text-xs" :title="s.image">{{ s.image }}</TableCell>
                <TableCell>
                  <button
                    v-if="s.ip"
                    type="button"
                    class="cursor-pointer font-mono text-xs hover:underline"
                    :title="copied === s.ip ? '已复制' : '点击复制'"
                    @click="copyVal(s.ip ?? '')"
                  >
                    {{ copied === s.ip ? '已复制' : s.ip }}
                  </button>
                  <span v-else class="text-xs text-muted-foreground">-</span>
                </TableCell>
                <TableCell class="text-xs">
                  <span :class="stateCls(s)" :title="s.status">{{ s.running ? 'running' : s.state }}</span>
                </TableCell>
                <TableCell class="max-w-36 truncate font-mono text-xs" :title="s.volume ?? '无数据卷'">
                  {{ s.volume ?? '-' }}
                </TableCell>
                <TableCell class="text-xs">
                  <p class="max-w-48 truncate" :title="s.description || undefined">{{ s.description || '—' }}</p>
                  <p v-if="s.createdAt" class="text-muted-foreground">{{ fmtDate(s.createdAt) }}</p>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button variant="ghost" size="sm" :disabled="busyName === s.name">⋯</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem @click="toggleInfo(s)">{{ expandedInfo === s.name ? '收起详情' : '详情' }}</DropdownMenuItem>
                      <DropdownMenuItem v-if="!s.running" @click="op(s.name, () => startService(s.name))">启动</DropdownMenuItem>
                      <DropdownMenuItem v-if="s.running" @click="op(s.name, () => stopService(s.name))">停止</DropdownMenuItem>
                      <DropdownMenuItem @click="op(s.name, () => restartService(s.name))">重启</DropdownMenuItem>
                      <DropdownMenuItem @click="toggleLogs(s)">{{ logs[s.name] != null ? '收起日志' : '日志' }}</DropdownMenuItem>
                      <DropdownMenuItem @click="pendingDelete = { name: s.name, deleteData: false }">删除（留数据）</DropdownMenuItem>
                      <DropdownMenuItem class="text-destructive" @click="pendingDelete = { name: s.name, deleteData: true }">
                        删除（连数据）
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
              <!-- 详情行：连接命令 + env 凭据优先（最高频关注内容），命令/元数据垫后；
                   就地展开，取代原嵌套「连接信息」弹窗。 -->
              <TableRow v-if="expandedInfo === s.name">
                <TableCell colspan="9" class="bg-muted/30 p-2">
                  <div class="space-y-2 text-xs">
                    <div v-if="s.connect.length">
                      <p class="mb-1 text-muted-foreground">连接命令（点击复制）：</p>
                      <div class="space-y-1">
                        <button
                          v-for="c in s.connect"
                          :key="c"
                          type="button"
                          class="block w-full cursor-pointer rounded-md border bg-background/60 p-2 text-left font-mono break-all hover:bg-muted/50"
                          :title="copied === c ? '已复制' : '点击复制'"
                          @click="copyVal(c)"
                        >
                          {{ copied === c ? '已复制' : c }}
                        </button>
                      </div>
                    </div>
                    <div v-if="Object.keys(s.env).length">
                      <p class="mb-1 text-muted-foreground">环境变量（点击值复制）：</p>
                      <div class="divide-y rounded-md border">
                        <div v-for="(v, k) in s.env" :key="k" class="flex flex-col gap-0.5 px-3 py-1.5 font-mono sm:flex-row sm:gap-3">
                          <span class="shrink-0 truncate text-muted-foreground sm:w-44">{{ k }}</span>
                          <button
                            type="button"
                            class="cursor-pointer text-left break-all hover:underline"
                            :title="copied === v ? '已复制' : '点击复制'"
                            @click="copyVal(String(v))"
                          >
                            {{ copied === v ? '已复制' : v }}
                          </button>
                        </div>
                      </div>
                    </div>
                    <p v-if="s.command?.length" class="font-mono text-muted-foreground">命令：{{ s.command.join(' ') }}</p>
                  </div>
                </TableCell>
              </TableRow>
              <TableRow v-if="logs[s.name] != null">
                <TableCell colspan="9" class="bg-muted/30 p-2">
                  <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{{ logs[s.name] }}</pre>
                </TableCell>
              </TableRow>
            </template>
            </TableBody>
          </Table>
        </div>

        <!-- 手机卡片列表：每服务一张卡（名称/状态 + 镜像/IP/卷信息行 + 操作菜单）。
             与表格共用 items/logs/busyName/op 等同一批状态与处理器，纯展示层差异。 -->
        <div v-if="items.length" class="space-y-2 md:hidden">
          <div
            v-for="s in items"
            :key="s.name"
            class="rounded-md border p-2.5"
          >
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate text-sm font-medium">
                {{ s.name }}
                <span v-if="s.metaMissing" title="sidecar 元数据缺失（state.json 被清过？），重建可恢复" class="text-amber-600"> ⚠</span>
              </span>
              <Badge variant="outline" class="shrink-0 font-normal">{{ s.preset }}</Badge>
              <span class="shrink-0 text-xs" :class="stateCls(s)" :title="s.status">{{ s.running ? 'running' : s.state }}</span>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="sm" class="shrink-0" :disabled="busyName === s.name">⋯</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @click="toggleInfo(s)">{{ expandedInfo === s.name ? '收起详情' : '详情' }}</DropdownMenuItem>
                  <DropdownMenuItem v-if="!s.running" @click="op(s.name, () => startService(s.name))">启动</DropdownMenuItem>
                  <DropdownMenuItem v-if="s.running" @click="op(s.name, () => stopService(s.name))">停止</DropdownMenuItem>
                  <DropdownMenuItem @click="op(s.name, () => restartService(s.name))">重启</DropdownMenuItem>
                  <DropdownMenuItem @click="toggleLogs(s)">{{ logs[s.name] != null ? '收起日志' : '日志' }}</DropdownMenuItem>
                  <DropdownMenuItem @click="pendingDelete = { name: s.name, deleteData: false }">删除（留数据）</DropdownMenuItem>
                  <DropdownMenuItem class="text-destructive" @click="pendingDelete = { name: s.name, deleteData: true }">
                    删除（连数据）
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div class="mt-1.5 space-y-0.5 font-mono text-xs text-muted-foreground">
              <p v-if="s.description" class="break-all text-foreground/80">{{ s.description }}</p>
              <p v-if="primaryConnect(s)">
                <button
                  type="button"
                  class="cursor-pointer break-all text-left hover:underline"
                  :title="`${primaryConnect(s)}（点击复制）`"
                  @click="copyVal(primaryConnect(s))"
                >
                  {{ copied === primaryConnect(s) ? '已复制 ✓' : primaryConnect(s) }}
                </button>
              </p>
              <p class="break-all" :title="s.image">{{ s.image }}</p>
              <p>
                <template v-if="s.ip">
                  <button
                    type="button"
                    class="cursor-pointer hover:underline"
                    :title="copied === s.ip ? '已复制' : '点击复制'"
                    @click="copyVal(s.ip)"
                  >
                    {{ copied === s.ip ? '已复制' : s.ip }}
                  </button>
                </template>
                <template v-else>-</template>
                · {{ s.volume ?? '无数据卷' }}
                <template v-if="s.createdAt"> · {{ fmtDate(s.createdAt) }}</template>
              </p>
            </div>
            <div v-if="expandedInfo === s.name" class="mt-1.5 space-y-2 text-xs">
              <div v-if="s.connect.length">
                <p class="mb-1 text-muted-foreground">连接命令（点击复制）：</p>
                <button
                  v-for="c in s.connect"
                  :key="c"
                  type="button"
                  class="mb-1 block w-full cursor-pointer rounded-md border bg-background/60 p-2 text-left font-mono break-all hover:bg-muted/50"
                  :title="copied === c ? '已复制' : '点击复制'"
                  @click="copyVal(c)"
                >
                  {{ copied === c ? '已复制' : c }}
                </button>
              </div>
              <div v-if="Object.keys(s.env).length">
                <p class="mb-1 text-muted-foreground">环境变量（点击值复制）：</p>
                <div class="divide-y rounded-md border">
                  <div v-for="(v, k) in s.env" :key="k" class="flex flex-col gap-0.5 px-3 py-1.5 font-mono">
                    <span class="break-all text-muted-foreground">{{ k }}</span>
                    <button
                      type="button"
                      class="cursor-pointer text-left break-all hover:underline"
                      :title="copied === v ? '已复制' : '点击复制'"
                      @click="copyVal(String(v))"
                    >
                      {{ copied === v ? '已复制' : v }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <div v-if="logs[s.name] != null" class="mt-1.5">
              <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono text-xs">{{ logs[s.name] }}</pre>
            </div>
          </div>
        </div>
      </div>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

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
        @cancel="pendingDelete = null"
      />

      <ServiceCreateDialog
        v-if="showCreate"
        @created="showCreate = false; refreshJobs(); refresh()"
        @close="showCreate = false"
      />
    </DialogContent>
  </Dialog>
</template>
