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
  normalizeOpenCodeBinding,
  Unauthorized,
  type AiView,
  type AiBinding,
  type AiOpenCodeEntry,
  type BatchResult,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Bot } from 'lucide-vue-next'
import AiFieldClaude from './AiFieldClaude.vue'
import AiFieldCodex from './AiFieldCodex.vue'
import AiFieldMulti from './AiFieldMulti.vue'
import AiOpenCodeField from './AiOpenCodeField.vue'
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
const ocEntries = ref<AiOpenCodeEntry[]>([])
const ocDefaultModel = ref('')
// OpenCode 配置（落 opencode.json 顶层，user scope）：权限 auto 缺省开，model 优先于
// 绑定 setDefault 的自动推导，small_model 给了才写。
const ocAuto = ref(true)
const ocModel = ref('')
const ocSmallModel = ref('')
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
  const ocSlot = normalizeOpenCodeBinding(b?.opencode)
  ocEntries.value = ocSlot?.entries ?? []
  ocDefaultModel.value = ocSlot?.defaultModel ?? ''
  pi.value = b?.pi?.providers ? [...b.pi.providers] : []
  piWires.value = b?.pi?.wires?.length ? [...b.pi.wires] : ['openai-chat']
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
      result.value = await saveAiClaudePage(claude.value, claudeToolRef.value!.toolConfigOut(), undefined, claudeMode)
    } else {
      const stored = view.value?.binding ?? {}
      const b: AiBinding =
        tool === 'codex'
          ? { ...stored, codex: { provider: codex.value, setDefault: codexDefault.value } }
          : tool === 'opencode'
            ? {
                ...stored,
                opencode: {
                  entries: ocEntries.value.map((e) => ({
                    provider: e.provider,
                    wires: e.wires.map((w) => ({ wire: w.wire, ...(w.models?.length ? { models: [...w.models] } : {}) })),
                  })),
                  setDefault: true,
                  ...(ocDefaultModel.value ? { defaultModel: ocDefaultModel.value } : {}),
                },
              }
            : { ...stored, pi: { providers: [...pi.value], wires: [...piWires.value] as GatewayWire[] } }
      const ocTc =
        tool === 'opencode'
          ? {
              permissionAuto: ocAuto.value,
              ...(ocModel.value.trim() ? { model: ocModel.value.trim() } : {}),
              ...(ocSmallModel.value.trim() ? { smallModel: ocSmallModel.value.trim() } : {}),
            }
          : undefined
      result.value = await saveAiBinding(b, undefined, [tool], ocTc ? { opencode: ocTc } : undefined)
      if (view.value) view.value = { ...view.value, binding: b, ...(ocTc ? { toolConfig: { ...view.value.toolConfig, opencode: ocTc } } : {}) }
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
          <div v-show="toolTab === 'codex'" class="space-y-1.5 pt-3">
            <AiFieldCodex
              :providers="providers"
              :provider-id="codex"
              :set-default="codexDefault"
              @update:provider-id="(v) => (codex = v)"
              @update:set-default="(v) => (codexDefault = v)"
            />
            <p class="text-[11px] text-muted-foreground/70">Codex 暂无绑定之外的自身配置。</p>
            <div class="flex items-center justify-end gap-2 border-t pt-3">
              <span class="text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</span>
              <Button :disabled="busy" @click="submitTool('codex')">{{
                busy ? '应用中…' : '保存并应用'
              }}</Button>
            </div>
          </div>

          <!-- ③ OpenCode（entries：每 provider 独立协议、每协议独立模型）/ ④ Pi：多 provider × wire 变体 -->
          <div v-show="toolTab === 'opencode'" class="space-y-3 pt-3">
            <AiOpenCodeField
              :providers="providers"
              :entries="ocEntries"
              :default-model="ocDefaultModel"
              @update:entries="(v) => (ocEntries = v)"
              @update:default-model="(v) => (ocDefaultModel = v)"
            />
            <!-- OpenCode 配置（opencode.json 顶层，user scope）：权限 auto = permission:'allow'
                 （等价 --auto）；主模型优先于绑定 setDefault 自动推导；small_model 给了才写 -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <label class="flex items-center gap-1.5 text-xs">
                <Checkbox :model-value="ocAuto" @update:model-value="(v) => (ocAuto = !!v)" />
                权限默认 auto
              </label>
              <Input v-model="ocModel" class="h-7 w-64 text-xs" placeholder="主模型 provider/模型（可选）" />
              <Input v-model="ocSmallModel" class="h-7 w-60 text-xs" placeholder="轻量模型 small_model（可选）" />
            </div>
            <div class="flex items-center justify-end gap-3 border-t pt-3">
              <p class="mr-auto self-center text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</p>
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
              <p class="mr-auto self-center text-[11px] text-muted-foreground">目标：本机 + 受管容器（含停机）+ 模板</p>
              <Button :disabled="busy" @click="submitTool('pi')">{{
                busy ? '应用中…' : '保存并应用到全部目标'
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
