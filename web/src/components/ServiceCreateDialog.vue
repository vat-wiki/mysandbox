<script setup lang="ts">
// 新建 docker 服务：预设（postgres/redis/mysql）或自定义镜像。
// 提交走后台任务：POST 只做快校验 + 预占，拿到 jobId 即关窗——拉镜像进度、取消、
// 完成通知都在服务面板的任务区与全局 toast（lib/serviceJobs.ts），对话框不再等待。
import { ref, computed, watch, onMounted } from 'vue'
import {
  getServicePresets,
  createService,
  listContainers,
  listDockerImages,
  listServices,
  Unauthorized,
  type ServicePresetView,
  type DockerImageRef,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const emit = defineEmits<{ (e: 'created'): void; (e: 'close'): void }>()

const presets = ref<ServicePresetView[]>([])
const presetKey = ref('postgres')
const name = ref('')
const description = ref('')
const ipMode = ref<'auto' | 'manual' | string>('auto')
const manualIp = ref('')
const customImage = ref('')
const customVolume = ref('')
const customEnv = ref('')
const customCommand = ref('')
const envValues = ref<Record<string, string>>({})
const busy = ref(false)
const err = ref('')

// 撞名提示：服务重名是硬提示（后端必 409，同名任务进行中也会撞）；与 LXC 容器同名是
// 软提示（不同命名空间技术上允许，但 hosts 里会互相覆盖）。
const lxcNames = ref<Set<string>>(new Set())
const nameClash = computed(() => name.value.trim() !== '' && lxcNames.value.has(name.value.trim()))
const svcNames = ref<Set<string>>(new Set())
const svcClash = computed(() => name.value.trim() !== '' && svcNames.value.has(name.value.trim()))

// 宿主已有镜像：自定义镜像的候选（输入即过滤，选中即填）；也为预设标注「已在本地」。
const localImages = ref<DockerImageRef[]>([])
const imgOpen = ref(false)
const imgHighlight = ref(0)
const imgFiltered = computed(() => {
  const q = customImage.value.trim().toLowerCase()
  const list = q
    ? localImages.value.filter((i) => i.ref.toLowerCase().includes(q))
    : localImages.value
  return list.slice(0, 60) // 渲染上限，滚轮消化不了的量就靠输入收窄
})
watch(() => customImage.value, () => (imgHighlight.value = 0))

function pickImage(refName: string): void {
  customImage.value = refName
  imgOpen.value = false
}

// 镜像框 Enter 语义分层：候选开着先选候选，没候选才当提交。
function onImageKeydown(e: KeyboardEvent): void {
  if (imgOpen.value && imgFiltered.value.length) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      imgHighlight.value = Math.min(imgHighlight.value + 1, imgFiltered.value.length - 1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      imgHighlight.value = Math.max(imgHighlight.value - 1, 0)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      pickImage(imgFiltered.value[imgHighlight.value]!.ref)
      return
    }
  }
  if (e.key === 'Escape') imgOpen.value = false
  else if (e.key === 'Enter') submit()
}

// 预设默认名：名称空或还停留在别的预设默认名时代填（不覆盖用户手输）。
const PRESET_DEFAULT_NAME: Record<string, string> = { postgres: 'pg', redis: 'redis', mysql: 'mysql' }

// 自动分配的 IP 预览（status.pool 首个可用；创建时后端重算，进行中任务可能抢占，仅供预览）。
const nextIp = ref<string | null>(null)

onMounted(() => {
  getServicePresets()
    .then((v) => {
      presets.value = v.presets
      if (v.presets.length) presetKey.value = v.presets[0].key
    })
    .catch((e) => {
      if (e instanceof Unauthorized) emit('close')
    })
  listContainers()
    .then((v) => {
      lxcNames.value = new Set(v.items.map((c) => c.name))
    })
    .catch(() => {
      /* 提示功能，失败静默 */
    })
  listDockerImages()
    .then((v) => {
      localImages.value = v.images
    })
    .catch(() => {
      /* 候选提示，失败静默（候选列表为空） */
    })
  listServices()
    .then((v) => {
      svcNames.value = new Set(v.items.map((s) => s.name))
      nextIp.value = v.status.pool.free[0] ?? null
    })
    .catch(() => {
      /* 提示功能，失败静默 */
    })
})

const isCustom = computed(() => presetKey.value === 'custom')
const current = computed(() => presets.value.find((p) => p.key === presetKey.value))
// 预设镜像恰为宿主已有 → 创建时跳过拉取（后端 imageExistsLocal 判定），标注出来。
const currentImageLocal = computed(
  () => !!current.value && localImages.value.some((i) => i.ref === current.value!.image),
)

// 预设切换清掉上一预设的 env 值（不同预设的 required 集不同，残留值会误提交）；
// 名称按需代填。
watch(presetKey, () => {
  envValues.value = {}
  const def = isCustom.value ? '' : (PRESET_DEFAULT_NAME[presetKey.value] ?? '')
  if (def && (!name.value.trim() || Object.values(PRESET_DEFAULT_NAME).includes(name.value.trim()))) {
    name.value = def
  }
})

// custom env 文本框 → Record（每行 KEY=VALUE，坏行即时报错而非提交时）。
const customEnvOk = computed(() =>
  customEnv.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .every((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l)),
)

// custom 数据卷路径：可选，填了须为绝对路径（留空 = 不建卷，数据在容器可写层）。
const customVolumeOk = computed(() => !customVolume.value.trim() || customVolume.value.trim().startsWith('/'))

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
const nameOk = computed(() => NAME_RE.test(name.value.trim()))

const formOk = computed(() => {
  if (!nameOk.value || busy.value) return false
  if (isCustom.value) {
    if (!customImage.value.trim() || !customEnvOk.value || !customVolumeOk.value) return false
  } else {
    // required env 必须非空
    for (const u of current.value?.userEnv ?? []) {
      if (u.required && !envValues.value[u.key]?.trim()) return false
    }
  }
  return true
})

async function submit() {
  if (!formOk.value) return
  busy.value = true
  err.value = ''
  try {
    const env: Record<string, string> = {}
    if (isCustom.value) {
      for (const line of customEnv.value.split('\n')) {
        const s = line.trim()
        if (!s) continue
        const eq = s.indexOf('=')
        env[s.slice(0, eq)] = s.slice(eq + 1)
      }
    } else {
      for (const u of current.value?.userEnv ?? []) {
        const v = envValues.value[u.key]
        if (v?.trim()) env[u.key] = v.trim()
      }
    }
    await createService({
      name: name.value.trim(),
      preset: presetKey.value,
      image: isCustom.value ? customImage.value.trim() : undefined,
      volumePath: isCustom.value ? customVolume.value.trim() || undefined : undefined,
      env,
      command: isCustom.value ? customCommand.value.trim() || undefined : undefined,
      description: description.value || undefined,
      ip: ipMode.value === 'manual' ? manualIp.value.trim() || undefined : undefined,
    })
    emit('created') // 关窗；任务在面板任务区/全局 toast 跟进
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-2xl">
      <DialogHeader>
        <DialogTitle>新建应用容器</DialogTitle>
        <DialogDescription>
          单容器 + 固定 IP，不发布端口——容器内按服务名直连（hosts 自动注入）；数据卷预设自动带，自定义可选。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="s-preset">类型</Label>
          <!-- shadcn Select（reka-ui portal）：原生 <select> 的弹层由 OS 自绘，强制
               dark 主题下白底违和（此前「下拉框样式坏」的根因），换 token 化弹层。 -->
          <Select v-model="presetKey">
            <SelectTrigger id="s-preset" class="w-full">
              <SelectValue placeholder="选择类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectLabel>预设</SelectLabel>
                <SelectItem v-for="p in presets" :key="p.key" :value="p.key">{{ p.label }}</SelectItem>
              </SelectGroup>
              <SelectGroup>
                <SelectLabel>其它</SelectLabel>
                <SelectItem value="custom">自定义镜像</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <!-- 预设档案一屏给全：描述/镜像/端口/数据卷/直连提示，省得靠试。 -->
          <div v-if="current" class="space-y-0.5 rounded-md border bg-muted/30 p-2.5 text-xs leading-relaxed text-muted-foreground">
            <p>{{ current.description }}</p>
            <p class="font-mono">
              镜像 {{ current.image }}
              <span v-if="currentImageLocal" class="text-emerald-500">· 已在本地，跳过拉取</span>
              <template v-if="current.ports.length"> · 端口 {{ current.ports.join('/') }}</template>
              <template v-if="current.volumePath"> · 数据卷 {{ current.volumePath }}</template>
            </p>
            <p>{{ current.hint }}</p>
          </div>
        </div>

        <!-- 宽版双列：名称/描述并排，减少纵向滚动；手机自动退回单列。 -->
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label for="s-name">名称 *</Label>
            <Input id="s-name" v-model="name" placeholder="pg" @keydown.enter="submit()" />
            <p v-if="name && !nameOk" class="text-xs text-destructive">仅小写字母/数字/连字符，2-31 位</p>
            <p v-else-if="svcClash" class="text-xs text-destructive">已存在同名应用容器（进行中的同名任务也冲突）</p>
            <p v-else-if="nameClash" class="text-xs text-amber-600">
              与现有 LXC 容器同名——hosts 里会互相覆盖，建议换个名字
            </p>
          </div>

          <div class="space-y-1.5">
            <Label for="s-desc">描述</Label>
            <Input id="s-desc" v-model="description" placeholder="（可选）" @keydown.enter="submit()" />
          </div>
        </div>

        <div v-if="isCustom" class="space-y-1.5">
          <div class="space-y-1.5">
            <Label for="s-image">镜像 *</Label>
            <!-- 镜像 combobox：一个输入框吃两种来源——手打任意引用 / 从宿主已有镜像里
                 输入过滤 + 键盘选取（↑↓ 高亮、Enter 选）。自绘弹层走 token，不用
                 原生 <select>（OS 自绘弹层 dark 下白底违和）。daemon 不可达时退化纯输入框。 -->
            <div class="relative">
              <Input
                id="s-image"
                v-model="customImage"
                placeholder="输入引用，或从宿主已有镜像选择（如 postgres:17）"
                autocomplete="off"
                @focus="imgOpen = localImages.length > 0"
                @keydown="onImageKeydown"
                @blur="imgOpen = false"
              />
              <div
                v-if="imgOpen && imgFiltered.length"
                class="absolute left-0 right-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
              >
                <button
                  v-for="(img, i) in imgFiltered"
                  :key="img.ref"
                  type="button"
                  class="flex w-full items-baseline justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-xs"
                  :class="i === imgHighlight ? 'bg-accent text-accent-foreground' : ''"
                  @mousedown.prevent
                  @click="pickImage(img.ref)"
                  @mousemove="imgHighlight = i"
                >
                  <span class="min-w-0 truncate font-mono">{{ img.ref }}</span>
                  <span class="shrink-0 text-muted-foreground">{{ img.size }} · {{ img.createdSince }}</span>
                </button>
              </div>
            </div>
          </div>
          <div class="space-y-1.5">
            <Label for="s-volume">数据卷挂载路径</Label>
            <Input id="s-volume" v-model="customVolume" placeholder="（可选）如 /data——填了建 mysandbox-svc-<名> 卷" @keydown.enter="submit()" />
            <p v-if="customVolume && !customVolumeOk" class="text-xs text-destructive">须为绝对路径（/ 开头）</p>
            <p v-else class="text-xs text-muted-foreground">留空不建卷，数据写在容器可写层（重启不丢，删容器即丢）</p>
          </div>
          <div class="space-y-1.5">
            <Label for="s-env">环境变量</Label>
            <Textarea
              id="s-env"
              v-model="customEnv"
              placeholder="每行一条 KEY=VALUE"
              class="min-h-28 font-mono text-xs"
            />
            <p v-if="customEnv && !customEnvOk" class="text-xs text-destructive">
              存在格式不对的行（应为 KEY=VALUE）
            </p>
          </div>
          <div class="space-y-1.5">
            <Label for="s-cmd">命令</Label>
            <Input id="s-cmd" v-model="customCommand" placeholder="（可选）空格分词直接执行，无 shell" @keydown.enter="submit()" />
          </div>
        </div>

        <div v-else class="space-y-1.5">
          <template v-for="u in current?.userEnv ?? []" :key="u.key">
            <Label :for="`s-env-${u.key}`">{{ u.label }}{{ u.required ? ' *' : '' }}</Label>
            <Input
              :id="`s-env-${u.key}`"
              v-model="envValues[u.key]"
              :type="u.secret ? 'password' : 'text'"
              autocomplete="off"
              @keydown.enter="submit()"
            />
          </template>
        </div>

        <div class="space-y-1.5">
          <Label>IP</Label>
          <div class="flex flex-wrap items-center gap-3">
            <RadioGroup v-model="ipMode" class="flex items-center gap-4">
              <div class="flex items-center gap-1.5">
                <RadioGroupItem id="sip-auto" value="auto" />
                <Label for="sip-auto" class="font-normal">自动分配</Label>
              </div>
              <div class="flex items-center gap-1.5">
                <RadioGroupItem id="sip-manual" value="manual" />
                <Label for="sip-manual" class="font-normal">手动</Label>
              </div>
            </RadioGroup>
            <Input v-if="ipMode === 'manual'" v-model="manualIp" placeholder="10.88.0.210" class="max-w-48" @keydown.enter="submit()" />
            <span v-else class="text-xs text-muted-foreground">
              {{ nextIp ? `预计分配 ${nextIp}（池内首个可用）` : '取服务池首个可用 IP' }}
            </span>
          </div>
        </div>

        <div v-if="err" class="space-y-1">
          <p class="text-sm text-destructive">{{ err }}</p>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="busy" @click="emit('close')">取消</Button>
        <Button :disabled="!formOk" @click="submit">{{ busy ? '提交中…' : '创建并启动' }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
