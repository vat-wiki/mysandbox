<script setup lang="ts">
// header 常驻徽标：基础镜像 present/missing/building 三态。click 打开 ImagePanel。
// 用 Badge 组件，与 App.vue 里 version / docker-ok 徽标同款外观。
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ exists: boolean | null; building: boolean }>()
defineEmits<{ (e: 'click'): void }>()

const colorClass = computed(() =>
  props.building
    ? 'border-transparent bg-blue-500/15 text-blue-500'
    : props.exists === true
      ? 'border-transparent bg-emerald-500/15 text-emerald-500'
      : props.exists === false
        ? 'border-transparent bg-destructive/15 text-destructive'
        : 'text-muted-foreground',
)
const text = computed(() =>
  props.building
    ? '构建中…'
    : `镜像 ${props.exists === false ? '✗' : props.exists === true ? '✓' : '…'}`,
)
</script>

<template>
  <button
    type="button"
    :title="exists === false ? '基础镜像未构建，点击构建/拉取' : '基础镜像状态（点击管理）'"
    class="cursor-pointer focus:outline-none"
    @click="$emit('click')"
  >
    <Badge variant="outline" :class="['font-normal', colorClass]">{{ text }}</Badge>
  </button>
</template>
