<script setup lang="ts">
// 删除容器专用 Dialog：合并原 confirm+prompt 两步为一个三态框。
//   1) 默认：仅删容器，保留 home 数据。
//   2) 勾「同时删除 home 数据」：弹出输入框，需输入容器名以确认才解锁删除按钮。
// 这修掉了原生版本的一个反直觉点——原 onDelete 点 confirm「取消」时 deleteData=false，
// 仍会继续删容器；这里取消就是真取消。
import { ref, watch } from 'vue'
import type { ContainerView } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{ container: ContainerView; busy?: boolean }>()
const emit = defineEmits<{
  (e: 'delete', payload: { deleteData: boolean; confirmName?: string }): void
  (e: 'close'): void
}>()

const deleteData = ref(false)
const confirmName = ref('')
// 每次挂载（选中不同容器）重置
watch(
  () => props.container.id,
  () => {
    deleteData.value = false
    confirmName.value = ''
  },
)

const name = () => props.container.name
const cueOk = () => confirmName.value === name()

function submit() {
  if (deleteData.value && !cueOk()) return
  emit('delete', {
    deleteData: deleteData.value,
    confirmName: deleteData.value ? confirmName.value : undefined,
  })
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>删除容器 {{ name() }}</DialogTitle>
        <DialogDescription>删除后无法恢复。容器内进程将被停止。</DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <label class="flex cursor-pointer items-start gap-2.5 text-sm">
          <!-- reka-ui Checkbox 的 v-model 是 checked，不是默认 modelValue -->
          <Checkbox v-model:checked="deleteData" class="mt-0.5" />
          <span>
            同时删除 home 数据
            <span class="block text-xs text-muted-foreground">勾选后，挂载的 home 目录数据将一并清除。</span>
          </span>
        </label>

        <div v-if="deleteData" class="space-y-1.5">
          <span class="text-xs text-destructive"
            >要同时删除 home 数据，请输入容器名 <code class="font-mono">{{ name() }}</code> 以确认：</span
          >
          <Input v-model="confirmName" :placeholder="name()" @keydown.enter="submit" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">取消</Button>
        <Button
          variant="destructive"
          :disabled="busy || (deleteData && !cueOk())"
          @click="submit"
        >{{ busy ? '删除中…' : '删除' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
