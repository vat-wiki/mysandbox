<script setup lang="ts">
// 容器导出为包：任意容器（不只模板）→ tar.zst。走 /api/base/export 的 SSE（from=容器名），
// 打包分钟级，进度逐条滚动。导出要求容器已停止——在跑时黄字提示，后端 conflict 兜底。
import { ref, watch, nextTick } from 'vue'
import { streamBaseAction, type BaseProgressEvent, type ContainerView } from '@/lib/api'
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
import InfoHint from '@/components/InfoHint.vue'

const props = defineProps<{ container: ContainerView }>()
const emit = defineEmits<{ (e: 'done'): void; (e: 'close'): void }>()

const path = ref('')
const busy = ref(false)
const err = ref('')
const done = ref('')
const log = ref<string[]>([])
const logEl = ref<HTMLElement | null>(null)

// 日志区自动滚到底（BasePanel 同款）
watch(
  () => log.value.length,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

function appendLog(e: BaseProgressEvent) {
  if (e.type === 'done') {
    const size = typeof e.result?.size === 'number' ? e.result.size : null
    log.value.push(
      `[完成] ${e.result?.path ?? ''}${size != null ? `（${(size / 1024 / 1024).toFixed(1)} MB）` : ''}`,
    )
    done.value = String(e.result?.path ?? '')
    return
  }
  if (e.type === 'error') {
    log.value.push(`[失败] ${e.message || ''}`)
    return
  }
  if (e.stream) log.value.push(e.stream)
  else if (e.status) log.value.push(e.status)
}

function submit() {
  busy.value = true
  err.value = ''
  done.value = ''
  log.value = []
  streamBaseAction('export', { from: props.container.name, path: path.value.trim() || undefined, force: true }, appendLog)
    .then(() => emit('done'))
    .catch((e) => {
      err.value = e instanceof Error ? e.message : String(e)
    })
    .finally(() => {
      busy.value = false
    })
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-1.5">
          导出为包
          <InfoHint tip="包内容 = config + rootfs" />
        </DialogTitle>
        <DialogDescription>
          把 {{ container.displayName || container.name }} 打包成 tar.zst，
          拷到别的机器用「从包导入」恢复。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="exp-path">包路径</Label>
          <Input
            id="exp-path"
            v-model="path"
            :placeholder="`~/${container.name}.tar.zst`"
            :disabled="busy"
          />
        </div>

        <p
          v-if="container.state === 'running'"
          class="text-xs leading-relaxed text-amber-600 dark:text-amber-500"
        >
          容器须已停止——运行中导出的包内容不可信。先停止它再导出。
        </p>

        <div
          v-if="busy || log.length"
          ref="logEl"
          class="max-h-36 overflow-auto rounded-md bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-100"
        >
          <pre v-for="(line, i) in log" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</pre>
          <pre v-if="busy" class="animate-pulse text-zinc-400">▌</pre>
        </div>

        <p v-if="done" class="text-xs text-muted-foreground">已导出：{{ done }}</p>
        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">关闭</Button>
        <Button :disabled="busy" @click="submit">
          {{ busy ? '打包中…' : '导出' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
