<script setup lang="ts">
// 集群面板（嵌入 SettingsDialog 的 cluster 分区）：加入集群 + peer 列表 + 隧道状态。
import { onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Plus, Loader2, Trash2, RefreshCw } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getClusterStatus, clusterJoin, clusterLeave, clusterPullTemplate, clusterSyncSkills, Unauthorized, type ClusterStatusView, type ClusterPeerInfo } from '@/lib/api'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

const status = ref<ClusterStatusView | null>(null)
const loading = ref(false)
const joining = ref(false)
const showJoin = ref(false)
const joinUrl = ref('')
const joinToken = ref('')
const joinName = ref('')

async function refresh() {
  loading.value = true
  try {
    status.value = await getClusterStatus()
  } catch (e) {
    if (e instanceof Unauthorized) return emit('unauthorized')
    toast.error(`加载集群状态失败: ${e instanceof Error ? e.message : e}`)
  } finally {
    loading.value = false
  }
}

async function join() {
  if (!joinUrl.value || !joinToken.value) return
  joining.value = true
  try {
    await clusterJoin(joinUrl.value, joinToken.value, joinName.value || undefined)
    toast.success(`已加入 ${joinUrl.value}`)
    showJoin.value = false
    joinUrl.value = ''
    joinToken.value = ''
    joinName.value = ''
    await refresh()
  } catch (e) {
    if (e instanceof Unauthorized) return emit('unauthorized')
    toast.error(`加入失败: ${e instanceof Error ? e.message : e}`)
  } finally {
    joining.value = false
  }
}

async function leave(machineId: string, name: string) {
  if (!confirm(`确定要断开与 ${name} 的连接吗？`)) return
  try {
    await clusterLeave(machineId)
    toast.success(`已断开 ${name}`)
    await refresh()
  } catch (e) {
    toast.error(`断开失败: ${e instanceof Error ? e.message : e}`)
  }
}

function lastSeenText(peer: ClusterPeerInfo): string {
  if (!peer.lastSeenAt) return '从未连接'
  const diff = Date.now() - new Date(peer.lastSeenAt).getTime()
  if (diff < 60_000) return '在线'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  return '离线'
}

async function pullTemplate(machineId: string, name: string) {
  try {
    const r = await clusterPullTemplate(machineId)
    if (r.ok) toast.success(`已从 ${name} 拉取模板`)
    else toast.error(r.error ?? '拉取失败')
  } catch (e) {
    toast.error(`拉取失败: ${e instanceof Error ? e.message : e}`)
  }
}

async function syncSkills(machineId: string, name: string) {
  try {
    const r = await clusterSyncSkills(machineId)
    if (r.ok) toast.success(`已从 ${name} 同步 ${r.installed.length} 个技能`)
    else toast.error(r.error ?? '同步失败')
  } catch (e) {
    toast.error(`同步失败: ${e instanceof Error ? e.message : e}`)
  }
}

onMounted(refresh)
</script>

<template>
  <div class="space-y-4">
    <!-- 本机信息 -->
    <div v-if="status" class="rounded-lg border p-3 text-sm space-y-1">
      <div class="flex justify-between">
        <span class="text-muted-foreground">本机</span>
        <span class="font-medium">{{ status.name ?? '—' }}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">隧道</span>
        <span :class="status.tunnel.up ? 'text-emerald-500' : 'text-muted-foreground'">
          {{ status.tunnel.up ? `已连接（${status.tunnel.handshakePeers}/${status.tunnel.peers} 握手）` : '未启动' }}
        </span>
      </div>
    </div>

    <!-- peer 列表 -->
    <div v-if="status && status.peers.length > 0" class="space-y-2">
      <div class="text-sm font-medium">已连接（{{ status.peers.length }}）</div>
      <div v-for="peer in status.peers" :key="peer.machineId" class="rounded-lg border p-3 text-sm space-y-2">
        <div class="flex items-center justify-between">
          <div>
            <div class="font-medium">{{ peer.name }}</div>
            <div class="text-muted-foreground text-xs">
              {{ peer.overlayIp }} · {{ peer.containerSubnet }} · {{ lastSeenText(peer) }}
            </div>
          </div>
          <Button variant="ghost" size="icon" @click="leave(peer.machineId, peer.name)">
            <Trash2 class="h-4 w-4 text-destructive" />
          </Button>
        </div>
        <div class="flex gap-1.5">
          <Button variant="outline" size="sm" class="text-xs h-7" @click="pullTemplate(peer.machineId, peer.name)">
            拉取模板
          </Button>
          <Button variant="outline" size="sm" class="text-xs h-7" @click="syncSkills(peer.machineId, peer.name)">
            同步技能
          </Button>
        </div>
      </div>
    </div>
    <div v-else-if="status" class="text-sm text-muted-foreground py-4 text-center">
      还没有连接任何 peer
    </div>
    <div v-if="!status" class="py-8 text-center text-muted-foreground">
      <Loader2 class="h-6 w-6 animate-spin mx-auto" />
    </div>

    <!-- 操作 -->
    <div class="flex gap-2">
      <Button class="flex-1" @click="showJoin = true">
        <Plus class="h-4 w-4 mr-1" />
        加入集群
      </Button>
      <Button variant="outline" size="icon" :disabled="loading" @click="refresh">
        <RefreshCw :class="['h-4 w-4', loading && 'animate-spin']" />
      </Button>
    </div>

    <!-- 加入子弹框 -->
    <Dialog :open="showJoin" @update:open="(v: boolean) => { if (!v) showJoin = false }">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>加入集群</DialogTitle>
          <DialogDescription>
            填入一个已有集群成员的 mysandbox 地址和 Token。
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <div class="space-y-1.5">
            <Label>Peer 地址</Label>
            <Input v-model="joinUrl" placeholder="https://192.168.1.100:7321" />
          </div>
          <div class="space-y-1.5">
            <Label>Token</Label>
            <Input v-model="joinToken" type="password" placeholder="对端 mysandbox 的 API Token" />
          </div>
          <div class="space-y-1.5">
            <Label>名称（可选）</Label>
            <Input v-model="joinName" placeholder="给这台 peer 起个名字" />
          </div>
          <Button class="w-full" :disabled="joining || !joinUrl || !joinToken" @click="join">
            <Loader2 v-if="joining" class="h-4 w-4 mr-1 animate-spin" />
            加入
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
