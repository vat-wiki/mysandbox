<script setup lang="ts">
// Claude Code 绑定字段组（受控展示）：单接入点 provider Select（只列 anthropic
// 端点的 provider）。全局 Agent 工具页的工具页签与目标覆盖表单（AiBindingTargetForm）
// 共用同一组字段。字段 ref 留父级，本组件纯受控：props 进、emit 出。
// 没选 provider = 该工具不参与绑定（不碰落盘配置）——不再有启用勾选框，页签即入口。
import { computed } from 'vue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import type { AiProvider } from '@/lib/api'

const props = withDefaults(
  defineProps<{
    providers: AiProvider[]
    providerId: string
    /** 工具名头行：Agent 页签（页签即工具名）关掉；目标覆盖表单（四盒并排）保留 */
    showHeader?: boolean
  }>(),
  { showHeader: true },
)
const emit = defineEmits<{
  (e: 'update:providerId', v: string): void
}>()

const anthropicProviders = computed(() => props.providers.filter((p) => p.endpoints.anthropic))
</script>

<template>
  <div class="space-y-3">
    <div v-if="showHeader" class="flex items-center gap-2 text-sm">
      <span class="font-medium">Claude Code</span>
      <span class="text-[11px] text-muted-foreground">单接入点</span>
    </div>
    <div class="space-y-1.5">
      <Label for="ai-claude-provider" class="text-[11px] text-muted-foreground">模型供应商</Label>
      <Select :model-value="providerId" @update:model-value="(v) => emit('update:providerId', v as string)">
        <SelectTrigger id="ai-claude-provider" size="sm" class="w-full">
          <SelectValue placeholder="选模型供应商（anthropic 端点）" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="p in anthropicProviders" :key="p.id" :value="p.id" class="text-xs">{{ p.name }}（{{ p.id }}）</SelectItem>
        </SelectContent>
      </Select>
      <p class="font-mono text-[10px] text-muted-foreground/60">env 注入 ~/.claude/settings.json</p>
    </div>
  </div>
</template>
