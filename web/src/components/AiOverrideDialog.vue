<script setup lang="ts">
// AI 配置（覆盖模式弹框）：容器卡片菜单「AI 配置…」与本机「为本机配置」的入口形态。
// 这是临时小任务——只编辑该目标的覆盖绑定，弹框即来即走；全局管理才进主区工作区
// （AiWorkspace）。AiBindingTab target 模式承载全部表单逻辑（保存/清除覆盖/下发结果）。
import { computed } from 'vue'
import { Bot } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import AiBindingTab from './AiBindingTab.vue'
import { HOST_TARGET } from '@/lib/api'

const props = defineProps<{ target: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'changed'): void
}>()

const label = computed(() => (props.target === HOST_TARGET ? '本机' : props.target))
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="flex items-center gap-2 text-lg font-semibold">
          <Bot class="size-4" />
          AI 配置 · {{ label }}
        </DialogTitle>
        <DialogDescription class="sr-only">该目标的专属工具绑定（覆盖全局）</DialogDescription>
      </div>
      <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <AiBindingTab
          :target="props.target"
          @done="emit('changed')"
          @unauthorized="emit('unauthorized')"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>
