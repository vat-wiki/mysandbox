<script setup lang="ts">
// 分屏布局树节点（递归渲染）：叶子 = 终端 pane（头部操作条 + Terminal），
// split = 同方向多块并排/堆叠 + 可拖分隔条。自身在模板里递归引用，深度不限。
// 布局状态全部由 ContainerList 持有：动作经 inject 的 TERM_OPS 上抛统一改树，
// 尺寸比例由父级经 style 下发（flexGrow + flexBasis 0%）。
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RefreshCw, SquareSplitHorizontal, SquareSplitVertical, X } from 'lucide-vue-next'
import PaneDivider from '@/components/PaneDivider.vue'
import { containerColor } from '@/lib/utils'
import { getTermCwd, serviceFileId, sshTargetName } from '@/lib/api'
import { gatePoll } from '@/lib/linkQuality'
import {
  TERM_OPS,
  MAX_GROUP_PANES,
  leafCount,
  ordinalOf,
  type LayoutDir,
  type LayoutNode,
  type TermGroup,
} from '@/lib/termlayout'

// 异步加载终端组件：与旧结构一致，xterm 全家桶只在首个 pane 出现时才下载。
const Terminal = defineAsyncComponent(() => import('@/components/Terminal.vue'))

const props = defineProps<{
  node: LayoutNode
  group: TermGroup
  active?: boolean
  /** 终端列对人是否可见（AI 视图打开/编辑器专注/手机编辑器覆盖时为 false）：cwd 轮询的懒加载门 */
  visible?: boolean
}>()

const ops = inject(TERM_OPS)!
// 模板按叶子/分叉两分支渲染；根级 v-if 对联合类型收窄不稳，这里先收好再给模板。
const leaf = computed(() => (props.node.kind === 'leaf' ? props.node : null))
const split = computed(() => (props.node.kind === 'split' ? props.node : null))
const total = computed(() => leafCount(props.group.root))
// 单组分屏上限：满员后分屏按钮禁用（新开一组是 tab 右键「新开一组终端」的显式动作）。
const full = computed(() => total.value >= MAX_GROUP_PANES)
const splitTitle = (dir: 'row' | 'col') =>
  full.value
    ? `每组最多 ${MAX_GROUP_PANES} 个终端；tab 右键「新开一组终端」`
    : `${dir === 'row' ? '左右' : '上下'}分屏（${props.group.kind === 'host' ? '宿主' : props.group.kind === 'service' ? '同服务' : props.group.kind === 'ssh' ? '同主机' : '同容器'}新终端）`
const ordinal = computed(() =>
  props.node.kind === 'leaf' ? ordinalOf(props.group.root, props.node.termId) : 0,
)
function childKey(c: LayoutNode): string {
  return c.kind === 'leaf' ? c.termId : c.id
}
// 叶子动作（回调里拿不到模板的收窄，统一在 script 里先验 kind 再转发）。
function doSplit(dir: LayoutDir) {
  if (props.node.kind !== 'leaf') return
  ops.split(props.group, props.node.termId, dir)
}
function doClose() {
  if (props.node.kind !== 'leaf') return
  ops.close(props.group, props.node.termId)
}
const termRef = ref<{ redraw(): void } | null>(null)
function bindTerm(el: unknown) {
  if (props.node.kind !== 'leaf') return
  termRef.value = (el as { redraw(): void } | null) ?? null
  ops.setRef(props.node.termId, el)
}
function doRedraw() {
  termRef.value?.redraw()
}
function onOsc(path: string) {
  if (props.node.kind !== 'leaf') return
  ops.onOscOpen(props.group, props.node.termId, path)
}
function onLinkOpen(path: string, line?: number, col?: number) {
  if (props.node.kind !== 'leaf') return
  ops.onLinkOpen(props.group, props.node.termId, path, line, col)
}
// pane 动态标题（OSC onTitleChange / 服务端 title 帧）上抛：ContainerList 存内存
// map，tab 标签/popout 窗口标题优先显示它。
function onTitle(title: string) {
  if (props.node.kind !== 'leaf') return
  ops.onTitle(props.group, props.node.termId, title)
}
// pane 落焦上抛：ContainerList 让文件面板跟随最后聚焦的 pane（按组记忆，切 tab 恢复）。
function onFocus() {
  if (props.node.kind !== 'leaf') return
  ops.onPaneFocus(props.group, props.node.termId)
}
// 回车上抛：ContainerList 借此让文件面板即时做一次 cwd 跟随检查（cd 后不等轮询）。
function onEnter() {
  if (props.node.kind !== 'leaf') return
  ops.onPaneEnter(props.group, props.node.termId)
}
// OSC 7 cwd 上抛：ContainerList 只在被跟随 pane 上报时转发给文件面板（cd 生效即达）。
function onCwd(path: string) {
  if (props.node.kind !== 'leaf') return
  ops.onPaneCwd(props.group, props.node.termId, path)
}
// 分叉动作：分隔条 dragstart 换算该轴最小像素后上抛（idx = 分隔条之后的 child 序号）。
function onDividerStart(idx: number, parentSize: number) {
  const s = split.value
  if (!s) return
  ops.dividerStart(s, idx, parentSize, s.dir === 'col' ? 80 : 120)
}

// —— pane 自己的 cwd（头部标题旁展示）——
// 每叶子一份轮询：容器侧 tmux list-panes、宿主侧同款端点（HOST_ID 哨兵分流）、SSH 组走
// /api/ssh/<name>/cwd（远端 tmux 的 pane_current_path 就是远端真实路径）。
// 5s 节奏与旧整行信息条一致；会话未建/已收（404）显示占位而非报错。
// 懒轮询：只有「激活组（active）且终端列对人可见（visible）」才轮——切 tab/AI 视图/
// 编辑器专注下零请求，恢复可见时立即拉一次补新鲜值。cwd 跟随的即时性由 OSC 7 /
// 回车 nudge 两条事件链路承担，这个 timer 只是兜底。
const cwd = ref('')
// pane 动态标题（OSC 链路，ContainerList 内存态）：跑命令/CC·opencode 任务时替代
// cwd 显示位（每 pane 各自可见，分屏时逐 pane 有标题；tab 标签恒为容器名做身份定位）。
// 空闲标题（用户@主机:路径）与 cwd 语义重合但更紧凑（~ 缩写），同样适用。
const paneTitle = computed(() => (leaf.value ? ops.titleOf(leaf.value.termId) : ''))
let cwdSeq = 0
let cwdTimer: ReturnType<typeof setInterval> | null = null
async function pollCwd() {
  const l = leaf.value
  const seq = ++cwdSeq
  if (!l) return
  try {
    // 服务组走 's:' 前缀切 /api/services/<name>/cwd（docker exec 进容器查会话 shell 的
    // cwd，标记注入与扫描见 server/serviceFiles.ts / hostTerminal.ts）。SSH 组
    // containerId 本体即 'ssh:'+名，getTermCwd 自动落到 /api/ssh/<name>/cwd。
    const id =
      props.group.kind === 'service' ? serviceFileId(props.group.containerId) : props.group.containerId
    // host 组 containerId 即 HOST_ID 哨兵，getTermCwd 自动落到 /api/host-terminal/cwd
    const r = await getTermCwd(id, l.termId)
    if (seq !== cwdSeq) return
    cwd.value = r.cwd
  } catch {
    if (seq !== cwdSeq) return
    cwd.value = '' // 会话还没建好/已收：占位，下轮自愈
  }
}
if (leaf.value) {
  function stopCwdPoll() {
    if (cwdTimer) {
      clearInterval(cwdTimer)
      cwdTimer = null
    }
  }
  function startCwdPoll() {
    if (cwdTimer) return
    pollCwd()
    // gate：弱网/页面隐藏时拉长实际频率（pane 标题非关键路径）。
    cwdTimer = setInterval(gatePoll(() => void pollCwd(), 5_000, { hidden: true }), 5000)
  }
  const cwdVisible = computed(() => (props.active ?? true) && (props.visible ?? true))
  watch(cwdVisible, (v) => (v ? startCwdPoll() : stopCwdPoll()), { immediate: true })
  onBeforeUnmount(stopCwdPoll)
  // 组被隐藏/恢复会重建叶子组件（groups ↔ hiddenGroups 换数组），重建即按可见性重开，
  // 这里不需要额外 watch。
}
</script>

<template>
  <!-- 叶子：一个终端 pane -->
  <div v-if="leaf" class="flex min-h-[80px] min-w-[120px] flex-col">
    <!-- pane 头部：标题「容器名 #序号」+ 动态标题（跑命令/CC 任务/空闲路径，OSC 链路）
         或会话 cwd（tmux 活跃 pane 当前目录，5s 轮询）。
         termId 是内部标识对人无意义，hover 才可见。 -->
    <div
      class="flex items-center gap-2 border-b border-border bg-muted/20 px-2 py-1 text-[10px]"
      :class="total > 1 ? '' : 'max-md:hidden'"
    >
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :style="{ backgroundColor: group.kind === 'host' ? '#f59e0b' : containerColor(group.containerId) }"
      />
      <span class="shrink-0 text-muted-foreground" :title="leaf.termId">
        {{ ops.groupLabel(group) }}<span v-if="total > 1"> #{{ ordinal + 1 }}</span>
      </span>
      <!-- 动态标题（人读文本）不用 font-mono：mono 栈无 CJK，回退字体与标签 sans 栈的
           回退度量不一致（实测用户 Chrome 里 CJK 偏高 ~2px），同栈才与「组名 #序号」对齐；
           cwd 是路径（机器串）保留 mono。 -->
      <span
        class="min-w-0 flex-1 truncate"
        :class="paneTitle ? 'text-foreground/75' : 'font-mono text-muted-foreground/80'"
        :title="paneTitle || cwd"
      >
        {{ paneTitle || (cwd ? '· ' + cwd : '· …') }}
      </span>
      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <!-- 重绘：xterm 滚回历史后偶发叠字/错位（buffer 没坏，是渲染层失配），点一下
             清字形缓存并重画当前视口，滚动位置保持不变。 -->
        <button
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:p-2"
          title="重绘终端（滚动后字符叠字/错位时点一下，不改变滚动位置）"
          @click="doRedraw"
        >
          <RefreshCw class="size-3.5 pointer-coarse:size-4.5" />
        </button>
        <!-- 手机禁用分屏：竖屏宽度放不下横排，堆叠又过度压缩终端；
             单 pane 连头部一起隐藏，终端空间最大化。桌面创建的多 pane
             恢复到手机时保留关闭入口，但不再继续新增分屏。 -->
        <button
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground max-md:hidden pointer-coarse:p-2"
          :title="splitTitle('row')"
          :disabled="full"
          @click="doSplit('row')"
        >
          <SquareSplitHorizontal class="size-3.5 pointer-coarse:size-4.5" />
        </button>
        <button
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground max-md:hidden pointer-coarse:p-2"
          :title="splitTitle('col')"
          :disabled="full"
          @click="doSplit('col')"
        >
          <SquareSplitVertical class="size-3.5 pointer-coarse:size-4.5" />
        </button>
        <button
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive pointer-coarse:p-2"
          title="关闭"
          @click="doClose()"
        >
          <X class="size-3.5 pointer-coarse:size-4.5" />
        </button>
      </div>
    </div>
    <!-- Terminal：常驻，切 group 时 v-show 恢复、ResizeObserver 自动 refit。
         host group 连 /ws/host-terminal（无容器 id），其余连容器 exec。
         from-term-id：分屏新 pane 的 cwd 来源（ContainerList 内存映射，非分屏为 undefined）。 -->
    <Terminal
      :ref="bindTerm"
      :id="group.kind === 'host' ? undefined : group.containerId"
      :name="group.name"
      :term-id="leaf.termId"
      :host="group.kind === 'host'"
      :service="group.kind === 'service' ? group.containerId : undefined"
      :ssh="group.kind === 'ssh' ? sshTargetName(group.containerId) : undefined"
      :shell="group.kind === 'service' ? 'bash' : undefined"
      :active="active"
      :from-term-id="ops.cwdSourceOf(leaf.termId)"
      @osc-open="onOsc"
      @link-open="onLinkOpen"
      @title="onTitle"
      @focus="onFocus"
      @enter="onEnter"
      @cwd="onCwd"
    />
  </div>

  <!-- 分叉：同方向多块（row=横排 col=竖排），块间分隔条拖动调相邻两块比例 -->
  <div v-else-if="split" class="flex min-h-0 min-w-0" :class="split.dir === 'col' ? 'flex-col' : 'flex-row'">
    <template v-for="(child, i) in split.children" :key="childKey(child)">
      <PaneDivider
        v-if="i > 0"
        :vertical="split.dir === 'col'"
        @dragstart="(size: number) => onDividerStart(i, size)"
        @drag="ops.dividerDrag"
      />
      <TermLayoutNode
        :node="child"
        :group="group"
        :active="active"
        class="min-h-0 min-w-0"
        :style="{ flexGrow: split.grows[i] ?? 1, flexBasis: '0%' }"
      />
    </template>
  </div>
</template>
