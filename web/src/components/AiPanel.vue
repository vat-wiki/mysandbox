<script setup lang="ts">
// AI 工具面板：三个页签——技能中心（库 + 安装规则，持续同步） / 模型服务（provider
// 库，N 个网关凭据端点） / 智能体配置（绑定分发：工具 → 模型服务，自动追平）。
// 覆盖模式两种入口：容器卡片菜单「AI 配置…」（props.overrideFor，无返回语义）与
// 全局面板里的「为本机配置」（本机哨兵 __host__，可返回全局）——都只开智能体配置
// 页签，编辑对象是该目标的覆盖绑定。
import { ref, computed } from 'vue'
import { Bot } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import SkillsHubTab from './SkillsHubTab.vue'
import AiProvidersTab from './AiProvidersTab.vue'
import AiBindingTab from './AiBindingTab.vue'
import { HOST_TARGET } from '@/lib/api'

const props = defineProps<{
  // 传入 = 覆盖模式（只显示智能体配置页签，表单编辑该目标的覆盖绑定）。
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

const tab = ref<'hub' | 'providers' | 'binding'>(props.overrideFor ? 'binding' : 'hub')
const targetLabel = (t: string) => (t === HOST_TARGET ? '本机' : t)
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="flex items-center gap-2 text-lg font-semibold">
          <Bot class="size-4" />
          {{ activeTarget ? `AI 配置 · ${targetLabel(activeTarget)}` : 'AI 工具' }}
        </DialogTitle>
        <DialogDescription class="sr-only">技能中心、模型服务与智能体配置</DialogDescription>
      </div>

      <Tabs v-model="tab" class="flex min-h-0 flex-1 flex-col gap-0">
        <div v-if="!activeTarget" class="border-b px-5 py-2.5">
          <TabsList class="gap-1">
            <TabsTrigger value="hub" class="px-3 text-xs">技能中心</TabsTrigger>
            <TabsTrigger value="providers" class="px-3 text-xs">模型服务</TabsTrigger>
            <TabsTrigger value="binding" class="px-3 text-xs">智能体配置</TabsTrigger>
          </TabsList>
        </div>

        <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <TabsContent v-if="!activeTarget" value="hub" class="mt-0">
            <SkillsHubTab @unauthorized="emit('unauthorized')" />
          </TabsContent>
          <TabsContent v-if="!activeTarget" value="providers" class="mt-0">
            <AiProvidersTab @unauthorized="emit('unauthorized')" @changed="emit('changed')" />
          </TabsContent>
          <TabsContent value="binding" class="mt-0">
            <AiBindingTab
              :target="activeTarget ?? undefined"
              :allow-back="!props.overrideFor && !!localTarget"
              @unauthorized="emit('unauthorized')"
              @done="emit('changed')"
              @configure-host="localTarget = HOST_TARGET"
              @back="localTarget = null"
            />
          </TabsContent>
        </div>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
