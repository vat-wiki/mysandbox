<script setup lang="ts">
// 镜像管理面板：status 详情 + 构建/拉取/发布 三动作 + 内联流式日志（SSE）。
// 完成后 emit changed（让 header 徽标刷新）。鉴权失败 emit close（由 App 触发登出）。
import { ref, watch, nextTick, onMounted } from 'vue'
import {
  getImageStatus,
  streamImageBuild,
  streamImagePull,
  streamImagePush,
  Unauthorized,
  type ImageStatusView,
  type ImageProgressEvent,
} from '@/lib/api'
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
import ConfirmDialog from '@/components/ConfirmDialog.vue'

const emit = defineEmits<{ (e: 'close'): void; (e: 'changed'): void; (e: 'running', v: boolean): void }>()

const status = ref<ImageStatusView>({ exists: false })
const loading = ref(false)
// 当前进行中的操作：'' | 'build' | 'pull' | 'push'
const op = ref<'' | 'build' | 'pull' | 'push'>('')
const log = ref<string[]>([])
const err = ref('')
// pull/push 的 ref 输入；空=用 config 默认 ${registry}:${imageTag}
const pullRef = ref('')
const pushRef = ref('')
// 复制 id 的瞬时反馈
const copied = ref(false)
const logEl = ref<HTMLElement | null>(null)

async function refresh() {
  loading.value = true
  try {
    status.value = await getImageStatus()
    err.value = ''
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

// 日志区自动滚到底
watch(
  () => log.value.length,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

function appendLog(e: ImageProgressEvent) {
  if (e.type === 'done') {
    const r = e.result
    log.value.push(`[完成] ${r?.tag || r?.ref || 'ok'}`)
    return
  }
  if (e.type === 'error') {
    log.value.push(`[失败] ${e.message || ''}`)
    return
  }
  if (e.stream) log.value.push(e.stream)
  else if (e.status) log.value.push((e.id ? `${e.id}: ` : '') + e.status)
}

// 覆盖本地镜像的确认（首次构建不存在则免确认；push 始终确认——它对外发布）
// 返回确认文案，null 表示无需确认。实际确认由 ConfirmDialog 异步完成。
function overwriteConfirmDesc(which: 'build' | 'pull' | 'push'): string | null {
  if (which === 'push') return '将把本地镜像推送到 registry（对外发布）。'
  if (!status.value.exists) return null
  return `${which === 'build' ? '重建' : '拉取'}将覆盖本地当前镜像（运行中的容器不受影响，新建容器用新镜像）。`
}

// 待确认的操作：点动作后，若需要覆盖确认，先弹 ConfirmDialog，确认后再执行。
interface PendingOp {
  which: 'build' | 'pull' | 'push'
  desc: string
  fn: (onEvent: (e: ImageProgressEvent) => void) => Promise<void>
}
const pending = ref<PendingOp | null>(null)

async function run(
  which: 'build' | 'pull' | 'push',
  fn: (onEvent: (e: ImageProgressEvent) => void) => Promise<void>,
) {
  if (op.value) return
  const desc = overwriteConfirmDesc(which)
  if (desc) {
    pending.value = { which, desc, fn }
    return
  }
  await execRun(which, fn)
}

async function execRun(
  which: 'build' | 'pull' | 'push',
  fn: (onEvent: (e: ImageProgressEvent) => void) => Promise<void>,
) {
  op.value = which
  emit('running', true)
  log.value = []
  err.value = ''
  try {
    await fn(appendLog)
    await refresh()
    emit('changed')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    op.value = ''
    emit('running', false)
  }
}

// ConfirmDialog 确认后：执行暂存的操作
function onConfirmOverwrite() {
  if (!pending.value) return
  const { which, fn } = pending.value
  pending.value = null
  void execRun(which, fn)
}

const onBuild = () => run('build', (onEvent) => streamImageBuild({ noCache: false }, onEvent))
const onPull = () => run('pull', (onEvent) => streamImagePull(pullRef.value.trim() || undefined, onEvent))
const onPush = () => run('push', (onEvent) => streamImagePush(pushRef.value.trim() || undefined, onEvent))

function fmtSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 相对时间：「12 天前」。原始纳秒级 ISO 串（2026-08-02T11:27:36.623011401+08:00）没人想心算。
function fmtAgo(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
// id 缩短：sha256:fe8a…71 字符截断没法复制也没法读，展示前 19 位（sha256:xxxxxxxxxxxx），
// title 悬浮看全量、点击复制完整值。
function shortId(id: string): string {
  return id.length > 19 ? id.slice(0, 19) + '…' : id
}
async function copyId(id: string) {
  try {
    await navigator.clipboard.writeText(id)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* 非 HTTPS / 无权限：静默 */
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>镜像管理</DialogTitle>
        <DialogDescription>构建 / 拉取 / 发布基础镜像，构建日志实时流式显示。</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- 状态 -->
        <div v-if="loading" class="text-sm text-muted-foreground">读取状态…</div>
        <div v-else-if="status.exists && status.image" class="rounded-md border border-border p-3 text-xs">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full bg-emerald-500" />
            <span class="font-medium">镜像已就绪</span>
          </div>
          <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-muted-foreground">
            <dt>tags</dt><dd class="truncate">{{ status.image.repoTags.join(', ') || '—' }}</dd>
            <dt>size</dt><dd>{{ fmtSize(status.image.size) }}</dd>
            <dt>created</dt>
            <dd :title="status.image.created">{{ fmtAgo(status.image.created) }}</dd>
            <dt>id</dt>
            <dd
              class="cursor-pointer hover:text-foreground"
              :title="copied ? '已复制' : status.image.id + '（点击复制）'"
              @click="copyId(status.image.id)"
            >{{ copied ? '✓ 已复制' : shortId(status.image.id) }}</dd>
          </dl>
        </div>
        <div v-else class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          基础镜像本地不存在 —— 先「构建」或「拉取」一个，否则无法新建容器。
        </div>

        <!-- 动作 -->
        <div class="space-y-2">
          <div class="flex flex-wrap gap-2">
            <Button :disabled="!!op" @click="onBuild">
              {{ op === 'build' ? '构建中…' : '构建镜像' }}
            </Button>
            <Button :disabled="!!op" variant="outline" @click="onPull">
              {{ op === 'pull' ? '拉取中…' : '拉取' }}
            </Button>
            <Button :disabled="!!op" variant="outline" @click="onPush">
              {{ op === 'push' ? '发布中…' : '发布' }}
            </Button>
          </div>
          <div class="grid grid-cols-2 gap-2">
            <div>
              <Label for="img-pull-ref" class="text-xs text-muted-foreground">拉取 ref（空=默认）</Label>
              <Input id="img-pull-ref" v-model="pullRef" placeholder="${registry}:${imageTag}" class="h-8 text-xs" />
            </div>
            <div>
              <Label for="img-push-ref" class="text-xs text-muted-foreground">发布 ref（空=默认）</Label>
              <Input id="img-push-ref" v-model="pushRef" placeholder="${registry}:${imageTag}" class="h-8 text-xs" />
            </div>
          </div>
        </div>

        <!-- 流式日志 -->
        <div
          v-if="log.length || op"
          ref="logEl"
          class="h-48 overflow-auto rounded-md bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-100"
        >
          <pre v-for="(line, i) in log" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</pre>
          <pre v-if="op" class="animate-pulse text-zinc-400">▌</pre>
        </div>

        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <div class="flex justify-end">
        <Button variant="outline" @click="emit('close')">关闭</Button>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-if="pending"
    :title="pending.which === 'push' ? '发布镜像' : pending.which === 'build' ? '重建镜像' : '拉取镜像'"
    :description="pending.desc"
    confirm-text="继续"
    @confirm="onConfirmOverwrite"
    @close="pending = null"
  />
</template>
