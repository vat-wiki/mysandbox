<script setup lang="ts">
// Claude Code 工具自身配置（toolConfig，全局一份）：绑定之外的 CLI 特殊配置——
// 默认模型（写入 ANTHROPIC_MODEL）+ 自定义 env 键值对。双形态一个真相：
//   常用项表单  = 模型 Input + env 键值对行（rows 是唯一真相，行编辑直接改）
//   Monaco 原文 = 同一份 env 对象的 JSON 原文（rows ⇄ raw 双向同步，Ctrl+S = 保存）
// 保存走 saveAiToolConfig（PUT /api/ai/tool-config），下发结果用 AiBindingResult 展示。
// 保留键（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN）后端 400 拒绝——由模型服务绑定管。
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import { saveAiToolConfig, Unauthorized, type AiClaudeToolConfig, type BatchResult } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Plus, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import AiBindingResult from './AiBindingResult.vue'
import InfoHint from './InfoHint.vue'

const props = defineProps<{
  // 父级传入的当前配置（view.toolConfig.claude，可能是异步到达的初值）。
  tc?: AiClaudeToolConfig
}>()
const emit = defineEmits<{
  (e: 'saved'): void
  (e: 'unauthorized'): void
}>()

// Monaco 壳懒加载（monaco 本体是共享 chunk，多入口不重复下载——见 CodeEditor.vue 头注）。
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))

// —— 真相：模型 + env 行列表（{key,value}；空 key 行 = 未填，保存时过滤）——
interface EnvRow {
  key: string
  value: string
}
const model = ref('')
const rows = ref<EnvRow[]>([])
const busy = ref(false)
const err = ref('')
const result = ref<BatchResult | null>(null)
// 用户动过表单后不再用 prop 初值回灌（父级 view 刷新不冲掉编辑中的草稿）。
const dirty = ref(false)

let initializing = false
function initFrom(tc: AiClaudeToolConfig | undefined) {
  initializing = true
  model.value = tc?.model ?? ''
  rows.value = Object.entries(tc?.env ?? {}).map(([key, value]) => ({ key, value }))
  if (!rows.value.length) rows.value = [{ key: '', value: '' }]
  initializing = false
}
watch(
  () => props.tc,
  (tc) => {
    if (!dirty.value) initFrom(tc)
  },
  { immediate: true },
)
// 行编辑（v-model 直改行对象）与模型输入 = 用户动过草稿。
watch(
  rows,
  () => {
    if (!initializing) dirty.value = true
  },
  { deep: true },
)
watch(model, () => {
  if (!initializing) dirty.value = true
})

function addRow() {
  rows.value.push({ key: '', value: '' })
}
function removeRow(i: number) {
  rows.value.splice(i, 1)
  if (!rows.value.length) rows.value = [{ key: '', value: '' }]
}

// rows → env 对象（空 key 行过滤；同名键后者赢——与对象字面量语义一致）。
const envOut = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const r of rows.value) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
})

// —— Monaco 原文（env 对象的 JSON；rows ⇄ raw 双向同步）——
const raw = ref('')
const parseErr = ref('')
// 注意：Vue 的 watch 回调是异步冲刷的，同步旗标拦不住自己的回灌（回调跑时旗标已复位）
// ——改用「解析结果与当前表单等价 = 只是回显」判定：回显不动 dirty、不重建行。
watch(
  envOut,
  (env) => {
    const s = JSON.stringify(env, null, 2)
    if (s !== raw.value) raw.value = s
  },
  { immediate: true },
)
watch(raw, (s) => {
  let v: unknown
  try {
    v = JSON.parse(s || '{}')
  } catch {
    parseErr.value = '不是合法 JSON，暂不套用（改对后自动套用，原文不丢）'
    return
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    parseErr.value = '顶层必须是 JSON 对象，暂不套用'
    return
  }
  if (Object.values(v as Record<string, unknown>).some((x) => typeof x !== 'string')) {
    parseErr.value = '所有值必须是字符串，暂不套用'
    return
  }
  parseErr.value = ''
  if (JSON.stringify(v) === JSON.stringify(envOut.value)) return // 只是回显
  dirty.value = true
  rows.value = Object.keys(v as Record<string, string>).length
    ? Object.entries(v as Record<string, string>).map(([key, value]) => ({ key, value }))
    : [{ key: '', value: '' }]
})

const RESERVED = 'ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN'
const keyClash = computed(() =>
  rows.value.some((r) => r.key.trim() === 'ANTHROPIC_BASE_URL' || r.key.trim() === 'ANTHROPIC_AUTH_TOKEN'),
)

async function save() {
  if (busy.value || parseErr.value || keyClash.value) return
  busy.value = true
  result.value = null
  err.value = ''
  try {
    result.value = await saveAiToolConfig({
      claude: {
        ...(model.value.trim() ? { model: model.value.trim() } : {}),
        ...(Object.keys(envOut.value).length ? { env: envOut.value } : {}),
      },
    })
    toast('Claude Code 自身配置已保存并下发')
    emit('saved')
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
  <div class="space-y-3 border-t pt-3">
    <div class="flex items-center gap-2">
      <Badge variant="outline" class="px-1.5 text-[10px] text-muted-foreground">自身配置</Badge>
      <span class="min-w-0 flex-1 text-[11px] text-muted-foreground">默认模型 + 自定义 env，全局一份，随 claude 绑定一起追平到各容器</span>
      <InfoHint label="自身配置说明">
        <p>「自身配置」是 Claude Code 绑定之外的特殊配置：默认模型写入 ANTHROPIC_MODEL，自定义 env 键值对原样进 settings.json 的 env 块。</p>
        <p>只保存全局一份，不进绑定四层（本机/容器覆盖/项目规则都不带它）；落点跟着 claude 绑定走——未绑 claude 的目标不写。</p>
        <p>{{ RESERVED }} 由模型服务绑定管，这里写了会被拒。</p>
      </InfoHint>
    </div>

    <AiBindingResult v-if="result" :result="result" @back="result = null" />
    <template v-else>
      <!-- 常用项：默认模型 -->
      <div class="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div class="space-y-1.5">
          <Label for="ai-claude-model">默认模型</Label>
          <Input
            id="ai-claude-model"
            v-model="model"
            placeholder="claude-sonnet-4-5"
            class="font-mono"
          />
        </div>
        <span class="pb-1.5 text-[11px] text-muted-foreground">写入 ANTHROPIC_MODEL（留空 = 不设）</span>
      </div>

      <!-- 常用项：env 键值对行 -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <Label>自定义 env</Label>
          <Button variant="outline" size="xs" @click="addRow"><Plus class="size-3.5" /> 添加键值对</Button>
        </div>
        <div v-for="(r, i) in rows" :key="i" class="flex items-center gap-2">
          <Input
            v-model="r.key"
            placeholder="键（如 CLAUDE_CODE_MAX_OUTPUT_TOKENS）"
            class="h-8 flex-1 font-mono text-xs"
          />
          <Input
            v-model="r.value"
            placeholder="值"
            class="h-8 flex-[2] font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground/60 hover:text-destructive"
            title="删除该键值对"
            @click="removeRow(i)"
          >
            <Trash2 class="size-3.5" />
          </Button>
        </div>
        <p v-if="keyClash" class="text-[11px] text-destructive">
          {{ RESERVED }} 由模型服务绑定管——删掉再保存（后端会拒绝）。
        </p>
      </div>

      <!-- Monaco 原文：同一份 env 对象的 JSON（Ctrl+S = 保存；改对自动套用回表单） -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <Label>env 原文（JSON）</Label>
          <span class="text-[10px] text-muted-foreground/70">Ctrl+S 保存 · 改对自动套用回表单</span>
        </div>
        <CodeEditor
          v-model="raw"
          language="json"
          class="h-40 overflow-hidden rounded-md border"
        />
        <p v-if="parseErr" class="text-[11px] text-amber-600 dark:text-amber-400">{{ parseErr }}</p>
      </div>

      <p v-if="err" class="text-sm text-destructive">{{ err }}</p>

      <div class="flex items-center justify-end gap-2">
        <span class="mr-auto text-[11px] text-muted-foreground/70">
          保存即刻下发到已绑 claude 的容器；新建容器随补发自动带上。
        </span>
        <Button size="xs" :disabled="busy || !!parseErr || keyClash" @click="save">{{
          busy ? '保存中…' : '保存并下发'
        }}</Button>
      </div>
    </template>
  </div>
</template>
