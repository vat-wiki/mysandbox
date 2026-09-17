<script setup lang="ts">
// 模型供应商页签（AI 工作区三板块之二）：接入凭据与端点的库——薄行常驻，
// 添加/编辑表单内联展开。从这里拆出（原「模型接入」页签的上半段）：provider 库
// 独立成板块，工具绑定挪去「Agent 工具」页签。myapikey 是旧版单网关档的一次性
// 迁移产物（LEGACY_PROVIDER_ID，id 落各工具配置当 provider 名），空态点名。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  upsertAiProvider,
  deleteAiProvider,
  probeAiProvider,
  fetchAiModels,
  wireModels,
  Unauthorized,
  type AiProvider,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ChevronDown, CloudDownload, KeyRound, Pencil, Plus, Radar, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import ConfirmDialog from './ConfirmDialog.vue'

const emit = defineEmits<{
  (e: 'done'): void
  (e: 'unauthorized'): void
}>()

const providers = ref<AiProvider[]>([])
const busy = ref(false)
const err = ref('')

// 编辑草稿：null = 列表态。draft.id 存在 = 更新，wantId 仅新建时收。
// 模型清单按协议各一份（chat/responses/anthropic 各一串逗号分隔）——OpenAI 兼容
// 网关同一条 /models 下两套协议实际可用的模型不同，单一共享清单会失真。
const draft = ref<null | {
  id?: string
  wantId: string
  name: string
  anthropicUrl: string
  openaiUrl: string
  responsesUrl: string
  apiKey: string
  chatModels: string
  responsesModels: string
  anthropicModels: string
}>(null)
const probeRes = ref<{ openai?: string; responses?: string; anthropic?: string } | null>(null)
const fetchNote = ref('')

const WIRES: { wire: GatewayWire; label: string }[] = [
  { wire: 'openai-chat', label: 'chat' },
  { wire: 'openai-responses', label: 'responses' },
  { wire: 'anthropic-messages', label: 'anthropic' },
]
const totalModels = (p: AiProvider) => new Set(WIRES.flatMap(({ wire }) => wireModels(p, wire))).size

async function load() {
  try {
    providers.value = (await getAiView()).providers
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}
onMounted(load)

function startAdd() {
  draft.value = { wantId: '', name: '', anthropicUrl: '', openaiUrl: '', responsesUrl: '', apiKey: '', chatModels: '', responsesModels: '', anthropicModels: '' }
  probeRes.value = null
  fetchNote.value = ''
  err.value = ''
}
function startEdit(p: AiProvider) {
  draft.value = {
    id: p.id,
    wantId: p.id,
    name: p.name,
    anthropicUrl: p.endpoints.anthropic?.baseUrl ?? '',
    openaiUrl: p.endpoints.openai?.baseUrl ?? '',
    responsesUrl: p.endpoints.responses?.baseUrl ?? '',
    apiKey: p.apiKey,
    chatModels: wireModels(p, 'openai-chat').join(', '),
    responsesModels: wireModels(p, 'openai-responses').join(', '),
    anthropicModels: wireModels(p, 'anthropic-messages').join(', '),
  }
  probeRes.value = null
  fetchNote.value = ''
  err.value = ''
}

const draftEndpoints = computed(() => ({
  ...(draft.value?.openaiUrl.trim() ? { openai: { baseUrl: draft.value.openaiUrl.trim() } } : {}),
  ...(draft.value?.responsesUrl.trim() ? { responses: { baseUrl: draft.value.responsesUrl.trim() } } : {}),
  ...(draft.value?.anthropicUrl.trim() ? { anthropic: { baseUrl: draft.value.anthropicUrl.trim() } } : {}),
}))

async function doProbe() {
  if (!draft.value) return
  busy.value = true
  probeRes.value = null
  try {
    probeRes.value = await probeAiProvider(draftEndpoints.value)
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

// 按协议行拉取（每行一个小拉取按钮，从该行端点拉 /models 预填该行清单——覆盖
// 式，但作用域只有这一行，可预期）。responses 行未单独配端点时按钮禁用（同址
// 回落 openai，拉了也是 chat 那份，没有区分意义）。
const MODEL_ROWS = [
  {
    side: 'anthropic',
    label: 'anthropic',
    title: 'anthropic',
    urlKey: 'anthropicUrl',
    modelKey: 'anthropicModels',
    urlPh: 'http://…/anthropic（claude 用，不含 /v1）',
    modelsPh: '模型清单，如 claude-sonnet-4-5',
    fetchTitle: '从该端点拉取模型清单（覆盖式预填本行）',
  },
  {
    side: 'openai',
    label: 'chat',
    title: 'openai · chat',
    urlKey: 'openaiUrl',
    modelKey: 'chatModels',
    urlPh: 'http://…/openai/v1（opencode/pi 的 chat 变体用）',
    modelsPh: '模型清单，如 gpt-5, deepseek-chat',
    fetchTitle: '从该端点拉取模型清单（覆盖式预填本行）',
  },
  {
    side: 'responses',
    label: 'responses',
    title: 'openai · responses',
    urlKey: 'responsesUrl',
    modelKey: 'responsesModels',
    urlPh: '缺省 = chat 同址；两协议不同址才单独填（codex 也走它）',
    modelsPh: '模型清单（部分模型不支持 responses，按实际支持填）',
    fetchTitle: '从 responses 端点拉取；未单独配端点时不可用（同址回落 chat，拉了没有区分意义）',
  },
] as const
type ModelRow = (typeof MODEL_ROWS)[number]

async function fetchRow(row: ModelRow) {
  if (!draft.value) return
  const url = draft.value[row.urlKey].trim()
  if (!url) return
  busy.value = true
  fetchNote.value = ''
  try {
    const r = await fetchAiModels({ [row.side]: { baseUrl: url } } as AiProvider['endpoints'], draft.value.apiKey.trim())
    const list = row.side === 'anthropic' ? r.anthropic : row.side === 'openai' ? r.openai : r.responses
    if (list?.length) {
      draft.value[row.modelKey] = list.join(', ')
      fetchNote.value = `${row.label} 预填 ${list.length} 个（覆盖原输入）`
    } else {
      fetchNote.value = `${row.label}：网关没返回模型${r.errors.length ? `；${r.errors.join('；')}` : ''}`
    }
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

async function save() {
  if (!draft.value) return
  const d = draft.value
  if (!d.name.trim()) {
    err.value = '显示名必填'
    return
  }
  if (!d.id && !/^[a-z][a-z0-9-]{0,31}$/.test(d.wantId.trim())) {
    err.value = 'ID 必填：小写字母开头，小写字母/数字/短横线，≤32 位（会被用作各工具配置里的 provider 名）'
    return
  }
  if (!d.openaiUrl.trim() && !d.responsesUrl.trim() && !d.anthropicUrl.trim()) {
    err.value = '至少填一个端点（OpenAI 兼容 / OpenAI responses 兼容 / Anthropic 兼容）'
    return
  }
  if (!d.apiKey.trim()) {
    err.value = 'API Key 必填'
    return
  }
  busy.value = true
  err.value = ''
  try {
    // 组装 per-wire 清单（空串的 wire 不带键）；后端收到 models 键即整体替换，
    // 清空某协议输入框 = 清掉该协议清单。
    const models: AiProvider['models'] = {}
    const put = (wire: GatewayWire, s: string) => {
      const l = s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean)
      if (l.length) models[wire] = l
    }
    put('openai-chat', d.chatModels)
    put('openai-responses', d.responsesModels)
    put('anthropic-messages', d.anthropicModels)
    const { provider } = await upsertAiProvider({
      ...(d.id ? { id: d.id } : { wantId: d.wantId.trim() }),
      name: d.name.trim(),
      endpoints: draftEndpoints.value,
      apiKey: d.apiKey.trim(),
      models,
    })
    toast(`已保存模型供应商：${provider.name}（${provider.id}）`)
    draft.value = null
    await load()
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

// 删除走 ConfirmDialog（项目标准确认件）：目标挂 ref，确认才执行。
const delProvider = ref<AiProvider | null>(null)
async function doRemoveProvider() {
  const p = delProvider.value
  if (!p) return
  delProvider.value = null
  busy.value = true
  try {
    await deleteAiProvider(p.id)
    toast(`已删除：${p.id}`)
    await load()
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
  <div class="flex flex-col gap-3">
    <!-- 模型供应商（provider 库）：薄行常驻，表单内联展开。板块外框与技能中心/
         Agent 工具同款（rounded-md border + muted 头部条）——三页签统一板块语言 -->
    <section class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <KeyRound class="size-3.5 shrink-0 text-muted-foreground" />
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ providers.length }}
        </Badge>
        <span class="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/70">接入凭据与端点的库，分配给「Agent 工具」里的各 CLI</span>
        <Button v-if="!draft" variant="ghost" size="xs" class="h-6 shrink-0 gap-1 px-1.5 text-[11px]" :disabled="busy" @click="startAdd">
          <Plus class="size-3.5" /> 添加
        </Button>
      </div>

      <div class="space-y-2 p-3">
        <p v-if="err" class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{{ err }}</p>

        <!-- 编辑/新建表单（内联展开）：基础信息（显示名/ID/Key）+ 协议接入分区
             （每协议一行 = 端点 URL + 模型清单 + 行内拉取，三协议同构） -->
        <div v-if="draft" class="space-y-3 rounded-md border p-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <div v-if="!draft.id" class="space-y-1.5">
            <Label for="ai-p-id">ID（配置里的 provider 名）</Label>
            <Input id="ai-p-id" v-model="draft.wantId" placeholder="myapikey" class="font-mono" />
          </div>
          <div class="space-y-1.5" :class="draft.id ? 'sm:col-span-2' : ''">
            <Label for="ai-p-name">显示名</Label>
            <Input id="ai-p-name" v-model="draft.name" placeholder="myapikey 中转" />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <Label for="ai-p-key">API Key</Label>
            <Input id="ai-p-key" v-model="draft.apiKey" type="password" placeholder="sk-…" />
          </div>
        </div>
        <div class="space-y-2.5 rounded-md border bg-muted/20 p-2.5">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-[11px] font-medium text-muted-foreground">协议接入</span>
            <span class="text-[10px] text-muted-foreground/70">URL 留空 = 不启用该协议；模型清单逗号分隔</span>
          </div>
          <div v-for="row in MODEL_ROWS" :key="row.side" class="space-y-1">
            <div class="grid items-center gap-2 sm:grid-cols-[8rem_1fr_auto]">
              <Label :for="`ai-p-${row.side}`" class="text-[11px] text-muted-foreground">{{ row.title }}</Label>
              <Input :id="`ai-p-${row.side}`" v-model="draft[row.urlKey]" :placeholder="row.urlPh" class="text-xs" />
              <Button
                variant="ghost"
                size="icon-xs"
                :title="row.fetchTitle"
                :disabled="busy || !draft[row.urlKey].trim()"
                @click="fetchRow(row)"
              ><CloudDownload class="size-3.5" /></Button>
            </div>
            <div class="grid gap-2 sm:grid-cols-[8rem_1fr]">
              <span />
              <Input v-model="draft[row.modelKey]" :placeholder="row.modelsPh" class="text-xs" />
            </div>
          </div>
          <p v-if="fetchNote" class="text-[10px] text-muted-foreground">{{ fetchNote }}</p>
        </div>
        <div v-if="probeRes" class="space-y-0.5 rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
          <p v-if="probeRes.anthropic">{{ probeRes.anthropic }}</p>
          <p v-if="probeRes.openai">{{ probeRes.openai }}</p>
          <p v-if="probeRes.responses">{{ probeRes.responses }}</p>
        </div>
        <div class="flex items-center justify-between">
          <Button variant="outline" size="xs" :disabled="busy" @click="doProbe"><Radar class="size-3.5" /> 探测连通</Button>
          <div class="flex gap-2">
            <Button variant="outline" size="xs" :disabled="busy" @click="draft = null">取消</Button>
            <Button size="xs" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存' }}</Button>
          </div>
        </div>
      </div>

        <!-- 库列表（常驻） -->
        <p v-if="!providers.length && !draft" class="rounded-md border border-dashed px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          还没有模型供应商——点「添加」把网关的端点与 key 存进来。
          <template v-if="!draft">旧版单网关档已自动迁移为 <code class="font-mono">myapikey</code> 条目（重启过服务即有），直接编辑改 key。</template>
        </p>
        <div v-else class="space-y-1.5">
          <div v-for="p in providers" :key="p.id" class="rounded-md border px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">{{ p.name }}</span>
              <Badge variant="outline" class="px-1.5 font-mono text-[10px] text-muted-foreground">{{ p.id }}</Badge>
              <Badge v-if="p.endpoints.anthropic" variant="outline" class="px-1.5 text-[10px]">anthropic</Badge>
              <Badge v-if="p.endpoints.openai" variant="outline" class="px-1.5 text-[10px]">openai</Badge>
              <Badge v-if="p.endpoints.responses" variant="outline" class="px-1.5 text-[10px]">responses</Badge>
              <Badge v-if="totalModels(p)" variant="outline" class="px-1.5 text-[10px] text-muted-foreground">
                {{ WIRES.filter(({ wire }) => wireModels(p, wire).length).map(({ label, wire }) => `${label} ${wireModels(p, wire).length}`).join(' · ') }}
              </Badge>
              <div class="ml-auto flex gap-1">
                <Button variant="ghost" size="icon-xs" title="编辑" @click="startEdit(p)"><Pencil class="size-3.5" /></Button>
                <Button variant="ghost" size="icon-xs" class="text-destructive" title="删除（回收全部落盘条目）" @click="delProvider = p">
                  <Trash2 class="size-3.5" />
                </Button>
              </div>
            </div>
            <details class="group mt-1">
              <summary class="flex cursor-pointer select-none list-none items-center gap-1 text-[11px] text-muted-foreground marker:hidden">
                <ChevronDown class="size-3 transition-transform group-open:rotate-180" />
                端点与凭据
              </summary>
              <div class="mt-1 space-y-0.5 pl-4 font-mono text-[11px] text-muted-foreground">
                <p v-if="p.endpoints.anthropic">anthropic: {{ p.endpoints.anthropic.baseUrl }}</p>
                <p v-if="p.endpoints.openai">openai:&nbsp;&nbsp;&nbsp;{{ p.endpoints.openai.baseUrl }}</p>
                <p v-if="p.endpoints.responses">responses: {{ p.endpoints.responses.baseUrl }}</p>
                <p>key: {{ p.apiKey.slice(0, 6) }}…{{ p.apiKey.slice(-4) }}</p>
                <p v-for="{ wire, label } in WIRES" v-show="wireModels(p, wire).length" :key="wire">
                  {{ label }}:&nbsp;&nbsp;{{ wireModels(p, wire).join(', ') }}
                </p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>

    <ConfirmDialog
      v-if="delProvider"
      title="删除模型供应商"
      :description="`删除「${delProvider.name}」？本机与全部容器里的接入条目一并回收（claude 的 env 注入除外）。`"
      confirm-text="删除"
      variant="destructive"
      @confirm="doRemoveProvider"
      @close="delProvider = null"
    />
  </div>
</template>
