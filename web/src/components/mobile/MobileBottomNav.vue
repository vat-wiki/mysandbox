<script setup lang="ts">
import { Bot, FolderOpen, Settings, Terminal } from 'lucide-vue-next'
import SettingsMenu from '@/components/SettingsMenu.vue'
import type { MobileNavTarget } from './mobileNavigation'

defineProps<{
  active: MobileNavTarget
  busy?: boolean // 任一终端组有输出：终端图标挂呼吸标（原顶栏 tab 光晕的底栏落点）
}>()

const emit = defineEmits<{
  navigate: [target: MobileNavTarget]
  // 设置 popup 的菜单事件原样上抛（ContainerList 统一处理：openAi / 开详情弹框 / 管理组）
  'open-ai': []
  'open-section': ['testlens' | 'cluster' | 'notify']
  'open-base': []
  'open-accounts': []
  'open-batch': []
}>()

// settings 是动作不是视图（SettingsMenu popup 就地弹出，永不处于激活态），
// 与三个视图项同栏但语义不同——渲染时单独包一层菜单。
const items: { target: MobileNavTarget; label: string; icon: typeof Terminal }[] = [
  { target: 'terminal', label: '终端', icon: Terminal },
  { target: 'files', label: '文件', icon: FolderOpen },
  { target: 'ai', label: 'AI', icon: Bot },
  { target: 'settings', label: '设置', icon: Settings },
]
</script>

<template>
  <nav class="fixed inset-x-0 bottom-0 z-50 flex h-10 border-t border-border bg-background pb-safe md:hidden">
    <template v-for="item in items" :key="item.target">
      <!-- 设置：popup 锚定本按钮向上弹（AI 配置/TestLens/集群/通知/版本） -->
      <SettingsMenu
        v-if="item.target === 'settings'"
        side="top"
        align="end"
        class="flex min-w-0 flex-1"
        @open-ai="emit('open-ai')"
        @open-section="(s) => emit('open-section', s)"
        @open-base="emit('open-base')"
        @open-accounts="emit('open-accounts')"
        @open-batch="emit('open-batch')"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent"
        >
          <component :is="item.icon" class="size-4" />
          <span class="truncate">{{ item.label }}</span>
        </button>
      </SettingsMenu>
      <button
        v-else
        type="button"
        class="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] transition-colors"
        :class="
          active === item.target
            ? 'text-primary'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground active:bg-accent'
        "
        :aria-current="active === item.target ? 'page' : undefined"
        @click="emit('navigate', item.target)"
      >
        <span class="relative inline-flex">
          <component :is="item.icon" class="size-4" />
          <!-- busy 呼吸标只挂终端项：底栏全局唯一，语义是「有组在输出」 -->
          <span
            v-if="busy && item.target === 'terminal'"
            class="term-busy-halo absolute -inset-1 rounded-full"
            :style="{ backgroundColor: 'var(--primary)', '--dot': 'var(--primary)' }"
          />
        </span>
        <span class="truncate">{{ item.label }}</span>
      </button>
    </template>
  </nav>
</template>
