<script setup lang="ts">
// 工具条设置对话框（手机工具条 ⋯ 打开）：『按键』『指令』两个平级 tab——
// 按键 = 工具条按钮编排（一页 14 键，满页自动溢到下一页；chip 拖拽调序 / ✕ 移除、
// 候选按键点击追加、自定义按键）；指令 = 「指令」面板条目的增删改（拖手柄调序）。
// 两者是同一层级的两类配置，不再各用一个入口（v0.13.0 前：按键在 ⋯ 弹窗、
// 指令在面板的「管理」态；快捷短语与指令模型重复）。快捷短语已并入指令（v3 迁移）。
// 状态在 lib/termToolbar.ts 模块级单例，改完即时反映到工具条（无需确认按钮）。
// 输入框添加后主动 blur——移动端不收键盘会一直盖着面板。
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { CircleDot, GripVertical, Pencil, Plus, Trash2 } from '@lucide/vue'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  toolButtons,
  quickCmds,
  saveConfig,
  rmBtn,
  addKeyBtn,
  addCustomKey,
  addQuickCmd,
  updateQuickCmd,
  rmQuickCmd,
  parseSeq,
  encodeKeyDown,
  KEY_POOL,
  TOOLBAR_MAX,
  TB_PER_PAGE,
  type ToolBtn,
} from '@/lib/termToolbar'

const props = withDefaults(defineProps<{ initialTab?: 'keys' | 'cmds' }>(), { initialTab: 'keys' })
const emit = defineEmits<{ (e: 'close'): void }>()

const tab = ref<'keys' | 'cmds'>(props.initialTab)

// —— 按键：按工具条分页切分当前按钮，编排视图与工具条实际落位一致 ——
// data-idx 仍是扁平索引（页号 × 14 + 页内序号），拖拽跨页换位直接复用同一份列表。
const btnPages = computed<ToolBtn[][]>(() => {
  const out: ToolBtn[][] = []
  for (let i = 0; i < toolButtons.value.length; i += TB_PER_PAGE) out.push(toolButtons.value.slice(i, i + TB_PER_PAGE))
  return out
})

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
  if (dragArmed.value) saveConfig()
  drag.id = null
  dragArmed.value = false
  dragIdx.value = null
}
function dragAbort() {
  if (drag.id === null) return
  if (dragArmed.value) saveConfig()
  drag.id = null
  dragArmed.value = false
  dragIdx.value = null
}

// —— 指令拖拽调序：只有左侧手柄可拖（行本体还要点编辑/删除，且列表要能正常滚动）。
// 手柄 touch-action:none，其余区域照常滚；落点按 .qcc-row 的 data-idx 即时换位，
// 拖动中的行关掉 pointer-events + 变半透明，up 落盘。
const qcDragIdx = ref<number | null>(null)
const qcDragArmed = ref(false)
const qcDrag = { id: null as number | null, x: 0, y: 0 }
function qcGripDown(i: number, ev: PointerEvent) {
  if (qcDrag.id !== null) return
  qcDrag.id = ev.pointerId
  qcDrag.x = ev.clientX
  qcDrag.y = ev.clientY
  qcDragIdx.value = i
  qcDragArmed.value = false
}
function qcDragMove(ev: PointerEvent) {
  if (qcDrag.id === null || ev.pointerId !== qcDrag.id) return
  if (!qcDragArmed.value) {
    if (Math.hypot(ev.clientX - qcDrag.x, ev.clientY - qcDrag.y) < 6) return
    qcDragArmed.value = true
  }
  const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.qcc-row') as HTMLElement | null
  const to = Number(under?.dataset.idx)
  if (under == null || Number.isNaN(to) || to === qcDragIdx.value) return
  const [c] = quickCmds.value.splice(qcDragIdx.value!, 1)
  quickCmds.value.splice(to, 0, c)
  qcDragIdx.value = to
}
function qcDragEnd(ev: PointerEvent) {
  if (qcDrag.id === null || ev.pointerId !== qcDrag.id) return
  if (qcDragArmed.value) saveConfig()
  qcDrag.id = null
  qcDragArmed.value = false
  qcDragIdx.value = null
}
function qcDragAbort() {
  if (qcDrag.id === null) return
  if (qcDragArmed.value) saveConfig()
  qcDrag.id = null
  qcDragArmed.value = false
  qcDragIdx.value = null
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
  window.addEventListener('pointermove', dragMove)
  window.addEventListener('pointerup', dragEnd)
  window.addEventListener('pointercancel', dragAbort)
  window.addEventListener('blur', dragAbort)
  window.addEventListener('pointermove', qcDragMove)
  window.addEventListener('pointerup', qcDragEnd)
  window.addEventListener('pointercancel', qcDragAbort)
  window.addEventListener('blur', qcDragAbort)
  window.addEventListener('keydown', recordKeyDown, { capture: true })
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', dragMove)
  window.removeEventListener('pointerup', dragEnd)
  window.removeEventListener('pointercancel', dragAbort)
  window.removeEventListener('blur', dragAbort)
  window.removeEventListener('pointermove', qcDragMove)
  window.removeEventListener('pointerup', qcDragEnd)
  window.removeEventListener('pointercancel', qcDragAbort)
  window.removeEventListener('blur', qcDragAbort)
  window.removeEventListener('keydown', recordKeyDown, { capture: true })
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

// —— 指令表单：editIdx = -1 新增，>= 0 编辑对应条目；名称重复则禁用保存 ——
const qcFormOpen = ref(false)
const qcEditIdx = ref(-1)
const qcDraftLabel = ref('')
const qcDraftCmd = ref('')
const qcLabelInput = ref<HTMLInputElement | null>(null)
const qcCmdInput = ref<HTMLInputElement | null>(null)
const qcDup = computed(() => {
  const l = qcDraftLabel.value.trim()
  return !!l && quickCmds.value.some((c, i) => i !== qcEditIdx.value && c.label === l)
})
const qcCanSave = computed(() => !!qcDraftLabel.value.trim() && !!qcDraftCmd.value.trim() && !qcDup.value)
function openCmdAdd() {
  qcEditIdx.value = -1
  qcDraftLabel.value = ''
  qcDraftCmd.value = ''
  qcFormOpen.value = true
  nextTick(() => qcLabelInput.value?.focus())
}
function openCmdEdit(i: number) {
  const c = quickCmds.value[i]
  if (!c) return
  qcEditIdx.value = i
  qcDraftLabel.value = c.label
  qcDraftCmd.value = c.cmd
  qcFormOpen.value = true
  nextTick(() => qcLabelInput.value?.focus())
}
function saveCmdForm() {
  if (!qcCanSave.value) return
  if (qcEditIdx.value < 0) addQuickCmd(qcDraftLabel.value, qcDraftCmd.value)
  else updateQuickCmd(qcEditIdx.value, qcDraftLabel.value, qcDraftCmd.value)
  closeCmdForm()
}
function closeCmdForm() {
  qcFormOpen.value = false
  qcDraftLabel.value = ''
  qcDraftCmd.value = ''
  // 输入框主动 blur——移动端不收键盘会一直盖着列表（与按键表单同款取舍）
  qcLabelInput.value?.blur()
  qcCmdInput.value?.blur()
}
function rmCmd(i: number) {
  rmQuickCmd(i)
  // 删除会挪动索引：正在编辑的表单直接收掉，避免保存到错行
  if (qcFormOpen.value) closeCmdForm()
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <!-- z-[100]：从指令面板「配置」跳来时，面板 (z-90) 还在播退出动画——设置内容必须在它之上，
         不能等动画结束才出现；也顺带压过工具条本体 (z-80)。 -->
    <DialogContent class="z-[100] max-w-sm">
      <DialogHeader>
        <DialogTitle>工具条设置</DialogTitle>
      </DialogHeader>

      <!-- 两个平级分区：按键（工具条按钮）/ 指令（指令面板条目） -->
      <div class="grid grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1">
        <button
          type="button"
          class="rounded-md px-2 py-2 text-xs font-medium transition-colors"
          :class="tab === 'keys' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
          @click="tab = 'keys'"
        >按键</button>
        <button
          type="button"
          class="rounded-md px-2 py-2 text-xs font-medium transition-colors"
          :class="tab === 'cmds' ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'"
          @click="tab = 'cmds'"
        >指令（{{ quickCmds.length }}）</button>
      </div>

      <!-- —— 按键：编排工具条按钮 —— -->
      <div v-if="tab === 'keys'">
        <p class="mb-2 text-xs text-muted-foreground">
          拖拽调序，改动只保存在本浏览器。每页 14 个按钮，工具条上横向翻页。
        </p>

        <div class="max-h-[46vh] overflow-y-auto pr-0.5 scroll-thin">
          <p class="mb-1 text-xs font-semibold text-muted-foreground">当前按钮（{{ toolButtons.length }}/{{ TOOLBAR_MAX }}）</p>
          <div v-for="(pg, pi) in btnPages" :key="pi" class="mb-2">
            <p class="mb-1 text-[11px] text-zinc-500">第 {{ pi + 1 }} 页（{{ pg.length }}/{{ TB_PER_PAGE }}）</p>
            <div class="flex flex-wrap items-center gap-1">
              <span
                v-for="(b, bi) in pg"
                :key="b.t === 'key' ? `k:${b.id}` : `c:${b.label}`"
                class="tsc-chip"
                :class="{ 'tsc-drag': dragArmed && dragIdx === pi * TB_PER_PAGE + bi }"
                :data-idx="pi * TB_PER_PAGE + bi"
                @pointerdown="chipDown(pi * TB_PER_PAGE + bi, $event)"
              >
                <span class="max-w-24 truncate">{{ b.t === 'key' ? KEY_POOL[b.id]?.label : b.label }}</span>
                <button type="button" class="tsc-x" title="移除" @click="rmBtn(pi * TB_PER_PAGE + bi)">✕</button>
              </span>
            </div>
          </div>
          <!-- 固定入口不在编排列表里：恒按「指令 → ⋯」跟在按钮末尾（满页时顺延到新一页） -->
          <p class="mt-1 flex items-center gap-1 text-[11px] text-zinc-500">
            固定入口：
            <span class="tsc-chip tsc-static opacity-60" title="快捷指令面板入口，恒在按钮之后">指令</span>
            <span class="tsc-chip tsc-static opacity-60" title="工具条设置入口，恒为最后一项">⋯ 设置</span>
          </p>

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
      </div>

      <!-- —— 指令：管理「指令」面板条目（增删改 / 拖手柄调序）—— -->
      <div v-else>
        <p class="mb-2 text-xs text-muted-foreground">
          点「指令」面板里的条目即发送整条命令并回车；拖左侧手柄调序，改动只保存在本浏览器。
        </p>

        <div class="max-h-[46vh] overflow-y-auto pr-0.5 scroll-thin">
          <p v-if="!quickCmds.length && !qcFormOpen" class="px-1 py-5 text-center text-xs text-muted-foreground">
            还没有指令
          </p>
          <div class="mb-2 flex flex-col gap-1">
            <div
              v-for="(c, i) in quickCmds"
              :key="c.id"
              class="qcc-row flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 py-1 pl-0.5 pr-1"
              :class="{ 'qcc-drag': qcDragArmed && qcDragIdx === i }"
              :data-idx="i"
            >
              <span class="qcc-grip" title="拖动调序" @pointerdown.stop.prevent="qcGripDown(i, $event)">
                <GripVertical class="size-4" />
              </span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-zinc-100">{{ c.label }}</span>
                <span class="block truncate font-mono text-[11px] text-zinc-400">{{ c.cmd }}</span>
              </span>
              <button
                type="button"
                class="qcc-act"
                title="编辑"
                @click="openCmdEdit(i)"
              ><Pencil class="size-3.5" /></button>
              <button
                type="button"
                class="qcc-act hover:text-red-400"
                title="删除"
                @click="rmCmd(i)"
              ><Trash2 class="size-3.5" /></button>
            </div>
          </div>

          <button v-if="!qcFormOpen" type="button" class="tsc-pool tsc-pool-on w-full" @click="openCmdAdd">
            <Plus class="size-3.5" /> 新增指令
          </button>

          <div v-else class="rounded-lg border border-zinc-700 p-2">
            <p class="mb-2 text-xs font-semibold text-muted-foreground">{{ qcEditIdx < 0 ? '新增指令' : '编辑指令' }}</p>
            <input
              ref="qcLabelInput"
              v-model="qcDraftLabel"
              class="mb-2 h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 text-xs text-zinc-100"
              placeholder="名称，如：web 部署"
              spellcheck="false"
              enterkeyhint="next"
              @keydown.enter.prevent="qcCmdInput?.focus()"
            />
            <input
              ref="qcCmdInput"
              v-model="qcDraftCmd"
              class="h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 font-mono text-xs text-zinc-100"
              placeholder="命令，如：cd ~/web && npm run build"
              spellcheck="false"
              enterkeyhint="done"
              @keydown.enter.prevent="saveCmdForm"
            />
            <p v-if="qcDup" class="mt-1 text-[11px] text-amber-400">名称重复</p>
            <div class="mt-2 flex justify-end gap-2">
              <button type="button" class="tsc-pool" @click="closeCmdForm">取消</button>
              <button
                type="button" class="tsc-pool tsc-pool-on disabled:opacity-40"
                :disabled="!qcCanSave"
                @click="saveCmdForm"
              >保存</button>
            </div>
          </div>
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
/* 固定入口只是展示，不能暗示可拖 */
.tsc-chip.tsc-static {
  cursor: default;
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
/* 指令行：只有手柄可拖（列表本身要能正常滚动）；行内操作按钮与 chip 的 ✕ 同语言 */
.qcc-row {
  user-select: none;
  -webkit-user-select: none;
}
.qcc-drag {
  opacity: 0.45;
  pointer-events: none;
}
.qcc-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.5rem;
  height: 2rem;
  flex-shrink: 0;
  color: #71717a;
  touch-action: none;
  cursor: grab;
}
.qcc-grip:active {
  cursor: grabbing;
  color: #a1a1aa;
}
.qcc-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
  border-radius: 0.375rem;
  color: #a1a1aa;
}
.qcc-act:active {
  background: #27272a;
  color: #e4e4e7;
}
</style>
