<script setup lang="ts">
// 库技能多选列表（过滤 + 勾选行）——AiSpotDialog（文件面板就地装）与 SkillsHubTab
// （技能中心全局安装弹框）共用一份：行形状（勾选框 + 名称 + 快照徽标 + 描述）、
// 过滤、加载/空态都在这里；装到哪、范围语义归调用方（picked 状态与提交也归调用方）。
import { ref, computed } from 'vue'
import type { SkillRegistryItem } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Search, Loader2 } from 'lucide-vue-next'

const props = defineProps<{
  skills: SkillRegistryItem[] | null // null = 库还在加载
  picked: string[]
  emptyText?: string
}>()
const emit = defineEmits<{
  (e: 'toggle', name: string, on: boolean): void
}>()

const filter = ref('')
const filtered = computed(() =>
  (props.skills ?? []).filter(
    (s) => s.exists && (!filter.value.trim() || s.name.includes(filter.value.trim())),
  ),
)
</script>

<template>
  <div class="space-y-2">
    <div class="flex h-7 items-center gap-1.5 rounded-md border bg-muted/30 px-2">
      <Search class="size-3 shrink-0 text-muted-foreground" />
      <input
        v-model="filter"
        class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
        placeholder="过滤技能名…"
        @keydown.esc="filter = ''"
      />
    </div>
    <slot name="error" />
    <p v-if="skills === null" class="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
      <Loader2 class="size-3 animate-spin" /> 读取技能库…
    </p>
    <div
      v-else-if="!filtered.length"
      class="rounded-md border border-dashed px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground"
    >
      {{ emptyText ?? '技能库是空的。' }}
    </div>
    <div v-else class="scroll-thin max-h-72 space-y-0.5 overflow-y-auto pr-1">
      <label
        v-for="s in filtered"
        :key="s.name"
        class="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/50"
      >
        <Checkbox class="mt-0.5" :model-value="picked.includes(s.name)" @update:model-value="(v) => emit('toggle', s.name, !!v)" />
        <!-- 名字+快照一行、描述下方全宽两行截断（title 看全文）——描述挤名字右侧窄条会把每行撑到七八行高（实测走形） -->
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="shrink-0 font-mono">{{ s.name }}</span>
            <Badge
              variant="outline"
              class="shrink-0 border-transparent bg-muted px-1 text-[9px] text-muted-foreground"
              title="静态快照——来源改动不自动进库，更新在技能中心"
            >快照</Badge>
          </div>
          <p class="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground" :title="s.description">{{ s.description }}</p>
        </div>
      </label>
    </div>
  </div>
</template>
