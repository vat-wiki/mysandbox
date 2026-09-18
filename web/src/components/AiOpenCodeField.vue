<script setup lang="ts">
// OpenCode 绑定字段组（受控展示）：provider 多选共存；每个 provider 独立配接入点协议，
// 每个协议独立配用哪些模型（不选 = 库内该协议的清单——provider 的模型清单按协议各
// 一份）；defaultModel 显式默认（<变体>/<模型>，空 = 自动取第一个配置组合）。
// 布局对齐模型供应商表单的网格语言（8rem 标签列 + 内容列）：每 provider 卡内三协议
// 固定三行，勾选即启用该行——协议与模型清单的归属一眼可见，不再两段式（勾选一行 +
// 明细另起）。与 AiFieldMulti（pi 用）同族。没选任何 provider = 该工具不参与绑定
// （不碰落盘配置）。
import { computed } from 'vue'
import { X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { wireModels, type AiOpenCodeEntry, type AiProvider, type GatewayWire } from '@/lib/api'

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
// 某条目某协议的库内清单（模型清单按协议各一份；provider 缺失 = 空数组）。
const wireModelsOf = (pid: string, wire: GatewayWire): string[] => {
  const p = providerById(pid)
  return p ? wireModels(p, wire) : []
}

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

// 默认模型候选 = 全部已配置 变体/模型 组合（该协议勾了模型就取勾选的，否则该
// provider 该协议的库内清单——模型清单按协议各一份）。
const defaultOptions = computed(() =>
  props.entries.flatMap((e) =>
    e.wires.flatMap((w) => {
      const p = providerById(e.provider)
      const models = w.models?.length ? w.models : (p ? wireModels(p, w.wire) : [])
      return models.map((m) => ({ value: `${e.provider}-${WIRE_SUFFIX[w.wire]}/${m}`, label: `${e.provider}-${WIRE_SUFFIX[w.wire]} / ${m}` }))
    }),
  ),
)
</script>

<template>
  <div class="space-y-2">
    <!-- 分区头：左说明右规则（同模型供应商表单「协议接入」头） -->
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-[11px] font-medium text-muted-foreground">模型供应商（多选共存，工具内 /models 切换）</span>
      <span class="text-[10px] text-muted-foreground/70">不选 = 该工具不参与绑定（落盘配置不动）</span>
    </div>

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

    <!-- 每 provider 一卡：头（名称 + id + 移除）+ 三协议固定行（勾选 = 启用该行） -->
    <div v-for="(e, i) in entries" :key="e.provider" class="space-y-2 rounded-md border p-2.5">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium">{{ providerById(e.provider)?.name ?? e.provider }}</span>
        <Badge variant="outline" class="px-1.5 font-mono text-[10px] text-muted-foreground">{{ e.provider }}</Badge>
        <Button
          variant="ghost"
          size="icon-xs"
          class="ml-auto text-muted-foreground hover:text-foreground"
          title="移除该供应商"
          @click="setProviders(entries.map((x) => x.provider).filter((id) => id !== e.provider))"
        ><X class="size-3.5" /></Button>
      </div>

      <div v-for="w in WIRES" :key="w" class="grid items-start gap-2 sm:grid-cols-[8rem_1fr]">
        <label class="flex items-center gap-1.5 text-xs" :class="e.wires.some((x) => x.wire === w) ? '' : 'text-muted-foreground/70'">
          <Checkbox
            :model-value="e.wires.some((x) => x.wire === w)"
            @update:model-value="(v) => toggleWire(i, w, !!v)"
          />
          {{ WIRE_SUFFIX[w] }}
        </label>
        <!-- 内容列：启用 → 模型 pills（+ 未选提示）；库内无清单 → 说明；未启用 → 空 -->
        <div v-if="e.wires.some((x) => x.wire === w)" class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <template v-if="wireModelsOf(e.provider, w).length">
            <ToggleGroup
              type="multiple"
              size="sm"
              variant="outline"
              class="flex-wrap text-xs"
              :model-value="e.wires.find((x) => x.wire === w)?.models ?? []"
              @update:model-value="
                (v) => {
                  const cur = wireModelsOf(e.provider, w)
                  const next = cur.filter((m) => (v as string[]).includes(m))
                  // 全选/全不选都归 undefined（= 该协议全部模型），只存真子集
                  const models = next.length && next.length < cur.length ? next : undefined
                  updateEntry(i, { wires: e.wires.map((x) => (x.wire === w ? { wire: w, models } : x)) })
                }
              "
            >
              <ToggleGroupItem v-for="m in wireModelsOf(e.provider, w)" :key="m" :value="m">{{ m }}</ToggleGroupItem>
            </ToggleGroup>
            <span v-if="!e.wires.find((x) => x.wire === w)?.models?.length" class="text-[11px] text-muted-foreground">未选 = 该协议全部模型</span>
          </template>
          <span v-else class="text-[11px] text-muted-foreground">库内该协议没有清单，落盘不挂模型（到「模型供应商」编辑该行补齐）</span>
        </div>
      </div>
    </div>

    <!-- 默认模型：与协议行同网格对齐 -->
    <div v-if="entries.length" class="grid items-center gap-2 sm:grid-cols-[8rem_1fr]">
      <span class="text-[11px] text-muted-foreground">默认模型</span>
      <Select :model-value="defaultModel" @update:model-value="(v) => emit('update:defaultModel', v as string)">
        <SelectTrigger size="sm" class="w-full max-w-md"><SelectValue placeholder="自动（第一个配置组合）" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="o in defaultOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  </div>
</template>
