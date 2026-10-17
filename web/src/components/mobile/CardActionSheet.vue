<script setup lang="ts">
import { DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui'
import { X } from '@lucide/vue'

export interface CardAction {
  id: string
  label: string
  detail?: string
  destructive?: boolean
  disabled?: boolean
}

defineProps<{
  open: boolean
  title: string
  description?: string
  actions: CardAction[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [action: CardAction]
}>()

function select(action: CardAction) {
  if (action.disabled) return
  emit('update:open', false)
  emit('select', action)
}
</script>

<template>
  <DialogPortal>
    <DialogOverlay class="z-50 bg-black/70" @click="emit('update:open', false)" />
    <DialogContent
      class="fixed inset-x-0 bottom-0 z-50 max-h-[78dvh] w-full overflow-y-auto scroll-thin rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4"
      @interact-outside="emit('update:open', false)"
    >
      <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
      <div class="flex items-start justify-between gap-3 px-4 pt-3 pb-2">
        <div class="min-w-0">
          <DialogTitle class="truncate text-base font-semibold">{{ title }}</DialogTitle>
          <p v-if="description" class="mt-0.5 truncate text-xs text-muted-foreground">{{ description }}</p>
        </div>
        <DialogClose
          class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X class="size-4" />
          <span class="sr-only">关闭</span>
        </DialogClose>
      </div>
      <div class="px-2 pb-1">
        <button
          v-for="action in actions"
          :key="action.id"
          type="button"
          class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent/60 active:bg-accent disabled:pointer-events-none disabled:opacity-40"
          :class="action.destructive ? 'text-destructive' : 'text-foreground'"
          :disabled="action.disabled"
          @click="select(action)"
        >
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ action.label }}</span>
            <span v-if="action.detail" class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
              {{ action.detail }}
            </span>
          </span>
        </button>
      </div>
    </DialogContent>
  </DialogPortal>
</template>
