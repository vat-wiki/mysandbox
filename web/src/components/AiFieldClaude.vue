<script setup lang="ts">
// Claude Code 绑定字段组（受控展示）：启用 Checkbox + 单接入点 provider Select
// （只列 anthropic 端点的 provider）。从 AiBindingTab 抽出——全局 Agent 工具页的分卡
// 与目标覆盖表单（AiBindingTargetForm）共用同一组字段，行为一致无第二份实现。
// 字段 ref 留父级（fillFrom/bindingOut 不动），本组件纯受控：props 进、emit 出。
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
  enabled: boolean
  providerId: string
}>()
const emit = defineEmits<{
  (e: 'update:enabled', v: boolean): void
  (e: 'update:providerId', v: string): void
}>()

const anthropicProviders = computed(() => props.providers.filter((p) => p.endpoints.anthropic))
</script>

<template>
  <div class="space-y-1.5">
    <label class="flex items-center gap-2 text-sm">
      <Checkbox :model-value="enabled" @update:model-value="(v) => emit('update:enabled', !!v)" />
      <span class="font-medium">Claude Code</span>
      <span class="text-[11px] text-muted-foreground">单接入点（env 注入）</span>
    </label>
    <div v-if="enabled" class="grid gap-2 pl-6 sm:grid-cols-[1fr_auto] sm:items-center">
      <Select :model-value="providerId" @update:model-value="(v) => emit('update:providerId', v as string)">
        <SelectTrigger size="sm" class="w-full"><SelectValue placeholder="选模型服务（anthropic 端点）" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="p in anthropicProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</SelectItem>
        </SelectContent>
      </Select>
      <span class="text-[11px] text-muted-foreground">写 ~/.claude/settings.json（或项目级 .claude/settings.json）</span>
    </div>
  </div>
</template>
