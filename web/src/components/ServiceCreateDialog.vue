<script setup lang="ts">
// 新建 docker 服务：预设（postgres/redis/mysql）或自定义镜像。
// 提交走 SSE（拉镜像可能很慢），底部内联日志区照 BasePanel 的做法（自动滚动 + 进度行）。
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import {
  getServicePresets,
  streamCreateService,
  listContainers,
  Unauthorized,
  type ServicePresetView,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

const emit = defineEmits<{ (e: 'created'): void; (e: 'close'): void }>()

const presets = ref<ServicePresetView[]>([])
const presetKey = ref('postgres')
const name = ref('')
const description = ref('')
const ipMode = ref<'auto' | 'manual' | string>('auto')
const manualIp = ref('')
const customImage = ref('')
const customEnv = ref('')
const customCommand = ref('')
const envValues = ref<Record<string, string>>({})
const busy = ref(false)
const err = ref('')
const log = ref<string[]>([])
const logEl = ref<HTMLElement | null>(null)

// 撞名提示（软提示不阻断：服务与 LXC 容器是不同命名空间，同名技术上允许，
// 但 hosts 里会互相覆盖，值得提醒）。
const lxcNames = ref<Set<string>>(new Set())
const nameClash = computed(() => name.value.trim() !== '' && lxcNames.value.has(name.value.trim()))

onMounted(() => {
  getServicePresets()
    .then((v) => {
      presets.value = v.presets
      if (v.presets.length) presetKey.value = v.presets[0].key
    })
    .catch((e) => {
      if (e instanceof Unauthorized) emit('close')
    })
  listContainers()
    .then((v) => {
      lxcNames.value = new Set(v.items.map((c) => c.name))
    })
    .catch(() => {
      /* 提示功能，失败静默 */
    })
})

const isCustom = computed(() => presetKey.value === 'custom')
const current = computed(() => presets.value.find((p) => p.key === presetKey.value))

// 预设切换清掉上一预设的 env 值（不同预设的 required 集不同，残留值会误提交）。
watch(presetKey, () => {
  envValues.value = {}
})

// custom env 文本框 → Record（每行 KEY=VALUE，坏行即时报错而非提交时）。
const customEnvOk = computed(() =>
  customEnv.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)),
)

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
const nameOk = computed(() => NAME_RE.test(name.value.trim()))

const formOk = computed(() => {
  if (!nameOk.value || busy.value) return false
  if (isCustom.value) {
    if (!customImage.value.trim() || !customEnvOk.value) return false
  } else {
    // required env 必须非空
    for (const u of current.value?.userEnv ?? []) {
      if (u.required && !envValues.value[u.key]?.trim()) return false
    }
  }
  return true
})

watch(
  () => log.value.length,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

function onEvent(e: { type: string; stream?: string; status?: string; message?: string }) {
  if (e.stream) log.value.push(e.stream)
  else if (e.status) log.value.push(`[进行] ${e.status}`)
  else if (e.type === 'error' && e.message) log.value.push(`[失败] ${e.message}`)
}

async function submit() {
  if (!formOk.value) return
  busy.value = true
  err.value = ''
  log.value = []
  try {
    const env: Record<string, string> = {}
    if (isCustom.value) {
      for (const line of customEnv.value.split('\n')) {
        const s = line.trim()
        if (!s) continue
        const eq = s.indexOf('=')
        env[s.slice(0, eq)] = s.slice(eq + 1)
      }
    } else {
      for (const u of current.value?.userEnv ?? []) {
        const v = envValues.value[u.key]
        if (v?.trim()) env[u.key] = v.trim()
      }
    }
    await streamCreateService(
      {
        name: name.value.trim(),
        preset: presetKey.value,
        image: isCustom.value ? customImage.value.trim() : undefined,
        env,
        command: isCustom.value ? customCommand.value.trim() || undefined : undefined,
        description: description.value || undefined,
        ip: ipMode.value === 'manual' ? manualIp.value.trim() || undefined : undefined,
      },
      onEvent,
    )
    log.value.push('[完成] 服务就绪')
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
        <DialogTitle>新建服务</DialogTitle>
        <DialogDescription>
          单容器 + 固定 IP + 数据卷，不发布端口——容器内按服务名直连（hosts 自动注入）。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="s-preset">类型</Label>
          <select
            id="s-preset"
            v-model="presetKey"
            class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none"
          >
            <option v-for="p in presets" :key="p.key" :value="p.key">{{ p.label }}</option>
            <option value="custom">自定义镜像</option>
          </select>
          <p v-if="current" class="text-xs leading-relaxed text-muted-foreground">
            {{ current.description }} · 端口 {{ current.ports.join('/') }} · {{ current.hint }}
          </p>
        </div>

        <div v-if="isCustom" class="space-y-1.5">
          <div class="space-y-1.5">
            <Label for="s-image">镜像 *</Label>
            <Input id="s-image" v-model="customImage" placeholder="postgres:15 / 10.12.135.233/xx/yy:tag" />
          </div>
          <div class="space-y-1.5">
            <Label for="s-env">环境变量</Label>
            <Textarea
              id="s-env"
              v-model="customEnv"
              placeholder="每行一条 KEY=VALUE"
              class="min-h-20 font-mono text-xs"
            />
            <p v-if="customEnv && !customEnvOk" class="text-xs text-destructive">
              存在格式不对的行（应为 KEY=VALUE）
            </p>
          </div>
          <div class="space-y-1.5">
            <Label for="s-cmd">命令</Label>
            <Input id="s-cmd" v-model="customCommand" placeholder="（可选）空格分词直接执行，无 shell" />
          </div>
        </div>

        <div v-else class="space-y-1.5">
          <template v-for="u in current?.userEnv ?? []" :key="u.key">
            <Label :for="`s-env-${u.key}`">{{ u.label }}{{ u.required ? ' *' : '' }}</Label>
            <Input
              :id="`s-env-${u.key}`"
              v-model="envValues[u.key]"
              :type="u.secret ? 'password' : 'text'"
              autocomplete="off"
            />
          </template>
        </div>

        <div class="space-y-1.5">
          <Label for="s-name">名称 *</Label>
          <Input id="s-name" v-model="name" placeholder="pg" />
          <p v-if="name && !nameOk" class="text-xs text-destructive">仅小写字母/数字/连字符，2-31 位</p>
          <p v-else-if="nameClash" class="text-xs text-amber-600">
            与现有 LXC 容器同名——hosts 里会互相覆盖，建议换个名字
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="s-desc">描述</Label>
          <Input id="s-desc" v-model="description" placeholder="（可选）" />
        </div>

        <div class="space-y-1.5">
          <Label>IP</Label>
          <RadioGroup v-model="ipMode" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="sip-auto" value="auto" />
              <Label for="sip-auto" class="font-normal">自动分配</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="sip-manual" value="manual" />
              <Label for="sip-manual" class="font-normal">手动</Label>
            </div>
          </RadioGroup>
          <Input v-if="ipMode === 'manual'" v-model="manualIp" placeholder="10.88.0.210" />
        </div>

        <div v-if="log.length" class="space-y-1">
          <Label>进度</Label>
          <div
            ref="logEl"
            class="max-h-36 overflow-y-auto rounded-md border bg-muted/40 p-2 font-mono text-xs leading-relaxed"
          >
            <div v-for="(l, i) in log" :key="i" class="whitespace-pre-wrap break-all">{{ l }}</div>
          </div>
        </div>

        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">取消</Button>
        <Button :disabled="!formOk" @click="submit">{{ busy ? '创建中…' : '创建并启动' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
