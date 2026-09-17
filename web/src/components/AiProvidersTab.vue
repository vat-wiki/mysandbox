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

async function doFetchModels() {
  if (!draft.value) return
  busy.value = true
  fetchNote.value = ''
  try {
    const r = await fetchAiModels(draftEndpoints.value, draft.value.apiKey.trim())
    // openai 侧结果只预填 chat；responses 端点单独配了才拉它的 /models 预填
    // responses（同址回落 openai 时拉了也是同一份，不预填、手填）；anthropic 侧
    // 结果预填 anthropic。
    if (r.openai?.length) draft.value.chatModels = r.openai.join(', ')
    if (r.responses?.length) draft.value.responsesModels = r.responses.join(', ')
    if (r.anthropic?.length) draft.value.anthropicModels = r.anthropic.join(', ')
    fetchNote.value = [
      r.openai?.length ? `chat 预填 ${r.openai.length} 个` : 'openai 侧没返回模型',
      ...(draft.value.responsesUrl.trim()
        ? [r.responses?.length ? `responses 预填 ${r.responses.length} 个` : 'responses 侧没返回模型']
        : draft.value.openaiUrl.trim()
          ? ['responses 不预填（未单独配端点，同址 /models 区分不了，按实际支持手填）']
          : []),
      r.anthropic?.length ? `anthropic 预填 ${r.anthropic.length} 个` : '',
      ...r.errors,
    ].filter(Boolean).join('；')
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

        <!-- 编辑/新建表单（内联展开） -->
        <div v-if="draft" class="space-y-3 rounded-md border p-3">
        <div class="grid gap-3 sm:grid-cols-2">
          <div v-if="!draft.id" class="space-y-1.5">
            <Label for="ai-p-id">ID（配置里的 provider 名）</Label>
            <Input id="ai-p-id" v-model="draft.wantId" placeholder="myapikey" class="font-mono" />
          </div>
          <div class="space-y-1.5">
            <Label for="ai-p-name">显示名</Label>
            <Input id="ai-p-name" v-model="draft.name" placeholder="myapikey 中转" />
          </div>
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="ai-p-anthropic">Anthropic 兼容 Base URL</Label>
            <Input id="ai-p-anthropic" v-model="draft.anthropicUrl" placeholder="http://…/anthropic（claude 用，不含 /v1）" />
          </div>
          <div class="space-y-1.5">
            <Label for="ai-p-openai">OpenAI 兼容 Base URL</Label>
            <Input id="ai-p-openai" v-model="draft.openaiUrl" placeholder="http://…/openai/v1（opencode/pi 的 chat 变体用）" />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <Label for="ai-p-responses">
              OpenAI responses 兼容 Base URL
              <span class="text-[11px] font-normal text-muted-foreground">（缺省 = 上面的 OpenAI 端点同址；两协议不同址才单独填，codex 也走它）</span>
            </Label>
            <Input id="ai-p-responses" v-model="draft.responsesUrl" placeholder="http://…/openai/v1" />
          </div>
        </div>
        <div class="space-y-1.5">
          <Label for="ai-p-key">API Key</Label>
          <Input id="ai-p-key" v-model="draft.apiKey" type="password" placeholder="sk-…" />
        </div>
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <Label>模型清单（按协议各一份，逗号分隔；opencode/pi 的对应变体下挂）</Label>
            <Button variant="outline" size="xs" :disabled="busy" @click="doFetchModels">
              <CloudDownload class="size-3.5" /> 从网关拉取
            </Button>
          </div>
          <div v-if="draft.openaiUrl.trim() || draft.responsesUrl.trim()" class="grid gap-3 sm:grid-cols-2">
            <div v-if="draft.openaiUrl.trim()" class="space-y-1">
              <Label for="ai-p-models-chat" class="text-[11px] text-muted-foreground">chat 协议</Label>
              <Input id="ai-p-models-chat" v-model="draft.chatModels" placeholder="gpt-5, deepseek-chat" />
            </div>
            <div v-if="draft.openaiUrl.trim() || draft.responsesUrl.trim()" class="space-y-1">
              <Label for="ai-p-models-responses" class="text-[11px] text-muted-foreground">
                responses 协议{{ draft.responsesUrl.trim() ? '' : '（端点同址区分不了，按实际支持手填）' }}
              </Label>
              <Input id="ai-p-models-responses" v-model="draft.responsesModels" placeholder="gpt-5, …" />
            </div>
          </div>
          <div v-if="draft.anthropicUrl.trim()" class="space-y-1">
            <Label for="ai-p-models-anthropic" class="text-[11px] text-muted-foreground">anthropic 协议</Label>
            <Input id="ai-p-models-anthropic" v-model="draft.anthropicModels" placeholder="claude-sonnet-4-5" />
          </div>
          <p v-if="fetchNote" class="text-[11px] text-muted-foreground">{{ fetchNote }}</p>
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
