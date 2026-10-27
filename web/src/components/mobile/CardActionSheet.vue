<script setup lang="ts">
// 手机动作面板（壳 = BottomPanel，带遮罩的底部 sheet）：容器卡 / 文件 tab / 切换条 ⋯ / 网络信息共用。
// 这是移动端原生 action sheet 的形态——遮罩压暗底层、点遮罩即收，底部另有显式「取消」。
import { X } from '@lucide/vue'
import BottomPanel from './BottomPanel.vue'

export interface CardAction {
  id: string
  label: string
  detail?: string
  destructive?: boolean
  primary?: boolean
  disabled?: boolean
}

defineProps<{
  open: boolean
  title: string
  description?: string
  actions: CardAction[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [action: CardAction]
}>()

function select(action: CardAction) {
  if (action.disabled) return
  emit('update:open', false)
  emit('select', action)
}
</script>

<template>
  <BottomPanel :open="open" :label="title" @update:open="emit('update:open', $event)">
    <div class="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
      <div class="min-w-0">
        <p class="truncate text-base font-semibold">{{ title }}</p>
        <p v-if="description" class="mt-0.5 truncate text-xs text-muted-foreground">{{ description }}</p>
      </div>
      <button
        type="button"
        class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
        @click="emit('update:open', false)"
      >
        <X class="size-4" />
        <span class="sr-only">关闭</span>
      </button>
    </div>
    <div class="px-2 pb-1">
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-3 text-left transition-colors disabled:pointer-events-none disabled:opacity-40"
        :class="[
          action.primary ? 'bg-primary text-primary-foreground active:bg-primary/80' : 'active:bg-accent',
          action.destructive && !action.primary ? 'text-destructive' : '',
          !action.primary && !action.destructive ? 'text-foreground' : '',
        ]"
        :disabled="action.disabled"
        @click="select(action)"
      >
        <span class="min-w-0 flex-1">
          <span class="block text-sm font-medium">{{ action.label }}</span>
          <span v-if="action.detail" class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {{ action.detail }}
          </span>
        </span>
      </button>
    </div>
    <!-- 显式取消：没有黑幕兜底后，别让用户只能靠「点空白」猜怎么退 -->
    <div class="mx-2 border-t border-border/60 pt-1 pb-0.5">
      <button
        type="button"
        class="flex min-h-12 w-full items-center justify-center rounded-xl text-sm text-muted-foreground active:bg-accent"
        @click="emit('update:open', false)"
      >
        取消
      </button>
    </div>
  </BottomPanel>
</template>
