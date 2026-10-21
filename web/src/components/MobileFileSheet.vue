<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

// 手机半屏文件 sheet：终端页上叠一块可拖高度的文件面板——上半终端继续活着（父级给
// 终端区让位后 xterm 的 ResizeObserver 自动 refit），下半浏览/预览，这是「边盯终端
// 边看文件」的移动端形态。三档吸附（30/50/70% 视口高，记忆上次档位）；把手拖动实时
// 上报像素高度，拖到 20% 以下视为关闭。无遮罩——sheet 只盖下半屏，上半终端仍可点
// 选、滚动、输入。
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'height', px: number): void
}>()

const SNAP_PCTS = [30, 50, 70]
const SNAP_KEY = 'mysandbox:file-sheet-snap'
function loadSnap(): number {
  try {
    const v = Number(localStorage.getItem(SNAP_KEY))
    return SNAP_PCTS.includes(v) ? v : 50
  } catch {
    return 50
  }
}
const snapPct = ref(loadSnap())
const heightPx = ref(0)
const dragging = ref(false)
let dragStartY = 0
let dragStartH = 0

function pxOf(pct: number): number {
  return Math.round((pct / 100) * window.innerHeight)
}
function applyHeight(px: number) {
  heightPx.value = px
  emit('height', px)
}
watch(
  () => props.open,
  (open) => {
    if (open) applyHeight(pxOf(snapPct.value))
    else emit('height', 0)
  },
  { immediate: true },
)
function onDragStart(ev: PointerEvent) {
  dragging.value = true
  dragStartY = ev.clientY
  dragStartH = heightPx.value
  ;(ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId)
}
function onDragMove(ev: PointerEvent) {
  if (!dragging.value) return
  // 向上拖（clientY 变小）增高；钳在 8%–78%，松手才吸附/关闭
  const h = dragStartH + (dragStartY - ev.clientY)
  applyHeight(Math.min(Math.max(h, pxOf(8)), pxOf(78)))
}
function onDragEnd() {
  if (!dragging.value) return
  dragging.value = false
  if (heightPx.value < window.innerHeight * 0.2) {
    emit('update:open', false)
    return
  }
  // 吸附最近档并记忆
  const cur = (heightPx.value / window.innerHeight) * 100
  snapPct.value = SNAP_PCTS.reduce((a, b) => (Math.abs(b - cur) < Math.abs(a - cur) ? b : a))
  try {
    localStorage.setItem(SNAP_KEY, String(snapPct.value))
  } catch {
    /* localStorage 不可用就只留内存态 */
  }
  applyHeight(pxOf(snapPct.value))
}
// 旋转/软键盘弹出等视口变化：按当前吸附档重算像素高（百分比基准跟着 innerHeight 走）
function onResize() {
  if (props.open) applyHeight(pxOf(snapPct.value))
}
window.addEventListener('resize', onResize)
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  emit('height', 0)
})
</script>

<template>
  <!-- 手机 only（父层 v-if 保证）。bottom 让位底栏（h-14 + safe-area，同 MobileBottomNav
       与主列的 max-md:pb-[calc(3.5rem+…)]），高度正好等于父级要给终端腾出的空间。 -->
  <div
    v-if="open"
    class="absolute inset-x-0 z-40 flex flex-col overflow-hidden rounded-t-2xl border-t bg-card text-card-foreground shadow-[0_-8px_24px_rgb(0_0_0/0.35)]"
    :style="{
      bottom: 'calc(3.5rem + env(safe-area-inset-bottom))',
      height: heightPx + 'px',
      transition: dragging ? 'none' : 'height 160ms ease',
    }"
  >
    <!-- 把手：命中区整条 40px 高（touch-none 防滚动抢手势） -->
    <div
      class="flex shrink-0 touch-none cursor-grab justify-center py-3 active:cursor-grabbing"
      @pointerdown="onDragStart"
      @pointermove="onDragMove"
      @pointerup="onDragEnd"
      @pointercancel="onDragEnd"
    >
      <div class="h-1.5 w-12 rounded-full bg-muted-foreground/40" />
    </div>
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <slot />
    </div>
  </div>
</template>
