<script setup lang="ts">
// OpenCode 绑定字段组（受控展示）：provider 多选共存；每个 provider 独立配接入点协议，
// 每个协议独立配用哪些模型（不选 = 该 provider 全部模型）；defaultModel 显式默认
// （<变体>/<模型>，空 = 自动取第一个配置组合）。与 AiFieldMulti（pi 用）同族。
// 没选任何 provider = 该工具不参与绑定（不碰落盘配置）。
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AiOpenCodeEntry, AiProvider, GatewayWire } from '@/lib/api'

const props = defineProps<{
  providers: AiProvider[]
  entries: AiOpenCodeEntry[]
  defaultModel: string
}>()
const emit = defineEmits<{
  (e: 'update:entries', v: AiOpenCodeEntry[]): void
  (e: 'update:defaultModel', v: string): void
}>()

// 协议 → 变体后缀（与后端 WIRE_SUFFIX 一致）+ 短标签（同一词）。
const WIRE_SUFFIX: Record<GatewayWire, string> = {
  'openai-chat': 'chat',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
}
const WIRES = Object.keys(WIRE_SUFFIX) as GatewayWire[]

const providerById = (id: string) => props.providers.find((p) => p.id === id)

// 选中即按库内顺序增条目（新条目缺省 chat 协议）；取消选中即移除。
function setProviders(ids: string[]) {
  const next: AiOpenCodeEntry[] = []
  for (const p of props.providers) {
    const old = props.entries.find((e) => e.provider === p.id)
    if (ids.includes(p.id)) next.push(old ?? { provider: p.id, wires: [{ wire: 'openai-chat' }] })
  }
  emit('update:entries', next)
  emit('update:defaultModel', '')
}

function updateEntry(i: number, patch: Partial<AiOpenCodeEntry>) {
  const next = props.entries.map((e, j) => (j === i ? { ...e, ...patch } : e))
  emit('update:entries', next)
  emit('update:defaultModel', '')
}

function toggleWire(i: number, wire: GatewayWire, on: boolean) {
  const e = props.entries[i]
  const wires = on
    ? [...e.wires, { wire }]
    : e.wires.filter((w) => w.wire !== wire)
  updateEntry(i, { wires })
}

// 默认模型候选 = 全部已配置 变体/模型 组合（该协议勾了模型就取勾选的，否则全部）。
const defaultOptions = computed(() =>
  props.entries.flatMap((e) =>
    e.wires.flatMap((w) => {
      const p = providerById(e.provider)
      const models = w.models?.length ? w.models : (p?.models ?? [])
      return models.map((m) => ({ value: `${e.provider}-${WIRE_SUFFIX[w.wire]}/${m}`, label: `${e.provider}-${WIRE_SUFFIX[w.wire]} / ${m}` }))
    }),
  ),
)
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ToggleGroup
        type="multiple"
        size="sm"
        variant="outline"
        class="flex-wrap text-xs"
        :model-value="entries.map((e) => e.provider)"
        @update:model-value="(v) => setProviders(v as string[])"
      >
        <ToggleGroupItem v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</ToggleGroupItem>
      </ToggleGroup>
    </div>

    <div v-for="(e, i) in entries" :key="e.provider" class="space-y-1.5 rounded-md border p-2">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium">{{ providerById(e.provider)?.name }}（{{ e.provider }}）</span>
        <Button
          variant="ghost"
          size="sm"
          class="ml-auto h-6 px-2 text-[11px] text-muted-foreground"
          @click="setProviders(entries.map((x) => x.provider).filter((id) => id !== e.provider))"
        >移除</Button>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label v-for="w in WIRES" :key="w" class="flex items-center gap-1 text-xs">
          <Checkbox
            :model-value="e.wires.some((x) => x.wire === w)"
            @update:model-value="(v) => toggleWire(i, w, !!v)"
          />
          {{ WIRE_SUFFIX[w] }}
        </label>
      </div>
      <div v-for="w in e.wires" :key="w.wire" class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span class="w-20 shrink-0 text-[11px] text-muted-foreground">{{ WIRE_SUFFIX[w.wire] }} 模型</span>
        <ToggleGroup
          type="multiple"
          size="sm"
          variant="outline"
          class="flex-wrap text-xs"
          :model-value="w.models ?? []"
          @update:model-value="
            (v) => {
              const cur = providerById(e.provider)?.models ?? []
              const next = cur.filter((m) => (v as string[]).includes(m))
              // 全选/全不选都归 undefined（= 全部模型），只存真子集
              const models = next.length && next.length < cur.length ? next : undefined
              updateEntry(i, { wires: e.wires.map((x) => (x.wire === w.wire ? { wire: w.wire, models } : x)) })
            }
          "
        >
          <ToggleGroupItem v-for="m in providerById(e.provider)?.models ?? []" :key="m" :value="m">{{ m }}</ToggleGroupItem>
        </ToggleGroup>
        <span v-if="!w.models?.length" class="text-[11px] text-muted-foreground">未选 = 全部模型</span>
      </div>
    </div>

    <div v-if="entries.length" class="flex items-center gap-2 text-xs">
      <span class="text-muted-foreground">默认模型</span>
      <Select :model-value="defaultModel" @update:model-value="(v) => emit('update:defaultModel', v as string)">
        <SelectTrigger size="sm" class="w-64"><SelectValue placeholder="自动（第一个配置组合）" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="o in defaultOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>
</template>
