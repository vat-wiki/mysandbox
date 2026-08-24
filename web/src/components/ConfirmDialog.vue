<script setup lang="ts">
// 通用确认/输入 Dialog：替代原生 window.confirm / window.prompt。
// 用法：父组件用一个 ref(pending) 挂 v-if，emit('confirm', value?) / emit('close')。
//   - 纯确认：只传 title/description/confirmText/variant，confirm 时 value=undefined。
//   - 取输入：传 input.placeholder/input.default/input.confirmCue，confirm 时 value=输入值。
//     input.confirmCue 非空时，输入等于 cue 才解锁确认按钮（用于危险操作「输入名字以确认」）。
import { ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  variant?: 'default' | 'destructive'
  // 传入则渲染输入框（prompt 模式）；不传则纯确认（confirm 模式）
  input?: {
    placeholder?: string
    default?: string
    // 输入等于此值才解锁确认（危险操作二次校验）
    confirmCue?: string
    label?: string
  }
  busy?: boolean
}>()
const emit = defineEmits<{
  (e: 'confirm', value: string | undefined): void
  (e: 'close'): void
}>()

const value = ref(props.input?.default ?? '')
// 每次打开（pending 从 null→对象挂载）都重置输入为默认值
watch(
  () => props.input,
  (inp) => {
    value.value = inp?.default ?? ''
  },
)

const needCue = () => !!props.input?.confirmCue
const cueOk = () => !needCue() || value.value === props.input?.confirmCue

function submit() {
  if (needCue() && !cueOk()) return
  emit('confirm', props.input ? value.value : undefined)
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">{{ description }}</DialogDescription>
      </DialogHeader>

      <div v-if="input" class="space-y-1.5">
        <Label v-if="input.label" :for="'confirm-input'">{{ input.label }}</Label>
        <Input
          id="confirm-input"
          v-model="value"
          :placeholder="input.placeholder"
          @keydown.enter="submit"
        />
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">{{
          cancelText || '取消'
        }}</Button>
        <Button
          :variant="variant === 'destructive' ? 'destructive' : 'default'"
          :disabled="busy || (needCue() && !cueOk())"
          @click="submit"
        >{{ busy ? '处理中…' : confirmText || '确认' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
