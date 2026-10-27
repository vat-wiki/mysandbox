// 新版本浮动胶囊（提示状态来自 lib/versionCheck.ts 的 staleVersion）：
// 「服务端已部署新版」的引导入口。形态两层——
//   胶囊：「⟳ 新版本 vX.Y.Z」，点按即整页刷新（终端会话有 msmux 服务端兜底、
//         编辑器有自动保存，刷新不丢东西）；手指拖拽甩出去（超过阈值）收成圆点。
//   圆点：收起后的极简存在——一个呼吸点，不占注意力也不彻底消失；点按重新展开胶囊。
// 摆位：右下角；窄视口（手机，md 以下）让开固定底栏（h-10 + pb-safe，见
// MobileBottomNav）抬高到栏上方，md 及以上贴 bottom-4。z-40：低于面板/抽屉/toast，
// 被任何弹层盖住是预期行为。
<script setup lang="ts">
import { ref, computed } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import { staleVersion } from '@/lib/versionCheck'

// collapsed：圆点态。dragging/offset：跟手拖拽的瞬态（松手即归零或收起）。
const collapsed = ref(false)
const dragging = ref(false)
const dx = ref(0)
const dy = ref(0)

// 拖拽超过该距离（任意方向）→ 甩走收成圆点；位移小于 TAP_SLOP 视为点按（刷新）。
const DRAG_AWAY = 32
const TAP_SLOP = 8

let startX = 0
let startY = 0
let moved = false

function onPointerDown(e: PointerEvent): void {
  dragging.value = true
  moved = false
  startX = e.clientX
  startY = e.clientY
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent): void {
  if (!dragging.value) return
  dx.value = e.clientX - startX
  dy.value = e.clientY - startY
  if (Math.abs(dx.value) > TAP_SLOP || Math.abs(dy.value) > TAP_SLOP) moved = true
}

function onPointerUp(): void {
  if (!dragging.value) return
  dragging.value = false
  if (Math.abs(dx.value) > DRAG_AWAY || Math.abs(dy.value) > DRAG_AWAY) collapsed.value = true
  dx.value = 0
  dy.value = 0
}

// 松手后的 click 在这里分流：拖过 = 吃掉（防误刷新），纯点按 = 刷新。
function onClick(): void {
  if (moved) return
  location.reload()
}

const dragStyle = computed(() =>
  dragging.value
    ? { transform: `translate(${dx.value}px, ${dy.value}px)`, transition: 'none', cursor: 'grabbing' }
    : {},
)
</script>

<template>
  <!-- 外层定位锚：胶囊与圆点共用同一右下角锚点，形态切换走内部 Transition -->
  <div v-if="staleVersion" class="fixed bottom-[calc(2.5rem+env(safe-area-inset-bottom,0px)+0.75rem)] right-4 z-40 md:bottom-4">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 scale-75"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="opacity-0 scale-75"
      mode="out-in"
    >
      <!-- 圆点态：呼吸点 + 大命中区（视觉圆 12px，命中区 40px） -->
      <button
        v-if="collapsed"
        key="dot"
        class="flex h-10 w-10 items-center justify-center"
        aria-label="展开新版本提示"
        @click="collapsed = false"
      >
        <span class="relative flex h-3 w-3">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
          <span class="relative inline-flex h-3 w-3 rounded-full bg-primary ring-2 ring-background" />
        </span>
      </button>

      <!-- 胶囊态：点按刷新 / 拖拽甩走 -->
      <button
        v-else
        key="pill"
        class="flex touch-none select-none items-center gap-1.5 rounded-full border border-primary/20 bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/25"
        aria-label="新版本已部署，点按刷新，拖拽可收起"
        :style="dragStyle"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @click="onClick"
      >
        <RefreshCw class="h-3.5 w-3.5" aria-hidden="true" />
        新版本 v{{ staleVersion }}
      </button>
    </Transition>
  </div>
</template>
