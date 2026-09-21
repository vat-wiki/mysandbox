<script setup lang="ts">
// Agent 工具页签（AI 工作区三板块之三）：每个 agent CLI 一个页签（单个单个配置 +
// 单独保存）——绑定（用哪些模型供应商）+ 各自的特殊配置（本期 Claude Code 页内挂
// AiClaudeToolConfig 自身配置）。每个页签有自己的「保存并应用」（应用范围在按钮旁
// 常显短句）：只提交
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
  normalizeOpenCodeBinding,
  normalizePiBinding,
  openCodeVariants,
  Unauthorized,
  type AiView,
  type AiBinding,
  type AiOpenCodeEntry,
  type BatchResult,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Bot } from 'lucide-vue-next'
import AiFieldClaude from './AiFieldClaude.vue'
import AiFieldCodex from './AiFieldCodex.vue'
import AiOpenCodeField from './AiOpenCodeField.vue'
import AiModelCombo from './AiModelCombo.vue'
import AiBindingResult from './AiBindingResult.vue'
import AiClaudeToolConfig from './AiClaudeToolConfig.vue'
import ConfirmDialog from './ConfirmDialog.vue'

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
  opencode: ocEntries.value.length > 0,
  pi: piEntries.value.length > 0,
}))

const view = ref<AiView | null>(null)
const busy = ref(false)
const err = ref('')
const result = ref<BatchResult | null>(null)

// —— 绑定表单：每工具一段；没选模型供应商 = 该工具不参与（不碰落盘配置）——
const claude = ref('')
const codex = ref('')
const codexModel = ref('')
const ocEntries = ref<AiOpenCodeEntry[]>([])
const ocDefaultModel = ref('')
// OpenCode 配置（落 opencode.json 顶层，user scope）：权限 auto 缺省开，model 优先于
// 绑定 setDefault 的自动推导，small_model 给了才写。
const ocAuto = ref(true)
const ocModel = ref('')
const ocSmallModel = ref('')
// Pi 绑定与 opencode 同 entries 形状（每 provider 独立协议、每协议独立模型），无默认模型。
const piEntries = ref<AiOpenCodeEntry[]>([])
// Codex 自身配置（config.toml，user scope）：审批/推理/权限等基础项 + 折叠的高级项，给了才写、
// 清空保存即落盘回收（后端差集回收，与 claude 顶级键同口径）。EMPTY = 「不写」选项
// 的哨兵值（SelectItem 空 value 与 placeholder 渲染打架，用哨兵映射回空串）。
const EMPTY = '__none__'
const cdApprovalPolicy = ref('')
const cdEffort = ref('')
const cdVerbosity = ref('')
const cdSandboxMode = ref('')
const cdNetworkAccess = ref(EMPTY)
const cdContextWindow = ref('')
const cdAutoCompactTokenLimit = ref('')
const cdReasoningSummary = ref('')
const cdHistoryPersistence = ref('')

const providers = computed(() => view.value?.providers ?? [])
const noProviders = computed(() => !providers.value.length)
// 主模型/轻量模型的下拉候选 = 已配置 变体/模型 组合（与绑定默认模型候选同源）
const ocModelCandidates = computed(() => openCodeVariants(ocEntries.value, providers.value))
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
  codexModel.value = b?.codex?.model ?? ''
  const ocSlot = normalizeOpenCodeBinding(b?.opencode)
  ocEntries.value = ocSlot?.entries ?? []
  ocDefaultModel.value = ocSlot?.defaultModel ?? ''
  piEntries.value = normalizePiBinding(b?.pi)?.entries ?? []
}

onMounted(() => loadView(true))

// 数据加载。fill=true 重填表单（首挂载）；toolConfig 保存后的刷新不重填——各页签的
// 绑定草稿是独立编辑现场，不能被无差别回灌冲掉。
async function loadView(fill: boolean) {
  try {
    view.value = await getAiView()
    if (fill) {
      fillFrom(view.value.binding)
      const oc = view.value.toolConfig.opencode
      ocAuto.value = oc?.permissionAuto !== false
      ocModel.value = oc?.model ?? ''
      ocSmallModel.value = oc?.smallModel ?? ''
      const cd = view.value.toolConfig.codex
      cdApprovalPolicy.value = cd?.approvalPolicy ?? ''
      cdEffort.value = cd?.reasoningEffort ?? ''
      cdVerbosity.value = cd?.verbosity ?? ''
      cdSandboxMode.value = cd?.sandboxMode ?? ''
      cdNetworkAccess.value = cd?.networkAccess === undefined ? EMPTY : cd.networkAccess ? 'true' : 'false'
      cdContextWindow.value = cd?.contextWindow === undefined ? '' : String(cd.contextWindow)
      cdAutoCompactTokenLimit.value = cd?.autoCompactTokenLimit === undefined ? '' : String(cd.autoCompactTokenLimit)
      cdReasoningSummary.value = cd?.reasoningSummary ?? ''
      cdHistoryPersistence.value = cd?.historyPersistence ?? ''
    }
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

// Claude 页签写入策略在保存按钮的下拉菜单里选（点「保存并应用」→ 选模式 → 执行）：
// merge = 合并写入（默认，文件里其它键保留）；replace = 整文件替换（settings.json 只含
// 本次管理内容，用户手工加的其它键清掉——清历史残留用）。不持久化——replace 是破坏性
// 动作，每次保存都显式选，且菜单选中后先过确认步（askReplace）再执行。
const askReplace = ref(false)

async function submitTool(tool: ToolTab, claudeMode: 'merge' | 'replace' = 'merge') {
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
    if (!codexModel.value.trim()) {
      err.value = 'Codex：先填默认模型（不写 model = codex 用内置 gpt-5.x，网关没有这些模型）'
      return
    }
  } else if (tool === 'opencode') {
    if (!ocEntries.value.length) {
      err.value = 'OpenCode：先选至少一个模型供应商（不选 = 不碰该工具的落盘配置）'
      return
    }
    if (ocEntries.value.some((e) => !e.wires.length)) {
      err.value = 'OpenCode 有的供应商还没勾协议'
      return
    }
    if (ocModel.value.trim() && !ocModel.value.trim().includes('/')) {
      err.value = 'OpenCode 主模型格式：provider/模型（如 myapikey-chat/opencode-coding）'
      return
    }
  } else {
    if (!piEntries.value.length) {
      err.value = 'Pi：先选至少一个模型供应商（不选 = 不碰该工具的落盘配置）'
      return
    }
    if (piEntries.value.some((e) => !e.wires.length)) {
      err.value = 'Pi 有的供应商还没勾协议'
      return
    }
  }
  busy.value = true
  result.value = null
  try {
    if (tool === 'claude') {
      result.value = await saveAiClaudePage(claude.value, claudeToolRef.value!.toolConfigOut(), undefined, claudeMode)
      // claude 槽已并进服务端绑定（claude-config 是合并语义），但本地 view 还停在挂载
      // 时的旧底稿——别的页签保存走 {...stored, 本工具槽} 整体提交，会拿旧底稿把刚存的
      // claude（及本窗口内其他页签新改的槽）冲掉。这里刷新数据不重填表单（各页签草稿
      // 是独立编辑现场，不能被回灌冲掉）。
      await loadView(false)
    } else {
      const stored = view.value?.binding ?? {}
      // entries 落盘形状：models 空集不写（= 该协议全部模型）。
      const entriesOut = (entries: AiOpenCodeEntry[]) =>
        entries.map((e) => ({
          provider: e.provider,
          wires: e.wires.map((w) => ({ wire: w.wire, ...(w.models?.length ? { models: [...w.models] } : {}) })),
        }))
      const b: AiBinding =
        tool === 'codex'
          ? { ...stored, codex: { provider: codex.value, model: codexModel.value.trim() } }
          : tool === 'opencode'
            ? {
                ...stored,
                opencode: {
                  entries: entriesOut(ocEntries.value),
                  setDefault: true,
                  ...(ocDefaultModel.value ? { defaultModel: ocDefaultModel.value } : {}),
                },
              }
            : { ...stored, pi: { entries: entriesOut(piEntries.value) } }
      // 本工具的自身配置（toolConfig 单键合并写入，其他工具的槽不受影响）：空值不写
      //（后端给了才写、清空不碰已有值）。
      const tcOut =
        tool === 'opencode'
          ? {
              opencode: {
                permissionAuto: ocAuto.value,
                ...(ocModel.value.trim() ? { model: ocModel.value.trim() } : {}),
                ...(ocSmallModel.value.trim() ? { smallModel: ocSmallModel.value.trim() } : {}),
              },
            }
          : tool === 'codex'
            ? {
                codex: {
                  ...(cdApprovalPolicy.value ? { approvalPolicy: cdApprovalPolicy.value } : {}),
                  ...(cdEffort.value ? { reasoningEffort: cdEffort.value } : {}),
                  ...(cdVerbosity.value ? { verbosity: cdVerbosity.value } : {}),
                  ...(cdSandboxMode.value ? { sandboxMode: cdSandboxMode.value } : {}),
                  ...(cdSandboxMode.value === 'workspace-write' && cdNetworkAccess.value !== EMPTY
                    ? { networkAccess: cdNetworkAccess.value === 'true' }
                    : {}),
                  ...(cdContextWindow.value.trim() ? { contextWindow: Number(cdContextWindow.value) } : {}),
                  ...(cdAutoCompactTokenLimit.value.trim() ? { autoCompactTokenLimit: Number(cdAutoCompactTokenLimit.value) } : {}),
                  ...(cdReasoningSummary.value ? { reasoningSummary: cdReasoningSummary.value } : {}),
                  ...(cdHistoryPersistence.value ? { historyPersistence: cdHistoryPersistence.value } : {}),
                },
              }
            : undefined
      result.value = await saveAiBinding(b, undefined, [tool], tcOut)
      if (view.value) view.value = { ...view.value, binding: b, ...(tcOut ? { toolConfig: { ...view.value.toolConfig, ...tcOut } } : {}) }
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

          <!-- ① Claude Code：绑定 + 自身配置（toolConfig，全局一份）——绑定与自身
               配置分块展示，字段风格与 Codex 保持一致 -->
          <div v-show="toolTab === 'claude'" class="space-y-3 pt-3">
            <AiFieldClaude
              :providers="providers"
              :provider-id="claude"
              @update:provider-id="(v) => (claude = v)"
            />
            <AiClaudeToolConfig
              ref="claudeToolRef"
              :tc="view?.toolConfig.claude"
              :binding-env="claudeBindingEnv"
              :provider="claudeProvider"
            />
          <!-- 本工具的保存按钮：绑定 + 自身配置一次提交（合并接口）；其余工具不动。
               应用范围说明挪到按钮旁常显（短句）；写入策略在按钮下拉里选（同 ServicesPanel
               删除菜单范式） -->
          <div class="flex items-center justify-end gap-2 border-t pt-3">
            <span class="text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</span>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button :disabled="busy">{{ busy ? '应用中…' : '保存并应用' }}</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @click="submitTool('claude', 'merge')">合并写入（默认）</DropdownMenuItem>
                <DropdownMenuItem class="text-destructive" @click="askReplace = true">替换整个文件…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          </div>

          <!-- ② Codex -->
          <div v-show="toolTab === 'codex'" class="space-y-3 pt-3">
            <AiFieldCodex
              :providers="providers"
              :provider-id="codex"
              :model="codexModel"
              @update:provider-id="(v) => (codex = v)"
              @update:model="(v) => (codexModel = v)"
            />
            <!-- Codex 自身配置：三个可选键等宽排布；给了才写、清空不碰已有值（回收不猜） -->
            <div class="rounded-md border bg-muted/20 p-3 shadow-xs">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-xs font-medium">工具自身配置</span>
                <span class="text-[11px] text-muted-foreground">config.toml · user scope</span>
              </div>
              <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div class="space-y-1.5">
                  <Label for="ai-cd-approval" class="text-[11px] text-muted-foreground">审批策略</Label>
                  <Select :model-value="cdApprovalPolicy" @update:model-value="(v) => (cdApprovalPolicy = v === EMPTY ? '' : (v as string))">
                    <SelectTrigger id="ai-cd-approval" size="sm" class="w-full">
                      <SelectValue placeholder="不写" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="EMPTY">不写</SelectItem>
                      <SelectItem value="on-request">模型主动询问</SelectItem>
                      <SelectItem value="on-failure">失败后询问</SelectItem>
                      <SelectItem value="never">从不询问</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-1.5">
                  <Label for="ai-cd-effort" class="text-[11px] text-muted-foreground">推理力度</Label>
                  <Select :model-value="cdEffort" @update:model-value="(v) => (cdEffort = v === EMPTY ? '' : (v as string))">
                    <SelectTrigger id="ai-cd-effort" size="sm" class="w-full">
                      <SelectValue placeholder="不写" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="EMPTY">不写</SelectItem>
                      <SelectItem v-for="e in ['minimal', 'low', 'medium', 'high', 'xhigh']" :key="e" :value="e">{{ e }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-1.5">
                  <Label for="ai-cd-verbosity" class="text-[11px] text-muted-foreground">输出详略</Label>
                  <Select :model-value="cdVerbosity" @update:model-value="(v) => (cdVerbosity = v === EMPTY ? '' : (v as string))">
                    <SelectTrigger id="ai-cd-verbosity" size="sm" class="w-full">
                      <SelectValue placeholder="不写" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="EMPTY">不写</SelectItem>
                      <SelectItem v-for="v in ['low', 'medium', 'high']" :key="v" :value="v">{{ v }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="space-y-1.5 sm:col-span-2 xl:col-span-1">
                  <Label for="ai-cd-sandbox" class="text-[11px] text-muted-foreground">权限模式</Label>
                  <Select :model-value="cdSandboxMode" @update:model-value="(v) => (cdSandboxMode = v === EMPTY ? '' : (v as string))">
                    <SelectTrigger id="ai-cd-sandbox" size="sm" class="w-full">
                      <SelectValue placeholder="不写" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="EMPTY">不写</SelectItem>
                      <SelectItem v-for="v in ['read-only', 'workspace-write', 'danger-full-access']" :key="v" :value="v">
                        {{ v === 'read-only' ? '只读' : v === 'workspace-write' ? '工作区可写' : '完整访问' }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <details class="group mt-3 rounded-md border bg-background/60">
                <summary class="flex cursor-pointer items-center justify-between px-3 py-2 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground">
                  高级选项
                  <span class="text-[10px] text-muted-foreground/70 group-open:hidden">展开</span>
                  <span class="hidden text-[10px] text-muted-foreground/70 group-open:inline">收起</span>
                </summary>
                <div class="grid gap-3 border-t px-3 py-3 sm:grid-cols-2">
                  <div class="space-y-1.5" :class="cdSandboxMode === 'workspace-write' ? '' : 'opacity-50'">
                    <Label for="ai-cd-network" class="text-[11px] text-muted-foreground">工作区网络</Label>
                    <Select :model-value="cdNetworkAccess" :disabled="cdSandboxMode !== 'workspace-write'" @update:model-value="(v) => (cdNetworkAccess = v as string)">
                      <SelectTrigger id="ai-cd-network" size="sm" class="w-full">
                        <SelectValue :placeholder="cdSandboxMode === 'workspace-write' ? '不写' : '仅工作区可写模式适用'" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem :value="EMPTY">不写</SelectItem>
                        <SelectItem value="true">允许</SelectItem>
                        <SelectItem value="false">禁止</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-1.5">
                    <Label for="ai-cd-context" class="text-[11px] text-muted-foreground">上下文窗口</Label>
                    <Input id="ai-cd-context" v-model="cdContextWindow" type="number" min="1" max="10000000" step="1" placeholder="不写" />
                  </div>
                  <div class="space-y-1.5">
                    <Label for="ai-cd-compact" class="text-[11px] text-muted-foreground">自动压缩阈值</Label>
                    <Input id="ai-cd-compact" v-model="cdAutoCompactTokenLimit" type="number" min="1" max="10000000" step="1" placeholder="不写" />
                  </div>
                  <div class="space-y-1.5">
                    <Label for="ai-cd-summary" class="text-[11px] text-muted-foreground">推理摘要</Label>
                    <Select :model-value="cdReasoningSummary" @update:model-value="(v) => (cdReasoningSummary = v === EMPTY ? '' : (v as string))">
                      <SelectTrigger id="ai-cd-summary" size="sm" class="w-full">
                        <SelectValue placeholder="不写" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem :value="EMPTY">不写</SelectItem>
                        <SelectItem v-for="v in ['auto', 'concise', 'detailed', 'none']" :key="v" :value="v">{{ v }}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div class="space-y-1.5 sm:col-span-2">
                    <Label for="ai-cd-history" class="text-[11px] text-muted-foreground">历史持久化</Label>
                    <Select :model-value="cdHistoryPersistence" @update:model-value="(v) => (cdHistoryPersistence = v === EMPTY ? '' : (v as string))">
                      <SelectTrigger id="ai-cd-history" size="sm" class="w-full">
                        <SelectValue placeholder="不写" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem :value="EMPTY">不写</SelectItem>
                        <SelectItem value="save-all">保存全部</SelectItem>
                        <SelectItem value="none">不保存</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </details>
            </div>
            <div class="flex items-center justify-end gap-2 border-t pt-3">
              <span class="text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</span>
              <Button :disabled="busy" @click="submitTool('codex')">{{
                busy ? '应用中…' : '保存并应用'
              }}</Button>
            </div>
          </div>

          <!-- ③ OpenCode / ④ Pi：同 entries 形状（每 provider 独立协议、每协议独立模型；pi 无默认模型） -->
          <div v-show="toolTab === 'opencode'" class="space-y-3 pt-3">
            <AiOpenCodeField
              tool="opencode"
              :providers="providers"
              :entries="ocEntries"
              :default-model="ocDefaultModel"
              :default-model-disabled="!!ocModel.trim()"
              default-model-disabled-hint="「工具自身配置 → 主模型」已设置，落盘以主模型为准；要这里的默认模型生效，先清空主模型"
              @update:entries="(v) => (ocEntries = v)"
              @update:default-model="(v) => (ocDefaultModel = v)"
            />
            <!-- OpenCode 自身配置（opencode.json 顶层，user scope）：与 Codex 同卡片
                 网格；权限 auto = permission:'allow'（等价 --auto）；主模型优先于绑定
                 setDefault 的自动推导；small_model 给了才写 -->
            <div class="rounded-md border bg-muted/20 p-3 shadow-xs">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-xs font-medium">工具自身配置</span>
                <span class="text-[11px] text-muted-foreground">opencode.json · user scope</span>
              </div>
              <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div class="space-y-1.5">
                  <span class="text-[11px] text-muted-foreground">权限</span>
                  <label class="flex items-center gap-1.5 text-xs">
                    <Checkbox :model-value="ocAuto" @update:model-value="(v) => (ocAuto = !!v)" />
                    默认 auto（permission: 'allow'，等价 --auto）
                  </label>
                  <!-- opencode 的 auto 徽标是 TUI 运行时开关（--auto / Ctrl+P 命令面板），
                       不读配置也不持久化——配置生效与否看行为（不弹审批），别看徽标 -->
                  <p class="text-[10px] leading-relaxed text-muted-foreground">
                    免审批即刻生效，但 TUI 的 auto 徽标是运行时开关（Ctrl+P → Enable auto-approve），不随配置显示
                  </p>
                </div>
                <div class="space-y-1.5">
                  <Label for="ai-oc-model" class="text-[11px] text-muted-foreground">主模型</Label>
                  <AiModelCombo
                    input-id="ai-oc-model"
                    v-model="ocModel"
                    :models="ocModelCandidates.map((o) => o.value)"
                    placeholder="provider/模型（可选，优先于绑定默认推导）"
                  />
                </div>
                <div class="space-y-1.5">
                  <Label for="ai-oc-small" class="text-[11px] text-muted-foreground">轻量模型</Label>
                  <AiModelCombo
                    input-id="ai-oc-small"
                    v-model="ocSmallModel"
                    :models="ocModelCandidates.map((o) => o.value)"
                    placeholder="small_model（可选，后台任务用）"
                  />
                </div>
              </div>
            </div>
            <div class="flex items-center justify-end gap-2 border-t pt-3">
              <span class="text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</span>
              <Button :disabled="busy" @click="submitTool('opencode')">{{
                busy ? '应用中…' : '保存并应用'
              }}</Button>
            </div>
          </div>
          <div v-show="toolTab === 'pi'" class="space-y-3 pt-3">
            <AiOpenCodeField
              tool="pi"
              :providers="providers"
              :entries="piEntries"
              default-model=""
              @update:entries="(v) => (piEntries = v)"
            />
            <div class="flex items-center justify-end gap-2 border-t pt-3">
              <span class="text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</span>
              <Button :disabled="busy" @click="submitTool('pi')">{{
                busy ? '应用中…' : '保存并应用'
              }}</Button>
            </div>
          </div>

          <p v-if="err" class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{{ err }}</p>
        </div>
      </section>

      <!-- 替换整个文件的确认步：破坏性动作（清掉每个目标里用户自己的键），菜单选中后先过这里 -->
      <ConfirmDialog
        v-if="askReplace"
        title="替换整个 settings.json？"
        description="每个目标（本机 + 受管容器 + 模板）的 settings.json 将被整体重写，只含本次管理内容——你手工加的其它键（主题、插件、模型映射等）会一并清掉。"
        confirm-text="替换应用"
        variant="destructive"
        :busy="busy"
        @confirm="askReplace = false; submitTool('claude', 'replace')"
        @close="askReplace = false"
      />
    </template>
  </div>
</template>
