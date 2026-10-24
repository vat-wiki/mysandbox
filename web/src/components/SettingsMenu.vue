<script setup lang="ts">
// 设置弹出菜单（侧栏底行 / rail 底列 / popout 顶栏 / 手机底栏共用的唯一设置入口）。
// 目录层从弹框降格为锚定按钮的 popup 列表——模态目录页给轻量配置不值得：
// AI 配置只给跳转（主区 AI 工作区页签，openAi 语义在 ContainerList）；
// TestLens / 集群 / 浏览器通知开 SettingsDialog 直落对应分区（大体量详情仍住弹框）。
// 「管理」组（模板/账户/批量配置）2026-10-22 起从系统容器分区头 ⋯ 菜单收编进来——
// 管理动作统一走设置一个路口（分区头只留刷新/新建两个高频直连钮）。
// 版本号收编在列表末行（2026-10-22 起，品牌块 / rail 展开键 tooltip / 手机抽屉底
// 不再重复展示）。触发按钮由使用方以默认插槽传入（各处样式不同，as-child 接管）。
import { Bell, Bot, Globe, Network, Settings2, Users, ListChecks } from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { baseLabel } from '@/lib/caps'

// ⚠️ showManage 的默认值必须显式给 true——Vue 对缺省的 Boolean prop 运行时按
// false 处理，「!== false 当开关」的写法会让管理组永远不渲染（实测踩过）。
withDefaults(
  defineProps<{
    // 弹出方向随锚点不同：侧栏底部向上（top）、rail/手机向右/上、顶栏向下（bottom）
    side?: 'top' | 'bottom' | 'left' | 'right'
    align?: 'start' | 'center' | 'end'
    // popout 是纯终端工作区：管理组（模板/账户/批量）对它无意义，隐藏防死项
    showManage?: boolean
  }>(),
  { showManage: true },
)

const emit = defineEmits<{
  (e: 'open-ai'): void
  (e: 'open-section', s: 'testlens' | 'cluster' | 'notify'): void
  (e: 'open-base'): void
  (e: 'open-accounts'): void
  (e: 'open-batch'): void
}>()

const appVersion = __APP_VERSION__
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child><slot /></DropdownMenuTrigger>
    <DropdownMenuContent :side="side" :align="align" class="w-56">
      <DropdownMenuItem @click="emit('open-ai')">
        <Bot class="size-4" /> AI 配置
      </DropdownMenuItem>
      <DropdownMenuItem @click="emit('open-section', 'testlens')">
        <Globe class="size-4" /> TestLens
      </DropdownMenuItem>
      <DropdownMenuItem @click="emit('open-section', 'cluster')">
        <Network class="size-4" /> 集群
      </DropdownMenuItem>
      <DropdownMenuItem @click="emit('open-section', 'notify')">
        <Bell class="size-4" /> 浏览器通知
      </DropdownMenuItem>
      <template v-if="showManage !== false">
        <DropdownMenuSeparator />
        <DropdownMenuItem @click="emit('open-base')">
          <Settings2 class="size-4" /> {{ baseLabel }}管理
        </DropdownMenuItem>
        <DropdownMenuItem @click="emit('open-accounts')">
          <Users class="size-4" /> 账户管理
        </DropdownMenuItem>
        <DropdownMenuItem @click="emit('open-batch')">
          <ListChecks class="size-4" /> 批量配置
        </DropdownMenuItem>
      </template>
      <DropdownMenuSeparator />
      <!-- 版本行：纯展示（非菜单项，点不出动作） -->
      <div class="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
        <img src="/logo.svg" alt="" class="size-3.5" />
        <span>版本 v{{ appVersion }}</span>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
