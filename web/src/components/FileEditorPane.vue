<script setup lang="ts">
// 容器文件编辑面板（tab 化后的内联编辑器，FileEditorDialog 的接棒者）：
// Monaco 大编辑空间 + 自动保存（停手 1.2s 落盘，Ctrl+S 立即冲一次）。
// mtime 乐观锁冲突处理：409 后自动保存暂停，等用户重载/覆盖，绝不静默覆盖外部改动。
// 二进制 / 超大文件只读提示。关闭走 tab 栏 X → requestClose()：先把防抖窗口内的改动
// 冲一遍，失败/冲突留在原处裁决；新建文件不参与自动落盘（误触即建文件太激进），
// 显式保存或关闭冲刷时才创建。
// diff prop 存在时切「git 变更对比」模式：getGitDiff 快照（左 HEAD 右工作区）、只读、
// 无保存/脏确认；各降级路径（单侧二进制/超大/缺失）只影响那一侧，双侧都不可渲染时
// 给「以普通方式打开」出口（emit open-normal，父级清 diff 重挂普通模式）。
// 所有打开的 tab 常驻 DOM（父级 v-show 切换，同终端组机制）保 Monaco 撤销栈/滚动位；
// active 由父级传入——切换回显时 layout() 重算一次（隐藏期间 Monaco 拿到的是 0 尺寸），
// 同时只有 active 面板会响应父级的定位/关闭请求。
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch, defineAsyncComponent } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { langForFilename } from '@/lib/monaco' // 具名导入本身会执行 monaco 副作用
import { previewKind, previewMime, extOf } from '@/lib/preview'
import { hydrateMermaid } from '@/lib/mermaid'
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
import { Music, Pencil, Eye } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
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
  /** 主区是否正显示本面板（父级同区切换；定位/重算布局只在 active 时有意义） */
  active?: boolean
  /** 打开即编辑（文件面板右键「编辑」）：初始与 true→ 的变化都落编辑态，false 不打断 */
  editing?: boolean
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'saved', path: string): void
  (e: 'open-normal'): void
  (e: 'dirty', v: boolean): void
  // 形态上报（tab 右键菜单的编辑/预览项按此判定）：editing = 编辑会话中；
  // preview = 当前正显示渲染视图（仅 md/svg）。
  (e: 'mode', v: { editing: boolean; preview: boolean }): void
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
const conflict = ref(false) // 409 后的冲突条（重载 / 覆盖）
const confirmDiscard = ref(false) // 冲突未决时关闭的确认弹窗
const isNew = ref(false) // 新建态：读取 404 进入，保存成功后退出

// —— 在线预览（图片/视频/音频/PDF）——
// 走 download 端点整文件进内存 Blob（二进制安全、无 2MB 文本上限），objectURL 渲染。
// 只读：无编辑/保存/dirty 语义；关闭与重载时回收 objectURL。
const previewKindV = computed(() => (props.diff ? null : previewKind(name.value)))
const previewUrl = ref('')
const previewSize = ref(0)
// —— 文本型预览（svg / markdown）——
// 本体走 Monaco 文本编辑（源码可改），预览渲染态与源码编辑态由右下角浮动铅笔/进编辑联动切换。
// 默认落在预览（svg 直接看形状、md 直接读排版，编辑是少数场景）；渲染用当前编辑内容
// 实时生成（改动立即可见），不落盘——想看保存后的效果先保存。
// 刻意用 data: URL 而非 blob:（两者都受控渲染，效果一致），避免与文件预览的 blob 生命周期混管。
const isSvg = computed(() => !props.diff && extOf(name.value) === 'svg')
const isMd = computed(() => !props.diff && ['md', 'markdown'].includes(extOf(name.value)))
// 默认落在预览（svg 直接看形状、md 直接读排版，编辑是少数场景）；打开即编辑
// （右键「编辑」editing=true）时直接落源码态。渲染用当前编辑内容实时生成。
const textPreview = ref(!props.editing)
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
// mermaid 代码块 → pre.mermaid 占位（hydrateMdMermaid 懒加载渲染成 SVG）；其余语言
// return false 落回 marked 默认渲染。源码做 HTML 转义进 text，pre/class 都在 DOMPurify 白名单内
marked.use({
  renderer: {
    code({ text, lang }) {
      if ((lang ?? '').trim().toLowerCase() !== 'mermaid') return false
      return `<pre class="mermaid">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`
    },
  },
})
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
// —— mermaid 图表渲染 ——
// 占位 pre.mermaid → hydrateMermaid（lib/mermaid.ts，跨面板实例共享：懒 import、
// 串行队列、失败退避重试、mermaid-bad 判定都在那边）→ run() 原地替换成 SVG。
// mdHtml 每次重渲染 v-html 都整树换新，旧任务的渲染目标自然作废——seq 只用来在
// 作废后通知 lib 让位（cancelled 钩子），别让死树的工作占着串行队列。
let mdMmdSeq = 0
async function hydrateMdMermaid() {
  const root = mdBody.value
  if (!root) return
  const nodes = Array.from(root.querySelectorAll<HTMLElement>('pre.mermaid:not([data-processed])'))
  if (!nodes.length) return
  const seq = ++mdMmdSeq
  await hydrateMermaid(nodes, () => seq !== mdMmdSeq)
}
watch(
  mdHtml,
  () =>
    void nextTick(() => {
      hydrateMdImages()
      void hydrateMdMermaid()
    }),
)
onBeforeUnmount(() => {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  clearPreview()
  clearMdBlobs()
})

const dirty = computed(() => content.value !== savedContent.value)
watch(dirty, (v) => emit('dirty', v), { immediate: true })

// —— 自动保存（VSCode afterDelay 式）——
// 输入停顿 300ms 即落盘：短防抖≈实时——连续键入不逐键打请求（每次键入重置计时），
// 一停顿就存；保存飞行期间的键入由「定时器到期撞 busy → 重挂」接力补拍，感知为
// 「改完就存」，不存在「关闭才保存」。Ctrl+S 保留为立即冲一次。参与自动落盘的门槛：
// 非 diff/预览/二进制、非新建（误触即建文件太激进——新文件 Ctrl+S 或关闭冲刷时才创建）、
// 无未决冲突。
const AUTOSAVE_MS = 300
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
function canAutosave(): boolean {
  return !props.diff && !previewKindV.value && !meta.value?.binary && !isNew.value && !conflict.value
}
function scheduleAutosave() {
  if (!canAutosave()) return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    // 上一次保存还在飞：撞回去会被 busy 门槛吞掉，重挂定时器等下一拍
    if (busy.value) scheduleAutosave()
    else void save()
  }, AUTOSAVE_MS)
}
watch(content, () => {
  if (!loading.value && dirty.value) scheduleAutosave()
})

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
    if (s.absent === 'no_head_path') return `${which}侧 HEAD 无此文件（新增/未跟踪）`
    if (s.absent === 'deleted') return `${which}侧文件已删除`
    if (s.absent === 'unborn') return `${which}侧尚无提交（HEAD 不存在）`
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
    editing.value = false
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
      editing.value = true // 打开不存在的文件意图必然是写，直接落编辑态
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
// diff prop 变化（父级把 tab 在对比/普通两形态间切换，或 R 条目换 headPath）时重走加载：
// load 内部按 props.diff 分流，两个方向都能到。path/containerId 变化由父级 tab 身份（key）
// 重建组件，不需要 watch。
watch(() => props.diff, () => void load())
onMounted(load)

// —— :行:列 定位（终端 Ctrl+点击）——
// CodeEditor 是异步组件且只在内容加载完（loading=false 且非 binary/diff）才渲染，
// mount 事件在编辑器以初始 value 创建后触发，此时 reveal 已有效；binary/新建态（空内容）
// 钳到第 1 行无害。同一 tab（key 未变）换行号不重建面板，watch 重新定位。
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

// —— 只读默认 + 浮动铅笔 ——
// 使用画像是预览/复制为主、编辑偶发：打开默认 readOnly（Monaco 只读仍可选中/复制/
// 双击选词，高频路径零成本，且不点铅笔永远不会写盘），右下角浮动铅笔进入编辑。
// 编辑态右下角眼睛 = 回程：md/svg 回预览渲染、普通文件锁回只读，双向自由切换。
// 新建态（文件不存在，打开意图必然是写）直接落在编辑态。diff/二进制形态无编辑
// 语义无按钮。
const editing = ref(!!props.editing)
// 进编辑联动强出渲染态：md/svg 的编辑就是源码 Monaco，渲染视图下 Monaco 未挂载
watch(editing, (v) => {
  if (v && textPreview.value) textPreview.value = false
})
watch(
  () => props.editing,
  (v) => {
    if (v) editing.value = true
  },
)
// 铅笔进编辑：editing 已是 true（md/svg 编辑会话中正看渲染视图）时 watch 不触发，
// 直接强出渲染态落回源码 Monaco
function enterEdit() {
  editing.value = true
  if (textPreview.value) textPreview.value = false
}
// 「预览」回程（眼睛按钮与 tab 右键共用）：md/svg 回渲染视图（编辑会话保持，可再
// 点铅笔回源码）；普通文件没有渲染视图，语义是锁回只读（改动不丢，自动保存照常落盘）
function exitEdit() {
  if (isSvg.value || isMd.value) textPreview.value = true
  else editing.value = false
}
// 形态上报：编辑/预览切换入口（右下角按钮 + tab 右键菜单）按此判定
watch(
  [editing, textPreview, isSvg, isMd],
  ([ed, tp, svg, md]) => emit('mode', { editing: ed, preview: tp && (svg || md) }),
  { immediate: true },
)
defineExpose({
  requestClose: () => requestClose(),
  enterEdit: () => enterEdit(),
  showPreview: () => exitEdit(),
})
watch([editing, editorRef], ([v, ed]) => {
  if (!ed) return
  ed.updateOptions({ readOnly: !v })
  if (v) ed.focus()
})
// 注意：不要在 active 变化时手动 editor.layout()——面板以 visibility:hidden 隐藏（布局盒
// 恒定，父级 ContainerList 有说明），automaticLayout 自会跟进真实尺寸变化；在 0×0/
// 刚恢复可见的容器上同步 layout 曾实测触发 monaco 渲染死循环（整页冻结）。

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
    emit('saved', props.path)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    if (e instanceof ApiError && e.status === 409) {
      conflict.value = true // 自动保存到此暂停，等用户重载/覆盖后恢复
      if (autosaveTimer) {
        clearTimeout(autosaveTimer)
        autosaveTimer = null
      }
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

// 关闭流程（tab 栏 X → requestClose）：自动保存覆盖日常落盘——关闭时把防抖窗口内的
// 改动冲一次；失败/冲突留在原处让用户裁决，不静默丢数据（父级收到 close 才摘 tab）。
// 冲突未决强行关 = 丢弃未落改动，过确认。diff 只读快照无脏态，直接关。
async function requestClose() {
  if (props.diff) {
    emit('close')
    return
  }
  if (autosaveTimer) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
  if (conflict.value) {
    confirmDiscard.value = true
    return
  }
  if (dirty.value && !meta.value?.binary && !previewKindV.value) {
    await save()
    if (err.value || conflict.value) return
  }
  emit('close')
}
function doDiscard() {
  confirmDiscard.value = false
  emit('close')
}

// 预览态的下载出口：复用 downloadEntry（落盘保存），失败进错误条。
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
  <div class="flex h-full min-h-0 flex-col bg-card">
    <!-- 无 header 的极简形态：路径语境在 tab title（hover）与右键「复制路径」里，
         形态徽章（对比）在 tab 上，下载/以普通方式打开收进文件 tab 右键菜单
         （ContainerList），编辑入口是右下角浮动铅笔——编辑区一行不占。只读态说明条
         （diffNotice/冲突/错误）保留在编辑区上方，它们是内容的一部分而非工具栏。 -->
    <!-- 体 -->
    <div class="flex min-h-0 flex-1 flex-col">
      <p v-if="loading" class="px-5 py-8 text-center text-sm text-muted-foreground">加载中…</p>
      <template v-else-if="err && !dirty">
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
        <div class="relative flex min-h-0 flex-1 flex-col">
          <!-- 冲突条：文件在编辑期间被外部修改。挂在预览/编辑两种形态之外——自动保存
               可能在预览态打出 409，收进编辑分支用户会看不见 -->
          <div
            v-if="conflict"
            class="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-5 py-2 text-xs text-amber-600 dark:text-amber-400"
          >
            <span class="min-w-0 flex-1">文件在编辑期间被修改（mtime 不一致）</span>
            <Button variant="outline" size="xs" :disabled="busy" @click="reload">重载（丢弃本地）</Button>
            <Button size="xs" :disabled="busy" @click="overwrite">覆盖保存</Button>
          </div>
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
               不用 svg 那种白底卡），相对图片在 hydrateMdImages 里换 objectURL，
               mermaid 代码块由 hydrateMdMermaid 懒加载渲染成 SVG -->
          <div
            v-else-if="isMd && textPreview"
            ref="mdBody"
            class="md-body scroll-thin min-h-0 flex-1 overflow-auto px-8 py-5"
            v-html="mdHtml"
          />
          <template v-else>
            <p v-if="err" class="px-5 py-2 text-xs text-destructive">{{ err }}</p>
            <CodeEditor
              v-model="content"
              :language="language"
              :options="{ readOnly: !editing }"
              class="min-h-0 flex-1"
              @mount="onEditorMount"
              @save="() => save()"
            />
          </template>
          <!-- 右下角浮动按钮：铅笔 = 进编辑（渲染视图/只读态）；眼睛 = 编辑态回程
               （md/svg 回预览渲染，普通文件锁回只读），所有文件对等。悬浮右下角不占布局 -->
          <Button
            v-if="!editing || ((isSvg || isMd) && textPreview)"
            variant="outline"
            size="icon"
            class="absolute right-3 bottom-3 z-10 size-8 rounded-md bg-background/80 shadow-sm backdrop-blur"
            title="编辑"
            @click="enterEdit"
          >
            <Pencil class="size-4" />
          </Button>
          <Button
            v-else
            variant="outline"
            size="icon"
            class="absolute right-3 bottom-3 z-10 size-8 rounded-md bg-background/80 shadow-sm backdrop-blur"
            :title="(isSvg || isMd) ? '预览渲染' : '锁回只读'"
            @click="exitEdit"
          >
            <Eye class="size-4" />
          </Button>
        </div>
      </template>
    </div>
    <!-- 冲突未决强关确认。刻意放在根 div 内部：本组件必须保持单根——多根片段会让
         父级的 class 透传（min-w-0 flex-1 尺寸）与 v-show（激活面板切换）双双失效，
         多个编辑器会并排罗列铺开（DialogContent 走 DialogPortal 传送 body，放里面无副作用）。 -->
    <ConfirmDialog
      v-if="confirmDiscard"
      title="放弃未落盘的修改？"
      :description="`${name} 存在保存冲突，未落盘的改动关闭后将丢失。`"
      confirm-text="放弃修改"
      variant="destructive"
      @confirm="doDiscard"
      @close="confirmDiscard = false"
    />
  </div>
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
/* mermaid 占位块：渲染成功后原地换成 SVG（居中铺放），剥掉代码块的 muted 底；
   解析失败保留源码便于就地改，红框示意 */
.md-body :deep(pre.mermaid) {
  display: flex;
  justify-content: center;
  background: transparent;
  padding: 1em 0.5em;
}
.md-body :deep(pre.mermaid svg) {
  max-width: 100%;
  height: auto;
}
.md-body :deep(pre.mermaid.mermaid-bad) {
  justify-content: flex-start;
  border-style: dashed;
  border-color: var(--color-destructive);
}
.md-body :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}
</style>
