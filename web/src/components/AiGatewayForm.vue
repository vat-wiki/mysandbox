<script setup lang="ts">
// AI 网关批量下发（自 AI 工具面板，原 BatchDialog ai tab 迁出）：对勾选容器把
// OpenAI/Anthropic 兼容网关写进 claude/codex/opencode/pi 配置。后端 aiconfig.ts
// 宿主直写 rootfs，容器不必在跑。表单与校验逻辑从 BatchDialog 原样迁出（场景驱动：
// 网关类型单选决定端点框显隐 / Codex 可用性 / 协议多选显隐）。
import { ref, computed, watch, onMounted } from 'vue'
import {
  batchAiConfig,
  getAiGateway,
  Unauthorized,
  type BatchResult,
  type GatewayWire,
  type AiGatewayState,
  type AiGatewayInput,
} from '@/lib/api'
import { stateColor, stateLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Checkbox } from '@/components/ui/checkbox'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ArrowLeft } from 'lucide-vue-next'

const props = defineProps<{
  containers: { id: string; label: string; ip?: string | null; state?: string | null }[]
}>()
const emit = defineEmits<{
  (e: 'done'): void
  (e: 'unauthorized'): void
}>()

// 容器勾选（紧凑 chip 形态）：默认全选，空选时执行按钮置灰。
const checked = ref<Set<string>>(new Set(props.containers.map((c) => c.id)))
const ids = computed(() => props.containers.filter((c) => checked.value.has(c.id)).map((c) => c.id))
function toggleCheck(id: string) {
  const s = new Set(checked.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  checked.value = s
}
const allChecked = computed(
  () => props.containers.length > 0 && props.containers.every((c) => checked.value.has(c.id)),
)
// 停机提示（不阻断）：rootfs 直写停机容器也生效，只提一句免得意外。
const stoppedSelected = computed(
  () =>
    ids.value.filter(
      (id) => props.containers.find((c) => c.id === id)?.state && props.containers.find((c) => c.id === id)!.state !== 'running',
    ).length,
)

const busy = ref(false)
const err = ref('')
// 结果态：执行后表单区整体切走；backToEdit 只清结果，表单内容保留（换 key 重推是常态）。
const result = ref<BatchResult | null>(null)

// —— 表单（自 BatchDialog 原样迁出）——
const aiAnthropicUrl = ref('')
const aiOpenaiUrl = ref('')
const aiKey = ref('')
const aiModels = ref('')
const aiSetDefault = ref(false)
// 网关场景：anthropic-only / openai-only / dual。null = 尚未选（首次进入无存档时）。
const aiGwKind = ref<'anthropic' | 'openai' | 'dual' | null>(null)
const aiTools = ref({ claude: true, codex: true, opencode: true, pi: true })
// 工具级 wire 多选。单协议场景不露选择器，wire 值由场景直接定；dual 才让用户挑。
// 值语义：undefined = 未选过（显示缺省）；[] = 显式清空全部变体（不写 provider）。
const aiWire = ref<{ opencode?: string[]; pi?: string[] }>({})
// 存档预填的脏标记：用户动过工具勾选后，迟到的存档回包不再覆盖勾选
// （早前实测踩过：勾了 opencode/pi，回包落地瞬间被存档里的 false 打回去，提交时仍是未勾）。
const aiToolsTouched = ref(false)
watch(
  () => ({ ...aiTools.value }),
  () => {
    aiToolsTouched.value = true
  },
)
// 场景切换的连带：anthropic-only 下 Codex 不可用、openai-only 下 Claude 不可用——
// 切进对应场景时自动取消其勾选，别留一个置灰又打勾的矛盾态（置灰只挡交互，值还在
// 会照发 payload，后端按勾选校验端点需求就会拦下「明明置灰了」的工具，实测踩过）。
watch(aiGwKind, (k) => {
  if (k === 'anthropic') aiTools.value.codex = false
  if (k === 'openai') aiTools.value.claude = false
})

// wire 有效值（提交与推导共用，与后端 wiresOf 缺省一致）：
// dual 场景取用户多选（undefined 缺省 chat）；单协议场景由场景定死。
const wiresOfTool = (tool: 'opencode' | 'pi'): string[] => {
  if (aiGwKind.value === 'anthropic') return ['anthropic-messages']
  if (aiGwKind.value === 'openai') return ['openai-chat']
  return aiWire.value[tool] ?? ['openai-chat']
}
// Codex 可用性：只会 openai responses，没有 openai 端点的场景置灰并注明
const codexDisabled = computed(() => aiGwKind.value === 'anthropic')

// 需求推导（与后端校验同规则，routes.ts / aiconfig.ts wiresOf）：
// 某条端点被哪些工具消费 → URL 框提示与错误点名。
const openaiConsumers = computed(() => {
  if (aiGwKind.value === 'anthropic') return []
  const out: string[] = []
  if (aiTools.value.codex) out.push('Codex')
  for (const tool of ['opencode', 'pi'] as const) {
    if (!aiTools.value[tool]) continue
    const labels = wiresOfTool(tool)
      .filter((w) => w !== 'anthropic-messages')
      .map((w) => (w === 'openai-responses' ? 'responses' : 'chat'))
    if (labels.length) out.push(`${tool === 'opencode' ? 'OpenCode' : 'Pi'}（${labels.join('、')}）`)
  }
  return out
})
const anthropicConsumers = computed(() => {
  if (aiGwKind.value === 'openai') return []
  const out: string[] = []
  if (aiTools.value.claude) out.push('Claude Code')
  for (const tool of ['opencode', 'pi'] as const) {
    if (!aiTools.value[tool]) continue
    if (wiresOfTool(tool).includes('anthropic-messages'))
      out.push(`${tool === 'opencode' ? 'OpenCode' : 'Pi'}（anthropic）`)
  }
  return out
})
const isUrl = (s: string) => /^https?:\/\//.test(s.trim())
// 欠填的端点（未填但有人要）。场景驱动后这几乎是「填了一半」的唯一残缺态
const missingEndpoints = computed(() => {
  const miss: { side: 'openai' | 'anthropic'; who: string[] }[] = []
  if (openaiConsumers.value.length && !isUrl(aiOpenaiUrl.value))
    miss.push({ side: 'openai', who: openaiConsumers.value })
  if (anthropicConsumers.value.length && !isUrl(aiAnthropicUrl.value))
    miss.push({ side: 'anthropic', who: anthropicConsumers.value })
  return miss
})
// opencode/pi 有勾且有变体时才需要模型 ID（wire 清空 = 不写 provider，无需模型）
const modelsConsumers = computed(() => {
  const out: string[] = []
  for (const tool of ['opencode', 'pi'] as const) {
    if (aiTools.value[tool] && wiresOfTool(tool).length) out.push(tool)
  }
  return out
})
// 存档 → 场景推导：按存档里两侧端点与 wire 的实际形状反推（存档可能是旧版写的）
function kindFromConfig(cfg: AiGatewayState): 'anthropic' | 'openai' | 'dual' {
  const hasOpenai = !!cfg.endpoints.openai?.baseUrl
  const hasAnthropic = !!cfg.endpoints.anthropic?.baseUrl
  if (hasOpenai && hasAnthropic) return 'dual'
  if (hasOpenai) return 'openai'
  // 存档只记了 anthropic 侧但 wire 里有 openai 系（旧版可勾不可填的非法态）→ 仍归 anthropic，
  // 提交校验会拦
  return 'anthropic'
}
// 一键重推：恢复存档全量（URL/key/勾选/wire/模型/设默认），场景也从存档推导
const lastPush = ref<AiGatewayState | null>(null)
function repushLast() {
  const cfg = lastPush.value
  if (!cfg) return
  aiGwKind.value = kindFromConfig(cfg)
  aiAnthropicUrl.value = cfg.endpoints.anthropic?.baseUrl ?? ''
  aiOpenaiUrl.value = cfg.endpoints.openai?.baseUrl ?? ''
  aiKey.value = cfg.apiKey
  aiWire.value = {
    opencode: cfg.wire?.opencode ? [...cfg.wire.opencode] : undefined,
    pi: cfg.wire?.pi ? [...cfg.wire.pi] : undefined,
  }
  aiModels.value = (cfg.models ?? []).join(', ')
  aiSetDefault.value = !!cfg.setDefault
  aiTools.value = {
    claude: cfg.tools.claude,
    codex: cfg.tools.codex,
    opencode: cfg.tools.opencode,
    pi: cfg.tools.pi,
  }
  result.value = null
  err.value = ''
}

// 打开即预填最近一次下发存档：场景从存档端点形状推导，URL/key/wire/模型只补空字段；
// 工具勾选在用户没动过时恢复（动过则跳过——否则「用户先勾后填」时迟到的响应会把
// 勾选打回去，实测踩过）。
onMounted(() => {
  getAiGateway()
    .then(({ config }) => {
      if (!config) return
      lastPush.value = config
      if (!aiGwKind.value) aiGwKind.value = kindFromConfig(config)
      if (!aiAnthropicUrl.value.trim() && config.endpoints.anthropic)
        aiAnthropicUrl.value = config.endpoints.anthropic.baseUrl
      if (!aiOpenaiUrl.value.trim() && config.endpoints.openai)
        aiOpenaiUrl.value = config.endpoints.openai.baseUrl
      if (config.wire)
        aiWire.value = {
          opencode: config.wire.opencode ? [...config.wire.opencode] : undefined,
          pi: config.wire.pi ? [...config.wire.pi] : undefined,
        }
      if (!aiKey.value.trim()) aiKey.value = config.apiKey
      if (!aiModels.value.trim()) aiModels.value = (config.models ?? []).join(', ')
      if (!aiToolsTouched.value && config.tools) aiTools.value = { ...config.tools }
    })
    .catch(() => {
      /* 无存档/读取失败不阻塞，表单留空手填 */
    })
})

async function submit() {
  if (!aiGwKind.value) {
    err.value = '先选网关类型（Anthropic 中转 / OpenAI 中转 / 双协议）'
    return
  }
  const t = aiTools.value
  if (!(t.claude || t.codex || t.opencode || t.pi)) {
    err.value = '至少勾选一个工具'
    return
  }
  if (!aiKey.value.trim()) {
    err.value = 'API Key 必填'
    return
  }
  // 端点需求按场景+工具+wire 推导（与后端校验同规则），错误点名需求方
  for (const m of missingEndpoints.value) {
    err.value =
      m.side === 'openai'
        ? `需要 OpenAI 兼容 Base URL：${m.who.join('、')} 要走这条端点`
        : `需要 Anthropic 兼容 Base URL：${m.who.join('、')} 要走这条端点`
    return
  }
  if (modelsConsumers.value.length && !aiModels.value.trim()) {
    err.value = `${modelsConsumers.value.map((s) => (s === 'opencode' ? 'OpenCode' : 'Pi')).join('、')} 需要至少一个模型 ID（逗号分隔）`
    return
  }
  // 单协议场景 wire 由场景定死；dual 才透传用户多选（undefined → 后端缺省 chat）
  const wireOut: AiGatewayInput['wire'] =
    aiGwKind.value === 'dual'
      ? {
          opencode: aiWire.value.opencode as GatewayWire[] | undefined,
          pi: aiWire.value.pi as GatewayWire[] | undefined,
        }
      : {
          opencode: ['anthropic-messages'] as GatewayWire[],
          pi: ['anthropic-messages'] as GatewayWire[],
          ...(aiGwKind.value === 'openai'
            ? { opencode: ['openai-chat'] as GatewayWire[], pi: ['openai-chat'] as GatewayWire[] }
            : {}),
        }
  busy.value = true
  result.value = null
  err.value = ''
  try {
    result.value = await batchAiConfig(ids.value, {
      endpoints: {
        ...(aiGwKind.value !== 'anthropic' && openaiConsumers.value.length
          ? { openai: { baseUrl: aiOpenaiUrl.value.trim() } }
          : {}),
        ...(aiGwKind.value !== 'openai' && anthropicConsumers.value.length
          ? { anthropic: { baseUrl: aiAnthropicUrl.value.trim() } }
          : {}),
      },
      apiKey: aiKey.value.trim(),
      tools: { ...t },
      wire: wireOut,
      models: aiModels.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
      setDefault: aiSetDefault.value,
    })
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
</script>

<template>
  <div class="space-y-4">
    <!-- 目标容器：紧凑 chip 勾选（rootfs 直写，停机容器同样生效，只提示不阻断） -->
    <div class="rounded-md border p-3">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium text-muted-foreground">
          目标容器 {{ ids.length }} / {{ props.containers.length }}
          <span v-if="stoppedSelected" class="text-amber-600 dark:text-amber-400">（{{ stoppedSelected }} 个未在运行，同样可写）</span>
        </span>
        <button
          type="button"
          class="text-xs text-muted-foreground transition-colors hover:text-foreground"
          @click="checked = allChecked ? new Set() : new Set(props.containers.map((c) => c.id))"
        >
          {{ allChecked ? '全不选' : '全选' }}
        </button>
      </div>
      <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
        <label
          v-for="c in props.containers"
          :key="c.id"
          class="flex cursor-pointer select-none items-center gap-1.5 text-sm"
        >
          <Checkbox :model-value="checked.has(c.id)" @update:model-value="() => toggleCheck(c.id)" />
          <span
            :class="['h-2 w-2 shrink-0 rounded-full', stateColor(c.state ?? '')]"
            :title="stateLabel(c.state ?? '')"
          />
          <span class="font-mono">{{ c.label }}</span>
        </label>
      </div>
    </div>

    <!-- 结果态：表单区整体切走（返回编辑保留表单内容，换 key 重推是常态） -->
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
              <TableHead class="h-8 text-xs font-medium">容器</TableHead>
              <TableHead class="h-8 text-xs font-medium">结果</TableHead>
              <TableHead class="h-8 text-xs font-medium">输出</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="it in result.items" :key="it.id" class="align-top">
              <TableCell class="font-mono text-xs">{{
                props.containers.find((c) => c.id === it.id)?.label ?? it.name
              }}</TableCell>
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
                <pre
                  v-if="it.stderr"
                  class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-destructive/80"
                  >{{ it.stderr.trim() }}</pre
                >
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <div class="flex justify-end">
        <Button variant="outline" @click="result = null">
          <ArrowLeft class="size-3.5" /> 返回编辑
        </Button>
      </div>
    </template>

    <!-- 编辑态（自 BatchDialog 原样迁出）：场景驱动表单 -->
    <template v-else>
      <!-- 上次下发：换 key 重推是最高频重复流，一键直达 -->
      <div
        v-if="lastPush"
        class="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2"
      >
        <span class="text-xs text-muted-foreground">
          上次下发 {{ new Date(lastPush.updatedAt).toLocaleString() }}
        </span>
        <Button variant="outline" size="xs" @click="repushLast">一键重推上次配置</Button>
      </div>

      <div class="space-y-1.5">
        <Label>网关类型</Label>
        <RadioGroup
          :model-value="aiGwKind ?? ''"
          class="grid grid-cols-1 gap-2 sm:grid-cols-3"
          @update:model-value="(v) => (aiGwKind = v as 'anthropic' | 'openai' | 'dual')"
        >
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem value="anthropic" />
            <span>
              Anthropic 中转
              <span class="block text-[11px] text-muted-foreground">claude api 中转</span>
            </span>
          </label>
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem value="openai" />
            <span>
              OpenAI 中转
              <span class="block text-[11px] text-muted-foreground">gpt 系中转</span>
            </span>
          </label>
          <label
            class="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem value="dual" />
            <span>
              双协议
              <span class="block text-[11px] text-muted-foreground">myapikey 等</span>
            </span>
          </label>
        </RadioGroup>
      </div>

      <!-- 端点：只出现本场景需要的框；框下点名消费者 -->
      <div v-if="aiGwKind" class="grid gap-3" :class="aiGwKind === 'dual' ? 'grid-cols-1 sm:grid-cols-2' : ''">
        <div v-if="aiGwKind !== 'openai'" class="space-y-1.5">
          <Label for="b-ai-anthropic">Anthropic 兼容 Base URL</Label>
          <Input
            id="b-ai-anthropic"
            v-model="aiAnthropicUrl"
            :class="anthropicConsumers.length && !aiAnthropicUrl.trim() ? 'border-destructive' : ''"
            placeholder="http://10.12.135.150:7800/anthropic"
          />
          <p
            class="text-[11px] leading-snug"
            :class="anthropicConsumers.length && !aiAnthropicUrl.trim() ? 'text-destructive' : 'text-muted-foreground'"
          >
            <template v-if="anthropicConsumers.length"
              >必填 — {{ anthropicConsumers.join('、') }} 走这条端点</template
            >
            <template v-else>没有工具用到，可留空</template>
          </p>
        </div>
        <div v-if="aiGwKind !== 'anthropic'" class="space-y-1.5">
          <Label for="b-ai-openai">OpenAI 兼容 Base URL</Label>
          <Input
            id="b-ai-openai"
            v-model="aiOpenaiUrl"
            :class="openaiConsumers.length && !aiOpenaiUrl.trim() ? 'border-destructive' : ''"
            placeholder="http://10.12.135.150:7800/openai/v1"
          />
          <p
            class="text-[11px] leading-snug"
            :class="openaiConsumers.length && !aiOpenaiUrl.trim() ? 'text-destructive' : 'text-muted-foreground'"
          >
            <template v-if="openaiConsumers.length"
              >必填 — {{ openaiConsumers.join('、') }} 走这条端点</template
            >
            <template v-else>没有工具用到，可留空</template>
          </p>
        </div>
      </div>

      <div v-if="aiGwKind" class="space-y-1.5">
        <Label for="b-ai-key">API Key</Label>
        <Input id="b-ai-key" v-model="aiKey" type="password" placeholder="sk-…" />
      </div>

      <!-- 工具勾选：Codex/Claude 在单协议场景置灰（协议与网关不符）。 -->
      <div v-if="aiGwKind" class="space-y-2 rounded-md border p-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2" :class="aiGwKind === 'openai' ? 'opacity-50' : ''">
          <label class="flex w-32 items-center gap-1.5 text-sm max-md:w-24">
            <Checkbox
              id="ai-claude"
              :model-value="aiTools.claude"
              :disabled="aiGwKind === 'openai'"
              @update:model-value="(v) => (aiTools.claude = !!v)"
            />
            Claude Code
          </label>
          <span class="text-[11px] text-muted-foreground">
            anthropic 协议（固定）{{ aiGwKind === 'openai' ? '· 只会说 anthropic，本场景不可用' : '' }}
          </span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2" :class="codexDisabled ? 'opacity-50' : ''">
          <label class="flex w-32 items-center gap-1.5 text-sm max-md:w-24">
            <Checkbox
              id="ai-codex"
              :model-value="aiTools.codex"
              :disabled="codexDisabled"
              @update:model-value="(v) => (aiTools.codex = !!v)"
            />
            Codex
          </label>
          <span class="text-[11px] text-muted-foreground">
            responses 协议（官方已停 chat）{{ codexDisabled ? '· 只会说 openai，本场景不可用' : '' }}
          </span>
        </div>
        <div v-for="tool in ['opencode', 'pi'] as const" :key="tool" class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label class="flex w-32 items-center gap-1.5 text-sm max-md:w-24">
            <Checkbox
              :id="`ai-${tool}`"
              :model-value="aiTools[tool]"
              @update:model-value="(v) => (aiTools[tool] = !!v)"
            />
            {{ tool === 'opencode' ? 'OpenCode' : 'Pi' }}
          </label>
          <!-- dual 才有协议选择；单协议场景展示定死的协议 -->
          <ToggleGroup
            v-if="aiGwKind === 'dual'"
            type="multiple"
            size="sm"
            variant="outline"
            :model-value="wiresOfTool(tool)"
            class="text-xs"
            @update:model-value="(v) => (aiWire[tool] = v as string[])"
          >
            <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
            <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
            <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
          </ToggleGroup>
          <span v-else class="text-[11px] text-muted-foreground">
            {{ aiGwKind === 'anthropic' ? 'anthropic 协议' : 'openai chat 协议' }}
          </span>
        </div>
        <p v-if="aiGwKind === 'dual'" class="text-[11px] leading-snug text-muted-foreground">
          多选协议时每个协议注册一个独立接入点（myapikey-chat / -responses / -anthropic），工具内按模型切换。全不选 =
          不给这个工具写接入点。
        </p>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Checkbox
            id="ai-default"
            :model-value="aiSetDefault"
            @update:model-value="(v) => (aiSetDefault = !!v)"
          />
          设为默认 provider（codex 设 model_provider；opencode/pi 用首个协议变体 + 首个模型）
        </label>
      </div>

      <div v-if="aiGwKind && modelsConsumers.length" class="space-y-1.5">
        <Label for="b-ai-models"
          >模型 ID（逗号分隔，{{ modelsConsumers.map((s) => (s === 'opencode' ? 'OpenCode' : 'Pi')).join('、') }}
          必填）</Label
        >
        <Input id="b-ai-models" v-model="aiModels" placeholder="claude-sonnet-4-5, gpt-5" />
      </div>

      <!-- 说明收纳为展开条：安全提示（key 明文落盘）保留常驻 -->
      <details class="group rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <summary class="cursor-pointer select-none list-none marker:hidden">
          <span class="inline-flex items-center gap-1">
            <span class="transition-transform group-open:rotate-90">▸</span>
            说明：写哪些文件 · 幂等 · key 明文落盘
          </span>
        </summary>
        <p class="mt-2">
          直接写入这 {{ ids.length }} 个容器的 home 配置文件——容器不必在运行，CLI
          下次启动即生效：claude 走 settings.json env 注入；codex 加 provider（key 经
          ~/.zshrc 环境变量，固定走 responses）；opencode / pi 在配置里内联 key，按所选
          协议注册接入点。已有配置只合并本方案的键，不会整体覆盖；重复执行幂等。
        </p>
        <p class="mt-1 text-amber-500/90">API Key 会明文落盘在各容器内。</p>
      </details>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

      <div class="flex justify-end">
        <Button :disabled="busy || !ids.length" @click="submit"
          >{{ busy ? '下发中…' : `下发（对 ${ids.length} 个容器）` }}</Button
        >
      </div>
    </template>
  </div>
</template>
