<script setup lang="ts">
// AI 工具工作区：主区级页面（文件 tab 栏的单例 tab，VSCode 设置页模式）——管理面板
// 的体量（技能库/provider/工具分配/自身配置/下发结果）早已超出对话框，直接占主区：
// 全尺寸、不遮挡侧栏、与文件 tab 同一套切换心智。头部只有页签行——页的身份由底部
// tab 栏的「AI 工具」页签表达，工作区内不再重复一行标题。三个板块：
//   技能中心   = SkillsHubTab（技能库/扫描/安装位置）
//   模型供应商 = AiProvidersTab（provider 库：myapikey 默认在库 + 自定义接入）
//   Agent 工具 = AiAgentsTab（每 CLI 一卡：绑定 + 自身配置，Claude Code 优先）
// 三个板块都是单面板：面板头顶栏不放与页签重复的标题——只放图标 + 动作/描述
// （Agent 工具页是图标 + 工具分段切换控件）。页身份由页签表达，重复是噪声。
// 容器覆盖配置（临时任务）不在这里——走 AiOverrideDialog 弹框，按任务体量分层。
import { ref } from 'vue'
import SkillsHubTab from './SkillsHubTab.vue'
import AiProvidersTab from './AiProvidersTab.vue'
import AiAgentsTab from './AiAgentsTab.vue'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'changed'): void // 配置保存（父级可刷新）
}>()

const tab = ref<'skills' | 'providers' | 'agents'>('skills')
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 头部：只有页签行——页的身份由底部 tab 栏的「AI 工具」页签表达，不再重复标题 -->
    <div class="shrink-0 border-b">
      <div class="flex gap-1 px-5 pt-2.5">
        <button
          type="button"
          class="border-b-2 px-3 pb-2 text-xs transition-colors"
          :class="tab === 'skills' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'skills'"
        >技能中心</button>
        <button
          type="button"
          class="border-b-2 px-3 pb-2 text-xs transition-colors"
          :class="tab === 'providers' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'providers'"
        >模型供应商</button>
        <button
          type="button"
          class="border-b-2 px-3 pb-2 text-xs transition-colors"
          :class="tab === 'agents' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'agents'"
        >Agent 工具</button>
      </div>
    </div>

    <!-- 内容：居中限宽（表单可读），下发结果等宽块在限宽内也够用 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-6 py-5">
        <SkillsHubTab v-if="tab === 'skills'" @unauthorized="emit('unauthorized')" />
        <AiProvidersTab
          v-else-if="tab === 'providers'"
          @unauthorized="emit('unauthorized')"
          @done="emit('changed')"
        />
        <AiAgentsTab
          v-else
          @unauthorized="emit('unauthorized')"
          @done="emit('changed')"
          @switch-providers="tab = 'providers'"
        />
      </div>
    </div>
  </div>
</template>
