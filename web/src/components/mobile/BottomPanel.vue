<script lang="ts">
// 手机底部面板：动作表 / 指令面板 / 工具条子弹框共用。
// 形态 = 移动端原生 action sheet：**带遮罩**的底部面板（压暗底层 → 注意力聚焦、避免误触穿透），
// 点遮罩即收，面板从底边滑入。与「移动端不开 dialog」不冲突——要去掉的是桌面式居中卡片，
// 底部 sheet 本来就是移动端语汇（2026-10-27 回补遮罩：去掉黑幕后点哪儿都像能继续操作，
// 反而比模态更难用）。
// 层级用语义化档位（字面量类，Tailwind 要能扫到），不要传任意 z 值。
// 根层显式 pointer-events:auto：宿主若是 reka modal Dialog（如工具条设置页），body 会被设
// pointer-events:none，teleport 到 body 的本组件会继承到——不补回去整个 sheet 点不动、滚不动。

// Esc 关闭的叠层序（feedback #65）：自绘 sheet 没有 reka FocusScope 的 onEscapeKeyDown，
// Esc 在 BottomPanel 补。多个 sheet 同开时一次 Esc 只关最顶一个——token 栈，开时入栈、
// 关/卸载时出栈，keydown 时核对栈顶。（终端键位发送走 xterm textarea 的捕获处理，不会
// 冒泡到这里，见 onEscKeydown 的编辑元素守卫。）
const escStack: symbol[] = []
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'

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

const escToken = Symbol('bottom-panel')
function onEscKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  // 只响应栈顶（最顶层的 sheet）：底层 sheet 不因穿透的 Esc 被连带收掉。
  if (escStack[escStack.length - 1] !== escToken) return
  // 编辑元素里的 Esc 不劫持（也不拦传播）：输入框/文本域/可编辑区域 Esc 常是「取消/退出」
  // 的应用语义（工具条设置页的表单等）；终端 textarea 的按键由 xterm 捕获转发前台程序。
  // 这些场景放行到各自的 target 处理器。
  const t = e.target as HTMLElement | null
  if (
    t &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  ) {
    return
  }
  e.preventDefault()
  // 捕获阶段拦下就收：document 捕获先于一切 bubble 监听（ContainerList 的 Esc 关文件
  // tab、reka Dialog 的关窗、快捷键录制之外的 window 级处理）——sheet 开着时 Esc 只归
  // sheet，一次按键不穿透关两层。
  e.stopPropagation()
  close()
}
watch(
  () => props.open,
  (v) => {
    if (v) {
      escStack.push(escToken)
      document.addEventListener('keydown', onEscKeydown, true)
    } else {
      const i = escStack.indexOf(escToken)
      if (i >= 0) escStack.splice(i, 1)
      document.removeEventListener('keydown', onEscKeydown, true)
    }
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  const i = escStack.indexOf(escToken)
  if (i >= 0) escStack.splice(i, 1)
  document.removeEventListener('keydown', onEscKeydown, true)
})
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
      <div v-if="open" class="pointer-events-auto fixed inset-0" :class="zClass">
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
