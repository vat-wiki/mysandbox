<script setup lang="ts">
// pane 间分隔条：拖动调整相邻两块的大小。默认竖直条（左右拖调宽度）；
// vertical=true 为水平条（上下拖调高度，用于上下分屏）。pointer 事件管理交给
// @vueuse/core 的 useDraggable，本组件只 emit 业务事件，父组件据此重算两侧 flex-grow 比例。
import { ref } from 'vue'
import { useDraggable } from '@vueuse/core'

const props = defineProps<{ vertical?: boolean }>()

const emit = defineEmits<{
  (e: 'dragstart', parentSize: number): void
  (e: 'drag', delta: number): void
  (e: 'dragend'): void
}>()

const handle = ref<HTMLElement>()
let startPos = 0
// useDraggable 监听 handle 的 pointerdown -> window 的 move/up（默认 draggingElement=window），
// 多指针/触屏/preventDefault 全包。注意：它返回的 position 是「元素该移到的绝对坐标」，
// 不是 delta——我们只要位移，故直接取回调第二参 event 的 clientX/Y 算 delta，不用 position。
useDraggable(handle, {
  preventDefault: true,
  onStart: (_pos, event) => {
    startPos = props.vertical ? event.clientY : event.clientX
    const parent = (event.currentTarget as HTMLElement).parentElement
    emit('dragstart', props.vertical ? (parent?.clientHeight ?? 0) : (parent?.clientWidth ?? 0))
  },
  onMove: (_pos, event) =>
    emit('drag', (props.vertical ? event.clientY : event.clientX) - startPos),
  onEnd: () => emit('dragend'),
})
</script>

<template>
  <div
    ref="handle"
    class="shrink-0 bg-border/60 hover:bg-primary/40"
    :class="vertical ? 'h-1 cursor-row-resize' : 'w-1 cursor-col-resize'"
    :title="vertical ? '拖动调整高度' : '拖动调整宽度'"
  />
</template>
