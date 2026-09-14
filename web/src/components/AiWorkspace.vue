<script setup lang="ts">
// AI 工具工作区：主区级页面（文件 tab 栏的单例 tab，VSCode 设置页模式）——管理面板
// 的体量（技能库/扫描/provider/工具分配/下发结果）早已超出对话框，抽屉也只是折中，
// 直接占主区：全尺寸、不遮挡侧栏、与文件 tab 同一套切换心智。
// 两个页签：技能（SkillsHubTab）/ 模型接入（AiAccessTab：provider 库+工具分配流水线）。
// 覆盖模式：容器卡片菜单「AI 配置…」（props.overrideFor）直落「模型接入」页签，
// 编辑对象是该目标的覆盖绑定（本机哨兵 __host__ 同页签，可返回全局）。
import { ref, computed } from 'vue'
import { Bot } from 'lucide-vue-next'
import SkillsHubTab from './SkillsHubTab.vue'
import AiAccessTab from './AiAccessTab.vue'
import { HOST_TARGET } from '@/lib/api'

const props = defineProps<{
  // 传入 = 覆盖模式（直落模型接入页签，表单编辑该目标的覆盖绑定）。
  overrideFor?: string | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'changed'): void // 配置保存（父级可刷新）
}>()

// 本机配置从全局面板内进入（localTarget），容器卡片菜单进来是 props.overrideFor。
const localTarget = ref<string | null>(null)
const activeTarget = computed(() => props.overrideFor ?? localTarget.value)
const tab = ref<'skills' | 'access'>(props.overrideFor ? 'access' : 'skills')
const targetLabel = (t: string) => (t === HOST_TARGET ? '本机' : t)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- 头部：标题 + 页签（覆盖模式免页签——只有模型接入一个任务） -->
    <div class="shrink-0 border-b">
      <div class="flex items-center gap-2 px-5 pt-3">
        <Bot class="size-4 shrink-0" />
        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold">
          {{ activeTarget ? `AI 配置 · ${targetLabel(activeTarget)}` : 'AI 工具' }}
        </h2>
      </div>
      <div v-if="!activeTarget" class="flex gap-1 px-5 pt-1.5">
        <button
          type="button"
          class="border-b-2 px-3 pb-2 text-xs transition-colors"
          :class="tab === 'skills' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'skills'"
        >技能</button>
        <button
          type="button"
          class="border-b-2 px-3 pb-2 text-xs transition-colors"
          :class="tab === 'access' ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = 'access'"
        >模型接入</button>
      </div>
    </div>

    <!-- 内容：居中限宽（表单可读），下发结果等宽块在限宽内也够用 -->
    <div class="scroll-thin min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-4xl px-6 py-5">
        <SkillsHubTab v-if="tab === 'skills'" @unauthorized="emit('unauthorized')" />
        <AiAccessTab
          v-else
          :target="activeTarget ?? undefined"
          :allow-back="!props.overrideFor && !!localTarget"
          @unauthorized="emit('unauthorized')"
          @done="emit('changed')"
          @configure-host="localTarget = HOST_TARGET"
          @back="localTarget = null"
        />
      </div>
    </div>
  </div>
</template>
