<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- 左对齐（原 text-center sm:text-left）：手机整页形态顶栏是「返回」行，居中标题与
       左侧返回错位；桌面 sm:text-left 本来就左对齐，此改动只影响 <640px。 -->
  <div
    data-slot="dialog-header"
    :class="cn('flex flex-col gap-2 text-left', props.class)"
  >
    <slot />
  </div>
</template>
