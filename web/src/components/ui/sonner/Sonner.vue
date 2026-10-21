<script setup lang="ts">
// vue-sonner 的薄封装（对标 shadcn-vue registry 的 sonner 组件，但因 registry 拉取
// 失败手写）。项目无 next-themes/color-mode——全站强制 <html class="dark">，
// theme 直接硬编码 dark，不引主题库。样式直接 import 包自带的 css（其内部变量体系
// 与 tailwind 无耦合，不走 @theme 注入）。
import { Toaster as Sonner } from 'vue-sonner'
import 'vue-sonner/style.css'
</script>

<template>
  <Sonner
    class="toaster group"
    :theme="'dark'"
    :rich-colors="true"
    position="bottom-right"
    v-bind="$attrs"
  />
</template>

<!-- 长描述（报错截断残留的长 URL/路径）撑破气泡的兜底：允许任意断行 + 限高滚动。
     vue-sonner 自带样式对 description 是 pre-line，断不了无空格长 token。
     气泡本身是固定宽（--width 356px），手机（<390px 视口）右缘出界——钳到屏宽减边距。 -->
<style>
[data-sonner-toast] [data-description] {
  white-space: normal;
  overflow-wrap: anywhere;
  max-height: 7rem;
  overflow-y: auto;
}
@media (max-width: 640px) {
  [data-sonner-toaster] {
    width: calc(100vw - 2rem) !important;
    left: 1rem !important;
    right: auto !important;
  }
  [data-sonner-toast] {
    width: 100% !important;
  }
}
</style>
