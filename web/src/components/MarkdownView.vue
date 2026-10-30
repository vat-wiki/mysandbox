<script setup lang="ts">
// markdown 渲染视图（FileEditorPane 预览态 / SkillSourceDialog 源文件查看共用）：
// marked（GFM + breaks）+ DOMPurify 消毒（md 允许内联 HTML，落 v-html 前必须过
// sanitizer）+ 相对图片经 fetchFileBlob 换 objectURL + mermaid 代码块懒渲染成 SVG
//（悬停工具条缩放 / 拖拽平移 / 全屏查看器）。纯渲染层——不做编辑（编辑方自己挂
// Monaco），滚动容器是根节点，高度/内边距 class 由调用方透传调整。
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { fetchFileBlob } from '@/lib/api'
import { previewMime } from '@/lib/preview'
import { hydrateMermaid } from '@/lib/mermaid'
import { X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  /** md 源文本（渲染实时跟随，编辑方的未保存改动立即可见） */
  content: string
  /** 相对图片取流目标（四足哨兵同文件面板：__host__ / 容器名 / 's:'+名） */
  containerId: string
  /** md 文件绝对路径——相对图片按其所在目录解析（`/` 开头按原始路径） */
  path: string
}>()

// 相对图片引用浏览器解不了（download 端点走 header token，<img> 带不上）——渲染后把
// 相对路径的 <img> 换成 fetchFileBlob 的 objectURL：相对段相对 md 所在目录、`/` 开头
// 按原始路径原样、`..` 逐段归一化；同图只取一次流。
marked.setOptions({ gfm: true, breaks: true })
// mermaid 代码块 → wrapper + stage + pre.mermaid 占位（hydrateMermaid 懒加载渲染成 SVG）；
// 其余语言 return false 落回 marked 默认渲染。源码做 HTML 转义进 text，pre/class 都在
// DOMPurify 白名单内。
marked.use({
  renderer: {
    code({ text, lang }) {
      if ((lang ?? '').trim().toLowerCase() !== 'mermaid') return false
      return `<div class="mermaid-view"><div class="mermaid-stage"><pre class="mermaid">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></div></div>`
    },
  },
})
// YAML frontmatter 剥离：技能/文档类 md 常以 `---` 元数据块开头，marked 不认识它，
// 会把整块当普通段落、闭合的 `---` 又反解析成 setext 标题——渲染成一条巨型标题，
// 且元数据里的长 token（Bash(npx:) 之类）成了不可断词的 min-content，手机上直接把
// 对话框 grid 轨道撑爆。只剥文件头部第一个完整块（`---` 开头 + 闭合行），中间出现
// 的 `---` 分隔线不受影响。
function stripFrontmatter(src: string): string {
  const m = /^---[^\n]*\n[\s\S]*?\n(?:---|\.\.\.)[^\n]*\n?/.exec(src)
  return m ? src.slice(m[0].length) : src
}

const mdHtml = computed(() => DOMPurify.sanitize(marked.parse(stripFrontmatter(props.content), { async: false })))
const mdBody = ref<HTMLElement | null>(null)
const mermaidViewerUrl = ref('')
const mermaidViewerScale = ref(1)
let mdBlobUrls: string[] = []
let mdImgSeq = 0
function clearMdBlobs() {
  for (const u of mdBlobUrls) URL.revokeObjectURL(u)
  mdBlobUrls = []
}

function clampMermaidZoom(value: number): number {
  return Math.max(0.5, Math.round(value * 100) / 100)
}

function setMermaidZoom(view: HTMLElement, value: number) {
  view.style.setProperty('--mermaid-zoom', clampMermaidZoom(value).toString())
}

// 缩放以锚点（视口 client 坐标）为不动点：缩放前后锚点压着的 SVG 内容点钉在同一屏幕
// 位置——量锚点在旧 SVG 里的相对比例，改完 zoom 后按新尺寸反推 scroll 补偿。锚点缺省
// 取 stage 视口中心（工具条按钮用）；滚轮缩放传鼠标位置。补偿量被滚动边界钳住时自然
// 退化为贴边（全图可见、无溢出可滚时回退居中收缩，与主流看图行为一致）。
function zoomMermaidView(view: HTMLElement, delta: number, ax?: number, ay?: number) {
  const current = Number(view.style.getPropertyValue('--mermaid-zoom') || 1)
  const next = clampMermaidZoom(current + delta)
  if (next === current) return
  const stage = view.querySelector<HTMLElement>('.mermaid-stage')
  const svg = view.querySelector<SVGElement>('svg')
  if (!stage || !svg) {
    setMermaidZoom(view, next)
    return
  }
  const stageRect = stage.getBoundingClientRect()
  const cx = ax ?? stageRect.left + stageRect.width / 2
  const cy = ay ?? stageRect.top + stageRect.height / 2
  const svgRect = svg.getBoundingClientRect()
  const rx = svgRect.width > 0 ? (cx - svgRect.left) / svgRect.width : 0.5
  const ry = svgRect.height > 0 ? (cy - svgRect.top) / svgRect.height : 0.5
  setMermaidZoom(view, next)
  // setProperty 同步触发样式重算，这里量到的已是新布局（含滚动条出现/消失的宽度变化）
  const after = svg.getBoundingClientRect()
  stage.scrollLeft += after.left - (cx - rx * after.width)
  stage.scrollTop += after.top - (cy - ry * after.height)
}

// 工具条不进 Markdown HTML（v-html 内容每次会被 DOMPurify 重洗），
// 渲染挂载后用 DOM 注入，并直接绑到每个按钮上，避免受 v-html 更新影响。
function attachMermaidControls(root: HTMLElement) {
  for (const view of Array.from(root.querySelectorAll<HTMLElement>('.mermaid-view'))) {
    if (view.querySelector(':scope > .mermaid-toolbar')) continue
    view.addEventListener('pointerdown', onMermaidPointerDown)
    const toolbar = document.createElement('div')
    toolbar.className = 'mermaid-toolbar'
    for (const [action, text, title] of [
      ['out', '−', '缩小'],
      ['in', '+', '放大'],
      ['fullscreen', '⛶', '全屏查看'],
      ['reset', '↺', '恢复大小'],
    ] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.mermaidAction = action
      button.textContent = text
      button.title = title
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onMermaidAction(event)
      })
      toolbar.append(button)
    }
    view.prepend(toolbar)
  }
}

function openMermaidViewer(view: HTMLElement) {
  const svg = view.querySelector<SVGSVGElement>('svg')
  if (!svg) return
  const source = new XMLSerializer().serializeToString(svg)
  mermaidViewerUrl.value = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`
  mermaidViewerScale.value = 1
}

function onMermaidAction(event: MouseEvent) {
  const target = event.target as HTMLElement
  const button = target.closest<HTMLElement>('[data-mermaid-action]')
  const view = target.closest<HTMLElement>('.mermaid-view')
  if (!view) return
  if (!button) return
  event.preventDefault()
  const action = button.dataset.mermaidAction
  if (action === 'in') zoomMermaidView(view, 0.2)
  else if (action === 'out') zoomMermaidView(view, -0.2)
  else if (action === 'reset') setMermaidZoom(view, 1)
  else if (action === 'fullscreen') openMermaidViewer(view)
}

// 滚轮缩放以鼠标为不动点（见 zoomMermaidView）；拖拽把缩放后的溢出交回 stage 自己滚。
function onMermaidWheel(event: WheelEvent) {
  const view = (event.target as HTMLElement).closest<HTMLElement>('.mermaid-view')
  if (!view) return
  event.preventDefault()
  zoomMermaidView(view, event.deltaY < 0 ? 0.2 : -0.2, event.clientX, event.clientY)
}

// 只拖图表视口，不劫持 Markdown 其他区域；工具条按钮仍走 click。
// 视口固定后缩放溢出全部收在 stage（mermaid-stage）里滚——横纵都平移 stage 自己，
// 不再借道 md-body（那是文档级滚动，图表视口一固定就跟它无关了）。
// 视口无溢出时不动 preventDefault，坏块的源码还能正常选中复制。
function onMermaidPointerDown(event: PointerEvent) {
  const view = event.currentTarget as HTMLElement
  if (event.button !== 0) return
  if ((event.target as HTMLElement).closest('.mermaid-toolbar')) return
  const stage = view.querySelector<HTMLElement>('.mermaid-stage')
  if (!stage) return
  if (stage.scrollWidth <= stage.clientWidth && stage.scrollHeight <= stage.clientHeight) return
  event.preventDefault()
  view.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startY = event.clientY
  const startLeft = stage.scrollLeft
  const startTop = stage.scrollTop
  view.style.cursor = 'grabbing'

  const onMove = (moveEvent: PointerEvent) => {
    stage.scrollLeft = startLeft - (moveEvent.clientX - startX)
    stage.scrollTop = startTop - (moveEvent.clientY - startY)
  }
  const onStop = () => {
    view.style.cursor = ''
    view.removeEventListener('pointermove', onMove)
    view.removeEventListener('pointerup', onStop)
    view.removeEventListener('pointercancel', onStop)
  }
  view.addEventListener('pointermove', onMove)
  view.addEventListener('pointerup', onStop)
  view.addEventListener('pointercancel', onStop)
}

function zoomMermaidViewer(delta: number) {
  // 全屏查看器缩放不设上下限（全屏就是看细节的，放大/缩小到哪都由用户自己定），
  // 只防 0/负值——宽度为负是无效 CSS，图像消失且 + 按钮救不回来；0.05 只是防呆底
  mermaidViewerScale.value = Math.max(0.05, Math.round((mermaidViewerScale.value + delta) * 100) / 100)
}

// 全屏层里 Ctrl + 滚轮跟内嵌图保持同一手势；普通滚轮仍交给全屏滚动容器。
function onMermaidViewerWheel(event: WheelEvent) {
  event.preventDefault()
  zoomMermaidViewer(event.deltaY < 0 ? 0.2 : -0.2)
}

// 全屏层拖拽平移；指针捕获保证移出图片后仍跟手。
function onMermaidViewerPointerDown(event: PointerEvent) {
  const stage = event.currentTarget as HTMLElement
  if (event.button !== 0) return
  if ((event.target as HTMLElement).closest('button')) return
  event.preventDefault()
  stage.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startY = event.clientY
  const startLeft = stage.scrollLeft
  const startTop = stage.scrollTop
  stage.style.cursor = 'grabbing'

  const onMove = (moveEvent: PointerEvent) => {
    stage.scrollLeft = startLeft - (moveEvent.clientX - startX)
    stage.scrollTop = startTop - (moveEvent.clientY - startY)
  }
  const onStop = () => {
    stage.style.cursor = ''
    stage.removeEventListener('pointermove', onMove)
    stage.removeEventListener('pointerup', onStop)
    stage.removeEventListener('pointercancel', onStop)
  }
  stage.addEventListener('pointermove', onMove)
  stage.addEventListener('pointerup', onStop)
  stage.addEventListener('pointercancel', onStop)
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
  attachMermaidControls(root)
  const seq = ++mdMmdSeq
  await hydrateMermaid(nodes, () => seq !== mdMmdSeq)
  for (const view of Array.from(root.querySelectorAll<HTMLElement>('.mermaid-view'))) {
    const svg = view.querySelector<SVGSVGElement>('svg')
    if (!svg) continue
    svg.style.maxWidth = 'none'
    // 视口宽高比锁死 stage 高度（超 70vh 封顶），之后缩放只改变内容尺寸、视口恒定，
    // 文档高度不再随缩放变化。优先用 pre 的盒尺寸（offset 含 padding+border，stage 宽
    // 与 pre 宽相等 → 高度按比例换算后严丝合缝，zoom 1 无多余滚动）；面板隐藏中量不到
    // （offset 为 0）时退回 viewBox 比例（差一个 pre padding 的余量，可接受）。
    const pre = view.querySelector<HTMLElement>('pre.mermaid')
    const vb = svg.viewBox.baseVal
    if (pre && pre.offsetWidth > 0 && pre.offsetHeight > 0) {
      view.style.setProperty('--mmd-ar', `${pre.offsetWidth} / ${pre.offsetHeight}`)
    } else if (vb.width > 0 && vb.height > 0) {
      view.style.setProperty('--mmd-ar', `${vb.width} / ${vb.height}`)
    }
  }
}
// immediate 必须带：两个调用方（文件面板 / 技能源查看器）都是内容就绪后才挂载本组件，
// 挂载后 content 往往不再变化——没有 immediate 的话首屏这次渲染永远不会触发图片/mermaid
// 水合，图表停在占位源码（要等内容再变一次才有第二拍）。immediate 补上挂载首拍。
watch(
  mdHtml,
  () =>
    void nextTick(() => {
      hydrateMdImages()
      void hydrateMdMermaid()
    }),
  { immediate: true },
)
onBeforeUnmount(() => {
  clearMdBlobs()
  mermaidViewerUrl.value = ''
})
</script>

<template>
  <div
    ref="mdBody"
    class="md-body scroll-thin min-h-0 flex-1 overflow-auto px-8 py-5"
    v-html="mdHtml"
    @wheel.capture="onMermaidWheel"
  />
  <!-- Mermaid 全屏查看器：复制当前已渲染 SVG 为 data URL，避免内嵌 SVG 的
       id 与文档其他图表冲突；缩放用百分比宽度，溢出由外层滚动容器承担。
       Teleport 到 body——调用方可能在 Dialog（transform 动画期间 fixed 会错锚）里。 -->
  <Teleport to="body">
    <div
      v-if="mermaidViewerUrl"
      class="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm"
      @click.self="mermaidViewerUrl = ''"
    >
      <div class="flex items-center justify-between gap-3 border-b px-4 py-2">
        <div class="text-sm text-muted-foreground">Mermaid 预览 · {{ Math.round(mermaidViewerScale * 100) }}%</div>
        <div class="flex items-center gap-1">
          <Button variant="ghost" size="icon" title="缩小" @click="zoomMermaidViewer(-0.2)">
            −
          </Button>
          <Button variant="ghost" size="icon" title="放大" @click="zoomMermaidViewer(0.2)">
            +
          </Button>
          <Button variant="ghost" size="icon" title="恢复大小" @click="mermaidViewerScale = 1">
            ↺
          </Button>
          <Button variant="ghost" size="icon" title="关闭" @click="mermaidViewerUrl = ''">
            <X class="size-4" />
          </Button>
        </div>
      </div>
      <div class="scroll-thin min-h-0 flex-1 overflow-auto p-6" @wheel="onMermaidViewerWheel">
        <div
          class="mx-auto flex min-h-full w-full cursor-grab items-center justify-center active:cursor-grabbing"
          @pointerdown="onMermaidViewerPointerDown"
        >
          <img
            :src="mermaidViewerUrl"
            alt="Mermaid 图表全屏预览"
            class="max-w-none rounded bg-background shadow-lg"
            :style="{ width: `${mermaidViewerScale * 100}%` }"
          >
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* markdown 排版：全走主题变量（深浅色自适应）。v-html 内容不吃 scoped 属性，
   一律经 :deep 下探；无 @tailwindcss/typography，手写这套就够预览用 */
.md-body {
  color: var(--color-foreground);
  font-size: 14px;
  line-height: 1.75;
  /* 长 token（URL/代码字面量）超容器宽时折行，不把滚动容器的内容宽撑出去 */
  overflow-wrap: break-word;
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
/* 表格：GFM 裸 table 无默认边框会挤成一团——全边框 + 表头 muted 底；
   宽表 display:block 撑出横向滚动（v-html 内容挂不了全局类，滚动条同 pre 复刻） */
.md-body :deep(table) {
  margin: 0.9em 0;
  display: block;
  overflow-x: auto;
  border-collapse: collapse;
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
}
.md-body :deep(table::-webkit-scrollbar) {
  width: 8px;
  height: 8px;
}
.md-body :deep(table::-webkit-scrollbar-track) {
  background: transparent;
}
.md-body :deep(table::-webkit-scrollbar-thumb) {
  background-color: var(--scroll-thumb);
  border-radius: 9999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.md-body :deep(table::-webkit-scrollbar-thumb:hover) {
  background-color: var(--scroll-thumb-hover);
}
.md-body :deep(th),
.md-body :deep(td) {
  border: 1px solid var(--color-border);
  padding: 0.35em 0.75em;
  text-align: left;
  vertical-align: top;
}
.md-body :deep(thead th) {
  background: var(--color-muted);
  font-weight: 600;
  white-space: nowrap;
}
/* mermaid 占位块：渲染成功后原地换成 SVG（居中铺放），剥掉代码块的 muted 底；
   解析失败保留源码便于就地改，红框示意 */
.md-body :deep(.mermaid-view) {
  position: relative;
}
/* 固定视口滚动层：高度按 viewBox 宽高比锁死（超 70vh 封顶），缩放后的溢出全部
   在视口内滚——文档高度不随缩放变化，拖拽/滚动条都只动视口内部。
   --mmd-ar 渲染完成后由 hydrateMdMermaid 从 viewBox 设入；坏块无 SVG 时变量缺席，
   aspect-ratio 落回 auto，视口高度 = 源码自然高度。 */
.md-body :deep(.mermaid-stage) {
  /* 上下间距在这里扛（原 pre.mermaid 的 margin 挪过来）：margin 若留在 pre 上会进
     stage 的 scrollHeight，zoom 1 时平白多出一条纵向滚动 */
  margin: 0.9em 0;
  /* 宽度必须显式 100%：auto 宽的 aspect-ratio 盒会把 max-height 当 transferred
     size suggestion 传导到宽度上（Chrome 实装）——纵向大图（宽高比 < 1）一被 70vh
     封顶，宽度就跟着缩成 70vh×宽高比的窄柱，视口裁掉半张图、工具条飘到右边空白。
     百分比宽度是 definite size 不吃传导：宽度恒铺满，aspect-ratio 只定高度。 */
  width: 100%;
  overflow: auto;
  aspect-ratio: var(--mmd-ar, auto);
  max-height: 70vh;
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
}
.md-body :deep(.mermaid-stage::-webkit-scrollbar) {
  width: 8px;
  height: 8px;
}
.md-body :deep(.mermaid-stage::-webkit-scrollbar-track) {
  background: transparent;
}
.md-body :deep(.mermaid-stage::-webkit-scrollbar-thumb) {
  background-color: var(--scroll-thumb);
  border-radius: 9999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.md-body :deep(.mermaid-stage::-webkit-scrollbar-thumb:hover) {
  background-color: var(--scroll-thumb-hover);
}
.md-body :deep(pre.mermaid) {
  display: flex;
  justify-content: safe center;
  /* 纵向也居中 + 撑满 stage 视口：pre 边框盒（通用 pre 规则带的）就是用户眼里的
     「视口」——高度若跟内容走，缩小后边框盒缩成一小块浮在恒定视口顶部，看起来
     像视口塌了、下面还拖一截看不见的空白。min-height 撑满视口（border-box），
     内容小则居中、大则照常撑出滚动，边框始终框住整个视口。 */
  align-items: safe center;
  min-height: 100%;
  background: transparent;
  padding: 1em 0.5em;
  /* margin 挪去 stage（见上），--mmd-ar 按 offset 量尺寸时不含 margin 才严丝合缝 */
  margin: 0;
  /* 通用 pre 的 overflow-x: auto 在这里撤掉——溢出的唯一滚动面是上面的 stage，
     pre 自己不滚（两个滚动面会让拖拽与滚轮行为分叉） */
  overflow: visible;
}
/* mermaid 渲染期间会往 pre 里塞一个临时包裹 div（svg 先在它里面量尺寸），gantt 等
   图型按 parentElement.offsetWidth 取排版宽度——flex 容器下这个临时 div shrink-to-fit，
   塌到空 svg 的默认固有宽 300px → 整图按 300px 排版再被拉宽，文字/刻度全部叠字。
   撑满宽度让测量拿到真实容器宽（渲染完临时 div 即被 svg 顶替，此规则平时无匹配）。 */
.md-body :deep(pre.mermaid > div) {
  width: 100%;
}
.md-body :deep(.mermaid-toolbar) {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 1;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 120ms ease;
}
.md-body :deep(.mermaid-view:hover .mermaid-toolbar),
.md-body :deep(.mermaid-view:focus-within .mermaid-toolbar) {
  opacity: 1;
}
.md-body :deep(.mermaid-toolbar button) {
  display: inline-flex;
  height: 1.75rem;
  width: 1.75rem;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-background);
  color: var(--color-foreground);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
}
.md-body :deep(.mermaid-toolbar button:hover) {
  background: var(--color-accent);
}
.md-body :deep(pre.mermaid svg) {
  flex: 0 0 auto;
  cursor: grab;
  touch-action: none;
  width: calc(100% * var(--mermaid-zoom, 1));
  height: auto;
  max-width: none;
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
