<script setup lang="ts">
import { ref } from 'vue'
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
  select: [action: CardAction]
  meta: []
  /** 动作面板即将弹出（点卡片/回车）：父组件借此做打开时的按需加载（端口懒拉等） */
  open: []
}>()

const sheetOpen = ref(false)
function openSheet() {
  if (sheetOpen.value) return
  sheetOpen.value = true
  emit('open')
}
</script>

<template>
  <div
    class="relative flex cursor-pointer select-none flex-col gap-1.5 rounded-lg border px-2.5 py-2 pl-3.5 transition-transform touch-manipulation active:scale-[0.99] active:bg-accent/60"
    :class="active ? 'border-border/60 bg-accent' : 'border-transparent hover:bg-accent/40'"
    role="button"
    tabindex="0"
    @click="openSheet"
    @keydown.enter.prevent="openSheet"
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
    <CardActionSheet
      v-model:open="sheetOpen"
      :title="title"
      :description="description"
      :actions="actions"
      @select="emit('select', $event)"
    />
  </div>
</template>
