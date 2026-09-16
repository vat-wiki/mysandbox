<script setup lang="ts">
// AI 配置（覆盖模式弹框）：容器卡片菜单「AI 配置…」的入口形态。
// 这是临时小任务——只编辑该容器自己的覆盖绑定，弹框即来即走；全局管理才进主区
// 工作区（AiWorkspace）。AiBindingTargetForm 承载全部表单逻辑（保存/清除覆盖/下发结果）。
// 本机跟随全局绑定（Agent 工具页保存即追平宿主），不是覆盖目标——这里只有容器。
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Bot } from 'lucide-vue-next'
import AiBindingTargetForm from './AiBindingTargetForm.vue'

const props = defineProps<{ target: string }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'changed'): void
}>()
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="flex items-center gap-2 text-lg font-semibold">
          <Bot class="size-4" />
          AI 配置 · {{ props.target }}
        </DialogTitle>
        <DialogDescription class="sr-only">该目标的专属工具绑定（覆盖全局）</DialogDescription>
      </div>
      <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <AiBindingTargetForm
          :target="props.target"
          @done="emit('changed')"
          @unauthorized="emit('unauthorized')"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>
