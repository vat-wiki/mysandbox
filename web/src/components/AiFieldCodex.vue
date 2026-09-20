<script setup lang="ts">
// Codex 绑定字段组（受控展示）：单接入点 provider Select（只列 openai/responses
// 端点的 provider——与后端 validateBinding 同口径）+ 默认模型 AiModelCombo（自由
// 输入保留 + 库内 openai-responses 清单点选回填）。model 必填：codex 没有顶层
// model 会用内置 gpt-5.x slug，第三方网关没有这些模型，请求必 404。没选 provider
// = 该工具不参与绑定（不碰落盘配置）。与 AiFieldClaude 同一套抽取逻辑（见其注释）。
import { computed } from 'vue'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import AiModelCombo from './AiModelCombo.vue'
import { wireModels, type AiProvider } from '@/lib/api'

const props = defineProps<{
  providers: AiProvider[]
  providerId: string
  model: string
}>()
const emit = defineEmits<{
  (e: 'update:providerId', v: string): void
  (e: 'update:model', v: string): void
}>()

// 校验与后端 validateBinding 同口径：responses 或 openai 端点任一即可（codex 固定
// responses 协议，responses 侧缺省回落 openai 侧）。
const codexProviders = computed(() => props.providers.filter((p) => p.endpoints.openai || p.endpoints.responses))
// 默认模型候选 = 选中 provider 库内的 openai-responses 清单（固定走 responses 协议）。
const modelCandidates = computed(() => {
  const p = props.providers.find((x) => x.id === props.providerId)
  return p ? wireModels(p, 'openai-responses') : []
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-center gap-2 text-sm">
      <span class="font-medium">Codex</span>
      <span class="text-[11px] text-muted-foreground">responses 协议 · 单供应商 + 默认模型</span>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="space-y-1.5">
        <Label for="ai-codex-provider" class="text-[11px] text-muted-foreground">模型供应商</Label>
        <Select :model-value="providerId" @update:model-value="(v) => emit('update:providerId', v as string)">
          <SelectTrigger id="ai-codex-provider" size="sm" class="w-full"><SelectValue placeholder="选择 openai/responses 供应商" /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="p in codexProviders" :key="p.id" :value="p.id">{{ p.name }}（{{ p.id }}）</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div v-if="providerId" class="space-y-1.5">
        <Label for="ai-codex-model" class="text-[11px] text-muted-foreground">默认模型</Label>
        <AiModelCombo
          input-id="ai-codex-model"
          :model-value="model"
          :models="modelCandidates"
          placeholder="必填——不写会用内置 gpt-5.x"
          @update:model-value="(v) => emit('update:model', v)"
        />
      </div>
    </div>
  </div>
</template>
