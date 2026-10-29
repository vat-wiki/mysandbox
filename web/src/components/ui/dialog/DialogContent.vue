<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { ChevronLeft, X } from "@lucide/vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DialogClose,
  DialogContent,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import DialogOverlay from "./DialogOverlay.vue"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(defineProps<DialogContentProps & { class?: HTMLAttributes["class"], showCloseButton?: boolean }>(), {
  showCloseButton: true,
})
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <DialogPortal>
    <DialogOverlay />
    <DialogContent
      data-slot="dialog-content"
      v-bind="{ ...$attrs, ...forwarded }"
      :class="
        cn(
          // 不放任何 sm:max-w-* 兜底：tailwind v4 的 media 变体在 CSS 里排在裸 max-w-* 之后，
          // 基础类的 sm:max-w-lg 会压过调用方传的 max-w-none/max-w-3xl（实测把大窗 Dialog 钉死在 512px）。
          // 宽度约束由调用方的 class 负责（w-full + max-w-[calc(100%-2rem)] 保住不溢出视口）。
          // 高度用裸类兜底 max-h + overflow：调用方自带 max-h/overflow-hidden 时经 twMerge 胜出，
          // 中小对话框（max-w-md 一族）在横屏手机上内容过高时自动可滚，无需逐个改。
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-[50%] left-[50%] z-50 grid max-h-[85dvh] w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto scroll-thin rounded-lg border p-6 shadow-lg duration-200',
          // 手机（max-md）一律渲染成整页而不是居中卡片：铺满视口、去圆角/边框/阴影、无缩放动画，
          // 只做轻微上推——「移动端不开 dialog 弹框」由底座兜底，各调用点不必逐个写 max-md:h-dvh。
          // 调用点自带的 max-md:*（h-dvh/rounded-none/pt-safe…）与之重复也无害（twMerge 去重）。
          // 左右内边距沿用基础 p-6；只把上下换成长度与安全区取大——整页形态下内容要避开刘海与 home indicator。
          // 自带 p-0 的整页（设置/批量/桌面/Claude 终端）用 max-md:py-0 抵消，避免整页里多出白边。
          // content-start：grid 默认 align-content:stretch 会把剩余高度均摊进 auto 行——整页
          // 形态下「返回」行与标题各自被撑出上百 px 空隙（桌面容器高随内容，从未暴露）。
          'max-md:top-0 max-md:left-0 max-md:content-start max-md:h-dvh max-md:max-h-none max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-none max-md:border-0 max-md:shadow-none max-md:pt-[max(env(safe-area-inset-top),1.5rem)] max-md:pb-[max(env(safe-area-inset-bottom),1.5rem)] max-md:data-[state=open]:zoom-in-100 max-md:data-[state=closed]:zoom-out-100 max-md:data-[state=open]:slide-in-from-bottom-2 max-md:data-[state=closed]:slide-out-to-bottom-2',
          props.class,
        )"
    >
      <!-- 手机整页形态用页内「返回」：悬浮 X 是桌面弹框的语汇，移动端页面顶栏一律是返回/关闭行。
           放在 grid/flex 第一项 = 标题上方一行；桌面隐藏（悬浮 X 仍在，见下）。 -->
      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-back"
        class="hidden w-fit items-center gap-0.5 rounded-lg py-1 pr-3 pl-0.5 text-sm text-muted-foreground outline-none active:bg-accent max-md:-mb-1 max-md:flex [&_svg]:pointer-events-none [&_svg]:shrink-0"
      >
        <ChevronLeft class="size-5" />
        返回
      </DialogClose>

      <slot />

      <DialogClose
        v-if="showCloseButton"
        data-slot="dialog-close"
        class="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none max-md:hidden [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
      >
        <X />
        <span class="sr-only">Close</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
