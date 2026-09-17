<script setup lang="ts">
// OpenCode / Pi 绑定字段组（受控展示）：多 provider ToggleGroup 共存 + 接入点协议
// ToggleGroup（<服务>-chat / -responses / -anthropic）+ opencode 的设默认。
// 与 AiFieldClaude 同一套抽取逻辑（见其注释）。
// 没选任何 provider = 该工具不参与绑定（不碰落盘配置；要回收条目走删 provider 或
// 清除覆盖，绑定表单不做「空 = 清空」的歧义表达）。
import { Checkbox } from '@/components/ui/checkbox'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { AiProvider, GatewayWire } from '@/lib/api'

defineProps<{
  tool: 'opencode' | 'pi'
  providers: AiProvider[]
  providerIds: string[]
  wires: GatewayWire[]
  setDefault?: boolean
}>()
const emit = defineEmits<{
  (e: 'update:providerIds', v: string[]): void
  (e: 'update:wires', v: GatewayWire[]): void
  (e: 'update:setDefault', v: boolean): void
}>()
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center gap-2 text-sm">
      <span class="font-medium">{{ tool === 'opencode' ? 'OpenCode' : 'Pi' }}</span>
      <span class="text-[11px] text-muted-foreground">{{
        tool === 'opencode' ? '多服务共存，/models 切换 · 权限默认 auto（免 --auto）' : '多服务共存，工具内 /models 切换'
      }}</span>
    </div>
    <ToggleGroup
      type="multiple"
      size="sm"
      variant="outline"
      class="flex-wrap text-xs"
      :model-value="providerIds"
      @update:model-value="(v) => emit('update:providerIds', v as string[])"
    >
      <ToggleGroupItem v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</ToggleGroupItem>
    </ToggleGroup>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <ToggleGroup
        type="multiple"
        size="sm"
        variant="outline"
        class="text-xs"
        :model-value="wires"
        @update:model-value="(v) => emit('update:wires', v as GatewayWire[])"
      >
        <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
        <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
        <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
      </ToggleGroup>
      <span class="text-[11px] text-muted-foreground">接入点协议（&lt;服务&gt;-chat / -responses / -anthropic）</span>
    </div>
    <label
      v-if="tool === 'opencode'"
      class="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground"
    >
      <Checkbox :model-value="setDefault" @update:model-value="(v) => emit('update:setDefault', !!v)" />
      设为默认（首个服务的首个协议 + 首个模型）
    </label>
    <p class="text-[11px] leading-snug text-muted-foreground/80">
      不选模型供应商 = 该工具不参与绑定（落盘配置不动）。
    </p>
  </div>
</template>
