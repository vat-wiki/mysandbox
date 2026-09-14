<script setup lang="ts">
// 智能体配置页签（AI 工具面板）：绑定 = 工具 → 用哪些模型服务（provider id 引用，
// 不内联端点）。两种模式：
//   全局（缺省）    绑定存 sidecar（期望状态）——启动 sweep + 新建容器补发 + start 事件
//                   自动追平，应用到全部受管容器。本机不随全局（宿主是真实环境），
//                   有独立的专属配置入口。
//   目标覆盖        props.target 传入时 = 该目标（容器名或 '__host__' 本机）的专属
//                   绑定：覆盖存在即生效（全局不再应用到这台），可清除恢复跟随全局
//                   （本机清除 = 回收落盘条目）。容器卡片菜单「AI 配置…」的 pull 入口。
// claude/codex 单槽（env 只有一份）；opencode/pi 多 provider 变体并存，工具内 /models 切。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  saveAiBinding,
  saveAiTargetOverride,
  clearAiTargetOverride,
  deleteAiProjectRule,
  HOST_TARGET,
  Unauthorized,
  type AiView,
  type AiBinding,
  type BatchResult,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ArrowLeft, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

const props = defineProps<{
  // 传入 = 目标覆盖模式（编辑/保存对象是该目标的覆盖绑定，不是全局）。
  target?: string
  // 全局面板内的本机配置入口允许「返回全局」（容器卡片菜单打开的覆盖模式没有返回语义）。
  allowBack?: boolean
}>()
const emit = defineEmits<{
  (e: 'done'): void
  (e: 'unauthorized'): void
  (e: 'configure-host'): void
  (e: 'back'): void
}>()

const view = ref<AiView | null>(null)
const busy = ref(false)
const err = ref('')
const result = ref<BatchResult | null>(null)
const overrideExists = ref(false)

const isTarget = computed(() => !!props.target)
const targetLabel = computed(() => (props.target === HOST_TARGET ? '本机' : props.target))

// —— 表单：每工具一行；enabled=false = 不碰该工具的落盘配置 ——
const claudeOn = ref(false)
const claude = ref('')
const codexOn = ref(false)
const codex = ref('')
const codexDefault = ref(false)
const ocOn = ref(false)
const oc = ref<string[]>([])
const ocWires = ref<string[]>(['openai-chat'])
const ocDefault = ref(false)
const piOn = ref(false)
const pi = ref<string[]>([])
const piWires = ref<string[]>(['openai-chat'])

const providers = computed(() => view.value?.providers ?? [])
const anthropicProviders = computed(() => providers.value.filter((p) => p.endpoints.anthropic))
const openaiProviders = computed(() => providers.value.filter((p) => p.endpoints.openai))
const noProviders = computed(() => !providers.value.length)

function fillFrom(b: AiBinding | null | undefined) {
  claudeOn.value = !!b?.claude
  claude.value = b?.claude?.provider ?? ''
  codexOn.value = !!b?.codex
  codex.value = b?.codex?.provider ?? ''
  codexDefault.value = !!b?.codex?.setDefault
  ocOn.value = !!b?.opencode
  oc.value = b?.opencode?.providers ? [...b.opencode.providers] : []
  ocWires.value = b?.opencode?.wires?.length ? [...b.opencode.wires] : ['openai-chat']
  ocDefault.value = !!b?.opencode?.setDefault
  piOn.value = !!b?.pi
  pi.value = b?.pi?.providers ? [...b.pi.providers] : []
  piWires.value = b?.pi?.wires?.length ? [...b.pi.wires] : ['openai-chat']
}

onMounted(() => loadView(true))

// 数据加载。fill=true 重填表单（首挂载）；provider 库变更后父级调 reload() 只刷
// providers/overrides——编辑中的绑定草稿是本地 ref，不被重置。
async function loadView(fill: boolean) {
  try {
    view.value = await getAiView()
    // 目标模式无覆盖时以全局绑定为编辑底稿（保存才落覆盖）；本机同样——预填只是底稿，
    // 不改变「本机不跟随全局」的追平语义。
    const base = props.target
      ? (view.value.overrides[props.target] ?? view.value.binding)
      : view.value.binding
    overrideExists.value = !!(props.target && view.value.overrides[props.target])
    if (fill) fillFrom(base)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

defineExpose({ reload: () => loadView(false) })

// 清除覆盖（恢复跟随全局 / 本机回收条目）
async function clearOverride() {
  if (!props.target) return
  busy.value = true
  err.value = ''
  try {
    await clearAiTargetOverride(props.target)
    overrideExists.value = false
    result.value = null
    toast(props.target === HOST_TARGET ? '已清除本机配置并回收接入条目' : '已清除覆盖，恢复跟随全局')
    const v = await getAiView()
    view.value = v
    fillFrom(props.target === HOST_TARGET ? null : (v.binding ?? null))
    emit('done')
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

const bindingOut = computed<AiBinding>(() => ({
  ...(claudeOn.value ? { claude: { provider: claude.value } } : {}),
  ...(codexOn.value ? { codex: { provider: codex.value, setDefault: codexDefault.value } } : {}),
  ...(ocOn.value ? { opencode: { providers: [...oc.value], wires: [...ocWires.value] as GatewayWire[], setDefault: ocDefault.value } } : {}),
  ...(piOn.value ? { pi: { providers: [...pi.value], wires: [...piWires.value] as GatewayWire[] } } : {}),
}))

async function submit() {
  const b = bindingOut.value
  if (!b.claude && !b.codex && !b.opencode && !b.pi) {
    err.value = '至少启用并配置一个工具（全部关掉 = 不碰任何落盘配置，保存无意义）'
    return
  }
  if (b.claude && !b.claude.provider) {
    err.value = 'Claude Code 已启用：选一个模型服务'
    return
  }
  if (b.codex && !b.codex.provider) {
    err.value = 'Codex 已启用：选一个模型服务'
    return
  }
  for (const [name, t] of [['OpenCode', b.opencode], ['Pi', b.pi]] as const) {
    if (t && t.providers.length && !t.wires?.length) {
      err.value = `${name} 选了模型服务但协议为空（不写接入点请清空模型服务选择）`
      return
    }
  }
  busy.value = true
  result.value = null
  err.value = ''
  try {
    result.value = props.target
      ? await saveAiTargetOverride(props.target, b)
      : await saveAiBinding(b)
    overrideExists.value = isTarget.value
    emit('done')
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

async function removeRule(id: string) {
  if (!confirm('删除这条项目级配置规则？已写入项目的接入条目会被回收。')) return
  try {
    const r = await deleteAiProjectRule(id)
    if (view.value) view.value = { ...view.value, projectRules: r.projectRules }
    toast('已删除项目规则并回收条目')
    emit('done')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

const ruleSummary = (r: AiBinding) => {
  const parts: string[] = []
  if (r.claude) parts.push(`claude → ${r.claude.provider}`)
  if (r.opencode?.providers.length) parts.push(`opencode → ${r.opencode.providers.join('、')}`)
  return parts.join(' · ') || '（空）'
}
</script>

<template>
  <div class="space-y-4">
    <!-- 结果态：表单区整体切走（返回编辑保留表单内容，重推是常态） -->
    <template v-if="result">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 class="text-sm font-medium">下发结果</h3>
        <span class="text-sm text-emerald-500">成功 {{ result.ok }}</span>
        <span class="text-sm text-destructive">失败 {{ result.failed }}</span>
        <span class="text-sm text-muted-foreground">共 {{ result.total }}</span>
      </div>
      <div class="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow class="bg-muted/50">
              <TableHead class="h-8 text-xs font-medium">目标</TableHead>
              <TableHead class="h-8 text-xs font-medium">结果</TableHead>
              <TableHead class="h-8 text-xs font-medium">输出</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="it in result.items" :key="it.id" class="align-top">
              <TableCell class="font-mono text-xs">{{ it.name }}</TableCell>
              <TableCell class="text-xs">
                <span v-if="it.ok" class="text-emerald-500">ok</span>
                <span v-else class="text-destructive">fail ({{ it.exitCode }})</span>
              </TableCell>
              <TableCell class="text-xs">
                <div v-if="it.error" class="text-destructive">{{ it.error }}</div>
                <pre
                  v-if="it.stdout"
                  class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground"
                  >{{ it.stdout.trim() }}</pre
                >
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div class="flex justify-end">
        <Button variant="outline" @click="result = null"><ArrowLeft class="size-3.5" /> 返回编辑</Button>
      </div>
    </template>

    <!-- 编辑态 -->
    <template v-else>
      <!-- 目标覆盖横幅 -->
      <div
        v-if="isTarget"
        class="rounded-md border px-3 py-2 text-[11px] leading-relaxed"
        :class="
          overrideExists
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'border-border bg-muted/30 text-muted-foreground'
        "
      >
        <div class="flex items-center justify-between gap-2">
          <span>
            <b class="font-medium">{{ targetLabel }}</b> ·
            <template v-if="props.target === HOST_TARGET">
              <template v-if="overrideExists">本机使用专属绑定配置（本机从不跟随全局）。</template>
              <template v-else>本机还没有配置——保存后成为本机的专属绑定。</template>
            </template>
            <template v-else>
              <template v-if="overrideExists">本容器使用专属绑定，全局绑定不再应用到这台（启动追平也跳过）。</template>
              <template v-else>当前跟随全局绑定——保存后成为本容器的专属绑定。</template>
            </template>
          </span>
          <Button v-if="allowBack" variant="ghost" size="xs" @click="emit('back')">返回全局</Button>
        </div>
      </div>

      <p v-if="noProviders" class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        模型服务库还是空的——先在「AI 工具 → 模型服务」添加提供商（端点 + key），再回来绑定工具。
      </p>

      <!-- claude -->
      <div class="space-y-1.5 rounded-md border p-3">
        <label class="flex items-center gap-2 text-sm">
          <Checkbox :model-value="claudeOn" @update:model-value="(v) => (claudeOn = !!v)" />
          <span class="font-medium">Claude Code</span>
          <span class="text-[11px] text-muted-foreground">单接入点（env 注入，重绑即覆盖）</span>
        </label>
        <div v-if="claudeOn" class="grid gap-2 pl-6 sm:grid-cols-[1fr_auto] sm:items-center">
          <Select :model-value="claude" @update:model-value="(v) => (claude = v as string)">
            <SelectTrigger size="sm" class="w-full"><SelectValue placeholder="选模型服务（anthropic 端点）" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="p in anthropicProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</SelectItem>
            </SelectContent>
          </Select>
          <span class="text-[11px] text-muted-foreground">写 ~/.claude/settings.json（或项目级 .claude/settings.json）</span>
        </div>
      </div>

      <!-- codex -->
      <div class="space-y-1.5 rounded-md border p-3">
        <label class="flex items-center gap-2 text-sm">
          <Checkbox :model-value="codexOn" @update:model-value="(v) => (codexOn = !!v)" />
          <span class="font-medium">Codex</span>
          <span class="text-[11px] text-muted-foreground">单接入点（responses 协议；多服务可共存，这里选默认）</span>
        </label>
        <div v-if="codexOn" class="grid gap-2 pl-6 sm:grid-cols-[1fr_auto] sm:items-center">
          <Select :model-value="codex" @update:model-value="(v) => (codex = v as string)">
            <SelectTrigger size="sm" class="w-full"><SelectValue placeholder="选模型服务（openai 端点）" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="p in openaiProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</SelectItem>
            </SelectContent>
          </Select>
          <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox :model-value="codexDefault" @update:model-value="(v) => (codexDefault = !!v)" />
            设为默认 provider
          </label>
        </div>
      </div>

      <!-- opencode / pi：多 provider × wire 变体 -->
      <div v-for="tool in ['opencode', 'pi'] as const" :key="tool" class="space-y-2 rounded-md border p-3">
        <label class="flex items-center gap-2 text-sm">
          <Checkbox
            :model-value="tool === 'opencode' ? ocOn : piOn"
            @update:model-value="(v) => (tool === 'opencode' ? (ocOn = !!v) : (piOn = !!v))"
          />
          <span class="font-medium">{{ tool === 'opencode' ? 'OpenCode' : 'Pi' }}</span>
          <span class="text-[11px] text-muted-foreground">多服务共存（每个 × 协议一个接入点，工具内 /models 切换）</span>
        </label>
        <template v-if="tool === 'opencode' ? ocOn : piOn">
          <ToggleGroup
            type="multiple"
            size="sm"
            variant="outline"
            class="flex-wrap text-xs"
            :model-value="tool === 'opencode' ? oc : pi"
            @update:model-value="(v) => (tool === 'opencode' ? (oc = v as string[]) : (pi = v as string[]))"
          >
            <ToggleGroupItem v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</ToggleGroupItem>
          </ToggleGroup>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ToggleGroup
              type="multiple"
              size="sm"
              variant="outline"
              class="text-xs"
              :model-value="tool === 'opencode' ? ocWires : piWires"
              @update:model-value="(v) => (tool === 'opencode' ? (ocWires = v as string[]) : (piWires = v as string[]))"
            >
              <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
              <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
              <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
            </ToggleGroup>
            <span class="text-[11px] text-muted-foreground">接入点协议（&lt;服务&gt;-chat / -responses / -anthropic）</span>
          </div>
          <label
            v-if="tool === 'opencode'"
            class="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground"
          >
            <Checkbox :model-value="ocDefault" @update:model-value="(v) => (ocDefault = !!v)" />
            设为默认（首个服务的首个协议 + 首个模型）
          </label>
          <p class="text-[11px] leading-snug text-muted-foreground/80">
            不选模型服务 = 清空{{ tool === 'opencode' ? ' OpenCode' : ' Pi' }}的全部接入点（回收旧条目）。
          </p>
        </template>
      </div>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

      <div class="flex items-center justify-end gap-2">
        <Button
          v-if="isTarget && overrideExists"
          variant="outline"
          :disabled="busy"
          :title="props.target === HOST_TARGET ? '删除本机配置并回收接入条目' : '删除本目标的覆盖配置，恢复跟随全局'"
          @click="clearOverride"
        >{{ props.target === HOST_TARGET ? '清除本机配置' : '清除覆盖（跟随全局）' }}</Button>
        <Button :disabled="busy" @click="submit">{{
          busy ? '应用中…' : isTarget ? '保存并应用到本目标' : '保存并应用到全部容器'
        }}</Button>
      </div>

      <!-- 全局模式的补充：本机专属配置 + 项目级规则 -->
      <template v-if="!isTarget && view">
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2">
          <div class="text-xs text-muted-foreground">
            <b class="font-medium text-foreground">本机</b> ·
            <template v-if="view.overrides[HOST_TARGET]">已有专属绑定（本机从不跟随全局）。</template>
            <template v-else>未配置——本机不随全局应用，避免改 key 连带刷掉宿主环境。</template>
          </div>
          <Button size="xs" variant="outline" @click="emit('configure-host')">
            {{ view.overrides[HOST_TARGET] ? '编辑本机绑定' : '为本机配置' }}
          </Button>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium">项目级配置</h3>
            <span class="text-[11px] text-muted-foreground">文件面板进到项目目录点「AI 配置」就地落</span>
          </div>
          <div
            v-if="!view.projectRules.length"
            class="rounded-md border border-dashed px-3 py-3 text-xs leading-relaxed text-muted-foreground"
          >
            还没有项目级规则。项目级 = 写进项目目录（claude 的 .claude/settings.json / opencode 的
            opencode.json），优先级高于 home 级绑定；克隆到别的容器会跟着走（start 时自动补齐）。
          </div>
          <div v-for="r in view.projectRules" :key="r.id" class="flex items-center gap-2 rounded-md border px-3 py-2">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ r.to }}</span>
            <span class="min-w-0 truncate text-[11px] text-muted-foreground">{{ ruleSummary(r) }}</span>
            <Badge variant="outline" class="shrink-0 px-1.5 text-[10px] text-muted-foreground">项目</Badge>
            <Button variant="ghost" size="icon-xs" class="shrink-0 text-destructive" title="删除规则并回收条目" @click="removeRule(r.id)">
              <Trash2 class="size-3.5" />
            </Button>
          </div>
        </div>
      </template>

      <details v-if="!isTarget" class="group rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <summary class="cursor-pointer select-none list-none marker:hidden">
          <span class="inline-flex items-center gap-1">
            <span class="transition-transform group-open:rotate-90">▸</span>
            说明：追平语义 · 写哪些文件 · key 明文落盘
          </span>
        </summary>
        <p class="mt-2">
          绑定保存后自动追平：启动 sweep、新建容器、容器 start 事件都会按「目标覆盖 ?? 全局绑定」写一份
          （容器不必在运行，CLI 下次启动即生效）。claude 走 settings.json env 注入；codex 加 provider 块
          （key 经 ~/.zshrc 环境变量，固定 responses）；opencode / pi 在配置里内联 key，按所选协议注册
          <code>&lt;服务&gt;-chat/-responses/-anthropic</code> 接入点。已有配置只合并本方案的键；换绑 / 清空会回收旧接入点。
        </p>
        <p class="mt-1 text-amber-500/90">API Key 会明文落盘到各目标（sidecar 存档同面）。</p>
      </details>
    </template>
  </div>
</template>
