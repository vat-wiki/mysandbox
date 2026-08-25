<script setup lang="ts">
// 基座管理面板：状态详情 + 动作按钮 + 内联流式日志（SSE）。
// 「基座」= 新建容器的来源物 = 模板容器（clone/export/import）。
// 按钮由 caps.baseActions 决定，文案由 caps.baseKind 决定（见 web/src/lib/caps.ts）。
// 完成后 emit changed（让 header 徽标刷新）。鉴权失败 emit close（由 App 触发登出）。
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import {
  getBaseStatus,
  getBaseSize,
  streamBaseAction,
  listContainers,
  Unauthorized,
  type BaseAction,
  type BaseStatus,
  type BaseActionOpts,
  type BaseProgressEvent,
  type ContainerView,
} from '@/lib/api'
import { caps, baseLabel, hasBaseAction } from '@/lib/caps'
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

const status = ref<BaseStatus>({ kind: 'template', name: '', exists: false, ready: false })
const loading = ref(false)
// 当前进行中的动作（''=空闲）
const op = ref<BaseAction | ''>('')
const log = ref<string[]>([])
const err = ref('')
// 各动作的输入。空=用后端默认（export 取 ~/<模板>.tar.zst）
const archivePath = ref('')
const cloneFrom = ref('')
// 体积按需取（要遍历整个 rootfs，秒级）
const size = ref<number | null>(null)
const sizeLoading = ref(false)
const copied = ref('')
const logEl = ref<HTMLElement | null>(null)

async function refresh() {
  loading.value = true
  try {
    status.value = await getBaseStatus()
    size.value = status.value.size ?? null
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

// clone 的来源容器候选。自己拉而不是从 App 透 props：这是本面板独有的需求，
// 传下来只会让 App 多一份与它无关的状态。
const containers = ref<ContainerView[]>([])
onMounted(async () => {
  if (!hasBaseAction('clone')) return
  try {
    containers.value = (await listContainers()).items.filter((c) => c.name !== status.value.name)
  } catch (e) {
    if (e instanceof Unauthorized) emit('close')
  }
})

async function loadSize() {
  sizeLoading.value = true
  try {
    size.value = (await getBaseSize()).size
  } catch (e) {
    if (e instanceof Unauthorized) emit('close')
  } finally {
    sizeLoading.value = false
  }
}

// 日志区自动滚到底
watch(
  () => log.value.length,
  async () => {
    await nextTick()
    if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight
  },
)

function appendLog(e: BaseProgressEvent) {
  if (e.type === 'done') {
    const r = e.result || {}
    const parts = Object.entries(r).map(([k, v]) => `${k}=${v}`)
    log.value.push(`[完成] ${parts.join(' ') || 'ok'}`)
    return
  }
  if (e.type === 'error') {
    log.value.push(`[失败] ${e.message || ''}`)
    return
  }
  if (e.stream) log.value.push(e.stream)
  else if (e.status) log.value.push((e.id ? `${e.id}: ` : '') + e.status)
}

// 确认文案：会销毁/覆盖既有物的动作必须先确认。null = 无需确认。
function confirmDesc(action: BaseAction): string | null {
  const label = baseLabel.value
  if (action === 'export') return null // 只写一个文件，无破坏性
  if (!status.value.exists) return null // 首次制作，没有可覆盖的东西
  if (action === 'clone') {
    return `将销毁当前${label} ${status.value.name} 并用容器 ${cloneFrom.value} 重建它。已有容器不受影响，新建容器用新${label}。`
  }
  if (action === 'import') {
    return `将销毁当前${label} ${status.value.name} 并从包恢复。已有容器不受影响。`
  }
  return null
}

// force：clone/import 覆盖既有基座时后端要求显式 force（防误删模板）。
function optsFor(action: BaseAction): BaseActionOpts {
  if (action === 'export') return { path: archivePath.value.trim() || undefined, force: true }
  if (action === 'import') return { path: archivePath.value.trim() || undefined, force: true }
  if (action === 'clone') return { from: cloneFrom.value.trim(), force: true }
  return {}
}

interface PendingOp {
  action: BaseAction
  desc: string
}
const pending = ref<PendingOp | null>(null)

function start(action: BaseAction) {
  if (op.value) return
  if (action === 'clone' && !cloneFrom.value.trim()) {
    err.value = '先选一个要固化成模板的容器'
    return
  }
  if (action === 'import' && !archivePath.value.trim()) {
    err.value = '先填包路径'
    return
  }
  const desc = confirmDesc(action)
  if (desc) {
    pending.value = { action, desc }
    return
  }
  void exec(action)
}

async function exec(action: BaseAction) {
  op.value = action
  emit('running', true)
  log.value = []
  err.value = ''
  try {
    await streamBaseAction(action, optsFor(action), appendLog)
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

function onConfirm() {
  if (!pending.value) return
  const { action } = pending.value
  pending.value = null
  void exec(action)
}

// 动作按钮的中文名（顺序即渲染顺序，caps.baseActions 之外的不渲染）
const ACTION_TEXT: Record<BaseAction, { idle: string; busy: string }> = {
  clone: { idle: '从容器固化', busy: '克隆中…' },
  export: { idle: '导出包', busy: '打包中…' },
  import: { idle: '从包导入', busy: '导入中…' },
}
const ORDER: BaseAction[] = ['clone', 'import', 'export']
const actions = computed(() => ORDER.filter((a) => hasBaseAction(a)))
// 第一个动作是「主动作」（制作基座），用实心按钮；其余 outline。
const primary = computed(() => actions.value[0])

const title = computed(() => `${baseLabel.value}管理`)
const description = computed(() =>
  '模板容器 = 新建容器的来源（克隆它）。可从现有容器固化，或与 tar.zst 包互转。',
)

function fmtSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
// 长值（镜像 id / rootfs 路径）截断展示，title 悬浮看全量、点击复制。
function shortVal(v: string): string {
  return v.length > 30 ? `${v.slice(0, 29)}…` : v
}
async function copyVal(v: string) {
  try {
    await navigator.clipboard.writeText(v)
    copied.value = v
    setTimeout(() => (copied.value = ''), 1500)
  } catch {
    /* 非 HTTPS / 无权限：静默 */
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <!-- 状态 -->
        <div v-if="loading" class="text-sm text-muted-foreground">读取状态…</div>
        <div v-else-if="status.exists" class="rounded-md border border-border p-3 text-xs">
          <div class="flex items-center gap-2">
            <span
              class="h-2 w-2 rounded-full"
              :class="status.ready ? 'bg-emerald-500' : 'bg-amber-500'"
            />
            <span class="font-medium">{{ baseLabel }} {{ status.name }} {{ status.ready ? '已就绪' : '未就绪' }}</span>
          </div>
          <p v-if="status.notReady" class="mt-1 text-amber-600 dark:text-amber-500">
            {{ status.notReady }}
          </p>
          <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-muted-foreground">
            <template v-for="(v, k) in status.detail || {}" :key="k">
              <dt>{{ k }}</dt>
              <dd
                class="cursor-pointer truncate hover:text-foreground"
                :title="copied === v ? '已复制' : `${v}（点击复制）`"
                @click="copyVal(v)"
              >{{ copied === v ? '✓ 已复制' : shortVal(v) }}</dd>
            </template>
            <dt>size</dt>
            <dd>
              <span v-if="size != null">{{ fmtSize(size) }}</span>
              <button
                v-else
                type="button"
                class="cursor-pointer underline decoration-dotted hover:text-foreground"
                :disabled="sizeLoading"
                @click="loadSize"
              >{{ sizeLoading ? '计算中…' : '点击计算' }}</button>
            </dd>
            <template v-if="status.createdAt">
              <dt>created</dt>
              <dd :title="status.createdAt">{{ fmtAgo(status.createdAt) }}</dd>
            </template>
            <template v-if="status.context">
              <dt>from</dt>
              <dd class="truncate" :title="status.context">{{ status.context }}</dd>
            </template>
          </dl>
          <p v-if="status.contextError" class="mt-1 text-destructive">{{ status.contextError }}</p>
        </div>
        <div v-else class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          {{ status.notReady || `${baseLabel} ${status.name} 不存在` }}——否则无法新建容器。
        </div>

        <!-- 动作 -->
        <div class="space-y-2">
          <div class="flex flex-wrap gap-2">
            <Button
              v-for="a in actions"
              :key="a"
              :disabled="!!op"
              :variant="a === primary ? 'default' : 'outline'"
              @click="start(a)"
            >
              {{ op === a ? ACTION_TEXT[a].busy : ACTION_TEXT[a].idle }}
            </Button>
          </div>

          <!-- 动作参数 -->
          <div class="grid grid-cols-2 gap-2">
            <div v-if="hasBaseAction('clone')">
              <Label for="base-clone-from" class="text-xs text-muted-foreground">固化来源容器</Label>
              <select
                id="base-clone-from"
                v-model="cloneFrom"
                class="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
              >
                <option value="">选择容器…</option>
                <option v-for="c in containers" :key="c.name" :value="c.name">
                  {{ c.displayName || c.name }}
                </option>
              </select>
            </div>
            <div v-if="hasBaseAction('export') || hasBaseAction('import')">
              <Label for="base-archive" class="text-xs text-muted-foreground">包路径（空=~/{{ status.name }}.tar.zst）</Label>
              <Input id="base-archive" v-model="archivePath" placeholder="~/ms-template.tar.zst" class="h-8 text-xs" />
            </div>
          </div>
          <p v-if="hasBaseAction('clone')" class="text-xs text-muted-foreground">
            固化会先停掉来源容器（克隆要求它已停），完成后不自动重启。
          </p>
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
    :title="`${ACTION_TEXT[pending.action].idle}`"
    :description="pending.desc"
    confirm-text="继续"
    @confirm="onConfirm"
    @close="pending = null"
  />
</template>
