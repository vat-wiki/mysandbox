<script setup lang="ts">
// 触屏工具条设置对话框（Terminal.vue 工具条 ⋯ 打开）：独立区域编排按钮——
// 当前按钮 chip 拖拽调序 / ✕ 移除、候选按键点击追加、快捷短语增删、自定义按键。
// 状态在 lib/termToolbar.ts 模块级单例，改完即时反映到工具条（无需确认按钮）。
// 输入框添加后主动 blur——移动端不收键盘会一直盖着面板。
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { CircleDot } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  toolButtons,
  saveToolButtons,
  rmBtn,
  addKeyBtn,
  addSnippet,
  addCustomKey,
  parseSeq,
  encodeKeyDown,
  KEY_POOL,
  TOOLBAR_MAX,
} from '@/lib/termToolbar'

const emit = defineEmits<{ (e: 'close'): void }>()

// —— chip 拖拽调序：全部监听挂 window（不用 setPointerCapture——WebKit 对 touch
// 指针的捕获有历史怪癖，隐式捕获目标还可能是 chip 内层 span），对各浏览器最钝感。
// pointerdown 记 pointerId，move 超 6px 武装；武装后 elementFromPoint 找落点 chip
// 即时换位（拖拽中的 chip 被 .tsc-drag 关掉 pointer-events，不会命中自己）。up 落盘。
const dragIdx = ref<number | null>(null)
const dragArmed = ref(false)
const drag = { id: null as number | null, x: 0, y: 0 }
function chipDown(i: number, ev: PointerEvent) {
  if (drag.id !== null || (ev.target as HTMLElement).closest('button')) return // ✕ 等按钮照常点击
  drag.id = ev.pointerId
  drag.x = ev.clientX
  drag.y = ev.clientY
  dragIdx.value = i
  dragArmed.value = false
}
function dragMove(ev: PointerEvent) {
  if (drag.id === null || ev.pointerId !== drag.id) return
  if (!dragArmed.value) {
    if (Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 6) return
    dragArmed.value = true
  }
  const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.tsc-chip') as HTMLElement | null
  const to = Number(under?.dataset.idx)
  if (under == null || Number.isNaN(to) || to === dragIdx.value) return
  const [b] = toolButtons.value.splice(dragIdx.value!, 1)
  toolButtons.value.splice(to, 0, b)
  dragIdx.value = to
}
function dragEnd(ev: PointerEvent) {
  if (drag.id === null || ev.pointerId !== drag.id) return
  if (dragArmed.value) saveToolButtons()
  drag.id = null
  dragArmed.value = false
  dragIdx.value = null
}
function dragAbort() {
  if (drag.id === null) return
  if (dragArmed.value) saveToolButtons()
  drag.id = null
  dragArmed.value = false
  dragIdx.value = null
}
onMounted(() => {
  window.addEventListener('pointermove', dragMove)
  window.addEventListener('pointerup', dragEnd)
  window.addEventListener('pointercancel', dragAbort)
  window.addEventListener('blur', dragAbort)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', dragMove)
  window.removeEventListener('pointerup', dragEnd)
  window.removeEventListener('pointercancel', dragAbort)
  window.removeEventListener('blur', dragAbort)
})

// —— 快捷短语：添加后 blur 输入框，别让软键盘一直盖着面板 ——
const snippetDraft = ref('')
const snippetInput = ref<HTMLInputElement | null>(null)
function addSnippetAndBlur() {
  addSnippet(snippetDraft.value)
  snippetDraft.value = ''
  snippetInput.value?.blur()
}

// —— 自定义按键：标签 + 任意转义序列（手输 \e \xHH 转义，或物理键盘录制）——
const ckLabel = ref('')
const ckSeqRaw = ref('')
const ckInput = ref<HTMLInputElement | null>(null)
function addCustomAndBlur() {
  const seq = parseSeq(ckSeqRaw.value)
  addCustomKey(ckLabel.value || ckSeqRaw.value.trim(), seq)
  ckLabel.value = ''
  ckSeqRaw.value = ''
  ckInput.value?.blur()
}
// 键盘录制：武装后 window 捕获阶段吃掉全部 keydown（不落进输入框/不触发弹窗快捷键），
// 编码成序列填进表单。需要物理键盘——纯触屏用户走上面的手输转义。
const recording = ref(false)
function toggleRecord() {
  if (recording.value) {
    recording.value = false
    return
  }
  recording.value = true
  ckInput.value?.blur()
}
function recordKeyDown(e: KeyboardEvent) {
  if (!recording.value) return
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
    recording.value = false // 裸 Esc = 退出录制；要发 Esc 走候选池
    return
  }
  const enc = encodeKeyDown(e)
  if (!enc) return
  ckLabel.value = enc.label
  ckSeqRaw.value = [...enc.seq].map((ch) => seqEscape(ch)).join('')
  recording.value = false
}
// 录制监听常驻 window 捕获阶段，内部按 recording 守卫——capture 优先级最高，
// 录制期间吃掉一切 keydown（不进输入框、不触发 reka 弹窗的 Esc 关闭）。
onMounted(() => {
  window.addEventListener('keydown', recordKeyDown, { capture: true })
})
// 序列反向转义成可读手输形式（展示在序列输入框里，可再手改）
function seqEscape(ch: string): string {
  const code = ch.charCodeAt(0)
  if (ch === '\\') return '\\\\'
  if (ch === '\x1b') return '\\e'
  if (ch === '\n') return '\\n'
  if (ch === '\r') return '\\r'
  if (ch === '\t') return '\\t'
  if (code < 0x20 || code === 0x7f) return '\\x' + code.toString(16).padStart(2, '0')
  return ch
}
onBeforeUnmount(() => {
  window.removeEventListener('keydown', recordKeyDown, { capture: true })
})
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
            :key="b.t === 'key' ? `k:${b.id}` : b.t === 'custom' ? `c:${b.label}` : `s:${b.text}`"
            class="tsc-chip"
            :class="{ 'tsc-drag': dragArmed && dragIdx === i }"
            :data-idx="i"
            @pointerdown="chipDown(i, $event)"
          >
            <span class="max-w-24 truncate">{{ b.t === 'key' ? KEY_POOL[b.id]?.label : b.t === 'custom' ? b.label : b.text }}</span>
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

        <p class="mb-1 mt-3 text-xs font-semibold text-muted-foreground">自定义按键（发送任意转义序列）</p>
        <div class="flex items-center gap-1">
          <input
            ref="ckInput"
            v-model="ckLabel"
            class="h-9 w-20 shrink-0 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100"
            placeholder="标签"
            spellcheck="false"
            enterkeyhint="done"
            @keydown.enter.prevent="addCustomAndBlur"
          />
          <input
            v-model="ckSeqRaw"
            class="h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 font-mono text-xs text-zinc-100"
            placeholder="序列：\e[5~ \x0c…"
            spellcheck="false"
            enterkeyhint="done"
            @keydown.enter.prevent="addCustomAndBlur"
          />
          <button type="button" class="tsc-pool tsc-pool-on" @click="addCustomAndBlur">添加</button>
        </div>
        <button
          type="button" class="mt-1 flex items-center gap-1 text-xs"
          :class="recording ? 'text-amber-400' : 'text-muted-foreground hover:text-zinc-300'"
          @click="toggleRecord"
        >
          <CircleDot class="size-3.5" :class="recording ? 'animate-pulse' : ''" />
          {{ recording ? '录制中：按下要发送的按键组合（裸 Esc 退出）' : '录制按键（需物理键盘）' }}
        </button>
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
