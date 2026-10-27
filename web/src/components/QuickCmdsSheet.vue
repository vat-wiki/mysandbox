<script setup lang="ts">
// 快捷指令面板（手机终端工具条「指令」键弹出，底栏 sheet）：**只负责运行**——
// 点条目 = 发送整条命令并回车（run 事件交回 Terminal.vue，含 cwd 跟随）并收起面板。
// 配置（增删改 / 调序）与工具条按键配置同级，统一收在全屏「终端工具条」页的
// 指令分区；面板右上「配置」直接跳过去（emit config），不再有「管理」态——
// 同一个列表在运行态和配置态语义相反（点 = 执行 vs 点 = 编辑）的问题随之消失。
// 数据在 lib/termToolbar.ts（localStorage 模块级单例——多终端实例共享一份）。
// 运行行的 pointerdown.prevent 防抢终端焦点（软键盘收起闪一下 + composition 被吞）。
// 层级 z-[90]：盖过工具条本体（Teleport z-[80]），portal 挂 body 不受终端容器裁切。
import { ref } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui'
import { ChevronRight, Settings2, X } from '@lucide/vue'
import { quickCmds } from '@/lib/termToolbar'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  run: [cmd: string]
  config: []
}>()

function runCmd(cmd: string) {
  emit('run', cmd)
  emit('update:open', false)
}

// 「配置」= 关面板 + 开工具条设置（同一拍）。必须吃掉本面板的关闭焦点还原：
// 退出动画结束后 reka 默认把焦点还给打开前的元素（终端 textarea），软键盘会弹起来
// 盖住刚打开的设置弹窗。设置弹窗自身会在挂载时接管焦点。
const skipFocusRestore = ref(false)
function openConfig() {
  skipFocusRestore.value = true
  emit('config')
}
function onCloseAutoFocus(e: Event) {
  if (!skipFocusRestore.value) return
  skipFocusRestore.value = false
  e.preventDefault()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[90] bg-black/70" />
      <DialogContent
        class="fixed inset-x-0 bottom-0 z-[90] max-h-[78dvh] w-full overflow-y-auto scroll-thin rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4"
        @close-auto-focus="onCloseAutoFocus"
      >
        <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <DialogTitle class="text-base font-semibold">快捷指令</DialogTitle>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              @click="openConfig"
            >
              <Settings2 class="size-3.5" />
              配置
            </button>
            <DialogClose
              class="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X class="size-4" />
              <span class="sr-only">关闭</span>
            </DialogClose>
          </div>
        </div>
        <div class="px-2 pb-1">
          <div v-if="!quickCmds.length" class="px-4 py-8 text-center">
            <p class="text-sm text-muted-foreground">还没有快捷指令</p>
            <p class="mt-1 text-xs text-muted-foreground">在「工具条设置 → 指令」里添加，如「部署」= cd ~/web && npm run build</p>
            <button
              type="button"
              class="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
              @click="openConfig"
            >去添加</button>
          </div>
          <button
            v-for="c in quickCmds"
            :key="c.id"
            type="button"
            class="flex min-h-14 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors hover:bg-accent/60 active:bg-accent"
            @pointerdown.prevent
            @click="runCmd(c.cmd)"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ c.label }}</span>
              <span class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{{ c.cmd }}</span>
            </span>
            <ChevronRight class="size-4 shrink-0 text-muted-foreground/60" />
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
