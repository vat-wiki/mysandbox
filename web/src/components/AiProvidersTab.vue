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
  Unauthorized,
  type AiProvider,
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
const draft = ref<null | {
  id?: string
  wantId: string
  name: string
  anthropicUrl: string
  openaiUrl: string
  apiKey: string
  models: string
}>(null)
const probeRes = ref<{ openai?: string; anthropic?: string } | null>(null)
const fetchNote = ref('')

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
  draft.value = { wantId: '', name: '', anthropicUrl: '', openaiUrl: '', apiKey: '', models: '' }
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
    apiKey: p.apiKey,
    models: (p.models ?? []).join(', '),
  }
  probeRes.value = null
  fetchNote.value = ''
  err.value = ''
}

const draftEndpoints = computed(() => ({
  ...(draft.value?.openaiUrl.trim() ? { openai: { baseUrl: draft.value.openaiUrl.trim() } } : {}),
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
    if (r.models.length) draft.value.models = r.models.join(', ')
    fetchNote.value = [
      r.models.length ? `拉到 ${r.models.length} 个模型` : '网关没返回模型',
      ...r.errors,
    ].join('；')
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
  if (!d.openaiUrl.trim() && !d.anthropicUrl.trim()) {
    err.value = '至少填一个端点（OpenAI 兼容 / Anthropic 兼容）'
    return
  }
  if (!d.apiKey.trim()) {
    err.value = 'API Key 必填'
    return
  }
  busy.value = true
  err.value = ''
  try {
    const { provider } = await upsertAiProvider({
      ...(d.id ? { id: d.id } : { wantId: d.wantId.trim() }),
      name: d.name.trim(),
      endpoints: draftEndpoints.value,
      apiKey: d.apiKey.trim(),
      models: d.models.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
    })
    toast(`已保存模型服务：${provider.name}（${provider.id}）`)
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
    <!-- 模型服务（provider 库）：薄行常驻，表单内联展开。板块外框与技能中心/
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
            <Input id="ai-p-openai" v-model="draft.openaiUrl" placeholder="http://…/openai/v1（codex/opencode/pi 用）" />
          </div>
        </div>
        <div class="space-y-1.5">
          <Label for="ai-p-key">API Key</Label>
          <Input id="ai-p-key" v-model="draft.apiKey" type="password" placeholder="sk-…" />
        </div>
        <div class="space-y-1.5">
          <div class="flex items-center justify-between">
            <Label for="ai-p-models">模型 ID（逗号分隔；opencode/pi 的变体下挂）</Label>
            <Button variant="outline" size="xs" :disabled="busy" @click="doFetchModels">
              <CloudDownload class="size-3.5" /> 从网关拉取
            </Button>
          </div>
          <Input id="ai-p-models" v-model="draft.models" placeholder="claude-sonnet-4-5, gpt-5" />
          <p v-if="fetchNote" class="text-[11px] text-muted-foreground">{{ fetchNote }}</p>
        </div>
        <div v-if="probeRes" class="space-y-0.5 rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed">
          <p v-if="probeRes.anthropic">{{ probeRes.anthropic }}</p>
          <p v-if="probeRes.openai">{{ probeRes.openai }}</p>
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
          还没有模型服务——点「添加」把网关的端点与 key 存进来。
          <template v-if="!draft">旧版单网关档已自动迁移为 <code class="font-mono">myapikey</code> 条目（重启过服务即有），直接编辑改 key。</template>
        </p>
        <div v-else class="space-y-1.5">
          <div v-for="p in providers" :key="p.id" class="rounded-md border px-3 py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-medium">{{ p.name }}</span>
              <Badge variant="outline" class="px-1.5 font-mono text-[10px] text-muted-foreground">{{ p.id }}</Badge>
              <Badge v-if="p.endpoints.anthropic" variant="outline" class="px-1.5 text-[10px]">anthropic</Badge>
              <Badge v-if="p.endpoints.openai" variant="outline" class="px-1.5 text-[10px]">openai</Badge>
              <Badge v-if="p.models?.length" variant="outline" class="px-1.5 text-[10px] text-muted-foreground">{{ p.models.length }} 模型</Badge>
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
                <p>key: {{ p.apiKey.slice(0, 6) }}…{{ p.apiKey.slice(-4) }}<span v-if="p.models?.length"> · 模型: {{ p.models.join(', ') }}</span></p>
              </div>
            </details>
          </div>
        </div>
      </div>
    </section>

    <ConfirmDialog
      v-if="delProvider"
      title="删除模型服务"
      :description="`删除「${delProvider.name}」？本机与全部容器里的接入条目一并回收（claude 的 env 注入除外）。`"
      confirm-text="删除"
      variant="destructive"
      @confirm="doRemoveProvider"
      @close="delProvider = null"
    />
  </div>
</template>
