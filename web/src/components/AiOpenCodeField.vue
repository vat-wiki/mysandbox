<script setup lang="ts">
// 多槽工具（opencode / pi）绑定字段组（受控展示）：provider 多选共存；每个 provider
// 独立配接入点协议，每个协议独立配用哪些模型（不选 = 库内该协议的清单——provider 的
// 模型清单按协议各一份）；opencode 另有 defaultModel 显式默认（<变体>/<模型>，空 =
// 自动取第一个配置组合），pi 没有这个概念、不渲染该行。布局对齐模型供应商表单的
// 网格语言（8rem 标签列 + 内容列）：每 provider 卡内三协议固定三行，勾选即启用该行。
// 模型选择不铺全量 pills（多模型 provider 又高又乱）——只显示已选 chip（点 × 移除）
// +「添加模型」下拉（搜索 + 勾选）；全不选 = 该协议全部模型。没选任何 provider =
// 该工具不参与绑定（不碰落盘配置）。
import { ref, computed, watch } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  openCodeVariants,
  WIRE_SUFFIX,
  wireModels,
  type AiOpenCodeEntry,
  type AiProvider,
  type GatewayWire,
} from '@/lib/api'

const props = defineProps<{
  tool: 'opencode' | 'pi'
  providers: AiProvider[]
  entries: AiOpenCodeEntry[]
  defaultModel: string
  // 主模型（toolConfig.model，全局一份）已设置时落盘 model 以它为准——默认模型整行
  // 禁用并说明原因（调用方传），避免「改了默认模型却不生效」的静默覆盖。
  defaultModelDisabled?: boolean
  defaultModelDisabledHint?: string
}>()
const emit = defineEmits<{
  (e: 'update:entries', v: AiOpenCodeEntry[]): void
  (e: 'update:defaultModel', v: string): void
}>()

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

// 勾/去一个模型。存档语义：空集归 undefined（= 该协议全部模型）。全集不折叠——
// 折叠回 undefined 后勾选态（models?.includes 派生）原地消失，勾最后一颗打不上、
// 单模型清单永远勾不上（表现为「有些模型无法选中」）；显式全集与 undefined 落盘
// 解析等价，只是存法不归一。
function toggleModel(i: number, wire: GatewayWire, m: string, on: boolean) {
  const e = props.entries[i]
  const cur = e.wires.find((x) => x.wire === wire)?.models ?? []
  const next = on ? [...cur, m] : cur.filter((x) => x !== m)
  const models = next.length ? next : undefined
  updateEntry(i, { wires: e.wires.map((x) => (x.wire === wire ? { wire, models } : x)) })
}

// 「添加模型」下拉：每行独立开合（key = provider|wire，同一时刻只记一个打开的行），
// 共享搜索词（打开即清）。
const addOpenKey = ref<string | null>(null)
const addQuery = ref('')
watch(addOpenKey, (v) => { if (v) addQuery.value = '' })
const addCandidates = (pid: string, wire: GatewayWire): string[] => {
  const q = addQuery.value.trim().toLowerCase()
  const all = wireModelsOf(pid, wire)
  return q ? all.filter((m) => m.toLowerCase().includes(q)) : all
}

// 默认模型候选 = 全部已配置 变体/模型 组合（单源 openCodeVariants，主模型/轻量模型
// 的下拉建议同源）。
const defaultOptions = computed(() => openCodeVariants(props.entries, props.providers))
</script>

<template>
  <div class="space-y-3">
    <!-- 分区头：左说明右规则（同模型供应商表单「协议接入」头） -->
    <div class="flex items-baseline justify-between gap-2">
      <span class="text-xs font-medium">模型供应商</span>
      <span class="text-[11px] text-muted-foreground">多选共存 · 不选 = 不参与绑定</span>
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
    <div v-for="(e, i) in entries" :key="e.provider" class="space-y-2 rounded-md border bg-background/60 p-3 shadow-xs">
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
        <label class="flex items-center gap-1.5 text-[11px] text-muted-foreground" :class="e.wires.some((x) => x.wire === w) ? 'text-foreground' : ''">
          <Checkbox
            :model-value="e.wires.some((x) => x.wire === w)"
            @update:model-value="(v) => toggleWire(i, w, !!v)"
          />
          {{ WIRE_SUFFIX[w] }}
        </label>
        <!-- 内容列：启用 → 已选 chips + 添加下拉；库内无清单 → 说明；未启用 → 空 -->
        <div v-if="e.wires.some((x) => x.wire === w)" class="flex flex-wrap items-center gap-1.5">
          <template v-if="wireModelsOf(e.provider, w).length">
            <Badge
              v-for="m in e.wires.find((x) => x.wire === w)?.models ?? []"
              :key="m"
              variant="outline"
              class="gap-0.5 px-1.5 text-[11px] font-normal"
            >
              {{ m }}
              <button type="button" class="rounded-sm text-muted-foreground hover:text-foreground" :title="`移除 ${m}`" @click="toggleModel(i, w, m, false)">
                <X class="size-3" />
              </button>
            </Badge>
            <Popover
              :open="addOpenKey === `${e.provider}|${w}`"
              @update:open="(v) => (addOpenKey = v ? `${e.provider}|${w}` : null)"
            >
              <PopoverTrigger as-child>
                <!-- 裸 button + click.prevent：shadcn Button 在 as-child 下会吞掉触发展开（AiModelCombo 同款写法） -->
                <button
                  type="button"
                  class="inline-flex h-5 items-center gap-0.5 rounded-md border px-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="勾选该协议要用的模型"
                  @click.prevent
                >
                  <Plus class="size-3" /> 模型
                </button>
              </PopoverTrigger>
              <PopoverContent class="w-60 p-0" align="start">
                <Input v-model="addQuery" placeholder="搜索模型…" class="h-8 rounded-b-none border-x-0 border-t-0 text-xs focus-visible:ring-0" />
                <div class="max-h-56 overflow-y-auto p-1">
                  <label
                    v-for="m in addCandidates(e.provider, w)"
                    :key="m"
                    class="flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1.5 text-xs hover:bg-muted"
                  >
                    <Checkbox
                      :model-value="(e.wires.find((x) => x.wire === w)?.models ?? []).includes(m)"
                      @update:model-value="(v) => toggleModel(i, w, m, !!v)"
                    />
                    <span class="truncate font-mono">{{ m }}</span>
                  </label>
                  <p v-if="!addCandidates(e.provider, w).length" class="px-1.5 py-2 text-[11px] text-muted-foreground">无匹配模型</p>
                </div>
                <p class="border-t px-2 py-1.5 text-[10px] text-muted-foreground/70">一个都不勾 = 该协议全部模型</p>
              </PopoverContent>
            </Popover>
            <span v-if="!e.wires.find((x) => x.wire === w)?.models?.length" class="text-[11px] text-muted-foreground">未选 = 全部 {{ wireModelsOf(e.provider, w).length }} 个模型</span>
          </template>
          <span v-else class="text-[11px] text-muted-foreground">库内该协议没有清单，落盘不挂模型（到「模型供应商」编辑该行补齐）</span>
        </div>
      </div>
    </div>

    <!-- 默认模型（pi 无此概念不渲染）：与协议行同网格对齐；主模型已设时整行禁用 -->
    <div
      v-if="tool === 'opencode' && entries.length"
      class="space-y-1.5"
      :class="defaultModelDisabled ? 'pointer-events-none opacity-60' : ''"
    >
      <Label class="text-[11px] text-muted-foreground">默认模型</Label>
      <Select
        :model-value="defaultModel"
        :disabled="defaultModelDisabled"
        @update:model-value="(v) => emit('update:defaultModel', v as string)"
      >
        <SelectTrigger size="sm" class="w-full">
          <SelectValue :placeholder="defaultModelDisabled ? '已被主模型覆盖（见下方工具自身配置）' : '自动（第一个配置组合）'" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="o in defaultOptions" :key="o.value" :value="o.value">{{ o.label }}</SelectItem>
        </SelectContent>
      </Select>
      <p v-if="defaultModelDisabled && defaultModelDisabledHint" class="text-[10px] text-muted-foreground">{{ defaultModelDisabledHint }}</p>
    </div>
  </div>
</template>
