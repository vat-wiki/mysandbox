<script setup lang="ts">
import { ref } from 'vue'
import { MoreVertical } from '@lucide/vue'
import CardActionSheet, { type CardAction } from './CardActionSheet.vue'

defineProps<{
  title: string
  description?: string
  actions: CardAction[]
}>()

const emit = defineEmits<{
  select: [action: CardAction]
}>()

const open = ref(false)
</script>

<template>
  <button
    type="button"
    class="flex size-10 shrink-0 items-center justify-center border-l border-border/60 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground active:bg-accent"
    title="当前标签操作"
    @click="open = true"
  >
    <MoreVertical class="size-5" />
    <CardActionSheet
      v-model:open="open"
      :title="title"
      :description="description"
      :actions="actions"
      @select="emit('select', $event)"
    />
  </button>
</template>
