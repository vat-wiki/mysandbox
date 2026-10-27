<script lang="ts">
// 手机底部面板：动作表 / 指令面板 / 工具条子弹框共用。
// 形态 = 移动端原生 action sheet：**带遮罩**的底部面板（压暗底层 → 注意力聚焦、避免误触穿透），
// 点遮罩即收，面板从底边滑入。与「移动端不开 dialog」不冲突——要去掉的是桌面式居中卡片，
// 底部 sheet 本来就是移动端语汇（2026-10-27 回补遮罩：去掉黑幕后点哪儿都像能继续操作，
// 反而比模态更难用）。
// 层级用语义化档位（字面量类，Tailwind 要能扫到），不要传任意 z 值。
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    open: boolean
    label?: string
    // panel：普通动作表；terminal：终端工具条之上；toolbar：工具条设置页之上（最高）
    layer?: 'panel' | 'terminal' | 'toolbar'
  }>(),
  { layer: 'panel' },
)

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

const zClass = computed(() =>
  props.layer === 'toolbar' ? 'z-[110]' : props.layer === 'terminal' ? 'z-[90]' : 'z-[70]',
)

function close() {
  emit('update:open', false)
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="translate-y-3 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-100 ease-in"
      leave-from-class="translate-y-0 opacity-100"
      leave-to-class="translate-y-3 opacity-0"
    >
      <div v-if="open" class="fixed inset-0" :class="zClass">
        <!-- 遮罩：短时聚焦选择需要压暗底层；点它即收（等于「取消」） -->
        <div class="absolute inset-0 bg-black/70" @click="close" />
        <div
          class="absolute inset-x-0 bottom-0 mx-auto max-h-[78dvh] w-full overflow-y-auto scroll-thin rounded-t-2xl border-t border-border/60 bg-background pb-[max(env(safe-area-inset-bottom),1rem)] shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.45)] sm:max-w-lg"
          role="dialog"
          :aria-modal="true"
          :aria-label="label"
        >
          <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
