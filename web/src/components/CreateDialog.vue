<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  streamCreateContainer,
  getBaseHosts,
  listContainers,
  Unauthorized,
  type BaseProgressEvent,
  type BaseHostsView,
  type ContainerView,
} from '@/lib/api'
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const emit = defineEmits<{ (e: 'created'): void; (e: 'close'): void }>()

const name = ref('')
const description = ref('')
// git 身份不放这里：批量配置一次能管所有容器，逐个新建时填是重复劳动。
// 新建对话框回归容器本身的参数：名字/描述/IP/来源。
const ipMode = ref<'auto' | 'manual' | string>('auto')
const manualIp = ref('')
const busy = ref(false)
const err = ref('')

// 来源三选：模板（缺省，现状）/ 现有容器（lxc-copy 克隆，源在跑会先停）/ tar.zst 包（解包）。
const sourceKind = ref<'template' | 'container' | 'archive'>('template')
const sourceContainer = ref('')
const archivePath = ref('')
// 建容器现在走 SSE：busy 期间逐条进度滚在日志区（克隆/解包分钟级，不能干等）。
const log = ref<string[]>([])

// 来源容器候选：自己拉而不是从 App 透 props（BasePanel 同款取舍）。模板已被后端
// listManaged 排除——它就是「模板」来源的默认，再出现在候选里只会让人困惑。
const containers = ref<ContainerView[]>([])
onMounted(async () => {
  try {
    containers.value = (await listContainers()).items
  } catch (e) {
    if (e instanceof Unauthorized) emit('close')
    /* 拉不到候选不阻塞模板/包来源，Select 只是空的 */
  }
})

// hosts 来源：继承所选来源 rootfs（克隆原样复制/解包原样落地，缺省）/ 宿主 /etc/hosts（整体覆写）。
// 预览为只读展示（<details> 默认收起）——想改默认去改模板容器，这里不做编辑入口。
const hostsSource = ref<'template' | 'host'>('template')
const hostsPreview = ref<BaseHostsView | null>(null)
const hostsShown = computed(() => {
  if (hostsSource.value === 'host') return hostsPreview.value?.host
  // 「继承来源」随 sourceKind 切换：template/container/archive 各查各的
  if (sourceKind.value === 'container') return hostsPreview.value?.container
  if (sourceKind.value === 'archive') return hostsPreview.value?.archive
  return hostsPreview.value?.template
})

// 预览数据：挂载时查模板+宿主，来源切换/换容器/改路径时 debounce 重查当前来源
// （包预览要跑 tar，不值得每键一查）。
let previewTimer: ReturnType<typeof setTimeout> | null = null
async function refreshPreview() {
  const opts =
    sourceKind.value === 'container' && sourceContainer.value
      ? { container: sourceContainer.value }
      : sourceKind.value === 'archive' && archivePath.value.trim()
        ? { archive: archivePath.value.trim() }
        : {}
  try {
    hostsPreview.value = await getBaseHosts(opts)
  } catch (e) {
    if (e instanceof Unauthorized) emit('close')
    /* 预读失败不阻塞创建流程，预览显示读不到 */
  }
}
onMounted(refreshPreview)
watch([sourceKind, sourceContainer, archivePath], () => {
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(refreshPreview, 500)
})

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
const nameOk = computed(() => NAME_RE.test(name.value.trim()))

function onClose() {
  emit('close')
}

function appendLog(e: BaseProgressEvent) {
  if (e.type === 'done') {
    log.value.push(`[完成] ${e.result?.name ?? ''} ${e.result?.ip ?? ''}`.trim())
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
  if (!nameOk.value) {
    err.value = '名称不合法（^[a-z0-9][a-z0-9-]{1,30}$）'
    return
  }
  if (sourceKind.value === 'container' && !sourceContainer.value) {
    err.value = '先选一个来源容器'
    return
  }
  if (sourceKind.value === 'archive' && !archivePath.value.trim()) {
    err.value = '先填包路径'
    return
  }
  busy.value = true
  err.value = ''
  log.value = []
  streamCreateContainer(
    {
      name: name.value.trim(),
      description: description.value || undefined,
      ip: ipMode.value === 'manual' ? manualIp.value.trim() || undefined : undefined,
      hosts: hostsSource.value,
      source:
        sourceKind.value === 'container'
          ? { kind: 'container', name: sourceContainer.value }
          : sourceKind.value === 'archive'
            ? { kind: 'archive', path: archivePath.value.trim() }
            : undefined,
    },
    appendLog,
  )
    .then(() => emit('created'))
    .catch((e) => {
      if (e instanceof Unauthorized) emit('close')
      else err.value = e instanceof Error ? e.message : String(e)
    })
    .finally(() => {
      busy.value = false
    })
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle>新建容器</DialogTitle>
        <DialogDescription>配置名称、IP 与来源。</DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="c-name">名称 *</Label>
          <Input id="c-name" v-model="name" placeholder="web-2" :disabled="busy" />
          <p v-if="name && !nameOk" class="text-xs text-destructive">
            仅小写字母/数字/连字符，2-31 位
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="c-desc">描述</Label>
          <Input id="c-desc" v-model="description" placeholder="（可选）" :disabled="busy" />
        </div>

        <div class="space-y-1.5">
          <Label>来源</Label>
          <RadioGroup v-model="sourceKind" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="src-template" value="template" :disabled="busy" />
              <Label for="src-template" class="font-normal">模板</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="src-container" value="container" :disabled="busy" />
              <Label for="src-container" class="font-normal">现有容器</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="src-archive" value="archive" :disabled="busy" />
              <Label for="src-archive" class="font-normal">从包导入</Label>
            </div>
          </RadioGroup>
          <!-- shadcn Select（reka-ui portal）：原生 <select> 的弹层由 OS 自绘，强制 dark 下白底违和 -->
          <div v-if="sourceKind === 'container'" class="space-y-1">
            <Select v-model="sourceContainer">
              <SelectTrigger id="c-source-container" class="h-8 w-full" :disabled="busy">
                <SelectValue placeholder="选择容器…" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem v-for="c in containers" :key="c.name" :value="c.name">
                    {{ c.displayName || c.name }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <p class="text-xs leading-relaxed text-amber-600 dark:text-amber-500">
              克隆要求源容器已停止：会先停止它，完成后不自动重启。
            </p>
          </div>
          <div v-else-if="sourceKind === 'archive'" class="space-y-1">
            <Input
              id="c-archive-path"
              v-model="archivePath"
              placeholder="~/ms-template.tar.zst"
              :disabled="busy"
            />
            <p class="text-xs leading-relaxed text-muted-foreground">
              包内 idmap 按本机 subuid 重写，解包后照常改 IP 并启动。
            </p>
          </div>
        </div>

        <div class="space-y-1.5">
          <Label>IP</Label>
          <RadioGroup v-model="ipMode" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="ip-auto" value="auto" :disabled="busy" />
              <Label for="ip-auto" class="font-normal">自动分配</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="ip-manual" value="manual" :disabled="busy" />
              <Label for="ip-manual" class="font-normal">手动</Label>
            </div>
          </RadioGroup>
          <Input v-if="ipMode === 'manual'" v-model="manualIp" placeholder="10.88.10.30" :disabled="busy" />
        </div>

        <div class="space-y-1.5">
          <Label>hosts 来源</Label>
          <RadioGroup v-model="hostsSource" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="hosts-template" value="template" :disabled="busy" />
              <Label for="hosts-template" class="font-normal">继承来源</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="hosts-host" value="host" :disabled="busy" />
              <Label for="hosts-host" class="font-normal">宿主机</Label>
            </div>
          </RadioGroup>
          <details class="group rounded-md border bg-muted/30">
            <summary
              class="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <span
                class="transition-transform group-open:rotate-90"
                aria-hidden="true"
                >▸</span
              >
              预览所选源的内容
            </summary>
            <div class="border-t px-3 py-2">
              <pre
                v-if="hostsShown"
                class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground"
                >{{ hostsShown }}</pre
              >
              <p v-else class="text-[11px] text-muted-foreground">
                读取失败或来源不存在（模板未就绪 / 来源未选 / 宿主 /etc/hosts 不可读）。
              </p>
            </div>
          </details>
          <p class="text-xs leading-relaxed text-muted-foreground">
            想改默认 hosts 直接改模板容器；新建后也可在批量配置里整体覆写。
          </p>
        </div>

        <!-- SSE 进度：克隆/解包分钟级，逐条滚动 -->
        <div
          v-if="busy || log.length"
          class="max-h-32 overflow-auto rounded-md bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-100"
        >
          <pre v-for="(line, i) in log" :key="i" class="whitespace-pre-wrap break-all">{{ line }}</pre>
          <pre v-if="busy" class="animate-pulse text-zinc-400">▌</pre>
        </div>

        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="onClose">取消</Button>
        <Button :disabled="busy || !nameOk" @click="submit">
          {{ busy ? '创建中…' : '创建并启动' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
