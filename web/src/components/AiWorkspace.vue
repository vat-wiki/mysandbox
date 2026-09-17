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
const tabs = [
  { key: 'skills', label: '技能中心' },
  { key: 'providers', label: '模型供应商' },
  { key: 'agents', label: 'Agent 工具' },
] as const
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 头部：页签行——页的身份由底部 tab 栏的「AI 工具」页签表达，不再重复标题。
         页签用分段控件（与 Agent 工具页的工具切换同款）：选中底色明显，不只靠文字高亮 -->
    <div class="shrink-0 border-b">
      <div class="flex px-5 py-2">
        <div class="flex gap-0.5 rounded-md border bg-muted/30 p-0.5">
          <button
            v-for="t in tabs"
            :key="t.key"
            type="button"
            class="rounded px-3 py-1 text-xs transition-colors"
            :class="tab === t.key ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            @click="tab = t.key"
          >{{ t.label }}</button>
        </div>
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
