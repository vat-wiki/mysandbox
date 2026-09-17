<script setup lang="ts">
// Claude Code 工具自身配置表单（toolConfig，全局一份）：绑定之外的 CLI 特殊配置。
// 常用项直接给表单字段（存储仍是同一个 toolConfig 对象，常用项只是预设键的视图）：
//   默认模型   = env.ANTHROPIC_MODEL（常驻）
//   开关       = env.PRESET_TOGGLES（非必要流量/自动更新/自动压缩，勾选 = '1'，常驻）
//   小模型/压缩窗口 = env.RESIDENT_PRESET_INPUTS（高频预设，常驻）
//   思考力度   = effortLevel（low/medium/high，常驻）
//   默认模式   = permissions.defaultMode（常驻 Select，落顶级 permissions 块）
//   开关       = SET_PRESET_TOGGLES（跳过危险模式确认/自动记忆，常驻，与 env 开关同排）
//   输出上限等 = env.PRESET_INPUTS（最大输出/思考预算/超时/子代理，进折叠区）
//   自定义 env = env.rows 键值对（只放非预设键，避免与常用项重复编辑）
//   顶级设置   = settings（settings.json 顶级键——effortLevel 等非 env 配置）：
//     开关       = SET_PRESET_TOGGLES（布尔：跳过危险模式确认/自动记忆）
//     自定义键   = setRows 键值对（值按 JSON 解析：true/false/数字/引号字符串）
// 渐进式披露：高频项常驻，低频项收进「高级配置」折叠区（已填项数给徽标）；
// settings.json 预览/原文（Monaco）是落盘全貌的确认口，恒常驻不折叠。
// envOut + settingsOut 是唯一出口；Monaco 原文 = 整份 settings.json 形状
//（{…顶级键, env: {…}}）：实时预览（随表单与所选模型服务即时更新）+ 高级编辑
//（改对自动套用回表单，env 块与非 env 顶级键各回各的表单区）。
// 本组件是纯表单：不持有保存按钮——保存由页签统一走 POST /api/ai/claude-config
// （绑定 + 自身配置一次提交），父级经 defineExpose 拿校验状态与 toolConfig 输出。
// 配置持久化在服务端 ai-config.json（0600），下次进入回显。
// 保留键（ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN；settings 里的 env）后端 400 拒绝。
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import type { AiClaudeToolConfig } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Plus, Trash2, ChevronDown } from 'lucide-vue-next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import InfoHint from './InfoHint.vue'

const props = defineProps<{
  // 父级传入的当前配置（view.toolConfig.claude，可能是异步到达的初值）。
  tc?: AiClaudeToolConfig
  // 绑定注入的受管键（ANTHROPIC_BASE_URL/AUTH_TOKEN，来自当前选中的 provider）——
  // 预览要展示落盘全貌就得带上；Monaco 里改它们恒被绑定覆盖，不进表单。
  bindingEnv?: Record<string, string> | null
}>()

// Monaco 壳懒加载（monaco 本体是共享 chunk，多入口不重复下载——见 CodeEditor.vue 头注）。
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))

// —— env 预设键，按使用频率分两组：常驻（高频）进主表单，其余收「高级配置」折叠区 ——
const RESIDENT_PRESET_INPUTS = [
  { key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', label: '小模型（后台任务）', placeholder: 'claude-haiku-…（标题/摘要等小任务走便宜模型）' },
  { key: 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', label: '上下文压缩窗口 tokens', placeholder: '如 20000：剩余不足即压缩；留空 = auto' },
  { key: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', label: '自动压缩触发 %', placeholder: '如 80：剩余上下文到 80% 即压缩；留空 = 默认' },
] as const
const PRESET_INPUTS = [
  { key: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', label: '最大输出 tokens', placeholder: '如 32000' },
  { key: 'MAX_THINKING_TOKENS', label: '思考预算 tokens', placeholder: '如 10240，留空 = 默认' },
  { key: 'API_TIMEOUT_MS', label: '请求超时 ms', placeholder: '慢网关调大，如 600000' },
  { key: 'CLAUDE_CODE_SUBAGENT_MODEL', label: '子代理模型', placeholder: 'Task 子代理用，留空 = 跟随主模型' },
] as const
// 全量预设键（常驻 + 折叠，逻辑层不分家——init/输出/原文回填都遍历它）
const ALL_PRESET_INPUTS = [...RESIDENT_PRESET_INPUTS, ...PRESET_INPUTS] as const
const PRESET_TOGGLES = [
  { key: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', label: '关闭非必要流量（遥测/错误上报/更新检查）' },
  { key: 'DISABLE_AUTOUPDATER', label: '关闭自动更新（容器内建议关）' },
  { key: 'DISABLE_AUTO_COMPACT', label: '关闭自动压缩（改用手动 /compact）' },
] as const
// ANTHROPIC_MODEL 归「默认模型」字段，同样不进自定义行
const PRESET_KEYS = new Set<string>([
  'ANTHROPIC_MODEL',
  ...ALL_PRESET_INPUTS.map((p) => p.key),
  ...PRESET_TOGGLES.map((t) => t.key),
])

// —— settings 顶级键常用项（settings.json 顶级键 = CLI 原生配置，非 env）——
// effortLevel 是常驻「思考力度」字段（见模板），此处只认领键防进自定义行
// 默认模式 = permissions.defaultMode（嵌套在顶级 permissions 块下）——常驻 Select；
// 取值枚举抄自 CLI 二进制；permissions 其余内容仍走「顶级设置」自定义行（settingsOut
// 里把 defaultMode 合并进 permissions 对象，原文回填时再拆出来，两边不互踩）。
const DEFAULT_MODES = [
  { value: 'default', label: 'default（每次操作逐条确认）' },
  { value: 'acceptEdits', label: 'acceptEdits（自动接受文件编辑）' },
  { value: 'plan', label: 'plan（只读规划模式）' },
  { value: 'bypassPermissions', label: 'bypassPermissions（跳过全部权限确认）' },
  { value: 'dontAsk', label: 'dontAsk' },
  { value: 'auto', label: 'auto' },
] as const
const SET_PRESET_TOGGLES = [
  { key: 'skipDangerousModePermissionPrompt', label: '跳过危险模式权限确认（不再逐条问）' },
  { key: 'autoMemoryEnabled', label: '启用自动记忆（AUTO MEMORY）' },
] as const
const SET_PRESET_KEYS = new Set<string>([
  'env', // env 块另有归属（绑定 + 自定义 env），settings 里禁写
  'effortLevel',
  ...SET_PRESET_TOGGLES.map((t) => t.key),
])

// —— 真相：模型 + 常用项值 + env 行列表 + 顶级设置（{key,value}；空 key 行 = 未填，保存时过滤）——
interface EnvRow {
  key: string
  value: string
}
const model = ref('')
const presets = ref<Record<string, string>>({}) // 非空才落 env；开关用 '1'/'' 表达
const rows = ref<EnvRow[]>([])
const effortLevel = ref('') // settings.effortLevel（low/medium/high）
const defaultMode = ref('') // settings.permissions.defaultMode（'' = 不设）
const setPresets = ref<Record<string, boolean>>({}) // 布尔开关 true/''
const setRows = ref<EnvRow[]>([])
// 用户动过表单后不再用 prop 初值回灌（父级 view 刷新不冲掉编辑中的草稿）。
const dirty = ref(false)

// 行值 ⇄ JSON 标量：true/false/数字按 JSON 解析，其余原样当字符串（要字面量 "true" 就带引号写）。
function parseScalar(s: string): unknown {
  const t = s.trim()
  if (!t) return ''
  try {
    return JSON.parse(t)
  } catch {
    return s
  }
}
function displayValue(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v)
}
// 读 st.permissions.defaultMode（permissions 非对象/无该键 = 不设）
function permsDefaultMode(st: Record<string, unknown>): string {
  const p = st.permissions
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ''
  const m = (p as Record<string, unknown>).defaultMode
  return typeof m === 'string' ? m : ''
}

let initializing = false
function initFrom(tc: AiClaudeToolConfig | undefined) {
  initializing = true
  const env = tc?.env ?? {}
  const st = tc?.settings ?? {}
  model.value = tc?.model ?? env.ANTHROPIC_MODEL ?? ''
  presets.value = Object.fromEntries(
    [...ALL_PRESET_INPUTS, ...PRESET_TOGGLES].map((p) => [p.key, env[p.key] ?? '']),
  )
  rows.value = Object.entries(env)
    .filter(([k]) => !PRESET_KEYS.has(k))
    .map(([key, value]) => ({ key, value }))
  effortLevel.value = typeof st.effortLevel === 'string' ? st.effortLevel : ''
  defaultMode.value = permsDefaultMode(st)
  setPresets.value = Object.fromEntries(
    SET_PRESET_TOGGLES.map((t) => [t.key, st[t.key] === true]),
  )
  setRows.value = Object.entries(st)
    .filter(([k]) => !SET_PRESET_KEYS.has(k))
    .map(([key, value]) => ({ key, value: displayValue(value) }))
  if (!rows.value.length) rows.value = [{ key: '', value: '' }]
  if (!setRows.value.length) setRows.value = [{ key: '', value: '' }]
  initializing = false
}
watch(
  () => props.tc,
  (tc) => {
    if (!dirty.value) initFrom(tc)
  },
  { immediate: true },
)
// 任何表单输入（行/模型/常用项/顶级设置）= 用户动过草稿。
watch(
  [rows, setRows],
  () => {
    if (!initializing) dirty.value = true
  },
  { deep: true },
)
watch(
  [model, presets, effortLevel, defaultMode, setPresets],
  () => {
    if (!initializing) dirty.value = true
  },
  { deep: true },
)

function addRow() {
  rows.value.push({ key: '', value: '' })
}
function removeRow(i: number) {
  rows.value.splice(i, 1)
  if (!rows.value.length) rows.value = [{ key: '', value: '' }]
}
function addSetRow() {
  setRows.value.push({ key: '', value: '' })
}
function removeSetRow(i: number) {
  setRows.value.splice(i, 1)
  if (!setRows.value.length) setRows.value = [{ key: '', value: '' }]
}

// rows → env 对象（空 key 行过滤；同名键后者赢——与对象字面量语义一致）。
const envOut = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  if (model.value.trim()) out.ANTHROPIC_MODEL = model.value.trim()
  for (const p of [...ALL_PRESET_INPUTS, ...PRESET_TOGGLES]) {
    const v = (presets.value[p.key] ?? '').trim()
    if (v) out[p.key] = v
  }
  for (const r of rows.value) {
    const k = r.key.trim()
    if (k) out[k] = r.value
  }
  return out
})

// setRows → settings 对象（预设项 + 通用行；值按 JSON 解析成标量）。
const settingsOut = computed<Record<string, unknown>>(() => {
  const out: Record<string, unknown> = {}
  if (effortLevel.value.trim()) out.effortLevel = effortLevel.value.trim()
  for (const t of SET_PRESET_TOGGLES) {
    if (setPresets.value[t.key] === true) out[t.key] = true
  }
  for (const r of setRows.value) {
    const k = r.key.trim()
    if (k) out[k] = parseScalar(r.value)
  }
  // 默认模式合并进顶级 permissions 块（自定义行里的 permissions 对象原样保留其余键）
  if (defaultMode.value) {
    const p = out.permissions
    const base =
      p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {}
    out.permissions = { ...base, defaultMode: defaultMode.value }
  }
  return out
})

// —— Monaco 原文（整份 settings.json 形状：实时预览 + 高级编辑；raw ⇄ 表单双向同步）——
// 预览 = 自身配置顶级键 + 自身配置 env + 绑定受管键（落盘全貌）；受管键只展示不可改。
const raw = ref('')
const parseErr = ref('')
const previewObj = computed<Record<string, unknown>>(() => ({
  ...settingsOut.value,
  env: { ...envOut.value, ...(props.bindingEnv ?? {}) },
}))
// 注意：Vue 的 watch 回调是异步冲刷的，同步旗标拦不住自己的回灌（回调跑时旗标已复位）
// ——改用「解析结果与当前预览等价 = 只是回显」判定：回显不动 dirty、不重建表单。
watch(
  previewObj,
  (obj) => {
    const s = JSON.stringify(obj, null, 2)
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
  const obj = { ...(v as Record<string, unknown>) }
  const env = obj.env
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    parseErr.value = 'env 必须是对象，暂不套用'
    return
  }
  const envObj = (env as Record<string, unknown> | undefined) ?? {}
  if (Object.values(envObj).some((x) => typeof x !== 'string')) {
    parseErr.value = 'env 的所有值必须是字符串，暂不套用'
    return
  }
  parseErr.value = ''
  if (JSON.stringify(obj) === JSON.stringify(previewObj.value)) return // 只是回显
  dirty.value = true
  // env 块 → env 表单区（受管键以绑定为准：Monaco 里的增删改不落表单，下次回显由绑定补回）
  const e = { ...(envObj as Record<string, string>) }
  for (const k of Object.keys(props.bindingEnv ?? {})) delete e[k]
  model.value = e.ANTHROPIC_MODEL ?? ''
  presets.value = Object.fromEntries(
    [...ALL_PRESET_INPUTS, ...PRESET_TOGGLES].map((p) => [p.key, e[p.key] ?? '']),
  )
  rows.value = Object.entries(e)
    .filter(([k]) => !PRESET_KEYS.has(k))
    .map(([key, value]) => ({ key, value }))
  if (!rows.value.length) rows.value = [{ key: '', value: '' }]
  // 其余顶级键 → 顶级设置表单区（预设键认领，其余进通用行；值按 JSON 还原显示）
  delete obj.env
  const st = obj as Record<string, unknown>
  // permissions.defaultMode 归「默认模式」Select，permissions 其余键留在通用行
  const perms = st.permissions
  if (perms && typeof perms === 'object' && !Array.isArray(perms)) {
    const rest = { ...(perms as Record<string, unknown>) }
    defaultMode.value = typeof rest.defaultMode === 'string' ? (rest.defaultMode as string) : ''
    delete rest.defaultMode
    if (Object.keys(rest).length) st.permissions = rest
    else delete st.permissions
  } else {
    defaultMode.value = ''
  }
  effortLevel.value = typeof st.effortLevel === 'string' ? (st.effortLevel as string) : ''
  setPresets.value = Object.fromEntries(
    SET_PRESET_TOGGLES.map((t) => [t.key, st[t.key] === true]),
  )
  setRows.value = Object.entries(st)
    .filter(([k]) => !SET_PRESET_KEYS.has(k) && st[k] !== undefined)
    .map(([key, value]) => ({ key, value: displayValue(value) }))
  if (!setRows.value.length) setRows.value = [{ key: '', value: '' }]
})

// —— 渐进式披露：高频项常驻，低频项收进「高级配置」折叠区 ——
// 折叠时给已填项数徽标，非空的低频配置不会藏在看不见的地方。
const advancedOpen = ref(false)
const advancedFilled = computed(() => {
  let n = 0
  for (const p of PRESET_INPUTS) if ((presets.value[p.key] ?? '').trim()) n++
  n += rows.value.filter((r) => r.key.trim()).length
  n += setRows.value.filter((r) => r.key.trim()).length
  return n
})

const RESERVED = 'ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN'
const keyClash = computed(() =>
  rows.value.some((r) => r.key.trim() === 'ANTHROPIC_BASE_URL' || r.key.trim() === 'ANTHROPIC_AUTH_TOKEN'),
)

// 父级统一保存前取校验状态与输出（页签一个保存按钮 = 绑定 + 自身配置一次提交）。
defineExpose({
  validationError: (): string | null =>
    parseErr.value || (keyClash.value ? `${RESERVED} 由模型服务绑定管——删掉再保存` : null),
  toolConfigOut: (): AiClaudeToolConfig => ({
    ...(model.value.trim() ? { model: model.value.trim() } : {}),
    ...(Object.keys(envOut.value).length ? { env: envOut.value } : {}),
    ...(Object.keys(settingsOut.value).length ? { settings: settingsOut.value } : {}),
  }),
})
</script>

<template>
  <div class="space-y-3 border-t pt-3">
    <div class="flex items-center gap-2">
      <Badge variant="outline" class="px-1.5 text-[10px] text-muted-foreground">自身配置</Badge>
      <span class="min-w-0 flex-1 text-[11px] text-muted-foreground">默认模型 + 常用项 + 自定义 env + 顶级设置，全局一份，随下方保存一起追平到各容器</span>
      <InfoHint label="自身配置说明">
        <p>「自身配置」是 Claude Code 绑定之外的特殊配置，落进 settings.json 两处：env 块（默认模型写入 ANTHROPIC_MODEL，常用项与自定义 env 原样写入）与顶级键（effortLevel、skipDangerousModePermissionPrompt 等 CLI 原生配置）。</p>
        <p>只保存全局一份，不进绑定四层（本机/容器覆盖/项目规则都不带它）；落点跟着 claude 绑定走——未绑 claude 的目标不写。</p>
        <p>小模型用 ANTHROPIC_DEFAULT_HAIKU_MODEL；旧版 CLI 的变量名是 ANTHROPIC_SMALL_FAST_MODEL，可在自定义 env 补写。</p>
        <p>压缩窗口（CLAUDE_CODE_AUTO_COMPACT_WINDOW）是 token 数——剩余上下文不足该值即触发 auto-compact，不是百分比。</p>
        <p>顶级设置的值按 JSON 解析：true / false / 数字直接写，字面量字符串 "true" 要带引号；嵌套结构（permissions 等）在下方原文里编辑，「默认模式」选的值会合并进顶级 permissions 块（permissions.defaultMode），其余 permissions 键仍在自定义行。注意环境变量优先级高于同名顶级配置（如 ANTHROPIC_MODEL 盖过顶级 model）——「默认模型」字段留空后顶级 model 才生效。</p>
        <p>{{ RESERVED }} 由模型服务绑定管，这里写了会被拒；settings 里不能写 env（env 块另有归属）。</p>
        <p>预览里出现的 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 来自上面选中的模型服务（落盘全貌），在原文里改它们会被绑定覆盖。</p>
      </InfoHint>
    </div>

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

    <!-- 常驻高频预设：小模型 / 压缩窗口 / 思考力度（effortLevel 是 settings 顶级键，与 env 预设同权展示） -->
    <div class="grid gap-3 sm:grid-cols-2">
      <div v-for="p in RESIDENT_PRESET_INPUTS" :key="p.key" class="space-y-1.5">
        <Label :for="`ai-claude-${p.key}`">{{ p.label }}</Label>
        <Input
          :id="`ai-claude-${p.key}`"
          v-model="presets[p.key]"
          :placeholder="p.placeholder"
          class="h-8 font-mono text-xs"
        />
        <p class="font-mono text-[10px] text-muted-foreground/60">{{ p.key }}</p>
      </div>
      <div class="space-y-1.5">
        <Label for="ai-claude-effortLevel">思考力度</Label>
        <Input
          id="ai-claude-effortLevel"
          v-model="effortLevel"
          placeholder="low / medium / high"
          class="h-8 font-mono text-xs"
        />
        <p class="font-mono text-[10px] text-muted-foreground/60">effortLevel（settings 顶级键）</p>
      </div>
      <div class="space-y-1.5">
        <Label for="ai-claude-defaultmode">默认模式</Label>
        <Select :model-value="defaultMode" @update:model-value="(v) => (defaultMode = (v as string) ?? '')">
          <SelectTrigger id="ai-claude-defaultmode" size="sm" class="w-full">
            <SelectValue placeholder="不设（CLI 默认行为）" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="m in DEFAULT_MODES" :key="m.value" :value="m.value" class="font-mono text-xs">
              {{ m.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="font-mono text-[10px] text-muted-foreground/60">permissions.defaultMode</p>
      </div>
    </div>

    <!-- 常用开关：一行（env 三开关 + settings 顶级两开关），勾选即写入 -->
    <div class="flex flex-wrap gap-x-5 gap-y-1.5">
      <label v-for="t in PRESET_TOGGLES" :key="t.key" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          :model-value="presets[t.key] === '1'"
          @update:model-value="(v) => (presets[t.key] = v ? '1' : '')"
        />
        {{ t.label }}
      </label>
      <label v-for="t in SET_PRESET_TOGGLES" :key="t.key" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox
          :model-value="setPresets[t.key] === true"
          @update:model-value="(v) => (setPresets[t.key] = v === true)"
        />
        {{ t.label }}
      </label>
    </div>

    <!-- 渐进式披露：低频项收进「高级配置」；折叠时徽标 = 已填低频项数 -->
    <button
      type="button"
      class="flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      @click="advancedOpen = !advancedOpen"
    >
      <ChevronDown class="size-3.5 transition-transform" :class="advancedOpen && 'rotate-180'" />
      高级配置
      <span
        v-if="advancedFilled && !advancedOpen"
        class="rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground"
      >{{ advancedFilled }}</span>
    </button>

    <div v-show="advancedOpen" class="space-y-3">
      <!-- 预设字段（中转/网关场景低频项） -->
      <div class="grid gap-3 sm:grid-cols-2">
        <div v-for="p in PRESET_INPUTS" :key="p.key" class="space-y-1.5">
          <Label :for="`ai-claude-${p.key}`">{{ p.label }}</Label>
          <Input
            :id="`ai-claude-${p.key}`"
            v-model="presets[p.key]"
            :placeholder="p.placeholder"
            class="h-8 font-mono text-xs"
          />
          <p class="font-mono text-[10px] text-muted-foreground/60">{{ p.key }}</p>
        </div>
      </div>

      <!-- 自定义 env 键值对行 -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <Label>自定义 env</Label>
          <Button variant="outline" size="xs" @click="addRow"><Plus class="size-3.5" /> 添加键值对</Button>
        </div>
        <div v-for="(r, i) in rows" :key="i" class="flex items-center gap-2">
          <Input
            v-model="r.key"
            placeholder="键（如 ANTHROPIC_SMALL_FAST_MODEL）"
            class="h-8 flex-1 font-mono text-xs"
          />
          <Input
            v-model="r.value"
            placeholder="值"
            class="h-8 flex-[2] font-mono text-xs"
          />
          <button
            type="button"
            class="shrink-0 text-muted-foreground/60 hover:text-destructive"
            title="删除该键值对"
            @click="removeRow(i)"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
        <p v-if="keyClash" class="text-[11px] text-destructive">
          {{ RESERVED }} 由模型服务绑定管——删掉再保存（后端会拒绝）。
        </p>
      </div>

      <!-- 顶级设置：settings.json 顶级键（非 env 的 CLI 原生配置） -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <Label>顶级设置</Label>
          <Button variant="outline" size="xs" @click="addSetRow"><Plus class="size-3.5" /> 添加键值对</Button>
        </div>
        <div v-for="(r, i) in setRows" :key="i" class="flex items-center gap-2">
          <Input
            v-model="r.key"
            placeholder="键（如 model）"
            class="h-8 flex-1 font-mono text-xs"
          />
          <Input
            v-model="r.value"
            placeholder="值（true / 42 / &quot;文本&quot;，按 JSON 解析）"
            class="h-8 flex-[2] font-mono text-xs"
          />
          <button
            type="button"
            class="shrink-0 text-muted-foreground/60 hover:text-destructive"
            title="删除该键值对"
            @click="removeSetRow(i)"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
        <p class="text-[10px] text-muted-foreground/60">settings.json 顶级键原样合并写入（整键覆盖）；嵌套结构（permissions、hooks 等）在下方原文里编辑。env 不能写在这里。</p>
      </div>
    </div>

    <!-- Monaco：整份 settings.json 形状——实时预览（随表单与所选模型服务即时更新）+ 高级编辑。
         落盘全貌的确认口，恒常驻不进折叠区 -->
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <Label>settings.json 预览 / 原文（JSON）</Label>
        <span class="text-[10px] text-muted-foreground/70">随表单与所选模型服务实时更新 · 可直接改（改对自动套用）</span>
      </div>
      <CodeEditor
        v-model="raw"
        language="json"
        class="h-56 overflow-hidden rounded-md border"
      />
      <p v-if="parseErr" class="text-[11px] text-amber-600 dark:text-amber-400">{{ parseErr }}</p>
    </div>
  </div>
</template>
