<script setup lang="ts">
// 目标覆盖绑定表单（AI 配置覆盖弹框的表单本体）：绑定 = 工具 → 用哪些模型服务
// （provider id 引用，不内联端点）。target 模式——props.target 传入 = 该目标（容器名
// 或 '__host__' 本机）的专属绑定：覆盖存在即生效（全局不再应用到这台），可清除恢复
// 跟随全局（本机清除 = 回收落盘条目）。容器卡片菜单「AI 配置…」的 pull 入口。
// 全局模式的绑定管理（分卡 + 工具自身配置 + 项目规则）在 AiAgentsTab——本组件只服务
// 覆盖弹框这个临时小任务。四工具字段组与全局页共用（AiField* 组件单源）。
// claude/codex 单槽（env 只有一份）；opencode/pi 多 provider 变体并存，工具内 /models 切。
// claude 自身配置（模型/env）是全局一份（toolConfig），不进覆盖——这里不出现。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  saveAiTargetOverride,
  clearAiTargetOverride,
  HOST_TARGET,
  Unauthorized,
  type AiView,
  type AiBinding,
  type BatchResult,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import AiFieldClaude from './AiFieldClaude.vue'
import AiFieldCodex from './AiFieldCodex.vue'
import AiFieldMulti from './AiFieldMulti.vue'
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

// —— 表单：每工具一行；没选模型服务 = 该工具不参与（不碰落盘配置）——
const claude = ref('')
const codex = ref('')
const codexDefault = ref(false)
const oc = ref<string[]>([])
const ocWires = ref<GatewayWire[]>(['openai-chat'])
const ocDefault = ref(false)
const pi = ref<string[]>([])
const piWires = ref<GatewayWire[]>(['openai-chat'])

const providers = computed(() => view.value?.providers ?? [])
const noProviders = computed(() => !providers.value.length)

function fillFrom(b: AiBinding | null | undefined) {
  claude.value = b?.claude?.provider ?? ''
  codex.value = b?.codex?.provider ?? ''
  codexDefault.value = !!b?.codex?.setDefault
  oc.value = b?.opencode?.providers ? [...b.opencode.providers] : []
  ocWires.value = b?.opencode?.wires?.length ? [...b.opencode.wires] : ['openai-chat']
  ocDefault.value = !!b?.opencode?.setDefault
  pi.value = b?.pi?.providers ? [...b.pi.providers] : []
  piWires.value = b?.pi?.wires?.length ? [...b.pi.wires] : ['openai-chat']
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

// 清除覆盖（恢复跟随全局 / 本机回收条目）
async function clearOverride() {
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
  ...(claude.value ? { claude: { provider: claude.value } } : {}),
  ...(codex.value ? { codex: { provider: codex.value, setDefault: codexDefault.value } } : {}),
  ...(oc.value.length ? { opencode: { providers: [...oc.value], wires: [...ocWires.value] as GatewayWire[], setDefault: ocDefault.value } } : {}),
  ...(pi.value.length ? { pi: { providers: [...pi.value], wires: [...piWires.value] as GatewayWire[] } } : {}),
}))

async function submit() {
  const b = bindingOut.value
  if (!b.claude && !b.codex && !b.opencode && !b.pi) {
    err.value = '没有选择任何模型服务——不选 = 不碰该工具的落盘配置，保存无意义'
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
          <b class="font-medium">{{ props.target === HOST_TARGET ? '本机' : props.target }}</b> ·
          <template v-if="props.target === HOST_TARGET">
            <template v-if="overrideExists">本机使用专属绑定配置（本机从不跟随全局）。</template>
            <template v-else>本机还没有配置——保存后成为本机的专属绑定。</template>
          </template>
          <template v-else>
            <template v-if="overrideExists">本容器使用专属绑定，全局绑定不再应用（启动追平也跳过）。</template>
            <template v-else>当前跟随全局绑定——保存后成为本容器的专属绑定。</template>
          </template>
        </span>
      </div>

      <p v-if="noProviders" class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        模型服务库还是空的——先到「AI 工具 → 模型供应商」添加提供商（端点 + key），再回来绑定工具。
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
        <AiFieldMulti
          tool="opencode"
          :providers="providers"
          :provider-ids="oc"
          :wires="ocWires"
          :set-default="ocDefault"
          @update:provider-ids="(v) => (oc = v)"
          @update:wires="(v) => (ocWires = v)"
          @update:set-default="(v) => (ocDefault = v)"
        />
      </div>
      <div class="space-y-2 rounded-md border p-3">
        <AiFieldMulti
          tool="pi"
          :providers="providers"
          :provider-ids="pi"
          :wires="piWires"
          @update:provider-ids="(v) => (pi = v)"
          @update:wires="(v) => (piWires = v)"
        />
      </div>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

      <div class="flex items-center justify-end gap-2">
        <Button
          v-if="overrideExists"
          variant="outline"
          :disabled="busy"
          :title="props.target === HOST_TARGET ? '删除本机配置并回收接入条目' : '删除本目标的覆盖配置，恢复跟随全局'"
          @click="clearOverride"
        >{{ props.target === HOST_TARGET ? '清除本机配置' : '清除覆盖（跟随全局）' }}</Button>
        <Button :disabled="busy" @click="submit">{{
          busy ? '应用中…' : '保存并应用到本目标'
        }}</Button>
      </div>
    </template>
  </div>
</template>
