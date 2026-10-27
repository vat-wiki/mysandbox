<script setup lang="ts">
// 终端工具条设置页（手机全屏 / 桌面 dialog，路由承载）：移动端工具条的唯一配置入口。
// v0.14.0 重整：配置不再寄生在工具条的弹窗里，而是离开终端进入独立页；按键/指令改为
// 列表化——手柄拖动调序、行内编辑，取代原来的 2×7 chip 分页拖拽（跨页难拖、配置时工具条
// 已消失、入口藏在末页这些「怪」点）。
//
// 页内两个平级分区：
//   · 工具条按键：有序列表（前 14 个在第 1 页，溢出自动翻页），候选池点击追加；
//   · 快捷指令：「指令」面板的条目，点行编辑、手柄调序。
// 页头下方常驻「布局预览」：与真实工具条共用 toolbarPages 分页 + .tb 样式（同尺寸），
// 增删/拖拽即时反映，左右滑看分页；可收起给列表腾空间。
// 快捷短语已并入指令（v3 迁移，见 lib/termToolbar.ts）。数据即时落 localStorage，只影响本浏览器。
// 入口三处（设置菜单 / 工具条 ⋯ / 指令面板「配置」）统一走 lib/termToolbarNav.ts；
// section=cmds 时滚到指令分区。
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent as SheetContent,
  DialogTitle as SheetTitle,
  DialogClose,
} from 'reka-ui'
import { ChevronDown, ChevronLeft, ChevronUp, CircleDot, GripVertical, Keyboard, Pencil, Plus, Trash2, X } from '@lucide/vue'
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
  formatSeq,
  encodeKeyDown,
  KEY_POOL,
  TOOLBAR_MAX,
  TB_PER_PAGE,
  toolbarPages,
  type ToolbarItem,
  type ToolBtn,
} from '@/lib/termToolbar'

const props = defineProps<{ section?: 'keys' | 'cmds' }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const scrollEl = ref<HTMLElement | null>(null)
const cmdsSection = ref<HTMLElement | null>(null)

// —— 按键/指令的展示文案 ——
function btnKey(b: ToolBtn) {
  return b.t === 'key' ? `k:${b.id}` : `c:${b.label}`
}
function btnLabel(b: ToolBtn) {
  return b.t === 'key' ? (KEY_POOL[b.id]?.label ?? b.id) : b.label
}
function btnDesc(b: ToolBtn) {
  return b.t === 'key' ? (KEY_POOL[b.id]?.title ?? '') : `序列 ${formatSeq(b.seq)}`
}

// —— 布局预览：真实工具条同尺寸 ——
// 分页吃 lib/termToolbar.toolbarPages（与 usePhoneToolbar 同一份），样式复用 Terminal.vue
// 的全局 .tb/.tb-esc（同高 36px、同字号/边框）。预览只读：网格 pointer-events:none，
// 左右滑动交给外层 snap 容器；页点可点。
const previewCollapsed = ref(false)
const previewScroller = ref<HTMLDivElement | null>(null)
const previewPage = ref(0)
const previewPages = computed(() => toolbarPages(toolButtons.value))

function previewLabel(item: ToolbarItem) {
  if (item.t === 'key') return KEY_POOL[item.id]?.label ?? item.id
  if (item.t === 'custom') return item.label
  return item.t === 'cmds' ? '指令' : '⋯'
}
function onPreviewScroll() {
  const el = previewScroller.value
  if (!el) return
  const w = el.clientWidth
  if (w > 0) previewPage.value = Math.min(previewPages.value.length - 1, Math.max(0, Math.round(el.scrollLeft / w)))
}
function goPreviewPage(i: number) {
  const page = Math.max(0, Math.min(previewPages.value.length - 1, i))
  previewPage.value = page // 收起时也要记住页号（展开后按它复位）
  const el = previewScroller.value
  if (el && el.clientWidth > 0) el.scrollTo({ left: page * el.clientWidth, behavior: 'smooth' })
}
// 编辑按键时把预览带到该键所在页：拖动/新增后不用再手动翻页找变化
function previewPageOf(i: number) {
  return Math.max(0, Math.min(previewPages.value.length - 1, Math.floor(i / TB_PER_PAGE)))
}
function revealKeyPage(i: number) {
  const p = previewPageOf(i)
  if (p !== previewPage.value) goPreviewPage(p)
}
// 分页数变少（删键）时把预览页收回到最后一页
watch(
  () => previewPages.value.length,
  (n) => {
    if (previewPage.value <= n - 1) return
    previewPage.value = Math.max(0, n - 1)
    void nextTick(() => {
      const el = previewScroller.value
      if (el) el.scrollLeft = previewPage.value * el.clientWidth
    })
  },
)
// 展开/转屏后按当前页重新对位（v-show 收起期间 clientWidth 为 0，不能算）
function syncPreviewScroll() {
  const el = previewScroller.value
  if (el && el.clientWidth > 0) el.scrollLeft = previewPage.value * el.clientWidth
}
watch(previewCollapsed, (collapsed) => {
  if (!collapsed) void nextTick(syncPreviewScroll)
})
function onPreviewResize() {
  syncPreviewScroll()
}

// —— 候选池（添加快捷键 sheet）——
const pickerOpen = ref(false)
const poolEntries = computed(() => Object.entries(KEY_POOL))
const usedKeyIds = computed(() => new Set(toolButtons.value.flatMap((b) => (b.t === 'key' ? [b.id] : []))))
function addKeyFromPicker(id: string) {
  const before = toolButtons.value.length
  addKeyBtn(id)
  // 新键追加在末尾：预览跟到最后一页，关掉 sheet 就能看到它落在哪
  if (toolButtons.value.length !== before) void nextTick(() => goPreviewPage(previewPages.value.length - 1))
}

// —— 列表拖拽调序（按键 / 指令共用一套 window 监听）——
// 只有左侧手柄能起拖：行本体在指令区还要点击编辑，且列表必须能正常滚动。
// 拖动中关掉被拖行的 pointer-events，elementFromPoint 才能穿过它命中落点；
// 靠近滚动容器上下缘时自动滚动（长列表里把末项拖到首位不可能靠手速）。
type DragKind = 'keys' | 'cmds'
interface DragSession {
  id: number
  x: number
  y: number
  idx: number
  armed: boolean
  kind: DragKind
}
let ds: DragSession | null = null
let lastX = 0
let lastY = 0
let raf = 0
const dragKind = ref<DragKind | ''>('')
const dragIdx = ref<number | null>(null)
const dragArmed = ref(false)

function dragClass(kind: DragKind, i: number) {
  return dragArmed.value && dragKind.value === kind && dragIdx.value === i ? 'tt-drag' : ''
}
function startDrag(kind: DragKind, i: number, ev: PointerEvent) {
  if (ds || !ev.isPrimary) return
  ds = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, idx: i, armed: false, kind }
  lastX = ev.clientX
  lastY = ev.clientY
  dragKind.value = kind
  dragIdx.value = i
  dragArmed.value = false
  if (kind === 'keys') revealKeyPage(i)
  if (!raf) raf = requestAnimationFrame(autoScroll)
}
function moveItem(kind: DragKind, from: number, to: number) {
  if (from === to) return
  if (kind === 'keys') {
    if (from < 0 || to < 0 || from >= toolButtons.value.length || to >= toolButtons.value.length) return
    const [b] = toolButtons.value.splice(from, 1)
    toolButtons.value.splice(to, 0, b)
    return
  }
  if (from < 0 || to < 0 || from >= quickCmds.value.length || to >= quickCmds.value.length) return
  const [c] = quickCmds.value.splice(from, 1)
  quickCmds.value.splice(to, 0, c)
}
function hitTest() {
  if (!ds?.armed) return
  const sel = ds.kind === 'keys' ? '.tt-key-row' : '.tt-cmd-row'
  const under = document.elementFromPoint(lastX, lastY)?.closest(sel) as HTMLElement | null
  const to = Number(under?.dataset.idx)
  if (!under || Number.isNaN(to) || to === ds.idx) return
  moveItem(ds.kind, ds.idx, to)
  ds.idx = to
  dragIdx.value = to
  if (ds.kind === 'keys') revealKeyPage(to)
}
function onPointerMove(ev: PointerEvent) {
  if (!ds || ev.pointerId !== ds.id) return
  lastX = ev.clientX
  lastY = ev.clientY
  if (!ds.armed) {
    if (Math.hypot(ev.clientX - ds.x, ev.clientY - ds.y) < 6) return
    ds.armed = true
    dragArmed.value = true
  }
  hitTest()
}
function autoScroll() {
  raf = 0
  if (!ds) return
  if (ds.armed) {
    const el = scrollEl.value
    if (el) {
      const r = el.getBoundingClientRect()
      const edge = 64
      let dy = 0
      if (lastY < r.top + edge) dy = -Math.min(14, Math.ceil((r.top + edge - lastY) / 5))
      else if (lastY > r.bottom - edge) dy = Math.min(14, Math.ceil((lastY - (r.bottom - edge)) / 5))
      if (dy) {
        el.scrollTop += dy
        hitTest()
      }
    }
  }
  raf = requestAnimationFrame(autoScroll)
}
function finishDrag(persist: boolean) {
  if (!ds) return
  if (persist && ds.armed) saveConfig()
  ds = null
  dragKind.value = ''
  dragIdx.value = null
  dragArmed.value = false
  if (raf) {
    cancelAnimationFrame(raf)
    raf = 0
  }
}
function endDrag(ev: PointerEvent) {
  if (!ds || ev.pointerId !== ds.id) return
  finishDrag(true)
}
function abortDrag() {
  finishDrag(true)
}

// —— 自定义按键（标签 + 转义序列 / 物理键盘录制）——
const customOpen = ref(false)
const recording = ref(false)
const ckLabel = ref('')
const ckSeqRaw = ref('')
const ckInput = ref<HTMLInputElement | null>(null)
const ckDup = computed(() => {
  const l = (ckLabel.value || ckSeqRaw.value).trim()
  return !!l && toolButtons.value.some((b) => b.t === 'custom' && b.label === l)
})
const ckCanAdd = computed(() => {
  const label = (ckLabel.value || ckSeqRaw.value).trim()
  return !!label && !ckDup.value && !!parseSeq(ckSeqRaw.value) && toolButtons.value.length < TOOLBAR_MAX
})
function openCustom() {
  ckLabel.value = ''
  ckSeqRaw.value = ''
  recording.value = false
  customOpen.value = true
}
function closeCustom() {
  customOpen.value = false
  recording.value = false
  ckInput.value?.blur()
}
function addCustom() {
  if (!ckCanAdd.value) return
  addCustomKey(ckLabel.value || ckSeqRaw.value.trim(), parseSeq(ckSeqRaw.value))
  closeCustom()
  void nextTick(() => goPreviewPage(previewPages.value.length - 1))
}
// 点遮罩/X 关闭时也必须停录制与 blur——否则 window 捕获阶段的录制监听会继续吞按键
function onCustomSheetOpen(v: boolean) {
  if (!v) closeCustom()
}
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
  ckSeqRaw.value = formatSeq(enc.seq)
  recording.value = false
}

// —— 指令：表单（新增/编辑共用，名称重复禁用保存）——
const cmdFormOpen = ref(false)
const cmdEditIdx = ref(-1)
const cmdDraftLabel = ref('')
const cmdDraftCmd = ref('')
const cmdLabelInput = ref<HTMLInputElement | null>(null)
const cmdCmdInput = ref<HTMLInputElement | null>(null)
const cmdDup = computed(() => {
  const l = cmdDraftLabel.value.trim()
  return !!l && quickCmds.value.some((c, i) => i !== cmdEditIdx.value && c.label === l)
})
const cmdCanSave = computed(() => !!cmdDraftLabel.value.trim() && !!cmdDraftCmd.value.trim() && !cmdDup.value)
function openCmdAdd() {
  cmdEditIdx.value = -1
  cmdDraftLabel.value = ''
  cmdDraftCmd.value = ''
  cmdFormOpen.value = true
  nextTick(() => cmdLabelInput.value?.focus())
}
function openCmdEdit(i: number) {
  const c = quickCmds.value[i]
  if (!c) return
  cmdEditIdx.value = i
  cmdDraftLabel.value = c.label
  cmdDraftCmd.value = c.cmd
  cmdFormOpen.value = true
  nextTick(() => cmdLabelInput.value?.focus())
}
function saveCmd() {
  if (!cmdCanSave.value) return
  if (cmdEditIdx.value < 0) addQuickCmd(cmdDraftLabel.value, cmdDraftCmd.value)
  else updateQuickCmd(cmdEditIdx.value, cmdDraftLabel.value, cmdDraftCmd.value)
  closeCmd()
}
function closeCmd() {
  cmdFormOpen.value = false
  cmdDraftLabel.value = ''
  cmdDraftCmd.value = ''
  cmdLabelInput.value?.blur()
  cmdCmdInput.value?.blur()
}
function rmCmd(i: number) {
  rmQuickCmd(i)
  if (cmdFormOpen.value) closeCmd() // 删除会挪索引，正在编辑的表单直接收掉防错行
}
function onCmdSheetOpen(v: boolean) {
  if (!v) closeCmd()
}

// 页面关闭：子 sheet 开着时先让子层处理（Esc/遮罩），别一键退掉整页
function closePage() {
  if (pickerOpen.value || customOpen.value || cmdFormOpen.value) return
  emit('close')
}

onMounted(() => {
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', abortDrag)
  window.addEventListener('blur', abortDrag)
  window.addEventListener('resize', onPreviewResize)
  window.addEventListener('keydown', recordKeyDown, { capture: true })
  if (props.section === 'cmds') {
    void nextTick(() => requestAnimationFrame(() => cmdsSection.value?.scrollIntoView({ block: 'start' })))
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', endDrag)
  window.removeEventListener('pointercancel', abortDrag)
  window.removeEventListener('blur', abortDrag)
  window.removeEventListener('resize', onPreviewResize)
  window.removeEventListener('keydown', recordKeyDown, { capture: true })
  finishDrag(true)
})
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || closePage()">
    <DialogContent
      :show-close-button="false"
      class="z-[100] flex max-h-[85dvh] w-full max-w-lg flex-col gap-0 overflow-hidden border-border/60 bg-background p-0 max-md:h-dvh max-md:max-h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0 max-md:pt-safe"
    >
      <header class="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          class="flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
          title="返回"
          @click="closePage"
        >
          <ChevronLeft class="size-5" />
          <span class="sr-only">返回</span>
        </button>
        <DialogTitle class="min-w-0 flex-1 truncate text-base font-semibold">终端工具条</DialogTitle>
        <span class="pr-1 text-[11px] text-muted-foreground">仅本浏览器</span>
      </header>

      <!-- 布局预览：常驻页头下方，与真实工具条同尺寸（.tb 36px）/ 同一份分页；
           增删拖拽即时更新，左右滑看分页。收起后只留标题行，给列表让高度。 -->
      <section class="shrink-0 border-b border-border/60 px-3 py-2">
        <div class="mb-2 flex items-center justify-between gap-2">
          <p class="flex items-baseline gap-1.5 text-xs font-semibold">
            布局预览
            <span class="text-[11px] font-normal tabular-nums text-muted-foreground">
              第 {{ previewPage + 1 }}/{{ previewPages.length }} 页 · 同尺寸
            </span>
          </p>
          <button
            type="button"
            class="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground outline-none active:bg-accent"
            @click="previewCollapsed = !previewCollapsed"
          >
            {{ previewCollapsed ? '展开' : '收起' }}
            <ChevronUp v-if="!previewCollapsed" class="size-3.5" />
            <ChevronDown v-else class="size-3.5" />
          </button>
        </div>
        <div v-show="!previewCollapsed" class="rounded-xl border border-border/60 bg-black p-2">
          <div
            ref="previewScroller"
            class="flex snap-x snap-mandatory overflow-x-auto scroll-thin"
            @scroll.passive="onPreviewScroll"
          >
            <div v-for="(pg, pi) in previewPages" :key="pi" class="w-full shrink-0 snap-center">
              <div class="pointer-events-none grid grid-cols-7 gap-1">
                <span
                  v-for="(it, ii) in pg"
                  :key="`${pi}:${ii}`"
                  class="tb flex items-center justify-center overflow-hidden text-ellipsis whitespace-nowrap"
                  :class="{ 'tb-esc': it.t === 'key' && it.id === 'esc' }"
                >{{ previewLabel(it) }}</span>
              </div>
            </div>
          </div>
          <div v-if="previewPages.length > 1" class="mt-0.5 flex justify-center gap-0.5">
            <button
              v-for="(_, i) in previewPages"
              :key="i"
              type="button"
              class="flex size-5 items-center justify-center rounded-full outline-none"
              :aria-label="`第 ${i + 1} 页`"
              @click="goPreviewPage(i)"
            >
              <span class="size-1.5 rounded-full transition-colors" :class="i === previewPage ? 'bg-zinc-400' : 'bg-zinc-700'" />
            </button>
          </div>
        </div>
      </section>

      <div ref="scrollEl" class="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-thin px-3 pb-[max(env(safe-area-inset-bottom),1.5rem)]">
        <p class="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          工具条在软键盘弹出时显示，改动即时保存。列表顺序即按钮顺序：每页 2 行 × 7 键，前 {{ TB_PER_PAGE }} 个在第 1 页，
          超出自动翻页；按键之后固定跟「指令」「⋯」两个入口（也参与分页）。
        </p>

        <!-- —— 工具条按键 —— -->
        <section class="mt-5">
          <div class="flex items-baseline justify-between px-1">
            <h2 class="text-sm font-semibold">工具条按键</h2>
            <span class="text-[11px] tabular-nums text-muted-foreground">{{ toolButtons.length }}/{{ TOOLBAR_MAX }}</span>
          </div>
          <p class="mt-1 px-1 text-xs text-muted-foreground">按住左侧手柄上下拖动调序；点 ✕ 移除。</p>

          <ul class="mt-2 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            <li
              v-for="(b, i) in toolButtons"
              :key="btnKey(b)"
              class="tt-key-row flex min-h-14 items-center gap-1 pr-1.5"
              :class="dragClass('keys', i)"
              :data-idx="i"
            >
              <span class="tt-grip" title="拖动调序" @pointerdown.stop.prevent="startDrag('keys', i, $event)">
                <GripVertical class="size-4" />
              </span>
              <span class="min-w-0 flex-1 py-2">
                <span class="block truncate font-mono text-sm font-medium">{{ btnLabel(b) }}</span>
                <span class="block truncate text-xs text-muted-foreground">{{ btnDesc(b) }}</span>
              </span>
              <button type="button" class="tt-act hover:text-red-400" title="移除" @click="rmBtn(i)">
                <X class="size-4" />
              </button>
            </li>
            <li v-if="!toolButtons.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
              工具条还没有按键
            </li>
          </ul>

          <button
            type="button"
            class="mt-2 flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-muted-foreground outline-none transition-colors active:bg-accent disabled:opacity-40"
            :disabled="toolButtons.length >= TOOLBAR_MAX"
            @click="pickerOpen = true"
          >
            <Plus class="size-4" /> 添加快捷键
          </button>
          <p v-if="toolButtons.length >= TOOLBAR_MAX" class="mt-1 px-1 text-[11px] text-amber-400">
            已达上限 {{ TOOLBAR_MAX }} 个，先移除再添加
          </p>
          <button
            type="button"
            class="mt-1 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl text-xs text-muted-foreground outline-none transition-colors active:bg-accent"
            @click="openCustom"
          >
            <Keyboard class="size-3.5" /> 自定义按键（转义序列 / 录制）
          </button>
        </section>

        <!-- —— 快捷指令 —— -->
        <section ref="cmdsSection" class="mt-7">
          <div class="flex items-baseline justify-between px-1">
            <h2 class="text-sm font-semibold">快捷指令</h2>
            <span class="text-[11px] tabular-nums text-muted-foreground">{{ quickCmds.length }}</span>
          </div>
          <p class="mt-1 px-1 text-xs text-muted-foreground">
            「指令」面板里的条目（面板里点一下 = 发送整条命令并回车）；这里点行编辑，按住手柄调序。
          </p>

          <ul class="mt-2 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-card">
            <li
              v-for="(c, i) in quickCmds"
              :key="c.id"
              class="tt-cmd-row flex min-h-14 items-center gap-1 pr-1.5"
              :class="dragClass('cmds', i)"
              :data-idx="i"
            >
              <span class="tt-grip" title="拖动调序" @pointerdown.stop.prevent="startDrag('cmds', i, $event)">
                <GripVertical class="size-4" />
              </span>
              <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-2 text-left" @click="openCmdEdit(i)">
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium">{{ c.label }}</span>
                  <span class="block truncate font-mono text-xs text-muted-foreground">{{ c.cmd }}</span>
                </span>
                <Pencil class="size-3.5 shrink-0 text-muted-foreground/70" />
              </button>
              <button type="button" class="tt-act hover:text-red-400" title="删除" @click="rmCmd(i)">
                <Trash2 class="size-4" />
              </button>
            </li>
            <li v-if="!quickCmds.length" class="px-3 py-6 text-center text-xs text-muted-foreground">
              还没有快捷指令
            </li>
          </ul>

          <button
            type="button"
            class="mt-2 flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-sm text-muted-foreground outline-none transition-colors active:bg-accent"
            @click="openCmdAdd"
          >
            <Plus class="size-4" /> 新建指令
          </button>
        </section>
      </div>
    </DialogContent>
  </Dialog>

  <!-- 候选按键 -->
  <DialogRoot :open="pickerOpen" @update:open="(v: boolean) => (pickerOpen = v)">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[110] bg-black/70" />
      <SheetContent
        class="fixed inset-x-0 bottom-0 z-[110] mx-auto max-h-[78dvh] w-full max-w-lg overflow-y-auto scroll-thin rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl"
      >
        <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <SheetTitle class="text-base font-semibold">添加快捷键</SheetTitle>
          <DialogClose class="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogClose>
        </div>
        <p class="px-4 pb-2 text-xs text-muted-foreground">点击追加到工具条末尾；已添加的按键不可重复。</p>
        <div class="px-2 pb-2">
          <button
            v-for="[id, e] in poolEntries"
            :key="id"
            type="button"
            class="flex min-h-12 w-full items-center gap-2 rounded-xl px-3 text-left transition-colors active:bg-accent disabled:opacity-40"
            :disabled="usedKeyIds.has(id) || toolButtons.length >= TOOLBAR_MAX"
            @click="addKeyFromPicker(id)"
          >
            <span class="w-12 shrink-0 font-mono text-sm text-foreground">{{ e.label }}</span>
            <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">{{ e.title }}</span>
            <span v-if="usedKeyIds.has(id)" class="shrink-0 text-[11px] text-muted-foreground">已添加</span>
            <Plus v-else class="size-4 shrink-0 text-muted-foreground" />
          </button>
        </div>
      </SheetContent>
    </DialogPortal>
  </DialogRoot>

  <!-- 自定义按键 -->
  <DialogRoot :open="customOpen" @update:open="onCustomSheetOpen">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[110] bg-black/70" />
      <SheetContent
        class="fixed inset-x-0 bottom-0 z-[110] mx-auto w-full max-w-lg rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl"
      >
        <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <SheetTitle class="text-base font-semibold">自定义按键</SheetTitle>
          <DialogClose class="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogClose>
        </div>
        <div class="px-3 pb-1">
          <p class="mb-2 px-1 text-xs text-muted-foreground">
            标签显示在按钮上；序列支持 \e \xHH 等转义，或直接录制物理键盘。
          </p>
          <div class="flex gap-1">
            <input
              ref="ckInput"
              v-model="ckLabel"
              class="h-10 w-24 shrink-0 rounded-md border border-zinc-700 bg-zinc-950 outline-none focus:border-zinc-500 px-2 text-sm text-zinc-100"
              placeholder="标签"
              spellcheck="false"
              enterkeyhint="done"
              @keydown.enter.prevent="addCustom"
            />
            <input
              v-model="ckSeqRaw"
              class="h-10 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 outline-none focus:border-zinc-500 px-2 font-mono text-sm text-zinc-100"
              placeholder="序列：\e[5~ \x0c…"
              spellcheck="false"
              enterkeyhint="done"
              @keydown.enter.prevent="addCustom"
            />
          </div>
          <p v-if="ckDup" class="mt-1 px-1 text-[11px] text-amber-400">标签已存在</p>
          <button
            type="button"
            class="mt-2 flex items-center gap-1 text-xs"
            :class="recording ? 'text-amber-400' : 'text-muted-foreground hover:text-foreground'"
            @click="toggleRecord"
          >
            <CircleDot class="size-3.5" :class="recording ? 'animate-pulse' : ''" />
            {{ recording ? '录制中：按下要发送的按键组合（裸 Esc 退出）' : '录制按键（需物理键盘）' }}
          </button>
          <div class="mt-3 flex justify-end gap-2 pb-1">
            <button type="button" class="sheet-btn" @click="closeCustom">取消</button>
            <button type="button" class="sheet-btn sheet-btn-on disabled:opacity-40" :disabled="!ckCanAdd" @click="addCustom">
              添加
            </button>
          </div>
        </div>
      </SheetContent>
    </DialogPortal>
  </DialogRoot>

  <!-- 新建 / 编辑指令 -->
  <DialogRoot :open="cmdFormOpen" @update:open="onCmdSheetOpen">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[110] bg-black/70" />
      <SheetContent
        class="fixed inset-x-0 bottom-0 z-[110] mx-auto w-full max-w-lg rounded-t-2xl border-border/60 bg-background p-0 pb-[max(env(safe-area-inset-bottom),1rem)] shadow-2xl"
      >
        <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
        <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
          <SheetTitle class="text-base font-semibold">{{ cmdEditIdx < 0 ? '新建指令' : '编辑指令' }}</SheetTitle>
          <DialogClose class="flex size-8 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground">
            <X class="size-4" />
            <span class="sr-only">关闭</span>
          </DialogClose>
        </div>
        <div class="px-3 pb-1">
          <input
            ref="cmdLabelInput"
            v-model="cmdDraftLabel"
            class="mb-2 h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 outline-none focus:border-zinc-500 px-2.5 text-sm text-zinc-100"
            placeholder="名称，如：web 部署"
            spellcheck="false"
            enterkeyhint="next"
            @keydown.enter.prevent="cmdCmdInput?.focus()"
          />
          <input
            ref="cmdCmdInput"
            v-model="cmdDraftCmd"
            class="h-10 w-full rounded-md border border-zinc-700 bg-zinc-950 outline-none focus:border-zinc-500 px-2.5 font-mono text-sm text-zinc-100"
            placeholder="命令，如：cd ~/web && npm run build"
            spellcheck="false"
            enterkeyhint="done"
            @keydown.enter.prevent="saveCmd"
          />
          <p v-if="cmdDup" class="mt-1 text-[11px] text-amber-400">名称重复</p>
          <div class="mt-3 flex justify-end gap-2 pb-1">
            <button type="button" class="sheet-btn" @click="closeCmd">取消</button>
            <button type="button" class="sheet-btn sheet-btn-on disabled:opacity-40" :disabled="!cmdCanSave" @click="saveCmd">
              保存
            </button>
          </div>
        </div>
      </SheetContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.tt-key-row,
.tt-cmd-row {
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
/* 拖拽中的行：半透明 + 放手让 elementFromPoint 穿过自己命中落点 */
.tt-drag {
  opacity: 0.45;
  pointer-events: none;
}
/* 手柄：唯一可起拖的热区（列表本身照常滚动） */
.tt-grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2.75rem;
  flex-shrink: 0;
  color: #71717a;
  touch-action: none;
  -webkit-touch-callout: none;
  cursor: grab;
}
.tt-grip:active {
  color: #a1a1aa;
  cursor: grabbing;
}
/* 行内操作：比旧弹窗的 28~32px 放大，接近 44px 触控建议 */
.tt-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
  border-radius: 0.5rem;
  color: #a1a1aa;
}
.tt-act:active {
  background: rgba(255, 255, 255, 0.06);
  color: #e4e4e7;
}
/* 子 sheet 的按钮：与工具条按键同语言 */
.sheet-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 3.5rem;
  height: 2.5rem;
  padding: 0 0.75rem;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
  user-select: none;
}
.sheet-btn:active {
  background: #27272a;
}
.sheet-btn-on {
  border-color: #f59e0b;
  color: #fbbf24;
}
</style>
