<script setup lang="ts">
// 目标覆盖绑定表单（AI 配置覆盖弹框的表单本体）：绑定 = 工具 → 用哪些模型供应商
// （provider id 引用，不内联端点）。target 模式——props.target 传入 = 该容器自己的
// 专属绑定：覆盖存在即生效（全局不再应用到这台），可清除恢复跟随全局。容器卡片
// 菜单「AI 配置…」的 pull 入口（本机跟随全局绑定，不是覆盖目标——这里只有容器）。
// 全局模式的绑定管理（分卡 + 工具自身配置 + 项目规则）在 AiAgentsTab——本组件只服务
// 覆盖弹框这个临时小任务。四工具字段组与全局页共用（AiField* 组件单源）。
// claude/codex 单槽（env 只有一份）；opencode/pi 多 provider 变体并存，工具内 /models 切。
// claude 自身配置（模型/env）是全局一份（toolConfig），不进覆盖——这里不出现。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  saveAiTargetOverride,
  clearAiTargetOverride,
  normalizeOpenCodeBinding,
  normalizePiBinding,
  Unauthorized,
  type AiView,
  type AiBinding,
  type AiOpenCodeEntry,
  type BatchResult,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import AiFieldClaude from './AiFieldClaude.vue'
import AiFieldCodex from './AiFieldCodex.vue'
import AiOpenCodeField from './AiOpenCodeField.vue'
import AiBindingResult from './AiBindingResult.vue'
import { toast } from 'vue-sonner'

const props = defineProps<{
  // 目标覆盖模式（编辑/保存对象是该目标的覆盖绑定，不是全局）。
  target: string
}>()
const emit = defineEmits<{
  (e: 'done'): void
  (e: 'unauthorized'): void
}>()

const view = ref<AiView | null>(null)
const busy = ref(false)
const err = ref('')
const result = ref<BatchResult | null>(null)
const overrideExists = ref(false)

// —— 表单：每工具一行；没选模型供应商 = 该工具不参与（不碰落盘配置）——
const claude = ref('')
const codex = ref('')
const codexDefault = ref(false)
const ocEntries = ref<AiOpenCodeEntry[]>([])
const ocDefaultModel = ref('')
// Pi 绑定与 opencode 同 entries 形状（每 provider 独立协议、每协议独立模型），无默认模型。
const piEntries = ref<AiOpenCodeEntry[]>([])

const providers = computed(() => view.value?.providers ?? [])
const noProviders = computed(() => !providers.value.length)

function fillFrom(b: AiBinding | null | undefined) {
  claude.value = b?.claude?.provider ?? ''
  codex.value = b?.codex?.provider ?? ''
  codexDefault.value = !!b?.codex?.setDefault
  const ocSlot = normalizeOpenCodeBinding(b?.opencode)
  ocEntries.value = ocSlot?.entries ?? []
  ocDefaultModel.value = ocSlot?.defaultModel ?? ''
  piEntries.value = normalizePiBinding(b?.pi)?.entries ?? []
}

onMounted(() => loadView(true))

// 数据加载。fill=true 重填表单（首挂载）；父级调 reload() 只刷数据不重填表单。
async function loadView(fill: boolean) {
  try {
    view.value = await getAiView()
    // 目标模式无覆盖时以全局绑定为编辑底稿（保存才落覆盖）。
    const base = view.value.overrides[props.target] ?? view.value.binding
    overrideExists.value = !!view.value.overrides[props.target]
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

// 清除覆盖（恢复跟随全局）
async function clearOverride() {
  busy.value = true
  err.value = ''
  try {
    await clearAiTargetOverride(props.target)
    overrideExists.value = false
    result.value = null
    toast('已清除覆盖，恢复跟随全局')
    const v = await getAiView()
    view.value = v
    fillFrom(v.binding ?? null)
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
  ...(claude.value ? { claude: { provider: claude.value } } : {}),
  ...(codex.value ? { codex: { provider: codex.value, setDefault: codexDefault.value } } : {}),
  ...(ocEntries.value.length
    ? {
        opencode: {
          entries: ocEntries.value.map((e) => ({
            provider: e.provider,
            wires: e.wires.map((w) => ({ wire: w.wire, ...(w.models?.length ? { models: [...w.models] } : {}) })),
          })),
          setDefault: true,
          ...(ocDefaultModel.value ? { defaultModel: ocDefaultModel.value } : {}),
        },
      }
    : {}),
  ...(piEntries.value.length
    ? {
        pi: {
          entries: piEntries.value.map((e) => ({
            provider: e.provider,
            wires: e.wires.map((w) => ({ wire: w.wire, ...(w.models?.length ? { models: [...w.models] } : {}) })),
          })),
        },
      }
    : {}),
}))

async function submit() {
  const b = bindingOut.value
  if (!b.claude && !b.codex && !b.opencode && !b.pi) {
    err.value = '没有选择任何模型供应商——不选 = 不碰该工具的落盘配置，保存无意义'
    return
  }
  if (b.opencode && b.opencode.entries.some((e) => !e.wires.length)) {
    err.value = 'OpenCode 有的供应商还没勾协议'
    return
  }
  if (b.pi && b.pi.entries.some((e) => !e.wires.length)) {
    err.value = 'Pi 有的供应商还没勾协议'
    return
  }
  busy.value = true
  result.value = null
  err.value = ''
  try {
    result.value = await saveAiTargetOverride(props.target, b)
    overrideExists.value = true
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
    <!-- 结果态：表单区整体切走（返回编辑保留表单内容，重推是常态） -->
    <template v-if="result">
      <AiBindingResult :result="result" @back="result = null" />
    </template>

    <!-- 编辑态 -->
    <template v-else>
      <!-- 目标覆盖横幅 -->
      <div
        class="rounded-md border px-3 py-2 text-[11px] leading-relaxed"
        :class="
          overrideExists
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'border-border bg-muted/30 text-muted-foreground'
        "
      >
        <span>
          <b class="font-medium">{{ props.target }}</b> ·
          <template v-if="overrideExists">本容器使用专属绑定，全局绑定不再应用（启动追平也跳过）。</template>
          <template v-else>当前跟随全局绑定——保存后成为本容器的专属绑定。</template>
        </span>
      </div>

      <p v-if="noProviders" class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        模型供应商库还是空的——先到「AI 工具 → 模型供应商」添加提供商（端点 + key），再回来绑定工具。
      </p>

      <!-- 四工具字段组（与全局 Agent 工具页共用同一组组件） -->
      <div class="space-y-1.5 rounded-md border p-3">
        <AiFieldClaude
          :providers="providers"
          :provider-id="claude"
          @update:provider-id="(v) => (claude = v)"
        />
      </div>
      <div class="space-y-1.5 rounded-md border p-3">
        <AiFieldCodex
          :providers="providers"
          :provider-id="codex"
          :set-default="codexDefault"
          @update:provider-id="(v) => (codex = v)"
          @update:set-default="(v) => (codexDefault = v)"
        />
      </div>
      <div class="space-y-2 rounded-md border p-3">
        <AiOpenCodeField
          tool="opencode"
          :providers="providers"
          :entries="ocEntries"
          :default-model="ocDefaultModel"
          @update:entries="(v) => (ocEntries = v)"
          @update:default-model="(v) => (ocDefaultModel = v)"
        />
      </div>
      <div class="space-y-2 rounded-md border p-3">
        <AiOpenCodeField
          tool="pi"
          :providers="providers"
          :entries="piEntries"
          default-model=""
          @update:entries="(v) => (piEntries = v)"
        />
      </div>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

      <div class="flex items-center justify-end gap-2">
        <Button
          v-if="overrideExists"
          variant="outline"
          :disabled="busy"
          title="删除本目标的覆盖配置，恢复跟随全局"
          @click="clearOverride"
        >清除覆盖（跟随全局）</Button>
        <Button :disabled="busy" @click="submit">{{
          busy ? '应用中…' : '保存并应用到本目标'
        }}</Button>
      </div>
    </template>
  </div>
</template>
