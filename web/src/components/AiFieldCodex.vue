<script setup lang="ts">
// Codex 绑定字段组（受控展示）：单接入点 provider Select（只列 openai 端点的
// provider）+ 设默认。与 AiFieldClaude 同一套抽取逻辑（见其注释）。
// 没选 provider = 该工具不参与绑定（不碰落盘配置）。
import { computed } from 'vue'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AiProvider } from '@/lib/api'

const props = defineProps<{
  providers: AiProvider[]
  providerId: string
  setDefault: boolean
}>()
const emit = defineEmits<{
  (e: 'update:providerId', v: string): void
  (e: 'update:setDefault', v: boolean): void
}>()

const openaiProviders = computed(() => props.providers.filter((p) => p.endpoints.openai))
</script>

<template>
  <div class="space-y-1.5">
    <div class="flex items-center gap-2 text-sm">
      <span class="font-medium">Codex</span>
      <span class="text-[11px] text-muted-foreground">responses 协议 · 多服务选默认</span>
    </div>
    <div class="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
      <Select :model-value="providerId" @update:model-value="(v) => emit('update:providerId', v as string)">
        <SelectTrigger size="sm" class="w-full"><SelectValue placeholder="选模型服务（openai 端点）" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="p in openaiProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</SelectItem>
        </SelectContent>
      </Select>
      <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Checkbox :model-value="setDefault" @update:model-value="(v) => emit('update:setDefault', !!v)" />
        设为默认 provider
      </label>
    </div>
  </div>
</template>
