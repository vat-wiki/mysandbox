<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { createContainer, getHosts, Unauthorized } from '@/lib/api'
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

const emit = defineEmits<{ (e: 'created'): void; (e: 'close'): void; (e: 'open-hosts'): void }>()

const name = ref('')
const description = ref('')
// git 身份不放这里：批量配置一次能管所有容器，逐个新建时填是重复劳动。
// 新建对话框回归容器本身的参数：名字/描述/IP/端口。
const ipMode = ref<'auto' | 'manual' | string>('auto')
const manualIp = ref('')
const ports = ref('') // 形如 6500:6200,7000:7000
const busy = ref(false)
const err = ref('')
// 全局 hosts 提示：新建容器经 --add-host 自动带上，这里只告知会带什么、要改去哪改，
// 不做编辑入口（hosts 是全局共享资产，编辑归 HostsPanel，避免 per-container 误解）。
const hostsCount = ref<number | null>(null)

onMounted(() => {
  getHosts()
    .then((v) => {
      hostsCount.value = v.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
    })
    .catch((e) => {
      if (e instanceof Unauthorized) emit('close')
      /* 预读失败不阻塞创建流程，提示行不显示条数 */
    })
})

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
const nameOk = computed(() => NAME_RE.test(name.value.trim()))

function parsePorts(): Record<string, Array<{ HostPort: string }>> | undefined {
  const out: Record<string, Array<{ HostPort: string }>> = {}
  for (const part of ports.value.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+):(\d+)$/)
    if (!m) throw new Error(`端口映射格式错误: ${part}（应为 hostPort:containerPort）`)
    out[`${m[2]}/tcp`] = [{ HostPort: m[1] }]
  }
  return Object.keys(out).length ? out : undefined
}

function onClose() {
  emit('close')
}

async function submit() {
  if (!nameOk.value) {
    err.value = '名称不合法（^[a-z0-9][a-z0-9-]{1,30}$）'
    return
  }
  busy.value = true
  err.value = ''
  try {
    let portMappings: Record<string, Array<{ HostPort: string }>> | undefined
    try {
      portMappings = parsePorts()
    } catch (e) {
      err.value = e instanceof Error ? e.message : String(e)
      busy.value = false
      return
    }
    await createContainer({
      name: name.value.trim(),
      description: description.value || undefined,
      ip: ipMode.value === 'manual' ? manualIp.value.trim() || undefined : undefined,
      portMappings,
    })
    emit('created')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>新建容器</DialogTitle>
        <DialogDescription>配置名称、IP 与端口映射。</DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="c-name">名称 *</Label>
          <Input id="c-name" v-model="name" placeholder="web-2" />
          <p v-if="name && !nameOk" class="text-xs text-destructive">
            仅小写字母/数字/连字符，2-31 位
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="c-desc">描述</Label>
          <Input id="c-desc" v-model="description" placeholder="（可选）" />
        </div>

        <div class="space-y-1.5">
          <Label>IP</Label>
          <RadioGroup v-model="ipMode" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="ip-auto" value="auto" />
              <Label for="ip-auto" class="font-normal">自动分配</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="ip-manual" value="manual" />
              <Label for="ip-manual" class="font-normal">手动</Label>
            </div>
          </RadioGroup>
          <Input v-if="ipMode === 'manual'" v-model="manualIp" placeholder="10.88.0.30" />
        </div>

        <div class="space-y-1.5">
          <Label for="c-ports">端口映射（可选，hostPort:containerPort，逗号分隔）</Label>
          <Input id="c-ports" v-model="ports" placeholder="6500:6200" />
        </div>

        <!-- 全局 hosts 提示：自动生效、可跳转编辑，与批量配置/HostsPanel 的互跳模式一致 -->
        <p class="text-xs leading-relaxed text-muted-foreground">
          创建时自动应用全局 hosts{{ hostsCount != null ? `（${hostsCount} 条）` : '' }}。
          <Button
            variant="link"
            size="xs"
            class="h-auto p-0 align-baseline text-xs"
            @click="emit('open-hosts')"
            >去编辑</Button
          >
        </p>

        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="onClose">取消</Button>
        <Button :disabled="busy || !nameOk" @click="submit">
          {{ busy ? '创建中…' : '创建并启动' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
