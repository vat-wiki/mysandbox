<script setup lang="ts">
// docker 服务面板：配套服务（数据库等）的列表 / 启停 / 日志 / 删除 / 新建。
// 服务 = mysandbox 启动的单容器 docker 服务（label 标记），固定 IP 直连、不发布端口，
// LXC 容器经 hosts 注入按服务名访问。头部状态行展示 docker 可达性与 dev-lan 桥一致性
// （桥名变了 = dev-lan 被重建过，需要同步 config 与网关 unit）。
import { ref, onMounted } from 'vue'
import {
  listServices,
  startService,
  stopService,
  restartService,
  deleteService,
  getServiceLogs,
  Unauthorized,
  type ServiceView,
  type ServicesStatus,
} from '@/lib/api'
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

// initialCreate=true：来自侧栏服务摘要条的 ＋ ——面板一打开就弹新建对话框（普通入口只展示管理面板）。
const props = defineProps<{ initialCreate?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const items = ref<ServiceView[]>([])
const status = ref<ServicesStatus | null>(null)
const busyName = ref('')
const err = ref('')
const copied = ref('')
const showCreate = ref(!!props.initialCreate)
// 行内日志：服务名 -> 日志内容（null = 未加载）
const logs = ref<Record<string, string>>({})
// 删除确认：null 关闭；{name, deleteData} 打开
const pendingDelete = ref<{ name: string; deleteData: boolean } | null>(null)

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

onMounted(refresh)

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
    <DialogContent class="max-w-3xl">
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
            <template v-if="status.network.bridgeOk">· 桥一致</template>
          </template>
          · 服务池 {{ status.pool.from }}–{{ status.pool.to }}（已用 {{ status.pool.assigned.length }}）
        </p>
        <p v-if="status.error" class="text-destructive">{{ status.error }}</p>
        <p v-if="status.network.detail" class="text-amber-600">{{ status.network.detail }}</p>
      </div>

      <div v-if="!status?.reachable" class="space-y-2">
        <p class="text-sm text-muted-foreground">
          docker 不可达——服务面板暂不可用，容器管理不受影响。
        </p>
        <Button variant="outline" size="sm" @click="refresh">重试</Button>
      </div>

      <div v-else class="space-y-2">
        <div class="flex items-center justify-between">
          <Button variant="outline" size="sm" @click="refresh">刷新</Button>
          <Button size="sm" @click="showCreate = true">新建服务</Button>
        </div>

        <div v-if="items.length === 0" class="rounded-md border p-6 text-center text-sm text-muted-foreground">
          还没有服务。点「新建服务」起一个 postgres 试试——容器里就能 <code>psql -h pg</code> 直连。
        </div>

        <Table v-else>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead>类型</TableHead>
              <TableHead>镜像</TableHead>
              <TableHead>IP</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>卷</TableHead>
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
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                      <Button variant="ghost" size="sm" :disabled="busyName === s.name">⋯</Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" class="w-36">
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
              <TableRow v-if="logs[s.name] != null">
                <TableCell colspan="7" class="bg-muted/30 p-2">
                  <pre class="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{{ logs[s.name] }}</pre>
                </TableCell>
              </TableRow>
            </template>
          </TableBody>
        </Table>
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

      <ServiceCreateDialog v-if="showCreate" @created="showCreate = false; refresh()" @close="showCreate = false" />
    </DialogContent>
  </Dialog>
</template>
