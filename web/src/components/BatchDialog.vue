<script setup lang="ts">
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import {
  batchGit,
  batchSshReseed,
  batchSshAppendKey,
  batchExec,
  batchAiConfig,
  getAiGateway,
  applyHosts,
  getHosts,
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
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
// Monaco 编辑器壳：exec/hosts tab 的高亮编辑。异步引入——git/ssh tab 打开零成本，
// 首次进 exec/hosts 才拉 monaco chunk（此后全站共享缓存）。
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))
import { ArrowLeft } from 'lucide-vue-next'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const props = defineProps<{
  // 可选容器全集（受管理/已纳入的），选择在对话框左栏完成——入口不依赖侧栏选择态。
  // state 用于左栏状态点与停机提示（exec/git/ssh/hosts 走 lxc-attach 停机必失败，
  // ai 是宿主直写 rootfs 不受影响）。
  containers: { id: string; label: string; ip?: string | null; state?: string | null }[]
}>()
const emit = defineEmits<{
  (e: 'done'): void
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'open-hosts'): void
}>()

// 容器勾选：默认全选（批量配置的典型场景就是「对全部来一遍」，不想要的单独取消）。
// ids 是提交用的派生视图；空选时执行按钮置灰。
const checked = ref<Set<string>>(new Set(props.containers.map((c) => c.id)))
const ids = computed(() => props.containers.filter((c) => checked.value.has(c.id)).map((c) => c.id))
const allChecked = computed(
  () => props.containers.length > 0 && props.containers.every((c) => checked.value.has(c.id)),
)
function toggleCheck(id: string) {
  const s = new Set(checked.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  checked.value = s
}
function toggleCheckAll() {
  checked.value = allChecked.value
    ? new Set()
    : new Set(props.containers.map((c) => c.id))
}

// tab / sshMode 放宽为 string，避免 reka-ui AcceptableValue 与字面量联合冲突
const tab = ref<string>('exec')
const busy = ref(false)
const err = ref('')
// 结果态：执行完成后右栏整体切走（表单/结果不混在一个滚动区里）。
// result=null 即编辑态；backToEdit 只清结果，表单内容原样保留（换 key 重推是常态）。
const result = ref<BatchResult | null>(null)
// 本次结果关联的 tab，结果标题用它说清「刚执行的是什么」
const resultOfTab = ref('')

// 停机容器提示：所选中有几个不在跑（ai tab 除外——rootfs 直写无需在跑）。
// 只提示不阻断：停机容器在后端按单容器收敛成 fail 结果，不拖垮整批。
const stoppedSelected = computed(
  () =>
    ids.value.filter(
      (id) => props.containers.find((c) => c.id === id)?.state && props.containers.find((c) => c.id === id)!.state !== 'running',
    ).length,
)
const tabNeedsRunning = computed(() => tab.value !== 'ai' && !result.value)

// 各 tab 表单
const gitName = ref('')
const gitEmail = ref('')
const sshMode = ref<string>('reseed')
const sshKey = ref('')
const execCommand = ref('')
const execTimeout = ref<number | undefined>(undefined)
// 命令框编辑器选项：无行号（短命令框省左栏），空内容显示占位提示
const execEditorOptions = {
  placeholder: 'echo "hello" > ~/note.txt',
  lineNumbers: 'off',
}
// hosts tab：预读全局已保存内容（侧车 hosts.txt），可改后对已选容器应用。
// 编辑用 Monaco（hosts 词法高亮），与全局 hosts 面板同观感；「已选容器」而非
// 「所有容器」是这里与 HostsPanel 的关键差异——HostsPanel 是全局持久视角，这是定向一次性视角。
const hostsContent = ref('')
const hostsLoaded = ref(false)

// ai tab：场景驱动的表单。用户心智模型是「我的网关是什么」而不是「每个 CLI 吃
// 什么协议」——所以第一层是网关类型单选（anthropic / openai / dual），它决定：
//   - 哪些端点框出现（非法状态不可达，而不是提交后才校验）
//   - Codex 可否勾选（它只会说 openai responses，anthropic-only 场景置灰 + 注明原因）
//   - opencode/pi 的协议多选是否露出（单协议网关没有「选协议」这回事，chips 是噪音）
// 第二层才是工具勾选与 key/模型。需求推导（谁消费哪条端点）保留上次修复的点名逻辑。
const aiAnthropicUrl = ref('')
const aiOpenaiUrl = ref('')
const aiKey = ref('')
const aiModels = ref('')
const aiSetDefault = ref(false)
// 网关场景：anthropic-only / openai-only / dual。null = 尚未选（首次进入无存档时）。
const aiGwKind = ref<'anthropic' | 'openai' | 'dual' | null>(null)
const aiTools = ref({ claude: true, codex: true, opencode: true, pi: true })
// 工具级 wire 多选。单协议场景不露选择器，wire 值由场景直接定（anthropic 场景全
// ['anthropic-messages']，openai 场景全 ['openai-chat']）；dual 才让用户挑。
// 值语义：undefined = 未选过（显示缺省）；[] = 显式清空全部变体（不写 provider）。
const aiWire = ref<{ opencode?: string[]; pi?: string[] }>({})
const aiLoaded = ref(false)
// 存档预填的脏标记：用户动过工具勾选后，迟到的存档回包不再覆盖勾选
// （早前实测踩过：勾了 opencode/pi，回包落地瞬间被存档里的 false 打回去，提交时仍是未勾）。
const aiToolsTouched = ref(false)
watch(
  () => ({ ...aiTools.value }),
  () => {
    aiToolsTouched.value = true
  },
)
// 场景切换的连带：anthropic-only 下 Codex 不可用（只会 openai responses）——
// 场景切走时自动取消其勾选，别留一个置灰又打勾的矛盾态。
watch(aiGwKind, (k) => {
  if (k === 'anthropic') aiTools.value.codex = false
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
  resetResult()
}

function resetResult() {
  result.value = null
  err.value = ''
}

async function run(fn: () => Promise<BatchResult>) {
  busy.value = true
  resetResult()
  try {
    result.value = await fn()
    resultOfTab.value = tab.value
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

function submit() {
  if (tab.value === 'exec') {
    if (!execCommand.value.trim()) {
      err.value = 'command 不能为空'
      return
    }
    const timeoutMs = execTimeout.value != null ? execTimeout.value * 1000 : undefined
    run(() => batchExec(ids.value, execCommand.value, timeoutMs))
  } else if (tab.value === 'git') {
    if (!gitName.value.trim() || !gitEmail.value.trim()) {
      err.value = '用户名和邮箱都必填'
      return
    }
    run(() => batchGit(ids.value, gitName.value.trim(), gitEmail.value.trim()))
  } else if (tab.value === 'ssh') {
    if (sshMode.value === 'append-key' && !sshKey.value.trim()) {
      err.value = '请粘贴公钥'
      return
    }
    run(() =>
      sshMode.value === 'reseed'
        ? batchSshReseed(ids.value)
        : batchSshAppendKey(ids.value, sshKey.value.trim()),
    )
  } else if (tab.value === 'ai') {
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
    run(() =>
      batchAiConfig(ids.value, {
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
      }),
    )
  } else {
    if (!hostsContent.value.trim()) {
      err.value = 'hosts 内容不能为空'
      return
    }
    // 对已选容器覆写 /etc/hosts（不保存全局——想改全局配置去 hosts 面板）
    run(() => applyHosts(hostsContent.value, ids.value))
  }
}

function onTab(v: string | number) {
  tab.value = String(v)
  resetResult()
  // hosts tab 首次进入时预读全局 hosts 内容
  if (tab.value === 'hosts' && !hostsLoaded.value) {
    hostsLoaded.value = true
    getHosts()
      .then((v) => {
        hostsContent.value = v.content
      })
      .catch(() => {
        /* 预读失败不阻塞，textarea 留空可手填 */
      })
  }
  // ai tab 首次进入时预填最近一次下发存档：场景从存档端点形状推导，URL/key/wire/
  // 模型只补空字段；工具勾选在用户没动过时恢复（动过则跳过——否则「用户先勾后填」
  // 时迟到的响应会把勾选打回去，实测踩过）。
  if (tab.value === 'ai' && !aiLoaded.value) {
    aiLoaded.value = true
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
  }
}

// 跳全局 hosts 面板：先关自己再开面板，避免两个 Dialog 叠层
function goHosts() {
  emit('close')
  emit('open-hosts')
}

// 通用命令排首位（无预设意图的高频动作）；git/ssh 是「装完配一次」类相邻；
// AI 网关是换 key/换网关的批量重推；hosts 覆写殿后并与全局面板拉开命名距离。
const tabs: { key: string; label: string }[] = [
  { key: 'exec', label: '通用命令' },
  { key: 'git', label: 'Git 身份' },
  { key: 'ssh', label: 'SSH' },
  { key: 'ai', label: 'AI 网关' },
  { key: 'hosts', label: 'hosts 覆写' },
]
const tabLabelOf = (key: string) => tabs.find((t) => t.key === key)?.label ?? key
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <!-- 宽模态左右分栏：左栏选容器（第一公民，不再挤头部一行 chip），右栏任务 tab +
         表单占满高度。执行后右栏整体切结果态，表单与结果不共一个滚动区。
         md 以下分栏放不下，左栏折叠回横向 chip 行（移动端不退化）。 -->
    <DialogContent
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
    >
      <!-- 头 -->
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="text-lg font-semibold">批量配置</DialogTitle>
        <DialogDescription class="sr-only">对所选容器批量执行配置或命令</DialogDescription>
      </div>

      <div class="flex min-h-0 flex-1 max-md:flex-col">
        <!-- 左栏：容器选择。md+ 独立列（滚动与右栏独立），max-md 折叠为横向 chip 行。 -->
        <aside
          class="flex min-h-0 shrink-0 flex-col border-r max-md:border-r-0 max-md:border-b md:w-56"
        >
          <div class="flex items-center justify-between px-3 pt-3 md:px-4">
            <span class="text-xs font-medium text-muted-foreground"
              >容器 {{ ids.length }} / {{ containers.length }}</span
            >
            <button
              type="button"
              class="text-xs text-muted-foreground transition-colors hover:text-foreground"
              @click="toggleCheckAll"
            >
              {{ allChecked ? '全不选' : '全选' }}
            </button>
          </div>
          <!-- 桌面：卡片列表（名称 + 状态点 + IP），独立滚动 -->
          <div class="scroll-thin mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 max-md:hidden md:px-4">            <!-- 两行卡片（同侧栏形态）：名称行挤不下 checkbox+点+IP，第一行放名与勾选，第二行放 IP -->
            <label
              v-for="c in containers"
              :key="c.id"
              class="flex cursor-pointer select-none flex-col gap-1 rounded-md border px-2.5 py-2 text-sm transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary/60"
            >
              <span class="flex items-center gap-2">
                <span
                  :class="['h-2 w-2 shrink-0 rounded-full', stateColor(c.state ?? '')]"
                  :title="stateLabel(c.state ?? '')"
                />
                <span class="min-w-0 flex-1 truncate font-mono" :title="c.label">{{ c.label }}</span>
                <Checkbox
                  :model-value="checked.has(c.id)"
                  @update:model-value="() => toggleCheck(c.id)"
                />
              </span>
              <span class="flex items-center justify-between pl-4 text-[11px] text-muted-foreground">
                <span class="font-mono">{{ c.ip ?? stateLabel(c.state ?? '') }}</span>
              </span>
            </label>
          </div>
          <!-- 移动端：横向流式 chip 行（沿用旧形态，窄屏放不下两栏） -->
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1.5 px-3 pb-2.5 md:hidden">
            <label
              v-for="c in containers"
              :key="c.id"
              class="flex cursor-pointer select-none items-center gap-1.5 text-sm"
            >
              <Checkbox :model-value="checked.has(c.id)" @update:model-value="() => toggleCheck(c.id)" />
              <span class="font-mono">{{ c.label }}</span>
              <span v-if="c.ip" class="font-mono text-xs text-muted-foreground">{{ c.ip }}</span>
            </label>
          </div>
        </aside>

        <!-- 结果态：右栏整体切换（表单/结果互斥，切换 tab 也回编辑态） -->
        <div v-if="result" class="flex min-h-0 flex-1 flex-col">
          <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h3 class="text-sm font-medium">
                {{ tabLabelOf(resultOfTab) }} · 执行结果
              </h3>
              <span class="text-sm text-emerald-500">成功 {{ result.ok }}</span>
              <span class="text-sm text-destructive">失败 {{ result.failed }}</span>
              <span class="text-sm text-muted-foreground">共 {{ result.total }}</span>
            </div>
            <div class="mt-3 overflow-hidden rounded-lg border">
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
                    <!-- 左栏选的是 displayName（build-box），后端 result 只带容器名（dev）——
                         用 id 映射回展示名，两栏对得上，用户才认得出哪行是哪个容器 -->
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
          </div>
          <div class="flex justify-end gap-2 border-t px-5 py-3">
            <Button variant="outline" @click="resetResult">
              <ArrowLeft class="size-3.5" /> 返回编辑
            </Button>
            <Button @click="emit('close')">完成</Button>
          </div>
        </div>

        <!-- 编辑态：任务 tab + 表单 -->
        <Tabs v-else :model-value="tab" class="flex min-h-0 flex-1 flex-col gap-0" @update:model-value="onTab">
          <!-- tab 栏：自然宽度胶囊轨道（不 grid 等分，避免窄 label 挤在一起）；
               手机上横向滚动（5 个胶囊在窄屏放不下，shrink-0 保单个胶囊不被压扁） -->
          <div class="overflow-x-auto border-b px-5 py-3 scroll-thin">
            <TabsList class="gap-1">
              <TabsTrigger
                v-for="t in tabs"
                :key="t.key"
                :value="t.key"
                class="shrink-0 px-3 text-xs"
                >{{ t.label }}</TabsTrigger
              >
            </TabsList>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin">
            <!-- 停机提示：本任务走 lxc-attach，所选里有停机容器时点名（不阻断，后端单容器收敛 fail） -->
            <div
              v-if="tabNeedsRunning && stoppedSelected"
              class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              所选容器有 {{ stoppedSelected }} 个未在运行——「{{ tabLabelOf(tab) }}」需要在跑的容器里执行，这部分会失败。
            </div>

            <!-- exec：shell 高亮编辑（Monaco 异步加载，外层定高盒防止布局跳动） -->
            <TabsContent value="exec" class="space-y-3">
              <div class="flex flex-col gap-1.5">
                <Label>命令（sh -c）</Label>
                <div class="h-48 overflow-hidden rounded-md border">
                  <CodeEditor
                    v-model="execCommand"
                    language="shell"
                    class="h-full"
                    :options="execEditorOptions"
                    @save="submit"
                  />
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Label for="b-exec-timeout" class="text-xs text-muted-foreground"
                  >超时（秒，留空=不限）</Label
                >
                <Input
                  id="b-exec-timeout"
                  v-model.number="execTimeout"
                  type="number"
                  min="1"
                  placeholder="60"
                  class="w-24 max-md:w-20"
                />
              </div>
            </TabsContent>

            <!-- git -->
            <TabsContent value="git" class="space-y-3">
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <Label for="b-git-name">git 用户名</Label>
                  <Input id="b-git-name" v-model="gitName" placeholder="dev" />
                </div>
                <div class="space-y-1.5">
                  <Label for="b-git-email">git 邮箱</Label>
                  <Input id="b-git-email" v-model="gitEmail" placeholder="dev@local" />
                </div>
              </div>
              <p class="text-xs text-muted-foreground">
                对每个容器执行 git config --global user.name/email，覆盖现有配置。
              </p>
            </TabsContent>

            <!-- ssh -->
            <TabsContent value="ssh" class="space-y-2">
              <RadioGroup v-model="sshMode" class="flex items-center gap-4">
                <div class="flex items-center gap-1.5">
                  <RadioGroupItem id="ssh-reseed" value="reseed" />
                  <Label for="ssh-reseed" class="font-normal">重新拷贝宿主 ~/.ssh</Label>
                </div>
                <div class="flex items-center gap-1.5">
                  <RadioGroupItem id="ssh-append" value="append-key" />
                  <Label for="ssh-append" class="font-normal">追加公钥</Label>
                </div>
              </RadioGroup>
              <p v-if="sshMode === 'reseed'" class="text-xs text-muted-foreground">
                清空 ~/.ssh 后从挂载的 /mnt/host/.ssh 重新拷贝（含 id_* 与 known_hosts），权限自动设为 700/600。
              </p>
              <Textarea
                v-else
                v-model="sshKey"
                rows="4"
                placeholder="ssh-ed25519 AAAA... user@host"
                class="font-mono text-xs"
              />
            </TabsContent>

            <!-- ai：场景驱动。第一层网关类型单选决定端点框显隐、Codex 可用性、
                 协议多选是否露出（非法组合不可达，而非提交后校验）；第二层工具勾选
                 + key/模型。网关端点直写各 CLI 配置文件（rootfs 直写，容器无需在跑）。 -->
            <TabsContent value="ai" class="space-y-4">
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

              <!-- 工具勾选：Codex 在 anthropic-only 场景置灰（它只会 openai responses）。
                   协议多选只在 dual 场景露出——单协议网关没有「选协议」这回事。 -->
              <div v-if="aiGwKind" class="space-y-2 rounded-md border p-3">
                <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <label class="flex w-32 items-center gap-1.5 text-sm max-md:w-24" :class="aiGwKind === 'openai' ? 'opacity-50' : ''">
                    <Checkbox
                      id="ai-claude"
                      :model-value="aiTools.claude"
                      :disabled="aiGwKind === 'openai'"
                      @update:model-value="(v) => (aiTools.claude = !!v)"
                    />
                    Claude Code
                  </label>
                  <span class="text-[11px] text-muted-foreground">anthropic 协议（固定）</span>
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
            </TabsContent>

            <!-- hosts：对已选容器一次性覆写 /etc/hosts（区别于全局 hosts 面板） -->
            <TabsContent value="hosts" class="space-y-3">
              <div class="flex flex-col gap-1.5">
                <Label>hosts 内容（一次性覆写所选容器）</Label>
                <div class="h-64 overflow-hidden rounded-md border">
                  <CodeEditor
                    v-model="hostsContent"
                    language="hosts"
                    class="h-full"
                    @save="submit"
                  />
                </div>
              </div>
              <div
                class="rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                已预填全局 hosts 配置（可修改，仅本次应用、不保存全局）。以 root 覆写这
                {{ ids.length }} 个容器的 /etc/hosts，一次性生效（容器重启后恢复全局配置——全局配置会自动追上）。
                <Button
                  variant="link"
                  size="xs"
                  class="h-auto p-0 align-baseline text-[11px]"
                  @click="goHosts"
                  >想统一保存、让新建容器也生效？打开全局 hosts 配置</Button
                >
              </div>
            </TabsContent>

            <p v-if="err" class="mt-3 text-sm text-destructive">{{ err }}</p>
          </div>

          <!-- 底部按钮 -->
          <div class="flex justify-end gap-2 border-t px-5 py-3">
            <Button variant="outline" @click="emit('close')">关闭</Button>
            <Button :disabled="busy || !ids.length" @click="submit"
              >{{ busy ? '执行中…' : `执行（对 ${ids.length} 个容器）` }}</Button
            >
          </div>
        </Tabs>
      </div>
    </DialogContent>
  </Dialog>
</template>
