<script setup lang="ts">
import { ref } from 'vue'
import { MoreVertical } from '@lucide/vue'
import CardActionSheet, { type CardAction } from './CardActionSheet.vue'

defineProps<{
  title: string
  description: string
  metaLabel?: string
  badgeLabel?: string
  badgeTitle?: string
  active?: boolean
  running?: boolean
  color?: string
  actions: CardAction[]
}>()

const emit = defineEmits<{
  open: []
  select: [action: CardAction]
  meta: []
}>()

const sheetOpen = ref(false)
</script>

<template>
  <div
    class="relative flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 pl-3.5 transition-colors active:bg-accent"
    :class="active ? 'border-border/60 bg-accent' : 'border-transparent hover:bg-accent/40'"
    role="button"
    tabindex="0"
    @click="emit('open')"
    @keydown.enter.prevent="emit('open')"
  >
    <span
      class="absolute left-0 rounded-full transition-all"
      :class="[active ? 'inset-y-1' : 'inset-y-2.5', running ? 'opacity-90' : 'bg-muted-foreground/30']"
      :style="running && color ? { backgroundColor: color } : undefined"
    />
    <div class="flex min-w-0 items-center gap-1.5 pr-9" :class="running ? '' : 'opacity-60'">
      <span class="min-w-0 truncate text-sm font-medium leading-snug text-foreground" :title="title">{{ title }}</span>
    </div>
    <div class="flex min-w-0 items-center gap-2 pr-9 text-[11px] leading-snug text-muted-foreground" :class="running ? '' : 'opacity-50'">
      <button
        v-if="metaLabel"
        type="button"
        class="shrink-0 font-mono tabular-nums transition-colors hover:text-foreground"
        @click.stop="emit('meta')"
      >
        {{ metaLabel }}
      </button>
      <span class="min-w-0 flex-1 truncate" :title="description">{{ description }}</span>
      <span
        v-if="badgeLabel"
        class="shrink-0 rounded-full border border-transparent bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
        :title="badgeTitle"
      >
        {{ badgeLabel }}
      </span>
    </div>
    <button
      type="button"
      class="absolute top-1 right-1 inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      title="操作"
      @click.stop="sheetOpen = true"
      @contextmenu.prevent
    >
      <MoreVertical class="size-4" />
    </button>
    <CardActionSheet
      v-model:open="sheetOpen"
      :title="title"
      :description="description"
      :actions="actions"
      @select="emit('select', $event)"
    />
  </div>
</template>
