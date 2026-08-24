<script setup lang="ts">
// header 常驻徽标：点击打开 HostsPanel（全局 /etc/hosts 统一配置）。
// 静态徽标——无状态轮询（不像 ImageBadge 需要查镜像是否存在）。
import { Badge } from '@/components/ui/badge'

defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <button
    type="button"
    title="全局 hosts 配置（统一编辑所有容器的 /etc/hosts）"
    class="cursor-pointer focus:outline-none"
    @click="$emit('click')"
  >
    <Badge variant="outline" class="font-normal text-muted-foreground">hosts</Badge>
  </button>
</template>
