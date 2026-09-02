<script setup lang="ts">
import { PopoverRoot } from "reka-ui"

defineOptions({
  inheritAttrs: false,
})
</script>

<template>
  <PopoverRoot data-slot="popover" v-bind="$attrs">
    <slot />
  </PopoverRoot>
</template>
