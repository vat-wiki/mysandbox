<script setup lang="ts">
// 项目级 AI 配置对话框（文件面板 ✨「AI 配置」入口）：把模型服务绑定写进当前浏览的
// 项目目录（claude 的 .claude/settings.json + opencode 的 opencode.json）并落/并入
// 项目规则（跟项目走，start 事件补发）。用居中弹窗而非文件面板内嵌条——provider 多选
// × 协议多选在窄面板条里展不开（实测挤成一团）。未启用的工具不动既有规则；v-if 挂载
// 天然重置状态。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  installAiProject,
  Unauthorized,
  type AiProvider,
  type AiProjectRule,
  type GatewayWire,
} from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from 'vue-sonner'

const props = defineProps<{
  containerId: string // 容器名或 '__host__'（宿主面板）
  containerName: string
  spot: string // 项目根（容器内 /home/dev/… 或宿主绝对路径）
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done'): void
  (e: 'unauthorized'): void
}>()

const providers = ref<AiProvider[] | null>(null)
const hostHome = ref('')
const existingRule = ref<AiProjectRule | null>(null)
const busy = ref(false)
const err = ref('')
// 每工具一个启用开关（默认关——只送启用的工具，未启用的不动既有规则）。
const claudeOn = ref(false)
const claude = ref('')
const ocOn = ref(false)
const oc = ref<string[]>([])
const ocWires = ref<GatewayWire[]>(['openai-chat'])

// spot → 规则 to（~/rel）归一化：容器按 home 契约前缀，宿主按真实 home（view 回带）。
const ruleKey = computed(() => {
  if (props.containerId === '__host__') {
    const home = hostHome.value.replace(/\/+$/, '')
    if (!home || !props.spot.startsWith(home + '/')) return null
    return `~/${props.spot.slice(home.length + 1)}`
  }
  if (!props.spot.startsWith('/home/dev/')) return null
  return `~/${props.spot.slice('/home/dev/'.length)}`
})

const anthropicProviders = computed(() => (providers.value ?? []).filter((p) => p.endpoints.anthropic))
const ruleSummary = computed(() => {
  const r = existingRule.value
  if (!r) return ''
  const parts: string[] = []
  if (r.claude) parts.push(`claude → ${r.claude.provider}`)
  if (r.opencode?.providers.length) parts.push(`opencode → ${r.opencode.providers.join('、')}`)
  return parts.join(' · ')
})

onMounted(async () => {
  try {
    const v = await getAiView()
    providers.value = v.providers
    hostHome.value = v.hostHome
    existingRule.value = v.projectRules.find((r) => r.to === ruleKey.value) ?? null
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
})

async function save() {
  const selection: { claude?: { provider: string }; opencode?: { providers: string[]; wires: GatewayWire[] } } = {}
  if (claudeOn.value) {
    if (!claude.value) {
      err.value = 'Claude Code 已启用：选一个模型服务'
      return
    }
    selection.claude = { provider: claude.value }
  }
  if (ocOn.value) {
    if (!oc.value.length || !ocWires.value.length) {
      err.value = 'OpenCode 已启用：选模型服务与协议'
      return
    }
    selection.opencode = { providers: [...oc.value], wires: [...ocWires.value] }
  }
  if (!selection.claude && !selection.opencode) {
    err.value = '至少启用并配置一个工具'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const r = await installAiProject(props.containerId, props.spot, selection)
    toast(`项目级 AI 配置 → ${r.to}${r.created ? '（新规则）' : '（并入已有规则）'}`)
    emit('done')
    emit('close')
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
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>AI 配置 · 项目级</DialogTitle>
        <DialogDescription class="truncate font-mono">
          {{ props.containerName }} : {{ props.spot }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <p
          v-if="existingRule"
          class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400"
        >
          该目录已有项目规则：{{ ruleSummary || '（空）' }}。保存把启用的工具并入这条规则。
        </p>

        <p v-if="providers && !providers.length" class="text-xs text-amber-500/90">
          模型服务库是空的——先在「AI 工具 → 模型服务」添加提供商。
        </p>
        <p v-else-if="!providers" class="text-xs text-muted-foreground">读取模型服务…</p>

        <!-- claude -->
        <div class="space-y-2 rounded-md border p-3">
          <div class="flex items-center gap-2">
            <Checkbox
              id="ai-spot-claude"
              :model-value="claudeOn"
              @update:model-value="(v) => (claudeOn = !!v)"
            />
            <Label for="ai-spot-claude" class="cursor-pointer">Claude Code</Label>
            <span class="ml-auto text-[11px] text-muted-foreground">.claude/settings.json env 注入</span>
          </div>
          <div v-if="claudeOn" class="pl-6">
            <Select :model-value="claude" @update:model-value="(v) => (claude = v as string)">
              <SelectTrigger size="sm" class="w-full">
                <SelectValue placeholder="选模型服务（anthropic 端点）" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in anthropicProviders" :key="p.id" :value="p.id">
                  {{ p.name }}（{{ p.id }}）
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <!-- opencode -->
        <div class="space-y-2 rounded-md border p-3">
          <div class="flex items-center gap-2">
            <Checkbox id="ai-spot-oc" :model-value="ocOn" @update:model-value="(v) => (ocOn = !!v)" />
            <Label for="ai-spot-oc" class="cursor-pointer">OpenCode</Label>
            <span class="ml-auto text-[11px] text-muted-foreground">opencode.json provider 变体</span>
          </div>
          <div v-if="ocOn" class="space-y-2 pl-6">
            <ToggleGroup
              type="multiple"
              size="sm"
              variant="outline"
              class="flex-wrap text-xs"
              :model-value="oc"
              @update:model-value="(v) => (oc = v as string[])"
            >
              <ToggleGroupItem v-for="p in providers ?? []" :key="p.id" :value="p.id">
                {{ p.name }}（{{ p.id }}）
              </ToggleGroupItem>
            </ToggleGroup>
            <ToggleGroup
              type="multiple"
              size="sm"
              variant="outline"
              class="text-xs"
              :model-value="ocWires"
              @update:model-value="(v) => (ocWires = v as GatewayWire[])"
            >
              <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
              <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
              <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <p class="text-[11px] leading-snug text-muted-foreground/80">
          项目级配置优先于 home 级绑定（工具自己的合并语义）；克隆到别的容器，start 时自动跟上。
          未启用的工具不动既有规则。
        </p>
        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="outline" size="xs" :disabled="busy" @click="emit('close')">取消</Button>
        <Button size="xs" :disabled="busy || !providers" @click="save">{{ busy ? '配置中…' : '保存配置' }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
