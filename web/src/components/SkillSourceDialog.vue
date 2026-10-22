<script setup lang="ts">
// 技能源文件查看器（SkillsHubTab 卡片 ⋯ 菜单「源文件」）。只读——库是静态快照，
// 「更新」会整体覆盖，编辑走「在文件面板打开」深链跳宿主面板改。
// 数据面零新增端点：库目录在宿主文件系统上（~/.mysandbox/skills/registry/<名>，
// 绝对路径随 SkillRegistryItem.path 下发），直接走宿主文件 API（HOST_ID 哨兵）的
// listFiles/readFile——与文件面板四足协议同一套（2MB 上限 / binary 判定单源）。
// 布局：左文件树（懒展开，SKILL.md 首选自动打开）+ 右 Monaco 只读预览（CodeEditor
// 壳，readOnly + domReadOnly；二进制/超限/错误占位）。
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import {
  listFiles,
  readFile,
  HOST_ID,
  Unauthorized,
  type FileEntry,
  type FileView,
  type SkillRegistryItem,
} from '@/lib/api'
import { langForFilename } from '@/lib/monaco'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FolderOpen, Folder, ChevronDown, ChevronRight, Loader2, FileText } from 'lucide-vue-next'

// Monaco 壳懒加载（monaco 本体是共享 chunk，多个入口不重复下载——见 CodeEditor 头注）。
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))

const props = defineProps<{
  skill: SkillRegistryItem | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  // 跳宿主文件面板定位到库目录（编辑场景）——ContainerList 落 locateContainerPath。
  (e: 'locate', path: string): void
}>()

// 懒加载树节点。key 唯一键（绝对路径即是——库内路径天然不重复）；根的 children =
// 顶层条目（树头已有技能名，不重复占一层）。
interface SkillNode {
  key: string
  name: string
  path: string
  type: FileEntry['type']
  size: number
  loaded: boolean
  expanded: boolean
  loading: boolean
  children: SkillNode[]
}

const tree = ref<SkillNode[]>([])
const treeErr = ref('')
const expanded = ref<Set<string>>(new Set())
const selPath = ref('')
const selView = ref<FileView | null>(null)
const selErr = ref('')
const selLoading = ref(false)

const visibleNodes = computed(() => {
  const out: { node: SkillNode; depth: number }[] = []
  const walk = (n: SkillNode, depth: number) => {
    out.push({ node: n, depth })
    if (expanded.value.has(n.key)) n.children.forEach((c) => walk(c, depth + 1))
  }
  tree.value.forEach((n) => walk(n, 0))
  return out
})

function toNodes(entries: FileEntry[], parent: string): SkillNode[] {
  return entries.map((e) => ({
    key: `${parent}/${e.name}`,
    name: e.name,
    path: `${parent}/${e.name}`,
    type: e.type,
    size: e.size,
    loaded: false,
    expanded: false,
    loading: false,
    children: [],
  }))
}

async function expand(node: SkillNode) {
  if (node.type !== 'dir' || node.loaded || node.loading) return
  node.loading = true
  try {
    const v = await listFiles(HOST_ID, node.path)
    node.children = toNodes(v.entries, node.path)
    node.loaded = true
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    treeErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    node.loading = false
  }
}

function toggleExpand(node: SkillNode) {
  const next = new Set(expanded.value)
  if (next.has(node.key)) next.delete(node.key)
  else next.add(node.key)
  expanded.value = next
  if (!node.loaded) void expand(node)
}

async function pick(node: SkillNode) {
  if (node.type === 'dir') {
    toggleExpand(node)
    return
  }
  if (node.type !== 'file' || selPath.value === node.path) return
  selPath.value = node.path
  selView.value = null
  selErr.value = ''
  selLoading.value = true
  try {
    selView.value = await readFile(HOST_ID, node.path)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    selErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    selLoading.value = false
  }
}

// 打开/换技能：重置状态 → 拉根目录 → 首选 SKILL.md（技能的门面文件）。
watch(
  () => props.skill,
  async (s) => {
    if (!s) return
    tree.value = []
    treeErr.value = ''
    expanded.value = new Set()
    selPath.value = ''
    selView.value = null
    selErr.value = ''
    try {
      const v = await listFiles(HOST_ID, s.path)
      tree.value = toNodes(v.entries, s.path)
      const skillMd = tree.value.find((n) => n.type === 'file' && n.name === 'SKILL.md')
      if (skillMd) void pick(skillMd)
      else {
        const first = tree.value.find((n) => n.type === 'file')
        if (first) void pick(first)
      }
    } catch (e) {
      if (e instanceof Unauthorized) {
        emit('unauthorized')
        return
      }
      treeErr.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// 预览语言与占位文案：二进制（classifyContent 单源判定）/ 413 超限（>2MB）分开说清。
const selLang = computed(() => (selView.value ? langForFilename(selView.value.name) : 'plaintext'))
const selPlaceholder = computed(() => {
  if (selErr.value) return selErr.value
  if (!selView.value) return ''
  if (selView.value.binary) return '二进制文件——在文件面板打开可下载查看。'
  return '内容为空。'
})

function openInPanel() {
  if (!props.skill) return
  emit('locate', props.skill.path)
  emit('close')
}
</script>

<template>
  <Dialog :open="!!skill" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-1.5 font-mono">
          <FileText class="size-4 shrink-0 text-muted-foreground" />
          {{ skill?.name }}
        </DialogTitle>
        <DialogDescription class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate font-mono text-[11px]" :title="skill?.path">{{ skill?.path }}</span>
          <Button
            variant="outline"
            size="xs"
            class="h-6 shrink-0 gap-1 px-2 text-[11px]"
            title="跳宿主文件面板定位到库目录——编辑在这里改（查看器只读）"
            @click="openInPanel"
          >
            <FolderOpen class="size-3" /> 在文件面板打开
          </Button>
        </DialogDescription>
      </DialogHeader>

      <div class="flex h-[62vh] min-h-72 flex-col gap-2 sm:flex-row">
        <!-- 左：文件树（懒展开；SKILL.md 首选自动打开） -->
        <div class="scroll-thin min-h-24 shrink-0 overflow-y-auto rounded border bg-card sm:h-full sm:w-56">
          <p v-if="treeErr" class="p-2 text-[11px] text-destructive">{{ treeErr }}</p>
          <p v-else-if="!tree.length" class="flex items-center gap-1.5 p-2 text-[11px] text-muted-foreground">
            <Loader2 class="size-3 animate-spin" /> 读取文件树…
          </p>
          <template v-else>
            <button
              v-for="{ node, depth } in visibleNodes"
              :key="node.key"
              type="button"
              class="flex w-full items-center gap-1 py-1 pr-2 text-left text-[11px] transition-colors"
              :class="selPath === node.path ? 'bg-primary/10' : 'hover:bg-accent/40'"
              :style="{ paddingLeft: depth * 14 + 6 + 'px' }"
              :title="node.path"
              @click="node.type === 'dir' ? toggleExpand(node) : pick(node)"
            >
              <span
                v-if="node.type === 'dir'"
                class="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60"
              >
                <Loader2 v-if="node.loading" class="size-3 animate-spin" />
                <component :is="expanded.has(node.key) ? ChevronDown : ChevronRight" v-else class="size-3" />
              </span>
              <span v-else class="size-4 shrink-0" />
              <Folder v-if="node.type === 'dir'" class="size-3 shrink-0 text-muted-foreground/70" />
              <FileText v-else class="size-3 shrink-0 text-muted-foreground/70" />
              <span class="min-w-0 flex-1 truncate" :class="node.type === 'dir' ? '' : 'font-mono'">{{ node.name }}</span>
              <span v-if="node.type === 'file'" class="shrink-0 text-[9px] text-muted-foreground/40">{{ fmtSize(node.size) }}</span>
            </button>
          </template>
        </div>

        <!-- 右：只读预览（CodeEditor 壳，readOnly + domReadOnly；异常态占位） -->
        <div class="relative min-h-0 flex-1 overflow-hidden rounded border bg-zinc-900">
          <template v-if="selLoading">
            <p class="flex items-center gap-1.5 p-3 text-xs text-muted-foreground">
              <Loader2 class="size-3 animate-spin" /> 读取中…
            </p>
          </template>
          <p v-else-if="selErr || !selView || selView.binary || !selView.content" class="p-3 text-xs text-muted-foreground">
            <span v-if="selErr" class="text-destructive">{{ selErr }}</span>
            <template v-else>{{ selPlaceholder }}</template>
          </p>
          <template v-else>
            <CodeEditor
              :model-value="selView.content"
              :language="selLang"
              :options="{ readOnly: true, domReadOnly: true }"
              class="h-full"
            />
          </template>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
