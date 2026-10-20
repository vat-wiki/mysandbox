<script setup lang="ts">
import { Bot, FolderOpen, Terminal } from 'lucide-vue-next'
import type { MobileNavTarget } from './mobileNavigation'

defineProps<{
  active: MobileNavTarget
}>()

const emit = defineEmits<{
  navigate: [target: MobileNavTarget]
}>()

const items: { target: MobileNavTarget; label: string; icon: typeof Terminal }[] = [
  { target: 'terminal', label: '终端', icon: Terminal },
  { target: 'files', label: '文件', icon: FolderOpen },
  { target: 'ai', label: 'AI', icon: Bot },
]
</script>

<template>
  <nav class="fixed inset-x-0 bottom-0 z-50 flex h-14 border-t border-border bg-background pb-safe md:hidden">
    <button
      v-for="item in items"
      :key="item.target"
      type="button"
      class="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors"
      :class="
        active === item.target
          ? 'text-primary'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent'
      "
      :aria-current="active === item.target ? 'page' : undefined"
      @click="emit('navigate', item.target)"
    >
      <component :is="item.icon" class="size-5" />
      <span class="truncate">{{ item.label }}</span>
    </button>
  </nav>
</template>
