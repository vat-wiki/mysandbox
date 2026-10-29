<script setup lang="ts">
// 终端会话对话框。主体是 TermSessionList（与侧栏终端区 / rail「所有终端」popover 同源），
// 这里只负责对话框壳——桌面主窗口的常驻入口在侧栏（终端区尾部块 / rail 分区），对话框
// 留给本机/SSH 卡片右键、手机切换器与 popout 顶栏。
import { TerminalSquare } from 'lucide-vue-next'
import type { ContainerView } from '@/lib/api'
import type { TermGroup } from '@/lib/termlayout'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import TermSessionList from '@/components/TermSessionList.vue'

defineProps<{
  // 本窗口隐藏的终端组（父级已在打开时剪掉容器已删的）
  hidden: TermGroup[]
  // 隐藏组里挂着「无输出提醒」标的组 id
  attentionIds?: Set<string>
  // 本窗口已占用的会话 key（可见 + 隐藏组的全部叶子）
  occupied: Set<string>
  items: ContainerView[]
}>()
const emit = defineEmits<{
  (e: 'restore', g: TermGroup): void
  (e: 'adopt', sessions: import('@/lib/api').TermSessionView[]): void
  (e: 'close'): void
  (e: 'unauthorized'): void
}>()
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <!-- 手机整页形态：grid 行 auto/auto/1fr，列表吃掉返回行+标题之外的剩余高度（内部滚动），
         底下不再留半屏空白；桌面仍 55vh 上限 + 容器自身滚动。 -->
    <DialogContent class="max-w-lg max-md:[grid-template-rows:auto_auto_1fr] max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <TerminalSquare class="size-4" /> 所有终端
        </DialogTitle>
      </DialogHeader>

      <div class="-mx-1 max-h-[55vh] overflow-y-auto px-1 scroll-thin max-md:max-h-none min-h-0">
        <TermSessionList
          :hidden="hidden"
          :attention-ids="attentionIds"
          :occupied="occupied"
          :items="items"
          @restore="emit('restore', $event)"
          @adopt="emit('adopt', $event)"
          @unauthorized="emit('unauthorized')"
        />
      </div>
    </DialogContent>
  </Dialog>
</template>
