<script setup lang="ts">
// header 常驻徽标：点击打开 ServicesPanel（docker 配套服务）。
// available 三态：null=未知（灰）、true=正常（默认色）、false=docker 不可达（红）。
import { computed } from 'vue'
import { Badge } from '@/components/ui/badge'

const props = defineProps<{ available?: boolean | null }>()
defineEmits<{ (e: 'click'): void }>()

const variant = computed(() => (props.available === false ? 'destructive' : 'outline'))
const cls = computed(() => (props.available == null ? 'font-normal text-muted-foreground' : 'font-normal'))
</script>

<template>
  <button
    type="button"
    title="docker 服务（postgres/redis…，固定 IP 直连，容器内按服务名访问）"
    class="cursor-pointer focus:outline-none"
    @click="$emit('click')"
  >
    <Badge :variant="variant" :class="cls">服务</Badge>
  </button>
</template>
