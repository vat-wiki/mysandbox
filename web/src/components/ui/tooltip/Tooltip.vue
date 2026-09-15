<script setup lang="ts">
import { TooltipProvider, TooltipRoot } from "reka-ui"

defineOptions({
  inheritAttrs: false,
})
</script>

<template>
  <!-- reka-ui v2：TooltipRoot 注入 Provider 上下文无 fallback（缺失直接 throw）——
       Provider 统一包在这里，调用方不用感知它的存在 -->
  <TooltipProvider :delay-duration="300">
    <TooltipRoot data-slot="tooltip" v-bind="$attrs">
      <slot />
    </TooltipRoot>
  </TooltipProvider>
</template>
