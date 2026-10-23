<script setup lang="ts">
// msmux 终端后端设置页（设置 → 终端后端）：全局切换 auto/tmux/msmux，
// 查看当前在线 agent，并对本机/系统容器/应用容器/SSH 目标逐个部署或重连。
//
// 这里只负责“让目标上线 + 保存服务端默认后端”；真正建会话仍走 Terminal.vue 的
// /ws/mux-terminal。auto 是渐进替代的默认值：没有 agent 的目标绝不会因为本页
// 改动而断掉旧 tmux 路径。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2, RefreshCw, Server, Terminal, Waypoints } from 'lucide-vue-next'
import {
  getMuxBackend,
  listContainers,
  listMuxAgents,
  listServices,
  listSshTargets,
  Unauthorized,
  type ContainerView,
  type MuxAgentView,
  type ServiceView,
  type SshTargetView,
} from '@/lib/api'
import {
  invalidateMuxAgents,
  setTerminalBackend,
  terminalBackend,
  type TerminalBackend,
} from '@/lib/mux'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import MuxDeployDialog from '@/components/MuxDeployDialog.vue'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

const BACKENDS: { value: TerminalBackend; title: string; detail: string }[] = [
  {
    value: 'auto',
    title: '自动',
    detail: '目标有 agent 时用 msmux，否则继续走 tmux（推荐）',
  },
  {
    value: 'tmux',
    title: '只用 tmux',
    detail: '完全保留旧路径，不改任何目标',
  },
  {
    value: 'msmux',
    title: '强制 msmux',
    detail: '新终端总是尝试 msmux；目标没上线会直接报连接错误',
  },
]

interface DeployRow {
  target: string
  label: string
  detail: string
  kind: 'host' | 'lxc' | 'service' | 'ssh'
  running: boolean
}

const backend = ref<TerminalBackend>('auto')
const agents = ref<MuxAgentView[]>([])
const containers = ref<ContainerView[]>([])
const services = ref<ServiceView[]>([])
const sshTargets = ref<SshTargetView[]>([])
const loading = ref(false)
const err = ref('')
const deployTarget = ref<DeployRow | null>(null)

const online = computed(() => new Map(agents.value.map((a) => [a.target, a])))

const rows = computed<DeployRow[]>(() => {
  const out: DeployRow[] = [
    { target: 'host', label: '本机', detail: '宿主 shell', kind: 'host', running: true },
  ]
  for (const c of containers.value) {
    out.push({
      target: `c:${c.name}`,
      label: c.displayName || c.name,
      detail: c.ip ? `系统容器 · ${c.ip}` : '系统容器 · 无 IP',
      kind: 'lxc',
      running: c.state === 'running',
    })
  }
  for (const s of services.value) {
    out.push({
      target: `s:${s.name}`,
      label: s.displayName || s.name,
      detail: s.ip ? `应用容器 · ${s.ip}` : '应用容器',
      kind: 'service',
      running: s.running,
    })
  }
  for (const t of sshTargets.value) {
    out.push({
      target: `ssh:${t.name}`,
      label: t.name,
      detail: `${t.user ? t.user + '@' : ''}${t.host}${t.port ? ':' + t.port : ''}`,
      kind: 'ssh',
      running: true,
    })
  }
  // 在线目标永远先出现；同类里保持服务端原序。
  return out.sort((a, b) => Number(!!online.value.has(b.target)) - Number(!!online.value.has(a.target)))
})

const deployableCount = computed(() => rows.value.filter((r) => r.running).length)
const onlineCount = computed(() => agents.value.length)

async function chooseBackend(value: TerminalBackend) {
  backend.value = value
  try {
    await setTerminalBackend(value)
    toast.success(`终端默认后端：${BACKENDS.find((x) => x.value === value)?.title}`, {
      description: '已打开的终端保持不变；未显式选择的新终端按新设置选择后端。',
    })
  } catch (e) {
    if (e instanceof Unauthorized) return emit('unauthorized')
    await terminalBackend().then((v) => (backend.value = v))
    toast.error('终端后端保存失败')
  }
}

async function loadAgents() {
  try {
    agents.value = (await listMuxAgents()).agents
    invalidateMuxAgents()
  } catch (e) {
    if (e instanceof Unauthorized) return emit('unauthorized')
    // agent 查询失败不遮住部署列表：目标是静态清单，仍可部署。
    agents.value = []
  }
}

async function loadAll() {
  if (loading.value) return
  loading.value = true
  err.value = ''
  try {
    const [cs, sv, ssh, pref] = await Promise.all([
      listContainers(),
      listServices().catch(() => ({ items: [] as ServiceView[] })),
      listSshTargets().catch(() => ({ targets: [] as SshTargetView[] })),
      getMuxBackend().catch(() => ({ backend: 'auto' as TerminalBackend })),
    ])
    containers.value = cs.items
    services.value = sv.items
    sshTargets.value = ssh.targets
    backend.value = pref.backend
    await loadAgents()
  } catch (e) {
    if (e instanceof Unauthorized) return emit('unauthorized')
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void loadAll()
  // 在线状态来自服务端内存里的 agent 连接，轻量轮询即可；部署后也会立即刷新。
  timer = setInterval(() => void loadAgents(), 5_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

function onDeployed() {
  void loadAgents()
}

function stateText(row: DeployRow): string {
  if (online.value.has(row.target)) return '在线'
  return row.running ? '未上线' : '未运行'
}
</script>

<template>
  <section class="space-y-5">
    <div class="space-y-2">
      <div class="flex items-center gap-1.5">
        <Terminal class="size-4 text-muted-foreground" />
        <h3 class="text-sm font-medium">浏览器终端后端</h3>
      </div>
      <p class="text-xs leading-relaxed text-muted-foreground">
        msmux 是内置的轻量会话语义替代品。默认自动切换，逐个目标部署即可渐进迁移，不需要一次切完。
      </p>
      <div class="grid gap-2">
        <button
          v-for="item in BACKENDS"
          :key="item.value"
          type="button"
          class="flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/50"
          :class="backend === item.value ? 'border-primary/50 bg-primary/5' : 'border-border'"
          @click="chooseBackend(item.value)"
        >
          <span
            class="mt-1 size-2.5 shrink-0 rounded-full border"
            :class="backend === item.value ? 'border-primary bg-primary' : 'border-muted-foreground/50'"
          />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ item.title }}</span>
            <span class="block text-xs text-muted-foreground">{{ item.detail }}</span>
          </span>
        </button>
      </div>
    </div>

    <div class="border-t" />

    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <Server class="size-4 text-muted-foreground" />
        <h3 class="text-sm font-medium">在线 agent</h3>
        <Badge variant="outline" class="text-[10px]">{{ onlineCount }}</Badge>
        <Button variant="ghost" size="icon-xs" class="ml-auto" :disabled="loading" title="刷新状态" @click="loadAll">
          <RefreshCw :class="loading ? 'animate-spin' : ''" />
        </Button>
      </div>
      <p v-if="!agents.length" class="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        暂无在线 agent。auto 模式下所有终端继续使用 tmux；从下面选一个目标部署即可开始切换。
      </p>
      <div v-else class="space-y-1">
        <div
          v-for="a in agents"
          :key="a.target"
          class="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs"
        >
          <span class="size-1.5 shrink-0 rounded-full bg-emerald-500" />
          <code class="min-w-0 flex-1 truncate font-mono">{{ a.target }}</code>
          <span class="shrink-0 text-muted-foreground">{{ a.protocol ? `v${a.protocol}` : '握手…' }}</span>
          <span class="shrink-0 text-muted-foreground">{{ a.channels }} 会话</span>
        </div>
      </div>
    </div>

    <div class="border-t" />

    <div class="space-y-2">
      <div class="flex items-center gap-2">
        <Waypoints class="size-4 text-muted-foreground" />
        <h3 class="text-sm font-medium">部署目标</h3>
        <Badge variant="outline" class="text-[10px]">{{ deployableCount }}</Badge>
      </div>
      <p v-if="err" class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{{ err }}</p>
      <p class="text-[11px] leading-relaxed text-muted-foreground">
        只列出当前可部署的目标；已在线也可以重新部署（更新二进制/重连）。SSH 目标部署时会要求填写它可达的回连地址。
      </p>
      <div class="space-y-1">
        <div
          v-for="row in rows"
          :key="row.target"
          class="flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5"
          :class="row.running ? '' : 'opacity-55'"
        >
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="min-w-0 truncate text-sm">{{ row.label }}</span>
              <code class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ row.target }}</code>
            </div>
            <p class="truncate text-[10px] text-muted-foreground" :title="row.detail">{{ row.detail }}</p>
          </div>
          <span
            class="shrink-0 text-[10px]"
            :class="online.has(row.target) ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'"
          >{{ stateText(row) }}</span>
          <Button
            variant="outline"
            size="xs"
            class="shrink-0"
            :disabled="!row.running"
            :title="row.running ? '上传 msmux 并启动/重连 agent' : '目标未运行，先启动再部署'"
            @click="deployTarget = row"
          >
            {{ online.has(row.target) ? '重连' : '部署' }}
          </Button>
        </div>
        <p v-if="!rows.length" class="px-2 py-3 text-xs text-muted-foreground">没有可部署目标</p>
      </div>
    </div>

    <p class="text-[11px] leading-relaxed text-muted-foreground">
      注意：agent 目前用 nohup / systemd 用户单元拉起。目标容器重启后需要再次部署一次；
      后续会补上目标侧自启动。
    </p>
  </section>

  <MuxDeployDialog
    v-if="deployTarget"
    :target="deployTarget.target"
    :label="deployTarget.label"
    @close="deployTarget = null"
    @deployed="onDeployed"
    @unauthorized="emit('unauthorized')"
  />
</template>
