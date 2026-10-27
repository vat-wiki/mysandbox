<script lang="ts">
// 手机底部面板（非模态）：动作表 / 指令面板 / 工具条子弹框共用。
// 刻意不用 Dialog：不铺黑幕、不锁焦点、不挡整屏——面板从底边滑上来，点面板外即收。
// 透明点击层只负责「点外面」这一件事（视觉上不可见），点完随面板一起消失。
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
        <div class="absolute inset-0" @click="close" />
        <div
          class="absolute inset-x-0 bottom-0 mx-auto max-h-[78dvh] w-full overflow-y-auto scroll-thin rounded-t-2xl border-t border-border/60 bg-background pb-[max(env(safe-area-inset-bottom),1rem)] shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.45)] sm:max-w-lg"
          role="group"
          :aria-label="label"
        >
          <div class="mx-auto mt-2.5 h-1 w-10 rounded-full bg-muted-foreground/30" />
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
