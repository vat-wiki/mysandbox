<script setup lang="ts">
// 终端组切换 sheet（手机）：顶栏取消后的终端切换落点——底栏「终端」激活态再点弹出。
// 行 = 组（身份色点 + busy 呼吸标 + 无输出琥珀标 + ·N 分屏数），点行切换、✕ 关闭、
// ⋯ 开该组动作表。底部固定两条全局动作：所有终端（会话对话框）/ 环境列表（容器抽屉，
// 左缘滑出手势之外的显式入口）。桌面不渲染；popout 无底栏，也不经这里。
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui'
import { FolderTree, Network, X, MoreHorizontal, Terminal } from '@lucide/vue'

export interface TermSwitcherRow {
  id: string
  label: string
  sub?: string
  color: string
  busy: boolean
  attention: boolean
  active: boolean
}

defineProps<{
  open: boolean
  rows: TermSwitcherRow[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [id: string]
  close: [id: string]
  actions: [id: string]
  sessions: []
  environments: []
  network: []
}>()
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="z-50 bg-black/70" />
      <DialogContent
        class="fixed inset-x-0 bottom-0 z-50 max-h-[78dvh] w-full overflow-y-auto scroll-thin rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4"
      >
        <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <DialogTitle class="text-base font-semibold">终端</DialogTitle>
          <DialogClose
            class="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogClose>
        </div>
        <div class="px-2 pb-1">
          <p v-if="!rows.length" class="px-3 py-6 text-center text-sm text-muted-foreground">
            还没有终端——去环境列表选容器打开
          </p>
          <div
            v-for="row in rows"
            :key="row.id"
            class="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors"
            :class="row.active ? 'bg-accent' : 'hover:bg-accent/60 active:bg-accent'"
            @click="emit('select', row.id)"
          >
            <span class="relative flex size-2.5 shrink-0">
              <span
                v-if="row.busy"
                class="term-busy-halo absolute -inset-1 rounded-full"
                :style="{ backgroundColor: row.color, '--dot': row.color }"
              />
              <span
                class="relative inline-flex size-2.5 rounded-full"
                :class="row.busy && 'term-busy-dot'"
                :style="{ backgroundColor: row.color }"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium" :class="row.active && 'text-foreground'">{{ row.label }}</span>
              <span v-if="row.sub" class="mt-0.5 block truncate text-xs text-muted-foreground">{{ row.sub }}</span>
            </span>
            <!-- 无输出提醒标（tmux bell 形态，切回即消） -->
            <span v-if="row.attention" class="size-1.5 shrink-0 rounded-full bg-amber-400" title="有输出等待查看" />
            <button
              type="button"
              class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
              title="组动作（新开一组 / 独立窗口 / 提醒 / 隐藏 / 关闭）"
              @click.stop="emit('actions', row.id)"
            >
              <MoreHorizontal class="size-4.5" />
            </button>
            <button
              type="button"
              class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              title="关闭终端组"
              @click.stop="emit('close', row.id)"
            >
              <X class="size-4" />
            </button>
          </div>
        </div>
        <!-- 全局动作：与会话/环境的关系是「跳转」而非组动作，视觉上与组列表分隔 -->
        <div class="mx-2 mb-1 border-t border-border/60 pt-1">
          <button
            type="button"
            class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors hover:bg-accent/60 active:bg-accent"
            @click="emit('sessions')"
          >
            <Terminal class="size-4 text-muted-foreground" />
            <span>所有终端</span>
            <span class="ml-auto text-xs text-muted-foreground">含其他窗口</span>
          </button>
          <button
            type="button"
            class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors hover:bg-accent/60 active:bg-accent"
            @click="emit('environments')"
          >
            <FolderTree class="size-4 text-muted-foreground" />
            <span>环境列表</span>
            <span class="ml-auto text-xs text-muted-foreground">容器 / SSH</span>
          </button>
          <button
            type="button"
            class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors hover:bg-accent/60 active:bg-accent"
            @click="emit('network')"
          >
            <Network class="size-4 text-muted-foreground" />
            <span>网络信息</span>
            <span class="ml-auto text-xs text-muted-foreground">当前组容器</span>
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
