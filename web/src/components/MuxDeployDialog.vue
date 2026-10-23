<script setup lang="ts">
// msmux 单目标部署/重连弹框。target 语法与 server/muxDeploy.ts 一致：
// host | c:<容器> | s:<服务/项目> | ssh:<SSH 目标名>。
//
// 本机/容器/服务的回连地址由服务端推导（本地控制台/网关桥），SSH 远端不在自管网段
// 内，必须显式给一个「从 SSH 主机能访问到」的 ws(s):// 控制台地址——这里默认填当前
// 浏览器地址，同网/Tailscale 场景可直接用，不同网络时让用户改。
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Loader2, Network, RadioTower } from 'lucide-vue-next'
import {
  deployMuxAgent,
  Unauthorized,
  type MuxDeployResult,
} from '@/lib/api'
import { invalidateMuxAgents } from '@/lib/mux'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{
  target: string
  label?: string
}>()

const emit = defineEmits<{
  (e: 'deployed', result: MuxDeployResult): void
  (e: 'close'): void
  (e: 'unauthorized'): void
}>()

const isSsh = computed(() => props.target.startsWith('ssh:'))
const defaultUrl = computed(() => {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws/mux-agent`
})
const url = ref(defaultUrl.value)
const busy = ref(false)
const err = ref('')
const result = ref<MuxDeployResult | null>(null)

async function deploy() {
  if (busy.value) return
  err.value = ''
  busy.value = true
  try {
    const r = await deployMuxAgent(props.target, isSsh.value ? url.value.trim() : undefined)
    invalidateMuxAgents()
    result.value = r
    if (r.connected) {
      toast.success('msmux agent 已上线', {
        description: `${r.target} · 已回连`,
      })
    } else {
      toast.warning('agent 已启动，但尚未回连', {
        description: '已等待 6 秒。查看目标日志或检查回连地址后再重试。',
      })
    }
    emit('deployed', r)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0 max-md:pt-safe">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Network class="size-4" /> 部署 msmux agent
        </DialogTitle>
        <DialogDescription>
          {{ label || target }} · 静态二进制上传后主动回连，不需要目标暴露入站端口。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="rounded-md border bg-muted/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <p>
            目标：<code class="font-mono text-foreground">{{ target }}</code>
          </p>
          <p class="mt-1">
            agent 在线后，`auto` 模式的新终端会在这个目标上使用 msmux；其他目标继续走 tmux。
          </p>
        </div>

        <div v-if="isSsh" class="space-y-1.5">
          <Label for="mux-agent-url" class="text-xs text-muted-foreground">回连地址</Label>
          <Input
            id="mux-agent-url"
            v-model="url"
            class="font-mono text-xs"
            placeholder="ws://10.0.0.10:7321/ws/mux-agent"
            @keydown.enter="deploy"
          />
          <p class="text-[11px] leading-relaxed text-muted-foreground">
            SSH 主机必须能访问这个地址。同网或 Tailscale 下可直接用当前控制台地址；控制台只监听
            127.0.0.1 时，请填写网关/局域网可达的地址。
          </p>
        </div>

        <p v-if="err" class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {{ err }}
        </p>

        <div
          v-if="result"
          class="space-y-1 rounded-md border px-3 py-2 text-xs"
          :class="result.connected ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'"
        >
          <p class="flex items-center gap-1.5 font-medium">
            <RadioTower class="size-3.5" :class="result.connected ? 'text-emerald-500' : 'text-amber-500'" />
            {{ result.connected ? '已回连，终端可以用 msmux 了' : '已部署，但 6 秒内未看到回连' }}
          </p>
          <p class="break-all font-mono text-[10px] text-muted-foreground">{{ result.url }}</p>
          <p class="text-muted-foreground">{{ result.detail }}</p>
          <p class="font-mono text-[10px] text-muted-foreground">
            {{ result.binary.bytes }} bytes · sha256 {{ result.binary.sha256.slice(0, 12) }}…
          </p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">关闭</Button>
        <Button :disabled="busy || (isSsh && !url.trim())" @click="deploy">
          <Loader2 v-if="busy" class="size-3.5 animate-spin" />
          {{ busy ? '部署中…' : result ? '重新部署' : '部署 / 重连' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
