<script setup lang="ts">
// 触屏工具条设置对话框（Terminal.vue 工具条 ⋯ 打开）：独立区域编排按钮——
// 当前按钮 chip 拖拽调序 / ✕ 移除、候选按键点击追加、快捷短语增删。
// 状态在 lib/termToolbar.ts 模块级单例，改完即时反映到工具条（无需确认按钮）。
// 输入框添加后主动 blur——移动端不收键盘会一直盖着面板。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { X } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  toolButtons,
  saveToolButtons,
  rmBtn,
  addKeyBtn,
  addSnippet,
  KEY_POOL,
  TOOLBAR_MAX,
} from '@/lib/termToolbar'

const emit = defineEmits<{ (e: 'close'): void }>()

// —— chip 拖拽调序：pointerdown 记起点，移动超阈值（6px 防误触）才武装拖拽；
// 武装后 setPointerCapture（触摸隐式捕获也走这里），elementFromPoint 找落点 chip
// 即时换位（拖拽中的 chip 已被 .tsc-drag 关掉 pointer-events，不会命中自己）。
// pointerup 统一落盘。chip 上 user-select/-webkit-touch-callout 全关——iOS 长按
// 弹选择/放大镜会 pointercancel 掉拖拽，真机「拖不动」多是这个。
const dragIdx = ref<number | null>(null)
const dragArmed = ref(false)
const chipDrag = { el: null as HTMLElement | null, x: 0, y: 0 }
function chipDown(i: number, ev: PointerEvent) {
  if (chipDrag.el || (ev.target as HTMLElement).closest('button')) return // ✕ 等按钮照常点击，不启动拖拽
  chipDrag.el = ev.currentTarget as HTMLElement
  chipDrag.x = ev.clientX
  chipDrag.y = ev.clientY
  dragIdx.value = i
  dragArmed.value = false
}
function chipMove(ev: PointerEvent) {
  if (!chipDrag.el) return
  if (!dragArmed.value) {
    if (Math.hypot(ev.clientX - chipDrag.x, ev.clientY - chipDrag.y) < 6) return
    dragArmed.value = true
    chipDrag.el.setPointerCapture(ev.pointerId)
  }
  const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tsc-chip') as HTMLElement | null
  const to = Number(under?.dataset.idx)
  if (under == null || Number.isNaN(to) || to === dragIdx.value) return
  const [b] = toolButtons.value.splice(dragIdx.value!, 1)
  toolButtons.value.splice(to, 0, b)
  dragIdx.value = to
}
function chipUp() {
  if (!chipDrag.el) return
  if (dragArmed.value) saveToolButtons()
  chipDrag.el = null
  dragArmed.value = false
  dragIdx.value = null
}
// 兜底：capture 之外丢掉 pointerup（窗外松手等）会卡死拖拽态，window 级再挂一份；
// chipUp 幂等（chipDrag.el 清空后直接 return），与 chip 级监听重复无害。
onMounted(() => {
  window.addEventListener('pointerup', chipUp)
  window.addEventListener('pointercancel', chipUp)
  window.addEventListener('blur', chipUp)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointerup', chipUp)
  window.removeEventListener('pointercancel', chipUp)
  window.removeEventListener('blur', chipUp)
})

// —— 快捷短语：添加后 blur 输入框，别让软键盘一直盖着面板 ——
const snippetDraft = ref('')
const snippetInput = ref<HTMLInputElement | null>(null)
function addSnippetAndBlur() {
  addSnippet(snippetDraft.value)
  snippetDraft.value = ''
  snippetInput.value?.blur()
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-sm">
      <DialogHeader>
        <DialogTitle>工具条按钮</DialogTitle>
      </DialogHeader>

      <p class="text-xs text-muted-foreground">
        拖拽 chip 调序，改动即时生效并记忆（存本浏览器）。
      </p>

      <div class="max-h-[52vh] overflow-y-auto pr-0.5 scroll-thin">
        <p class="mb-1 text-xs font-semibold text-muted-foreground">当前按钮（{{ toolButtons.length }}/{{ TOOLBAR_MAX }}）</p>
        <div class="flex flex-wrap items-center gap-1">
          <span
            v-for="(b, i) in toolButtons"
            :key="b.t === 'key' ? `k:${b.id}` : `s:${b.text}`"
            class="tsc-chip"
            :class="{ 'tsc-drag': dragArmed && dragIdx === i }"
            :data-idx="i"
            @pointerdown="chipDown(i, $event)"
            @pointermove="chipMove"
            @pointerup="chipUp"
            @pointercancel="chipUp"
          >
            <span class="max-w-24 truncate">{{ b.t === 'key' ? KEY_POOL[b.id]?.label : b.text }}</span>
            <button type="button" class="tsc-x" title="移除" @click="rmBtn(i)">✕</button>
          </span>
        </div>

        <p class="mb-1 mt-3 text-xs font-semibold text-muted-foreground">候选按键（点击追加到末尾）</p>
        <div class="flex flex-wrap items-center gap-1">
          <template v-for="(e, id) in KEY_POOL" :key="id">
            <button
              v-if="!toolButtons.some((b) => b.t === 'key' && b.id === id)"
              type="button" class="tsc-pool" :title="e.title"
              @click="addKeyBtn(String(id))"
            >{{ e.label }}</button>
          </template>
        </div>

        <p class="mb-1 mt-3 text-xs font-semibold text-muted-foreground">快捷短语（发送文本并自动回车）</p>
        <div class="flex items-center gap-1">
          <input
            ref="snippetInput"
            v-model="snippetDraft"
            class="h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 font-mono text-xs text-zinc-100"
            placeholder="输入短语，如：继续"
            spellcheck="false"
            enterkeyhint="done"
            @keydown.enter.prevent="addSnippetAndBlur"
          />
          <button type="button" class="tsc-pool tsc-pool-on" @click="addSnippetAndBlur">添加</button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* chip：拖拽把手 + 移除按钮。user-select/callout 全关——iOS 长按弹选择/放大镜会
   pointercancel 掉拖拽；touch-action:none 防起点在 chip 上的触摸被滚动抢走。 */
.tsc-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  height: 1.75rem;
  padding: 0 0.375rem 0 0.5rem;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
  font-family: var(--font-mono), ui-monospace, monospace;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: none;
  cursor: grab;
}
.tsc-chip:active {
  cursor: grabbing;
}
/* 拖拽中的 chip：半透明 + 放手让 elementFromPoint 穿过自己命中落点 */
.tsc-drag {
  opacity: 0.45;
  pointer-events: none;
}
.tsc-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.25rem;
  height: 1.25rem;
  border-radius: 0.25rem;
  color: #a1a1aa;
  font-size: 11px;
}
.tsc-x:hover {
  color: #f87171;
}
/* 候选池 / 添加按钮：与工具条 .tb 同语言（方形小键） */
.tsc-pool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 2rem;
  padding: 0 0.625rem;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
  user-select: none;
}
.tsc-pool:active {
  background: #27272a;
}
.tsc-pool-on {
  border-color: #f59e0b;
  color: #fbbf24;
}
</style>
