<script setup lang="ts">
// pane 间分隔条：拖动调宽。pointer 事件管理交给 @vueuse/core 的 useDraggable，
// 本组件只 emit 业务事件，父组件据此重算两 pane 的 flex-grow 比例。
import { ref } from 'vue'
import { useDraggable } from '@vueuse/core'

const emit = defineEmits<{
  (e: 'dragstart', parentWidth: number): void
  (e: 'drag', dx: number): void
  (e: 'dragend'): void
}>()

const handle = ref<HTMLElement>()
let startX = 0
// useDraggable 监听 handle 的 pointerdown -> window 的 move/up（默认 draggingElement=window），
// 多指针/触屏/preventDefault 全包。注意：它返回的 position 是「元素该移到的绝对坐标」，
// 不是 delta——我们只要位移，故直接取回调第二参 event 的 clientX 算 delta，不用 position。
useDraggable(handle, {
  preventDefault: true,
  onStart: (_pos, event) => {
    startX = event.clientX
    const parent = (event.currentTarget as HTMLElement).parentElement
    emit('dragstart', parent?.clientWidth ?? 0)
  },
  onMove: (_pos, event) => emit('drag', event.clientX - startX),
  onEnd: () => emit('dragend'),
})
</script>

<template>
  <div
    ref="handle"
    class="w-1 shrink-0 cursor-col-resize bg-border/60 hover:bg-primary/40"
    title="拖动调整宽度"
  />
</template>
