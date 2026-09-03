<script setup lang="ts">
// 通用命名输入弹窗：新建文件/新建文件夹/重命名共用（FilePanel 右键操作）。
// v-if 挂载天然重置状态：name 从 initial 起步，确认前本地校验，API 错误由调用方
// 通过 prop 传入展示（弹窗自身不发请求）。
import { ref, computed, nextTick } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{
  title: string
  desc?: string
  initial?: string
  okText?: string
  // 调用方异步提交期间的错误（同名 409 等）；为空不显示。busy 态禁提交。
  err?: string
  busy?: boolean
}>()
const emit = defineEmits<{ (e: 'confirm', name: string): void; (e: 'close'): void }>()

const name = ref(props.initial ?? '')
const inputEl = ref<HTMLInputElement | null>(null)
// 挂载后聚焦并全选（重命名场景旧名通常整体替换）。
nextTick(() => inputEl.value?.select())

const nameOk = computed(() => {
  const n = name.value.trim()
  return !!n && !n.includes('/')
})

function submit() {
  if (!nameOk.value || props.busy) return
  emit('confirm', name.value.trim())
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <!-- 单区布局：标题行右侧直接放动作按钮，无 footer——弹框就一个输入框，上下两段
         各占一行太空。X 关闭钮关掉（与「取消」重复且会压住右侧按钮），Esc/取消仍可达。 -->
    <DialogContent class="max-w-sm" :show-close-button="false">
      <DialogHeader class="flex-row items-center gap-2">
        <div class="min-w-0 flex-1">
          <DialogTitle>{{ title }}</DialogTitle>
          <DialogDescription v-if="desc" class="truncate">{{ desc }}</DialogDescription>
        </div>
        <div class="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="xs" :disabled="busy" @click="emit('close')">取消</Button>
          <Button size="xs" :disabled="!nameOk || busy" @click="submit">
            {{ busy ? '处理中…' : okText || '确定' }}
          </Button>
        </div>
      </DialogHeader>

      <div class="flex flex-col gap-1.5">
        <Label for="nd-name">名称</Label>
        <Input
          id="nd-name"
          ref="inputEl"
          v-model="name"
          @keydown.enter.prevent="submit"
        />
        <p v-if="name && !nameOk" class="text-xs text-destructive">名称不能包含 /</p>
        <p v-if="err" class="text-xs text-destructive">{{ err }}</p>
      </div>
    </DialogContent>
  </Dialog>
</template>
