<script setup lang="ts">
// 分屏布局树节点（递归渲染）：叶子 = 终端 pane（头部操作条 + Terminal），
// split = 同方向多块并排/堆叠 + 可拖分隔条。自身在模板里递归引用，深度不限。
// 布局状态全部由 ContainerList 持有：动作经 inject 的 TERM_OPS 上抛统一改树，
// 尺寸比例由父级经 style 下发（flexGrow + flexBasis 0%）。
import { computed, defineAsyncComponent, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { SquareSplitHorizontal, SquareSplitVertical, X } from 'lucide-vue-next'
import PaneDivider from '@/components/PaneDivider.vue'
import { containerColor } from '@/lib/utils'
import { getTermCwd } from '@/lib/api'
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
}>()

const ops = inject(TERM_OPS)!
// 模板按叶子/分叉两分支渲染；根级 v-if 对联合类型收窄不稳，这里先收好再给模板。
const leaf = computed(() => (props.node.kind === 'leaf' ? props.node : null))
const split = computed(() => (props.node.kind === 'split' ? props.node : null))
const total = computed(() => leafCount(props.group.root))
// 单组分屏上限：满员后分屏按钮禁用（新开一组是用户在 tab 栏点「＋」的显式动作）。
const full = computed(() => total.value >= MAX_GROUP_PANES)
const splitTitle = (dir: 'row' | 'col') =>
  full.value
    ? `每组最多 ${MAX_GROUP_PANES} 个终端；点 tab 栏「＋」新开一组`
    : `${dir === 'row' ? '左右' : '上下'}分屏（${props.group.kind === 'host' ? '宿主' : '同容器'}新终端）`
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
function bindTerm(el: unknown) {
  if (props.node.kind !== 'leaf') return
  ops.setRef(props.node.termId, el)
}
function onOsc(path: string) {
  if (props.node.kind !== 'leaf') return
  ops.onOscOpen(props.group, props.node.termId, path)
}
function onLinkOpen(path: string, line?: number, col?: number) {
  if (props.node.kind !== 'leaf') return
  ops.onLinkOpen(props.group, props.node.termId, path, line, col)
}
// 分叉动作：分隔条 dragstart 换算该轴最小像素后上抛（idx = 分隔条之后的 child 序号）。
function onDividerStart(idx: number, parentSize: number) {
  const s = split.value
  if (!s) return
  ops.dividerStart(s, idx, parentSize, s.dir === 'col' ? 80 : 120)
}

// —— pane 自己的 cwd（头部标题旁展示）——
// 每叶子一份轮询：容器侧 tmux list-panes、宿主侧同款端点（HOST_ID 哨兵分流）。
// 5s 节奏与旧整行信息条一致；会话未建/已收（404）显示占位而非报错。组切走
// （active=false）继续轮——切回来立即是新鲜值，代价是后台组也每 5s 一个轻请求。
const cwd = ref('')
let cwdSeq = 0
let cwdTimer: ReturnType<typeof setInterval> | null = null
async function pollCwd() {
  const l = leaf.value
  const seq = ++cwdSeq
  if (!l) return
  try {
    // host 组 containerId 即 HOST_ID 哨兵，getTermCwd 自动落到 /api/host-terminal/cwd
    const r = await getTermCwd(props.group.containerId, l.termId)
    if (seq !== cwdSeq) return
    cwd.value = r.cwd
  } catch {
    if (seq !== cwdSeq) return
    cwd.value = '' // 会话还没建好/已收：占位，下轮自愈
  }
}
if (leaf.value) {
  onMounted(() => {
    pollCwd()
    cwdTimer = setInterval(() => void pollCwd(), 5000)
  })
  onBeforeUnmount(() => {
    if (cwdTimer) clearInterval(cwdTimer)
  })
  // 组被隐藏/恢复会重建叶子组件（groups ↔ hiddenGroups 换数组），挂载即重启轮询，
  // 这里不需要额外 watch。
}
</script>

<template>
  <!-- 叶子：一个终端 pane -->
  <div v-if="leaf" class="flex min-h-[80px] min-w-[120px] flex-col">
    <!-- pane 头部：标题「容器名 #序号」+ 会话 cwd（tmux 活跃 pane 当前目录，5s 轮询）。
         termId 是内部标识对人无意义，hover 才可见。 -->
    <div class="flex items-center gap-2 border-b border-border bg-muted/20 px-2 py-1 text-[10px]">
      <span
        class="h-1.5 w-1.5 shrink-0 rounded-full"
        :style="{ backgroundColor: group.kind === 'host' ? '#f59e0b' : containerColor(group.containerId) }"
      />
      <span class="shrink-0 font-mono text-muted-foreground" :title="leaf.termId">
        {{ ops.groupLabel(group) }}<span v-if="total > 1"> #{{ ordinal + 1 }}</span>
      </span>
      <span class="min-w-0 flex-1 truncate font-mono text-muted-foreground/80" :title="cwd">
        {{ cwd ? '· ' + cwd : '· …' }}
      </span>
      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <!-- 左右分屏在手机隐藏（max-md:）：竖屏宽度放不下并排 pane；上下分屏保留。
             触屏下按钮命中区放大（pointer-coarse:p-2）。 -->
        <button
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground max-md:hidden pointer-coarse:p-2"
          :title="splitTitle('row')"
          :disabled="full"
          @click="doSplit('row')"
        >
          <SquareSplitHorizontal class="size-3.5 pointer-coarse:size-4.5" />
        </button>
        <button
          class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground pointer-coarse:p-2"
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
         host group 连 /ws/host-terminal（无容器 id），其余连容器 exec。 -->
    <Terminal
      :ref="bindTerm"
      :id="group.kind === 'host' ? undefined : group.containerId"
      :name="group.name"
      :term-id="leaf.termId"
      :host="group.kind === 'host'"
      :active="active"
      @osc-open="onOsc"
      @link-open="onLinkOpen"
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
