<script setup lang="ts">
// Agent 工具页签（AI 工作区三板块之三）：每个 agent CLI 一个页签（单个单个配置 +
// 单独保存）——绑定（用哪些模型服务）+ 各自的特殊配置（本期 Claude Code 页内挂
// AiClaudeToolConfig 自身配置）。每个页签有自己的「保存并应用到全部目标」：只提交
// 该工具的绑定，与已存绑定合并后整体提交（后端 AiBinding 整体替换语义 + 四层追平
// 链路不动，其余工具原样带上 = 落盘配置不碰）；应用目标 = 本机 + 受管容器（同权）。
// 容器的临时任务走 AiOverrideDialog（AiBindingTargetForm）；项目规则列表是全局形态
// 专属，收在本页尾部。工具自身配置（toolConfig）是全局一份，不进绑定四层。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  saveAiBinding,
  saveAiClaudePage,
  deleteAiProjectRule,
  Unauthorized,
  type AiView,
  type AiBinding,
  type BatchResult,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import AiFieldClaude from './AiFieldClaude.vue'
import AiFieldCodex from './AiFieldCodex.vue'
import AiFieldMulti from './AiFieldMulti.vue'
import AiBindingResult from './AiBindingResult.vue'
import AiClaudeToolConfig from './AiClaudeToolConfig.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import InfoHint from './InfoHint.vue'

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

// —— 绑定表单：每工具一段；没选模型服务 = 该工具不参与（不碰落盘配置）——
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
// 后端 AiBinding 是整体替换语义，这里与已存绑定合并（其余工具原样带上）再提交：
// 其余工具在 plan 里照旧存在 → 落盘配置保持追平不碰，「不选 = 不碰」的口径不变。
// （解绑某工具走删 provider——全量回收其落盘条目。）
// Claude 页签例外：一个按钮同时保存绑定 + 自身配置（toolConfig）——走合并接口
// POST /api/ai/claude-config（后端一次落两份存储、一遍下发），不打两个接口。
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
      err.value = 'Claude Code：先选一个模型服务（不选 = 不碰该工具的落盘配置）'
      return
    }
  } else if (tool === 'codex') {
    if (!codex.value) {
      err.value = 'Codex：先选一个模型服务（不选 = 不碰该工具的落盘配置）'
      return
    }
  } else if (tool === 'opencode') {
    if (!oc.value.length) {
      err.value = 'OpenCode：先选至少一个模型服务（不选 = 不碰该工具的落盘配置）'
      return
    }
    if (!ocWires.value.length) {
      err.value = 'OpenCode 选了模型服务但协议为空'
      return
    }
  } else {
    if (!pi.value.length) {
      err.value = 'Pi：先选至少一个模型服务（不选 = 不碰该工具的落盘配置）'
      return
    }
    if (!piWires.value.length) {
      err.value = 'Pi 选了模型服务但协议为空'
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
      result.value = await saveAiBinding(b)
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

// —— 项目级配置规则（全局形态专属段）——

const ruleSummary = (r: AiBinding) => {
  const parts: string[] = []
  if (r.claude) parts.push(`claude → ${r.claude.provider}`)
  if (r.opencode?.providers.length) parts.push(`opencode → ${r.opencode.providers.join('、')}`)
  return parts.join(' · ') || '（空）'
}

const ruleDelId = ref<string | null>(null)
async function doRemoveRule(id: string) {
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
</script>

<template>
  <div class="space-y-5">
    <!-- 结果态：表单区整体切走（返回编辑保留表单内容，重推是常态） -->
    <template v-if="result">
      <AiBindingResult :result="result" @back="result = null" />
    </template>

    <!-- 编辑态 -->
    <template v-else>
      <p v-if="noProviders" class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        模型服务库还是空的——
        <button type="button" class="font-medium text-primary underline-offset-2 hover:underline" @click="emit('switch-providers')">先到「模型供应商」添加</button>
        （端点 + key），再回来绑定工具。
      </p>

      <!-- 工具页签行：一页一个工具（圆点 = 该工具绑定已启用）；样式与工作区页签同款 -->
      <div class="border-b">
        <div class="flex gap-1">
          <button
            v-for="t in toolTabs"
            :key="t.key"
            type="button"
            class="flex items-center gap-1.5 border-b-2 px-3 pb-2 text-xs transition-colors"
            :class="
              toolTab === t.key
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
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

      <!-- ① Claude Code：绑定 + 自身配置（toolConfig，全局一份） -->
      <div v-show="toolTab === 'claude'" class="space-y-3 pt-4">
        <div class="space-y-1.5">
          <AiFieldClaude
            :providers="providers"
            :provider-id="claude"
            @update:provider-id="(v) => (claude = v)"
          />
        </div>
        <AiClaudeToolConfig
          ref="claudeToolRef"
          :tc="view?.toolConfig.claude"
          :binding-env="claudeBindingEnv"
        />
        <!-- 本工具的保存按钮：绑定 + 自身配置一次提交（合并接口）；其余工具不动 -->
        <div class="flex items-center justify-end gap-3 border-t pt-3">
          <span class="mr-auto text-[11px] text-muted-foreground/70">保存 = 自身配置 + Claude Code 绑定一起应用（其余工具不动）</span>
          <Button :disabled="busy" @click="submitTool('claude')">{{
            busy ? '应用中…' : '保存并应用到全部目标'
          }}</Button>
        </div>
      </div>

      <!-- ② Codex -->
      <div v-show="toolTab === 'codex'" class="space-y-1.5 pt-4">
        <AiFieldCodex
          :providers="providers"
          :provider-id="codex"
          :set-default="codexDefault"
          @update:provider-id="(v) => (codex = v)"
          @update:set-default="(v) => (codexDefault = v)"
        />
        <p class="text-[11px] text-muted-foreground/70">Codex 暂无绑定之外的自身配置。</p>
        <div class="flex items-center justify-end gap-3 border-t pt-3">
          <span class="mr-auto text-[11px] text-muted-foreground/70">只应用 Codex 的绑定（其余工具不动）</span>
          <Button :disabled="busy" @click="submitTool('codex')">{{
            busy ? '应用中…' : '保存并应用到全部目标'
          }}</Button>
        </div>
      </div>

      <!-- ③ OpenCode / ④ Pi：多 provider × wire 变体 -->
      <div v-show="toolTab === 'opencode'" class="space-y-3 pt-4">
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
          <span class="mr-auto text-[11px] text-muted-foreground/70">只应用 OpenCode 的绑定（其余工具不动）</span>
          <Button :disabled="busy" @click="submitTool('opencode')">{{
            busy ? '应用中…' : '保存并应用到全部目标'
          }}</Button>
        </div>
      </div>
      <div v-show="toolTab === 'pi'" class="space-y-3 pt-4">
        <AiFieldMulti
          tool="pi"
          :providers="providers"
          :provider-ids="pi"
          :wires="piWires"
          @update:provider-ids="(v) => (pi = v)"
          @update:wires="(v) => (piWires = v)"
        />
        <div class="flex items-center justify-end gap-3 border-t pt-3">
          <span class="mr-auto text-[11px] text-muted-foreground/70">只应用 Pi 的绑定（其余工具不动）</span>
          <Button :disabled="busy" @click="submitTool('pi')">{{
            busy ? '应用中…' : '保存并应用到全部目标'
          }}</Button>
        </div>
      </div>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

      <!-- 全局形态专属段：项目级规则 + 追平语义（从旧 AiBindingTab 迁入） -->
      <template v-if="view">
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-medium">项目级配置</h3>
            <span class="text-[11px] text-muted-foreground">文件面板进到项目目录点「AI 配置」就地落</span>
          </div>
          <div
            v-if="!view.projectRules.length"
            class="flex items-start gap-1.5 rounded-md border border-dashed px-3 py-3 text-xs leading-relaxed text-muted-foreground"
          >
            <p class="flex-1">还没有项目级规则——进项目目录保存即写入，优先级高于 home 级。</p>
            <InfoHint tip="claude 写 .claude/settings.json，opencode 写 opencode.json；start 时自动补齐。" />
          </div>
          <div v-for="r in view.projectRules" :key="r.id" class="flex items-center gap-2 rounded-md border px-3 py-2">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ r.to }}</span>
            <span class="min-w-0 truncate text-[11px] text-muted-foreground">{{ ruleSummary(r) }}</span>
            <Badge variant="outline" class="shrink-0 px-1.5 text-[10px] text-muted-foreground">项目</Badge>
            <Button variant="ghost" size="icon-xs" class="shrink-0 text-destructive" title="删除规则并回收条目" @click="ruleDelId = r.id">
              <Trash2 class="size-3.5" />
            </Button>
          </div>
        </div>

        <!-- 追平语义：一行常驻（触发时机 + key 明文风险句），机制细节收 InfoHint -->
        <div class="flex items-start gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <div class="flex-1 space-y-0.5">
            <p>绑定保存后自动追平（目标 = 本机 + 受管容器）：启动 sweep、新建容器、start 事件。</p>
            <p class="text-amber-500/90">API Key 会明文落盘到各目标（sidecar 存档同面；本机 = 宿主 home 的真实文件）。</p>
          </div>
          <InfoHint label="追平与落盘机制说明">
            <p>追平按「目标覆盖 ?? 全局绑定」写一份，容器不必在运行，CLI 下次启动即生效；本机跟随全局绑定（没有专属覆盖）。</p>
            <p>各工具落盘：claude 走 settings.json env 注入（含自身配置的模型/env）；codex 加 provider 块（key 经 ~/.zshrc 环境变量，固定 responses）；opencode / pi 在配置里内联 key，按所选协议注册 <code>&lt;服务&gt;-chat/-responses/-anthropic</code> 接入点。</p>
            <p>已有配置只合并本方案的键；换绑 / 清空会回收旧接入点。</p>
          </InfoHint>
        </div>
      </template>

      <ConfirmDialog
        v-if="ruleDelId"
        title="删除项目级配置规则"
        description="已写入项目的接入条目会被回收。"
        confirm-text="删除"
        variant="destructive"
        @confirm="doRemoveRule(ruleDelId); ruleDelId = null"
        @close="ruleDelId = null"
      />
    </template>
  </div>
</template>
