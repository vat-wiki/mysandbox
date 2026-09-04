// 终端分屏布局：树形结构 + 纯函数操作。
import type { InjectionKey } from 'vue'
import { newId } from './id.js'
// 叶子 = 一个终端 pane（termId 即会话标识）；split = 同方向（row=左右 / col=上下）的
// 1..N 块并排，grows[i] 是 children[i] 的 flex-grow 比例。任意嵌套即可表达
// 「左边一整列、右边上下两块」这类布局。
// ContainerList 持有树并经 TERM_OPS 注入动作回调；TermLayoutNode 只管递归渲染。

export type LayoutDir = 'row' | 'col'

// 单组分屏上限：满 4 块后分屏按钮禁用，想要更多终端由用户在 tab 栏点「＋」新开一组。
// 硬编码常量而非配置——这是交互语义（一块终端的可读下限），不是可调参数。
export const MAX_GROUP_PANES = 4

export interface LeafNode {
  kind: 'leaf'
  termId: string
}

export interface SplitNode {
  kind: 'split'
  id: string
  dir: LayoutDir
  children: LayoutNode[]
  grows: number[]
}

export type LayoutNode = LeafNode | SplitNode

export interface TermGroup {
  id: string
  containerId: string
  name: string
  kind?: 'host'
  root: LayoutNode
  // 同容器内的创建序号（1 起）：多组并存时显示 name·seq，身份稳定——关掉中间的组
  // 留缺口也不换号（语义同 tmux 窗口号）。单组独存时不显示后缀。
  seq?: number
  // 「无输出提醒」开关（tab 右键切换，随组持久化）：false = 关；undefined = 开
  // （默认，老存档兼容）。
  quietNotify?: boolean
}

export function newSplitId(): string {
  return newId()
}

export function equalGrows(n: number): number[] {
  return Array.from({ length: n }, () => 1)
}

// DFS 序（与渲染顺序一致：row 从左到右、col 从上到下）枚举所有叶子 termId。
export function leafIds(n: LayoutNode): string[] {
  if (n.kind === 'leaf') return [n.termId]
  return n.children.flatMap(leafIds)
}

export function leafCount(n: LayoutNode): number {
  return leafIds(n).length
}

export function ordinalOf(root: LayoutNode, termId: string): number {
  const ids = leafIds(root)
  const i = ids.indexOf(termId)
  return i < 0 ? 0 : i
}

function findLeafSlot(node: SplitNode, termId: string): { parent: SplitNode; idx: number } | null {
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i]
    if (c.kind === 'leaf' && c.termId === termId) return { parent: node, idx: i }
    if (c.kind === 'split') {
      const hit = findLeafSlot(c, termId)
      if (hit) return hit
    }
  }
  return null
}

// 在 termId 叶子旁边分出一个新终端：dir 决定左右/上下。
// 父 split 方向一致 -> 平级插到它后面；不一致 -> 把该叶子包进新方向的二分节点；
// 根本身就是叶子 -> 升级成二分。返回（可能被替换的）根，调用方回写 group.root。
export function splitLeaf(root: LayoutNode, termId: string, dir: LayoutDir, freshTermId: string): LayoutNode {
  const fresh: LeafNode = { kind: 'leaf', termId: freshTermId }
  if (root.kind === 'leaf') {
    return { kind: 'split', id: newSplitId(), dir, children: [root, fresh], grows: [1, 1] }
  }
  const hit = findLeafSlot(root, termId)
  if (!hit) return root
  const { parent, idx } = hit
  if (parent.dir === dir) {
    parent.children.splice(idx + 1, 0, fresh)
    parent.grows.splice(idx + 1, 0, 1)
  } else {
    parent.children[idx] = {
      kind: 'split',
      id: newSplitId(),
      dir,
      children: [parent.children[idx], fresh],
      grows: [1, 1],
    }
  }
  return root
}

// 摘掉一个叶子；父级只剩单孩时塌缩为该孩（保留其 grow）。根被摘掉返回 null，
// 调用方据此关整个 group。沿途重建祖先节点（未受影响的子树按引用保留，
// Terminal 以 termId 为 key，不受重渲染影响）。
export function removeLeaf(root: LayoutNode, termId: string): LayoutNode | null {
  if (root.kind === 'leaf') return root.termId === termId ? null : root
  const children: LayoutNode[] = []
  const grows: number[] = []
  for (let i = 0; i < root.children.length; i++) {
    const kept = removeLeaf(root.children[i], termId)
    if (kept) {
      children.push(kept)
      grows.push(root.grows[i] ?? 1)
    }
  }
  if (!children.length) return null
  if (children.length === 1) return children[0]
  return { kind: 'split', id: root.id, dir: root.dir, children, grows }
}

// 校验/修复持久化读回的布局：非法节点剔除、单孩塌缩、grows 与 children 对齐。
// 兼容旧数据的容错入口：无 kind 但有字符串 termId 也按叶子收。
export function normalizeRoot(raw: unknown): LayoutNode | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'leaf' || o.kind === undefined) {
    if (typeof o.termId !== 'string') return null
    return { kind: 'leaf', termId: o.termId }
  }
  if (o.kind !== 'split') return null
  if ((o.dir !== 'row' && o.dir !== 'col') || !Array.isArray(o.children)) return null
  const children = o.children.map(normalizeRoot).filter((c): c is LayoutNode => !!c)
  if (!children.length) return null
  if (children.length === 1) return children[0]
  const rawGrows = Array.isArray(o.grows) ? o.grows : []
  const grows = children.map((_, i) => {
    const g = rawGrows[i]
    return typeof g === 'number' && Number.isFinite(g) && g > 0 ? g : 1
  })
  return {
    kind: 'split',
    id: typeof o.id === 'string' ? o.id : newSplitId(),
    dir: o.dir,
    children,
    grows,
  }
}

// TermLayoutNode 经 inject 拿到的动作集合：所有布局改动都上抛给 ContainerList 统一改树。
export interface TermPaneOps {
  split(group: TermGroup, termId: string, dir: LayoutDir): void
  close(group: TermGroup, termId: string): void
  setRef(termId: string, el: unknown): void
  // 分屏新 pane 的 cwd 来源（termId → 源 pane termId；非分屏 pane 返回 undefined）。
  // 实现侧只存内存映射（不进 localStorage）：cwd 仅在「新会话首次创建」那一刻有意义，
  // 刷新后会话必已存在（attach 回去），映射随页面消亡即不再传。
  cwdSourceOf(termId: string): string | undefined
  onOscOpen(group: TermGroup, termId: string, path: string): void
  // Ctrl+点击路径链接（Terminal 的 link provider）：path 为原始 token（可相对/带 ~），
  // line/col 来自栈跟踪式 `:行:列` 后缀。
  onLinkOpen(group: TermGroup, termId: string, path: string, line?: number, col?: number): void
  // idx = 分隔条之后的 child 序号（调 children[idx-1] 与 [idx]）；minPx 为该轴最小像素。
  dividerStart(node: SplitNode, idx: number, parentSize: number, minPx: number): void
  dividerDrag(delta: number): void
  ordinalOf(root: LayoutNode, termId: string): number
  // 组显示名：同容器多组时自动带序号后缀（dev·2），单一组时就是原名。
  groupLabel(group: TermGroup): string
}

export const TERM_OPS: InjectionKey<TermPaneOps> = Symbol('mysandbox-term-pane-ops')
