<script setup lang="ts">
// 模型名输入组合框：输入框恒在（自由输入不设限），右侧下拉手柄仅当探测到模型
// 清单时出现——点开是带过滤的选择面板，点选即回填。清单拉不到（网关不支持
// /models、网络失败）= 手柄不渲染，退化为普通输入框，两种形态零切换成本。
// 清单由父级探测传入（AiClaudeToolConfig 按所选模型供应商拉取），本组件纯受控。
import { ref, computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps<{
  modelValue: string
  models: string[]
  inputId?: string
  placeholder?: string
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

const open = ref(false) // 受控：点选后立即收起（Popover 只认点外部，内点选项不会自己关）
const filter = ref('')
const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return q ? props.models.filter((m) => m.toLowerCase().includes(q)) : props.models
})
function pick(m: string) {
  emit('update:modelValue', m)
  open.value = false
  filter.value = ''
}
</script>

<template>
  <div class="relative">
    <Input
      :id="inputId"
      :model-value="modelValue"
      :placeholder="placeholder"
      class="h-8 pr-8 font-mono text-xs"
      @update:model-value="(v) => emit('update:modelValue', String(v))"
    />
    <Popover v-if="models.length" v-model:open="open">
      <PopoverTrigger as-child>
        <button
          type="button"
          class="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          title="从模型清单选择"
          @click.prevent
        >
          <ChevronDown class="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" class="w-80 space-y-1 p-1.5">
        <Input v-model="filter" placeholder="过滤模型…" class="h-7 text-xs" />
        <div class="scroll-thin max-h-56 overflow-y-auto">
          <button
            v-for="m in filtered"
            :key="m"
            type="button"
            class="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs transition-colors hover:bg-muted"
            :class="m === modelValue && 'bg-muted/60 font-medium'"
            @click="pick(m)"
          >
            {{ m }}
          </button>
          <p v-if="!filtered.length" class="px-2 py-1.5 text-[11px] text-muted-foreground">无匹配模型</p>
        </div>
      </PopoverContent>
    </Popover>
  </div>
</template>
