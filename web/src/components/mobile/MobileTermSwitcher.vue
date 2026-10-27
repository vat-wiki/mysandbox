<script setup lang="ts">
// 手机终端切换页（本窗口的终端组列表）：底栏「终端」激活态再点进入（iOS Safari「再点已激活
// 页签出总览」同款），路由 /terminals/switch（mobileOnly），系统后退即退出。
// 形态 = 独立整页（桌面 dialog 底座在 max-md 已整页化，页内左上「返回」），不是弹层：
// 行 = 组（身份色点 + busy 呼吸标 + 无输出琥珀标 + ·N 分屏），点行切换、✕ 关闭该组、
// ⋯ 开组动作表；底部三条全局动作：所有终端（会话列表）/ 环境列表（容器抽屉）/ 网络信息。
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FolderTree, MoreHorizontal, Network, Terminal, X } from '@lucide/vue'

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

// 产品版本号（vite define 注入，根 package.json）：手机端品牌块不占顶部的对位——钉在页脚。
const appVersion = __APP_VERSION__
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="max-w-lg max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0">
      <DialogHeader>
        <DialogTitle class="text-base font-semibold">终端</DialogTitle>
        <DialogDescription class="sr-only">本窗口打开的终端组</DialogDescription>
      </DialogHeader>

      <div>
        <p v-if="!rows.length" class="px-3 py-6 text-center text-sm text-muted-foreground">
          还没有终端——去环境列表选容器打开
        </p>
        <div
          v-for="row in rows"
          :key="row.id"
          class="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors"
          :class="row.active ? 'bg-accent' : 'active:bg-accent'"
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
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-accent"
            title="组动作（新开一组 / 独立窗口 / 提醒 / 隐藏 / 关闭）"
            @click.stop="emit('actions', row.id)"
          >
            <MoreHorizontal class="size-4.5" />
          </button>
          <button
            type="button"
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground active:bg-destructive/10 active:text-destructive"
            title="关闭终端组"
            @click.stop="emit('close', row.id)"
          >
            <X class="size-4" />
          </button>
        </div>
      </div>

      <!-- 全局动作：与会话/环境的关系是「跳转」而非组动作，视觉上与组列表分隔 -->
      <div class="border-t border-border/60 pt-1">
        <button
          type="button"
          class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors active:bg-accent"
          @click="emit('sessions')"
        >
          <Terminal class="size-4 text-muted-foreground" />
          <span>所有终端</span>
          <span class="ml-auto text-xs text-muted-foreground">含其他窗口</span>
        </button>
        <button
          type="button"
          class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors active:bg-accent"
          @click="emit('environments')"
        >
          <FolderTree class="size-4 text-muted-foreground" />
          <span>环境列表</span>
          <span class="ml-auto text-xs text-muted-foreground">容器 / SSH</span>
        </button>
        <button
          type="button"
          class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors active:bg-accent"
          @click="emit('network')"
        >
          <Network class="size-4 text-muted-foreground" />
          <span>网络信息</span>
          <span class="ml-auto text-xs text-muted-foreground">当前组容器</span>
        </button>
      </div>

      <!-- 版本号钉页脚：弱化居中 -->
      <p class="pb-0.5 text-center text-[10px] tabular-nums text-muted-foreground/70">v{{ appVersion }}</p>
    </DialogContent>
  </Dialog>
</template>
