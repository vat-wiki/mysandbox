<script setup lang="ts">
// AI 工具面板：AI 相关「就位配置」的唯一入口。两个页签分工——
//   技能中心 = skills 多源聚合分发（server/skillSync.ts，持续同步 + watch）
//   AI 网关  = 网关/凭据批量下发（server/aiconfig.ts，一次性批量写 + 探测）
// 纯 UI 组合层：两个后端机制生命周期不同，刻意不合并（后端各管各的）。
import { ref } from 'vue'
import { Bot } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import SkillsHubTab from './SkillsHubTab.vue'
import AiGatewayForm from './AiGatewayForm.vue'

const props = defineProps<{
  // 可选容器全集（受管理/已纳入的），网关页签的勾选池（技能中心不分发到指定容器，
  // 它恒向全部受管容器分发）。
  containers: { id: string; label: string; ip?: string | null; state?: string | null }[]
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'changed'): void // 网关下发完成（父级可刷新）
}>()

const tab = ref<'hub' | 'gw'>('hub')
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="flex items-center gap-2 text-lg font-semibold">
          <Bot class="size-4" /> AI 工具
        </DialogTitle>
        <DialogDescription class="sr-only">技能中心与 AI 网关配置</DialogDescription>
      </div>

      <Tabs v-model="tab" class="flex min-h-0 flex-1 flex-col gap-0">
        <div class="border-b px-5 py-2.5">
          <TabsList class="gap-1">
            <TabsTrigger value="hub" class="px-3 text-xs">技能中心</TabsTrigger>
            <TabsTrigger value="gw" class="px-3 text-xs">AI 网关</TabsTrigger>
          </TabsList>
        </div>

        <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <TabsContent value="hub" class="mt-0">
            <SkillsHubTab @unauthorized="emit('unauthorized')" />
          </TabsContent>
          <TabsContent value="gw" class="mt-0">
            <AiGatewayForm
              :containers="props.containers"
              @unauthorized="emit('unauthorized')"
              @done="emit('changed')"
            />
          </TabsContent>
        </div>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
