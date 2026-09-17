<script setup lang="ts">
// Agent 工具页签（AI 工作区三板块之三）：每个 agent CLI 一个页签（单个单个配置 +
// 单独保存）——绑定（用哪些模型供应商）+ 各自的特殊配置（本期 Claude Code 页内挂
// AiClaudeToolConfig 自身配置）。每个页签有自己的「保存并应用到全部目标」：只提交
// 该工具的绑定，与已存绑定合并后整体提交（后端 AiBinding 整体替换语义 + 四层追平
// 链路不动，其余工具原样带上 = 落盘配置不碰）；应用目标 = 本机 + 受管容器（同权）。
// 容器的临时任务走 AiOverrideDialog（AiBindingTargetForm）。本页 = 全局配置——项目级
// 规则不在这里展示/管理，落点与增删都在文件面板「AI 配置」就地完成（AiSpotDialog）。
// 工具自身配置（toolConfig）是全局一份，不进绑定四层。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  saveAiBinding,
  saveAiClaudePage,
  Unauthorized,
  type AiView,
  type AiBinding,
  type BatchResult,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Bot } from 'lucide-vue-next'
import AiFieldClaude from './AiFieldClaude.vue'
import AiFieldCodex from './AiFieldCodex.vue'
import AiFieldMulti from './AiFieldMulti.vue'
import AiBindingResult from './AiBindingResult.vue'
import AiClaudeToolConfig from './AiClaudeToolConfig.vue'

const emit = defineEmits<{
  (e: 'done'): void
  (e: 'unauthorized'): void
  (e: 'switch-providers'): void // provider 空态 → 切「模型供应商」页签
}>()

// —— 工具页签：单个单个配置（一页一个工具的表单 + 一个保存按钮）——
// 表单状态全部在本组件 ref 里，页签切换不丢草稿；保存按页签各自提交（见 submitTool）。
type ToolTab = 'claude' | 'codex' | 'opencode' | 'pi'
const toolTab = ref<ToolTab>('claude')
const toolTabs: { key: ToolTab; label: string }[] = [
  { key: 'claude', label: 'Claude Code' },
  { key: 'codex', label: 'Codex' },
  { key: 'opencode', label: 'OpenCode' },
  { key: 'pi', label: 'Pi' },
]
const toolOn = computed<Record<ToolTab, boolean>>(() => ({
  claude: !!claude.value,
  codex: !!codex.value,
  opencode: oc.value.length > 0,
  pi: pi.value.length > 0,
}))

const view = ref<AiView | null>(null)
const busy = ref(false)
const err = ref('')
const result = ref<BatchResult | null>(null)

// —— 绑定表单：每工具一段；没选模型供应商 = 该工具不参与（不碰落盘配置）——
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
// claude 绑定槽选中的 provider（自身配置表单拿它探测 /models 清单）
const claudeProvider = computed(() => providers.value.find((p) => p.id === claude.value) ?? null)

// 当前选中的 claude provider 将注入的受管键（与 configClaude 的落盘值一致：baseUrl
// 原样不含 /v1 + apiKey）——自身配置的 env 预览要展示落盘全貌就得带上。
const claudeBindingEnv = computed<Record<string, string> | null>(() => {
  const p = providers.value.find((x) => x.id === claude.value)
  if (!p?.endpoints.anthropic) return null
  return { ANTHROPIC_BASE_URL: p.endpoints.anthropic.baseUrl, ANTHROPIC_AUTH_TOKEN: p.apiKey }
})

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

// 数据加载。fill=true 重填表单（首挂载）；toolConfig 保存后的刷新不重填——各页签的
// 绑定草稿是独立编辑现场，不能被无差别回灌冲掉。
async function loadView(fill: boolean) {
  try {
    view.value = await getAiView()
    if (fill) fillFrom(view.value.binding)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

// —— 按工具保存：每个页签一个「保存并应用」，只提交该工具的绑定 ——
// 后端 AiBinding 是整体替换语义，这里与已存绑定合并（其余工具原样带上）再提交；
// apply=[tool] 让后端只下发本工具的落盘配置——工具间互相独立，页签保存不连带
// 重写其他工具的配置文件/探测它们的网关（存储里其余工具的槽原样保留）。
// （解绑某工具走删 provider——全量回收其落盘条目。）
// Claude 页签例外：一个按钮同时保存绑定 + 自身配置（toolConfig）——走合并接口
// POST /api/ai/claude-config（后端一次落两份存储、只下发 claude），不打两个接口。
const claudeToolRef = ref<InstanceType<typeof AiClaudeToolConfig> | null>(null)

async function submitTool(tool: ToolTab) {
  err.value = ''
  if (tool === 'claude') {
    const verr = claudeToolRef.value?.validationError() ?? null
    if (verr) {
      err.value = `自身配置没通过校验：${verr}`
      return
    }
    if (!claude.value) {
      err.value = 'Claude Code：先选一个模型供应商（不选 = 不碰该工具的落盘配置）'
      return
    }
  } else if (tool === 'codex') {
    if (!codex.value) {
      err.value = 'Codex：先选一个模型供应商（不选 = 不碰该工具的落盘配置）'
      return
    }
  } else if (tool === 'opencode') {
    if (!oc.value.length) {
      err.value = 'OpenCode：先选至少一个模型供应商（不选 = 不碰该工具的落盘配置）'
      return
    }
    if (!ocWires.value.length) {
      err.value = 'OpenCode 选了模型供应商但协议为空'
      return
    }
  } else {
    if (!pi.value.length) {
      err.value = 'Pi：先选至少一个模型供应商（不选 = 不碰该工具的落盘配置）'
      return
    }
    if (!piWires.value.length) {
      err.value = 'Pi 选了模型供应商但协议为空'
      return
    }
  }
  busy.value = true
  result.value = null
  try {
    if (tool === 'claude') {
      result.value = await saveAiClaudePage(claude.value, claudeToolRef.value!.toolConfigOut())
    } else {
      const stored = view.value?.binding ?? {}
      const b: AiBinding =
        tool === 'codex'
          ? { ...stored, codex: { provider: codex.value, setDefault: codexDefault.value } }
          : tool === 'opencode'
            ? { ...stored, opencode: { providers: [...oc.value], wires: [...ocWires.value] as GatewayWire[], setDefault: ocDefault.value } }
            : { ...stored, pi: { providers: [...pi.value], wires: [...piWires.value] as GatewayWire[] } }
      result.value = await saveAiBinding(b, undefined, [tool])
      if (view.value) view.value = { ...view.value, binding: b }
    }
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
  <!-- 板块外框与技能中心/模型供应商同款（rounded-md border + muted 头部条）——三页签统一板块语言 -->
  <div class="flex flex-col gap-3">
    <!-- 结果态：表单区整体切走（返回编辑保留表单内容，重推是常态） -->
    <template v-if="result">
      <AiBindingResult :result="result" @back="result = null" />
    </template>

    <!-- 编辑态 -->
    <template v-else>
      <!-- 单面板页：头顶栏 = 图标 + 工具分段切换（不放与页签重复的标题） -->
      <section class="rounded-md border">
        <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
          <Bot class="size-3.5 shrink-0 text-muted-foreground" />
          <!-- 工具切换：分段控件（选中底色明显，点开即该 CLI 的输入表单）；
               圆点 = 该工具绑定已启用 -->
          <div class="flex gap-0.5 rounded-md border bg-background/40 p-0.5">
            <button
              v-for="t in toolTabs"
              :key="t.key"
              type="button"
              class="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors"
              :class="
                toolTab === t.key
                  ? 'bg-background font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              "
              @click="toolTab = t.key; err = ''"
            >
              <span
                class="size-1.5 rounded-full"
                :class="toolOn[t.key] ? 'bg-emerald-500' : 'bg-muted-foreground/30'"
                :title="toolOn[t.key] ? '绑定已启用' : '未启用'"
              />
              {{ t.label }}
            </button>
          </div>
        </div>

        <div class="p-3">
          <p v-if="noProviders" class="rounded-md border border-dashed px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            模型供应商库还是空的——
            <button type="button" class="font-medium text-primary underline-offset-2 hover:underline" @click="emit('switch-providers')">先到「模型供应商」添加</button>
            （端点 + key），再回来绑定工具。
          </p>

          <!-- ① Claude Code：绑定 + 自身配置（toolConfig，全局一份）——绑定选择器
               经 prepend-grid 槽并进常驻网格首格，不占独立一行 -->
          <div v-show="toolTab === 'claude'" class="space-y-3 pt-3">
          <AiClaudeToolConfig
            ref="claudeToolRef"
            :tc="view?.toolConfig.claude"
            :binding-env="claudeBindingEnv"
            :provider="claudeProvider"
          >
            <template #prepend-grid>
              <AiFieldClaude
                :providers="providers"
                :provider-id="claude"
                :show-header="false"
                @update:provider-id="(v) => (claude = v)"
              />
            </template>
          </AiClaudeToolConfig>
          <!-- 本工具的保存按钮：绑定 + 自身配置一次提交（合并接口）；其余工具不动 -->
          <div class="flex items-center justify-end gap-3 border-t pt-3">
            <p class="mr-auto self-center text-[11px] text-muted-foreground">目标：本机 + 全部受管系统容器（含停机的；模板除外）</p>
            <Button :disabled="busy" @click="submitTool('claude')">{{
              busy ? '应用中…' : '保存并应用到全部目标'
            }}</Button>
          </div>
          </div>

          <!-- ② Codex -->
          <div v-show="toolTab === 'codex'" class="space-y-1.5 pt-3">
            <AiFieldCodex
              :providers="providers"
              :provider-id="codex"
              :set-default="codexDefault"
              @update:provider-id="(v) => (codex = v)"
              @update:set-default="(v) => (codexDefault = v)"
            />
            <p class="text-[11px] text-muted-foreground/70">Codex 暂无绑定之外的自身配置。</p>
            <div class="flex items-center justify-end gap-3 border-t pt-3">
              <p class="mr-auto self-center text-[11px] text-muted-foreground">目标：本机 + 全部受管系统容器（含停机的；模板除外）</p>
              <Button :disabled="busy" @click="submitTool('codex')">{{
                busy ? '应用中…' : '保存并应用到全部目标'
              }}</Button>
            </div>
          </div>

          <!-- ③ OpenCode / ④ Pi：多 provider × wire 变体 -->
          <div v-show="toolTab === 'opencode'" class="space-y-3 pt-3">
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
            <div class="flex items-center justify-end gap-3 border-t pt-3">
              <p class="mr-auto self-center text-[11px] text-muted-foreground">目标：本机 + 全部受管系统容器（含停机的；模板除外）</p>
              <Button :disabled="busy" @click="submitTool('opencode')">{{
                busy ? '应用中…' : '保存并应用到全部目标'
              }}</Button>
            </div>
          </div>
          <div v-show="toolTab === 'pi'" class="space-y-3 pt-3">
            <AiFieldMulti
              tool="pi"
              :providers="providers"
              :provider-ids="pi"
              :wires="piWires"
              @update:provider-ids="(v) => (pi = v)"
              @update:wires="(v) => (piWires = v)"
            />
            <div class="flex items-center justify-end gap-3 border-t pt-3">
              <p class="mr-auto self-center text-[11px] text-muted-foreground">目标：本机 + 全部受管系统容器（含停机的；模板除外）</p>
              <Button :disabled="busy" @click="submitTool('pi')">{{
                busy ? '应用中…' : '保存并应用到全部目标'
              }}</Button>
            </div>
          </div>

          <p v-if="err" class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{{ err }}</p>
        </div>
      </section>
    </template>
  </div>
</template>
