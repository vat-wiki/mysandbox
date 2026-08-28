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
