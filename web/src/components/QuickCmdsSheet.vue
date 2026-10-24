<script setup lang="ts">
// 快捷指令面板（手机终端工具条「指令」键弹出，底栏 sheet）：浏览态点条目 = 发送整条
// 命令并回车（run 事件交回 Terminal.vue 的 sendSnippet 统一走，含 cwd 跟随）并收起面板；
// 管理态支持增删改（表单内联在底部）。数据在 lib/termQuickCmds.ts（localStorage 模块级
// 单例——多终端实例共享一份）。运行行的 pointerdown.prevent 防抢终端焦点（软键盘收起
// 闪一下 + composition 被吞），管理态按钮不抢焦点问题无所谓，照常 pointerdown。
// 层级 z-[90]：盖过工具条本体（Teleport z-[80]），portal 挂 body 不受终端容器裁切。
import { nextTick, ref } from 'vue'
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogClose } from 'reka-ui'
import { Pencil, Plus, Trash2, X } from '@lucide/vue'
import { quickCmds, addQuickCmd, updateQuickCmd, rmQuickCmd } from '@/lib/termQuickCmds'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  run: [cmd: string]
}>()

const managing = ref(false)
function runCmd(cmd: string) {
  emit('run', cmd)
  emit('update:open', false)
}

// —— 表单：editIdx = -1 新增，>=0 编辑对应条目 ——
const formOpen = ref(false)
const editIdx = ref(-1)
const draftLabel = ref('')
const draftCmd = ref('')
const labelInput = ref<HTMLInputElement | null>(null)
const cmdInput = ref<HTMLInputElement | null>(null)
function openAdd() {
  editIdx.value = -1
  draftLabel.value = ''
  draftCmd.value = ''
  formOpen.value = true
  nextTick(() => labelInput.value?.focus())
}
function openEdit(i: number) {
  editIdx.value = i
  draftLabel.value = quickCmds.value[i].label
  draftCmd.value = quickCmds.value[i].cmd
  formOpen.value = true
  nextTick(() => labelInput.value?.focus())
}
function saveForm() {
  if (editIdx.value < 0) addQuickCmd(draftLabel.value, draftCmd.value)
  else updateQuickCmd(editIdx.value, draftLabel.value, draftCmd.value)
  closeForm()
}
function closeForm() {
  formOpen.value = false
  draftLabel.value = ''
  draftCmd.value = ''
  // 输入框主动 blur——移动端不收键盘会一直盖着列表（ToolbarSettingsDialog 同款取舍）
  labelInput.value?.blur()
  cmdInput.value?.blur()
}
</script>

<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="z-[90] bg-black/70" />
      <DialogContent
        class="fixed inset-x-0 bottom-0 z-[90] max-h-[78dvh] w-full overflow-y-auto scroll-thin rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-bottom-4"
      >
        <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <DialogTitle class="text-base font-semibold">快捷指令</DialogTitle>
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              @click="managing = !managing"
            >{{ managing ? '完成' : '管理' }}</button>
            <DialogClose
              class="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X class="size-4" />
              <span class="sr-only">关闭</span>
            </DialogClose>
          </div>
        </div>
        <div class="px-2 pb-1">
          <p v-if="!quickCmds.length && !managing && !formOpen" class="px-3 py-6 text-center text-sm text-muted-foreground">
            还没有快捷指令——点右上「管理」添加<br />
            <span class="text-xs">如「部署」= cd ~/web && npm run build</span>
          </p>
          <div
            v-for="(c, i) in quickCmds"
            :key="c.label"
            class="flex min-h-14 items-center gap-2 rounded-xl px-3 py-2 transition-colors"
            :class="managing ? 'bg-accent/40' : 'hover:bg-accent/60 active:bg-accent'"
            @pointerdown="managing || $event.preventDefault()"
            @click="managing ? openEdit(i) : runCmd(c.cmd)"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ c.label }}</span>
              <span class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{{ c.cmd }}</span>
            </span>
            <template v-if="managing">
              <button
                type="button"
                class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
                title="编辑"
                @click.stop="openEdit(i)"
              >
                <Pencil class="size-4" />
              </button>
              <button
                type="button"
                class="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                title="删除"
                @click.stop="rmQuickCmd(i)"
              >
                <Trash2 class="size-4" />
              </button>
            </template>
          </div>
          <button
            v-if="managing"
            type="button"
            class="flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 active:bg-accent"
            @click="openAdd"
          >
            <Plus class="size-4" />
            <span>新增指令</span>
          </button>
        </div>
        <!-- 新增/编辑表单：两行输入（名称 + 命令），enter 跳命令 → enter 保存 -->
        <div v-if="formOpen" class="mx-2 mb-1 rounded-xl border border-border/60 p-3">
          <p class="mb-2 text-xs font-semibold text-muted-foreground">{{ editIdx < 0 ? '新增指令' : '编辑指令' }}</p>
          <input
            ref="labelInput"
            v-model="draftLabel"
            class="mb-2 h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 text-sm text-zinc-100"
            placeholder="名称，如：web 部署"
            spellcheck="false"
            enterkeyhint="next"
            @keydown.enter.prevent="cmdInput?.focus()"
          />
          <input
            ref="cmdInput"
            v-model="draftCmd"
            class="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 font-mono text-sm text-zinc-100"
            placeholder="命令，如：cd ~/web && npm run build"
            spellcheck="false"
            enterkeyhint="done"
            @keydown.enter.prevent="saveForm"
          />
          <div class="mt-2 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              @click="closeForm"
            >取消</button>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-40"
              :disabled="!draftLabel.trim() || !draftCmd.trim()"
              @click="saveForm"
            >保存</button>
          </div>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
