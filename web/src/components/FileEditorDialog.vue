<script setup lang="ts">
// 容器文件编辑对话框：Monaco 大编辑空间 + Ctrl+S 保存 + mtime 乐观锁冲突处理。
// 二进制 / 超大文件只读提示。未保存关闭需确认（ConfirmDialog 复用）。
// diff prop 存在时切「git 变更对比」模式：getGitDiff 快照（左 HEAD 右工作区）、只读、
// 无保存/脏确认；各降级路径（单侧二进制/超大/缺失）只影响那一侧，双侧都不可渲染时
// 给「以普通方式打开」出口（emit open-normal，父级清 diff 重挂普通模式）。
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { langForFilename } from '@/lib/monaco' // 具名导入本身会执行 monaco 副作用
import { previewKind, previewMime, extOf } from '@/lib/preview'
import {
  readFile,
  writeFile,
  getGitDiff,
  downloadEntry,
  fetchFileBlob,
  Unauthorized,
  ApiError,
  type FileView,
  type GitDiffView,
} from '@/lib/api'
import { Music, Eye, Code } from 'lucide-vue-next'
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
const CodeDiffEditor = defineAsyncComponent(() => import('@/components/CodeDiffEditor.vue'))

const props = defineProps<{
  containerId: string
  containerName: string
  path: string
  /** git 对比模式：headPath 为 R 条目旧路径；存在即以 diff 快照打开 */
  diff?: { headPath?: string }
  /** 终端 Ctrl+点击带 `:行:列` 后缀时的定位目标（加载完成后 revealLineInCenter） */
  line?: number
  col?: number
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', path: string): void
  (e: 'open-normal'): void
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

// —— 在线预览（图片/视频/音频/PDF）——
// 走 download 端点整文件进内存 Blob（二进制安全、无 2MB 文本上限），objectURL 渲染。
// 只读：无编辑/保存/dirty 语义；关闭与重载时回收 objectURL。
const previewKindV = computed(() => (props.diff ? null : previewKind(name.value)))
const previewUrl = ref('')
const previewSize = ref(0)
// —— 文本型预览（svg / markdown）——
// 本体走 Monaco 文本编辑（源码可改），头部按钮在「编辑 / 预览渲染」间切换。
// 默认落在预览（svg 直接看形状、md 直接读排版，编辑是少数场景）；渲染用当前编辑内容
// 实时生成（改动立即可见），不落盘——想看保存后的效果先保存。
// 刻意用 data: URL 而非 blob:（两者都受控渲染，效果一致），避免与文件预览的 blob 生命周期混管。
const isSvg = computed(() => !props.diff && extOf(name.value) === 'svg')
const isMd = computed(() => !props.diff && ['md', 'markdown'].includes(extOf(name.value)))
const textPreview = ref(true)
function clearPreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = ''
  previewSize.value = 0
}
const svgUrl = computed(() => {
  if (!isSvg.value || !textPreview.value) return ''
  // encodeURIComponent 再包 data URL：SVG 内联的 < & > 不会打断 data: 头
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(content.value)}`
})

// —— markdown 渲染 ——
// marked（同步）+ DOMPurify 消毒：md 允许内联 HTML，落 v-html 前必须过 sanitizer。
// 相对图片引用浏览器解不了（download 端点走 header token，<img> 带不上）——渲染后把
// 相对路径的 <img> 换成 fetchFileBlob 的 objectURL：相对段相对 md 所在目录、`/` 开头
// 按容器路径原样，`..` 逐段归一化；同图只取一次流。
marked.setOptions({ gfm: true, breaks: true })
const mdHtml = computed(() => {
  if (!isMd.value || !textPreview.value) return ''
  return DOMPurify.sanitize(marked.parse(content.value, { async: false }))
})
const mdBody = ref<HTMLElement | null>(null)
let mdBlobUrls: string[] = []
let mdImgSeq = 0
function clearMdBlobs() {
  for (const u of mdBlobUrls) URL.revokeObjectURL(u)
  mdBlobUrls = []
}
function resolveMdImgPath(dir: string, src: string): string {
  const raw = src.startsWith('/') ? src : dir + src
  const parts: string[] = []
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}
async function hydrateMdImages() {
  const root = mdBody.value
  if (!root) return
  const seq = ++mdImgSeq // 内容重渲染后旧回调作废
  clearMdBlobs()
  const dir = props.path.slice(0, props.path.lastIndexOf('/') + 1)
  const srcs = new Map<string, Promise<string>>() // 同图去重
  for (const img of Array.from(root.querySelectorAll('img[src]'))) {
    const src = img.getAttribute('src') ?? ''
    if (!src || /^(https?:|data:|blob:)/i.test(src)) continue
    const target = resolveMdImgPath(dir, src)
    let p = srcs.get(target)
    if (!p) {
      p = fetchFileBlob(props.containerId, target, previewMime(target) ?? 'application/octet-stream')
        .then((b) => URL.createObjectURL(b))
        .catch(() => '')
      srcs.set(target, p)
    }
    void p.then((url) => {
      if (seq !== mdImgSeq || !url) return
      mdBlobUrls.push(url)
      img.setAttribute('src', url)
    })
  }
}
watch(mdHtml, () => void nextTick(hydrateMdImages))
onBeforeUnmount(() => {
  clearPreview()
  clearMdBlobs()
})

const dirty = computed(() => content.value !== savedContent.value)

// —— diff 模式状态 ——
const diffView = ref<GitDiffView | null>(null)
// 双侧都不可文本渲染：中央降级卡 + 「以普通方式打开」出口
const diffDead = computed(() => {
  const v = diffView.value
  if (!v) return false
  const bad = (s: typeof v.base) => s.binary === true || s.absent === 'too_large'
  return bad(v.base) && bad(v.work)
})
// 单侧降级说明条文案（null = 双侧正常，不渲染）
const diffNotice = computed(() => {
  const v = diffView.value
  if (!v) return null
  const say = (s: typeof v.base, which: string): string | null => {
    if (s.binary) return `${which}侧为二进制/非 UTF-8，无法对比`
    if (s.absent === 'too_large') return `${which}侧超过 2MB，已省略`
    return null
  }
  return say(v.base, '左（HEAD）') ?? say(v.work, '右（工作区）')
})

async function load() {
  loading.value = true
  err.value = ''
  try {
    if (props.diff) {
      await loadDiff()
      return
    }
    // 可预览类型（图片/视频/音频/PDF）：直接取流预览，不进 readFile 文本管线
    //（这类文件必是 binary，readFile 只会给死胡同卡，且大图会撞 2MB 上限）。
    // 404 也不进「新建态」——二进制文件没有新建语义，照常报错。
    if (previewKindV.value) {
      meta.value = null
      isNew.value = false
      const blob = await fetchFileBlob(
        props.containerId,
        props.path,
        previewMime(name.value) ?? 'application/octet-stream',
      )
      clearPreview()
      previewUrl.value = URL.createObjectURL(blob)
      previewSize.value = blob.size
      return
    }
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
    if (e instanceof ApiError && e.status === 404 && !previewKindV.value) {
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

async function loadDiff() {
  diffView.value = null
  const v = await getGitDiff(props.containerId, props.path, props.diff?.headPath)
  if (!v.repo) {
    // 点开期间仓库消失（罕见）：按普通文件打开兜底
    emit('open-normal')
    return
  }
  diffView.value = v
}
// diff prop 变化（父级从降级卡点「以普通方式打开」清掉 diff）时重走加载。
// path/containerId 变化由父级 :key 重建组件，不需要 watch。
watch(
  () => props.diff,
  () => {
    if (!props.diff) {
      diffView.value = null
      void load()
    }
  },
)
onMounted(load)

// —— :行:列 定位（终端 Ctrl+点击）——
// CodeEditor 是异步组件且只在内容加载完（loading=false 且非 binary/diff）才渲染，
// mount 事件在编辑器以初始 value 创建后触发，此时 reveal 已有效；binary/新建态（空内容）
// 钳到第 1 行无害。同一文件（key 未变）换行号不重建对话框，watch 重新定位。
const editorRef = ref<import('monaco-editor').editor.IStandaloneCodeEditor | null>(null)
function revealTarget() {
  const ed = editorRef.value
  if (!ed || props.line === undefined || props.diff) return
  const ln = Math.min(Math.max(1, props.line), ed.getModel()?.getLineCount() ?? 1)
  ed.revealLineInCenter(ln)
  ed.setPosition({ lineNumber: ln, column: Math.max(1, props.col ?? 1) })
  ed.focus()
}
function onEditorMount(ed: unknown) {
  editorRef.value = ed as import('monaco-editor').editor.IStandaloneCodeEditor
  revealTarget()
}
watch(() => [props.line, props.col], revealTarget)

// 侧内容取值：absent/binary 侧给空串（diff 视图里呈全增/全删形态，可读）。
// 参数可空：模板 diffDead 分支已保证 diffView 非空，但类型上不体现，这里兜住。
function sideText(s: { content?: string } | null | undefined): string {
  return s?.content ?? ''
}
function fmtBytes(n?: number): string {
  if (!n) return ''
  return n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
}

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

// 关闭流程：脏改动先过确认（diff 只读快照无脏态，直接关）。
function tryClose() {
  if (!props.diff && dirty.value && !meta.value?.binary) {
    confirmDiscard.value = true
    return
  }
  emit('close')
}
function doDiscard() {
  confirmDiscard.value = false
  emit('close')
}

// 预览态的下载出口：复用 downloadEntry（落盘保存），失败进对话框错误条。
async function downloadPreview() {
  try {
    await downloadEntry(props.containerId, props.path, name.value, false)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || tryClose()">
    <!-- h-[92vh] 显式高（不是 max-h）：flex-1 的 Monaco 容器需要父级有确定高度基准，
         max-h 只限不限撑，flex 子项会塌成内容高（实测 5px）。7xl 宽：编辑/diff 双栏
         都需要横向空间（diff 并排视图尤甚）。手机全屏（100dvh + 铺满视口）。 -->
    <DialogContent
      class="flex h-[100dvh] max-h-none flex-col gap-0 overflow-hidden p-0 max-md:max-w-none max-md:rounded-none sm:h-[92vh] sm:max-h-[92vh] sm:max-w-7xl"
    >
      <!-- 头：文件名 + dirty 点 + 容器/路径 -->
      <div class="flex items-center gap-2.5 border-b px-5 py-3 pr-10">
        <DialogTitle class="font-mono text-base font-semibold">{{ name }}</DialogTitle>
        <span
          v-if="diff"
          class="shrink-0 rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-400"
          title="git 变更对比（左 HEAD · 右 工作区）"
          >对比</span
        >
        <span
          v-if="previewKindV"
          class="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
          title="浏览器在线预览（只读）"
          >预览</span
        >
        <span
          v-if="(isSvg || isMd) && textPreview"
          class="shrink-0 rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-400"
          >预览</span
        >
        <span
          v-if="diff?.headPath && diff.headPath !== path"
          class="max-w-40 shrink-0 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          :title="diff.headPath"
          >{{ diff.headPath.slice(diff.headPath.lastIndexOf('/') + 1) }} →</span
        >
        <span v-else-if="isNew" class="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">新建</span>
        <span
          v-if="!diff && dirty"
          class="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          title="有未保存改动"
        />
        <DialogDescription class="sr-only">编辑容器内文件</DialogDescription>
        <span
          class="ml-auto max-w-[50%] truncate font-mono text-[11px] text-muted-foreground"
          :title="`${containerName}:${path}`"
          >{{ containerName }}:{{ path }}</span
        >
        <!-- svg / md 专属：编辑 ⇄ 预览渲染切换（渲染实时反映编辑内容，未保存也可见） -->
        <Button
          v-if="isSvg || isMd"
          variant="ghost"
          size="xs"
          class="ml-2 shrink-0"
          @click="textPreview = !textPreview"
        >
          <Eye v-if="!textPreview" class="size-3.5" />
          <Code v-else class="size-3.5" />
          {{ textPreview ? '编辑' : '预览' }}
        </Button>
      </div>

      <!-- 体 -->
      <div class="flex min-h-0 flex-1 flex-col">
        <p v-if="loading" class="px-5 py-8 text-center text-sm text-muted-foreground">加载中…</p>
        <template v-else-if="err">
          <p class="m-4 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ err }}</p>
        </template>
        <!-- diff 模式 -->
        <template v-else-if="diff">
          <!-- 双侧都不可渲染：降级卡 + 普通打开出口 -->
          <div
            v-if="diffDead"
            class="flex flex-1 flex-col items-center justify-center gap-3 px-5 py-8 text-muted-foreground"
          >
            <p class="text-sm">两侧内容都无法对比（二进制 / 超过 2MB）</p>
            <p v-if="diffView" class="text-xs">
              左（HEAD）{{ diffView.base.binary ? '二进制' : fmtBytes(diffView.base.size) }} ·
              右（工作区）{{ diffView.work.binary ? '二进制' : fmtBytes(diffView.work.size) }}
            </p>
            <Button variant="outline" size="sm" @click="emit('open-normal')">以普通方式打开</Button>
          </div>
          <template v-else>
            <p
              v-if="diffNotice"
              class="shrink-0 border-b border-border bg-muted/30 px-5 py-1.5 text-[11px] text-muted-foreground"
            >
              {{ diffNotice }}
            </p>
            <CodeDiffEditor
              class="min-h-0 flex-1"
              :original="sideText(diffView?.base)"
              :modified="sideText(diffView?.work)"
              :language="language"
              :original-path="diff?.headPath ?? path"
              :modified-path="path"
            />
          </template>
        </template>
        <!-- 在线预览：图片 / 视频 / 音频 / PDF（objectURL，只读） -->
        <template v-else-if="previewKindV && previewUrl">
          <div
            v-if="previewKindV === 'image'"
            class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4"
          >
            <img :src="previewUrl" :alt="name" class="max-h-full max-w-full object-contain" />
          </div>
          <div
            v-else-if="previewKindV === 'video'"
            class="flex min-h-0 flex-1 items-center justify-center bg-black/70 p-4"
          >
            <video :src="previewUrl" controls class="max-h-full max-w-full" />
          </div>
          <div
            v-else-if="previewKindV === 'audio'"
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4"
          >
            <Music class="size-10 text-muted-foreground/50" />
            <audio :src="previewUrl" controls class="w-80 max-w-full" />
          </div>
          <iframe
            v-else-if="previewKindV === 'pdf'"
            :src="previewUrl"
            :title="name"
            class="min-h-0 flex-1 border-0 bg-muted/20"
          />
        </template>
        <!-- 普通模式 -->
        <template v-else-if="meta?.binary">
          <div class="flex flex-1 flex-col items-center justify-center gap-2 px-5 py-8 text-muted-foreground">
            <p class="text-sm">二进制或非 UTF-8 文件，不支持在线编辑</p>
            <p v-if="meta.size" class="text-xs">大小 {{ fmtSize(meta.size) }}</p>
          </div>
        </template>
        <template v-else>
          <!-- svg 预览渲染：实时反映编辑内容（data URL，未保存也可见）。白底卡片：
               透明底 svg 在深色主题下白形状会糊掉，垫白最稳。
               必须带 isSvg 门——textPreview 初始 true，漏判会让所有文本文件都落进预览卡
               （Monaco 不挂载、且无切换按钮，编辑直接废掉） -->
          <div
            v-if="isSvg && textPreview"
            class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4"
          >
            <img
              :src="svgUrl"
              :alt="name"
              class="max-h-full max-w-full rounded border bg-white object-contain p-3 shadow-sm"
            />
          </div>
          <!-- md 预览：marked + DOMPurify 渲染当前编辑内容；走主题变量排版（长文阅读，
               不用 svg 那种白底卡），相对图片在 hydrateMdImages 里换 objectURL -->
          <div
            v-else-if="isMd && textPreview"
            ref="mdBody"
            class="md-body scroll-thin min-h-0 flex-1 overflow-auto px-8 py-5"
            v-html="mdHtml"
          />
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
              @mount="onEditorMount"
              @save="() => save()"
            />
          </template>
        </template>
      </div>

      <!-- 底部：状态 + 保存（diff 态是只读快照，无保存） -->
      <div class="flex items-center gap-3 border-t px-5 py-2.5">
        <span class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          <template v-if="diff">
            git 对比快照 · 左 HEAD · 右 工作区 · 只读
            <span v-if="diffView">（{{ fmtBytes(diffView.base.size) || '?' }} → {{ fmtBytes(diffView.work.size) || '?' }}）</span>
          </template>
          <template v-else>
            <span v-if="savedFlash" class="text-emerald-500">已保存</span>
            <span v-else-if="dirty" class="text-amber-500">未保存</span>
            <span v-else-if="isNew">新文件，保存时创建</span>
            <span v-else-if="previewKindV">在线预览 · {{ fmtSize(previewSize) }} · 只读</span>
            <span v-else-if="meta && !meta.binary">{{ fmtSize(meta.size) }}</span>
          </template>
        </span>
        <Button variant="outline" size="sm" @click="tryClose">关闭</Button>
        <Button v-if="previewKindV" variant="outline" size="sm" @click="downloadPreview">下载</Button>
        <Button v-if="!diff && !previewKindV" size="sm" :disabled="!dirty || busy || !!meta?.binary" @click="save()">
          {{ busy ? '保存中…' : '保存 (Ctrl+S)' }}
        </Button>
        <Button v-else variant="outline" size="sm" @click="emit('open-normal')">以普通方式打开</Button>
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

<style scoped>
/* markdown 排版：全走主题变量（深浅色自适应）。v-html 内容不吃 scoped 属性，
   一律经 :deep 下探；无 @tailwindcss/typography，手写这套就够预览用 */
.md-body {
  color: var(--color-foreground);
  font-size: 14px;
  line-height: 1.75;
}
.md-body :deep(h1),
.md-body :deep(h2),
.md-body :deep(h3),
.md-body :deep(h4) {
  margin: 1.4em 0 0.6em;
  font-weight: 600;
  line-height: 1.3;
}
.md-body :deep(h1:first-child),
.md-body :deep(h2:first-child),
.md-body :deep(h3:first-child) {
  margin-top: 0;
}
.md-body :deep(h1) {
  font-size: 1.6em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}
.md-body :deep(h2) {
  font-size: 1.35em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid var(--color-border);
}
.md-body :deep(h3) {
  font-size: 1.15em;
}
.md-body :deep(p) {
  margin: 0.7em 0;
}
.md-body :deep(a) {
  color: var(--color-sky-400);
  text-underline-offset: 3px;
}
.md-body :deep(ul),
.md-body :deep(ol) {
  margin: 0.7em 0;
  padding-left: 1.6em;
}
.md-body :deep(ul) {
  list-style: disc;
}
.md-body :deep(ol) {
  list-style: decimal;
}
.md-body :deep(li) {
  margin: 0.25em 0;
}
.md-body :deep(li > ul),
.md-body :deep(li > ol) {
  margin: 0.25em 0;
}
.md-body :deep(li:has(> input[type='checkbox'])) {
  list-style: none;
  margin-left: -1.2em;
}
.md-body :deep(input[type='checkbox']) {
  margin-right: 0.4em;
  accent-color: var(--color-primary);
}
.md-body :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.2em 1em;
  border-left: 3px solid var(--color-border);
  color: var(--color-muted-foreground);
}
.md-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.85em;
  background: var(--color-muted);
  border-radius: 4px;
  padding: 0.15em 0.4em;
}
.md-body :deep(pre) {
  margin: 0.9em 0;
  padding: 0.8em 1em;
  background: var(--color-muted);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow-x: auto;
  /* 代码块横向滚动条同 scroll-thin（v-html 里挂不了全局类，这里同款复刻） */
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
}
.md-body :deep(pre::-webkit-scrollbar) {
  width: 8px;
  height: 8px;
}
.md-body :deep(pre::-webkit-scrollbar-track) {
  background: transparent;
}
.md-body :deep(pre::-webkit-scrollbar-thumb) {
  background-color: var(--scroll-thumb);
  border-radius: 9999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.md-body :deep(pre::-webkit-scrollbar-thumb:hover) {
  background-color: var(--scroll-thumb-hover);
}
.md-body :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 12px;
  line-height: 1.6;
}
.md-body :deep(table) {
  margin: 0.9em 0;
  border-collapse: collapse;
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--color-border);
  padding: 0.35em 0.8em;
}
.md-body :deep(th) {
  background: var(--color-muted);
  font-weight: 600;
}
.md-body :deep(hr) {
  margin: 1.4em 0;
  border: 0;
  border-top: 1px solid var(--color-border);
}
.md-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}
</style>
