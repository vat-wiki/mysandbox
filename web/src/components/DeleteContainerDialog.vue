<script setup lang="ts">
// 删除容器专用 Dialog。两种形态，由引擎能力 caps.dataInsideContainer 决定：
//
// A) docker（数据在宿主 bind mount，可与容器分离）——三态框：
//   1) 默认：仅删容器，保留 home 数据。
//   2) 勾「同时删除 home 数据」：弹输入框，需输入容器名确认才解锁删除按钮。
//   这修掉了原生版本的一个反直觉点——原 onDelete 点 confirm「取消」时 deleteData=false，
//   仍会继续删容器；这里取消就是真取消。
// B) LXC（home 在 rootfs 内，见 docs/lxc-migration.md D4）——数据无法保留：
//   删容器必然连数据一起删，所以没有可勾的选项，无条件要求输入容器名确认。
//   后端 lifecycle.deleteManaged 也强制同一条规则，前端只是把「为什么」讲清楚。
import { ref, computed, watch } from 'vue'
import type { ContainerView } from '@/lib/api'
import { caps } from '@/lib/caps'
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

// 数据必然一起删（LXC）：不给选项，直接进确认态。
const dataAlwaysGone = computed(() => caps.dataInsideContainer)
const deleteData = ref(false)
const confirmName = ref('')
// 需要输名确认的条件：显式勾了删数据，或引擎本身就留不住数据。
const needsCue = computed(() => dataAlwaysGone.value || deleteData.value)
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
  if (needsCue.value && !cueOk()) return
  emit('delete', {
    deleteData: dataAlwaysGone.value || deleteData.value,
    confirmName: needsCue.value ? confirmName.value : undefined,
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
        <!-- LXC：数据在容器内，说明清楚而非给一个假的「保留数据」选项 -->
        <p v-if="dataAlwaysGone" class="text-sm text-destructive">
          home 数据在容器内部，删除容器会<strong>同时删掉 /home/dev 下的全部数据</strong>，无法只删容器保留数据。
        </p>

        <label v-else class="flex cursor-pointer items-start gap-2.5 text-sm">
          <!-- reka-ui Checkbox 的 v-model 是 checked，不是默认 modelValue -->
          <Checkbox v-model:checked="deleteData" class="mt-0.5" />
          <span>
            同时删除 home 数据
            <span class="block text-xs text-muted-foreground">勾选后，挂载的 home 目录数据将一并清除。</span>
          </span>
        </label>

        <div v-if="needsCue" class="space-y-1.5">
          <span class="text-xs text-destructive"
            >请输入容器名 <code class="font-mono">{{ name() }}</code> 以确认：</span
          >
          <Input v-model="confirmName" :placeholder="name()" @keydown.enter="submit" />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">取消</Button>
        <Button
          variant="destructive"
          :disabled="busy || (needsCue && !cueOk())"
          @click="submit"
        >{{ busy ? '删除中…' : '删除' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
