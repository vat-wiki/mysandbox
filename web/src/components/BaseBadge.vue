<script setup lang="ts">
// header 常驻徽标：基座 ready/missing/busy 三态。click 打开 BasePanel。
// 「基座」= 新建容器的来源物（docker=镜像，lxc=模板容器），文案取 caps.baseLabel。
// 用 Badge 组件，与 App.vue 里 version / engine-ok 徽标同款外观。
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'
import { baseLabel } from '@/lib/caps'

// ready 而非 exists：LXC 模板存在但在运行时不能克隆，徽标必须把这种「在但不可用」
// 显示成非绿色，否则用户点新建才发现失败。
const props = defineProps<{ ready: boolean | null; busy: boolean }>()
defineEmits<{ (e: 'click'): void }>()

const colorClass = computed(() =>
  props.busy
    ? 'border-transparent bg-blue-500/15 text-blue-500'
    : props.ready === true
      ? 'border-transparent bg-emerald-500/15 text-emerald-500'
      : props.ready === false
        ? 'border-transparent bg-destructive/15 text-destructive'
        : 'text-muted-foreground',
)
const text = computed(() =>
  props.busy
    ? '处理中…'
    : `${baseLabel.value} ${props.ready === false ? '✗' : props.ready === true ? '✓' : '…'}`,
)
</script>

<template>
  <button
    type="button"
    :title="ready === false ? `${baseLabel}未就绪，点击处理` : `${baseLabel}状态（点击管理）`"
    class="cursor-pointer focus:outline-none"
    @click="$emit('click')"
  >
    <Badge variant="outline" :class="['font-normal', colorClass]">{{ text }}</Badge>
  </button>
</template>
