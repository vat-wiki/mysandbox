<script setup lang="ts">
// 容器文件编辑对话框：Monaco 大编辑空间 + Ctrl+S 保存 + mtime 乐观锁冲突处理。
// 二进制 / 超大文件只读提示。未保存关闭需确认（ConfirmDialog 复用）。
import { ref, computed, onMounted, defineAsyncComponent } from 'vue'
import { langForFilename } from '@/lib/monaco' // 具名导入本身会执行 monaco 副作用
import {
  readFile,
  writeFile,
  Unauthorized,
  ApiError,
  type FileView,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import ConfirmDialog from '@/components/ConfirmDialog.vue'

// Monaco 编辑器壳（本组件本身被 defineAsyncComponent 懒加载，monaco chunk 不进首屏）
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))

const props = defineProps<{
  containerId: string
  containerName: string
  path: string
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', path: string): void
}>()

const name = computed(() => props.path.slice(props.path.lastIndexOf('/') + 1))
const language = computed(() => langForFilename(name.value))

const loading = ref(true)
const meta = ref<FileView | null>(null) // binary/size 等元信息（binary 时不渲染编辑器）
const content = ref('')
const savedContent = ref('')
const mtime = ref<number | undefined>(undefined)
const busy = ref(false)
const err = ref('')
const savedFlash = ref(false) // 「已保存」短暂提示
const conflict = ref(false) // 409 后的冲突条（重载 / 覆盖）
const confirmDiscard = ref(false) // 未保存关闭的确认弹窗
const isNew = ref(false) // 新建态：读取 404 进入，保存成功后退出
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null

const dirty = computed(() => content.value !== savedContent.value)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const v = await readFile(props.containerId, props.path)
    meta.value = v
    isNew.value = false
    if (!v.binary) {
      content.value = v.content ?? ''
      savedContent.value = v.content ?? ''
      mtime.value = v.mtime
    }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    if (e instanceof ApiError && e.status === 404) {
      // 不存在 = 新建：空编辑器，无 mtime（不带乐观锁，保存即创建）。
      isNew.value = true
      meta.value = { path: props.path, name: name.value, size: 0, mtime: 0, binary: false }
      content.value = ''
      savedContent.value = ''
      mtime.value = undefined
    } else if (e instanceof ApiError && e.status === 413) {
      // 超大：保留元信息态展示只读提示
      meta.value = { path: props.path, name: name.value, size: 0, mtime: 0, binary: true }
    } else {
      err.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    loading.value = false
  }
}
onMounted(load)

async function save(overwrite = false) {
  if (busy.value || meta.value?.binary) return
  busy.value = true
  err.value = ''
  try {
    const r = await writeFile(
      props.containerId,
      props.path,
      content.value,
      overwrite ? undefined : mtime.value,
    )
    savedContent.value = content.value
    mtime.value = r.mtime ?? mtime.value
    isNew.value = false // 保存成功即不再是新建态
    conflict.value = false
    savedFlash.value = true
    if (savedFlashTimer) clearTimeout(savedFlashTimer)
    savedFlashTimer = setTimeout(() => (savedFlash.value = false), 1500)
    emit('saved', props.path)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    if (e instanceof ApiError && e.status === 409) {
      conflict.value = true
    } else {
      err.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    busy.value = false
  }
}

// 冲突两路：重载（丢弃本地改动）/ 覆盖（不带 baseMtime 强写）。
async function reload() {
  conflict.value = false
  busy.value = true
  try {
    const v = await readFile(props.containerId, props.path)
    if (v.binary) {
      meta.value = v
      return
    }
    content.value = v.content ?? ''
    savedContent.value = v.content ?? ''
    mtime.value = v.mtime
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
async function overwrite() {
  conflict.value = false
  await save(true)
}

// 关闭流程：脏改动先过确认。
function tryClose() {
  if (dirty.value && !meta.value?.binary) {
    confirmDiscard.value = true
    return
  }
  emit('close')
}
function doDiscard() {
  confirmDiscard.value = false
  emit('close')
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || tryClose()">
    <!-- h-[85vh] 显式高（不是 max-h）：flex-1 的 Monaco 容器需要父级有确定高度基准，
         max-h 只限不限撑，flex 子项会塌成内容高（实测 5px）。 -->
    <DialogContent class="flex h-[85vh] max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
      <!-- 头：文件名 + dirty 点 + 容器/路径 -->
      <div class="flex items-center gap-2.5 border-b px-5 py-3 pr-10">
        <DialogTitle class="font-mono text-base font-semibold">{{ name }}</DialogTitle>
        <span
          v-if="isNew"
          class="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary"
          >新建</span
        >
        <span
          v-if="dirty"
          class="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          title="有未保存改动"
        />
        <DialogDescription class="sr-only">编辑容器内文件</DialogDescription>
        <span
          class="ml-auto max-w-[50%] truncate font-mono text-[11px] text-muted-foreground"
          :title="`${containerName}:${path}`"
          >{{ containerName }}:{{ path }}</span
        >
      </div>

      <!-- 体 -->
      <div class="flex min-h-0 flex-1 flex-col">
        <p v-if="loading" class="px-5 py-8 text-center text-sm text-muted-foreground">加载中…</p>
        <template v-else-if="err">
          <p class="m-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ err }}</p>
        </template>
        <template v-else-if="meta?.binary">
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-8 text-muted-foreground">
            <p class="text-sm">二进制或非 UTF-8 文件，不支持在线编辑</p>
            <p v-if="meta.size" class="text-xs">大小 {{ fmtSize(meta.size) }}</p>
          </div>
        </template>
        <template v-else>
          <!-- 冲突条：文件在编辑期间被外部修改 -->
          <div
            v-if="conflict"
            class="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-5 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            <span class="min-w-0 flex-1">文件在编辑期间被修改（mtime 不一致）</span>
            <Button variant="outline" size="xs" :disabled="busy" @click="reload">重载（丢弃本地）</Button>
            <Button size="xs" :disabled="busy" @click="overwrite">覆盖保存</Button>
          </div>
          <p v-if="err" class="px-5 py-2 text-xs text-destructive">{{ err }}</p>
          <CodeEditor
            v-model="content"
            :language="language"
            class="min-h-0 flex-1"
            @save="() => save()"
          />
        </template>
      </div>

      <!-- 底部：状态 + 保存 -->
      <div class="flex items-center gap-3 border-t px-5 py-2.5">
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <span v-if="savedFlash" class="text-emerald-500">已保存</span>
          <span v-else-if="dirty" class="text-amber-500">未保存</span>
          <span v-else-if="isNew">新文件，保存时创建</span>
          <span v-else-if="meta && !meta.binary">{{ fmtSize(meta.size) }}</span>
        </span>
        <Button variant="outline" size="sm" @click="tryClose">关闭</Button>
        <Button size="sm" :disabled="!dirty || busy || !!meta?.binary" @click="save()">
          {{ busy ? '保存中…' : '保存 (Ctrl+S)' }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-if="confirmDiscard"
    title="放弃未保存的修改？"
    :description="`${name} 有未保存的修改，关闭后将丢失。`"
    confirm-text="放弃修改"
    variant="destructive"
    @confirm="doDiscard"
    @close="confirmDiscard = false"
  />
</template>
