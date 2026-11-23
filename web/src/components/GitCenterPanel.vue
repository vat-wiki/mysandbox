<script setup lang="ts">
// Git 中心面板：内网 bare 仓库的管理 + 代码浏览。
// 仓库落在 ~/.mysandbox/repos/<name>.git；clone/push 走 /git/* 的 Smart HTTP（无 token），
// 本面板的读写走 /api/git-center/*（有 token）。桌面 dialog / 手机整页，与账户面板同壳。
import { ref, computed, onMounted, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { toast } from 'vue-sonner'
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
import { ArrowLeft, Copy, File, Folder, GitBranch, GitCommitHorizontal, Plus, RefreshCw, Tag, Trash2 } from 'lucide-vue-next'
import {
  Unauthorized,
  listGitRepos, createGitRepo, deleteGitRepo, getGitRepoDetail,
  getGitRepoTrees, getGitRepoFile, getGitRepoCommits, getGitRepoDiff,
  type GitCenterRepo, type GitCenterDetail, type GitCenterTree,
  type GitCenterTreeEntry, type GitCenterFile, type GitCenterCommits, type GitCenterDiff, type GitCommit,
} from '@/lib/api'

const emit = defineEmits<{ (e: 'close'): void }>()

type Tab = 'code' | 'commits' | 'refs' | 'diff'
const repos = ref<GitCenterRepo[]>([])
const loading = ref(false)
const current = ref('')
const detail = ref<GitCenterDetail | null>(null)
const refName = ref('HEAD')
const tab = ref<Tab>('code')
const path = ref('')
const tree = ref<GitCenterTree | null>(null)
const file = ref<GitCenterFile | null>(null)
const commits = ref<GitCommit[]>([])
const hasMore = ref(false)
const diff = ref<GitCenterDiff | null>(null)

marked.setOptions({ gfm: true, breaks: true })

const cloneUrl = computed(() => (current.value ? `${location.origin}/git/${current.value}.git` : ''))
const patchLines = computed(() => (diff.value?.patch ?? '').replace(/\n$/, '').split('\n'))
const fileHtml = computed(() => {
  if (!file.value || file.value.binary || !/\.md$/i.test(file.value.path)) return ''
  return DOMPurify.sanitize(marked.parse(file.value.content, { async: false }))
})

function fmtTime(v: number | string): string {
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(v)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false })
}
function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-muted-foreground'
  if (line.startsWith('+')) return 'text-emerald-600 dark:text-emerald-400'
  if (line.startsWith('-')) return 'text-red-600 dark:text-red-400'
  if (line.startsWith('@@')) return 'text-sky-600 dark:text-sky-400'
  return 'text-foreground/80'
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    repos.value = (await listGitRepos()).items
  } catch (e) {
    if (e instanceof Unauthorized) return emit('close')
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

async function loadTree(): Promise<void> {
  if (!current.value) return
  try {
    tree.value = await getGitRepoTrees(current.value, refName.value, path.value)
    file.value = null
    // 根目录有 README 就顺手渲染，像 GitHub 的仓库首页。
    if (!path.value && tree.value.entries.some((e) => /^readme(\.|$)/i.test(e.name) && e.type === 'blob')) {
      await openFile(tree.value.entries.find((e) => /^readme(\.|$)/i.test(e.name))!)
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

async function openFile(entry: GitCenterTreeEntry): Promise<void> {
  if (!current.value) return
  try {
    file.value = await getGitRepoFile(current.value, refName.value, entry.path)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

async function openRepo(name: string): Promise<void> {
  current.value = name
  tab.value = 'code'
  path.value = ''
  diff.value = null
  commits.value = []
  try {
    detail.value = await getGitRepoDetail(name)
    refName.value = detail.value.defaultBranch
    await loadTree()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}

function closeRepo(): void {
  current.value = ''
  detail.value = null
  tree.value = null
  file.value = null
}

function enterDir(entry: GitCenterTreeEntry): void {
  path.value = entry.path
  file.value = null
  void loadTree()
}
function goUp(): void {
  const segs = path.value.split('/').filter(Boolean)
  segs.pop()
  path.value = segs.join('/')
  file.value = null
  void loadTree()
}
async function switchRef(name: string): Promise<void> {
  refName.value = name
  path.value = ''
  file.value = null
  diff.value = null
  if (tab.value === 'code') await loadTree()
  if (tab.value === 'commits') await loadCommits()
}
async function loadCommits(): Promise<void> {
  if (!current.value) return
  try {
    const r: GitCenterCommits = await getGitRepoCommits(current.value, refName.value)
    commits.value = r.commits
    hasMore.value = r.hasMore
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
async function openDiff(to: string): Promise<void> {
  if (!current.value) return
  tab.value = 'diff'
  try {
    diff.value = await getGitRepoDiff(current.value, to)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
watch(tab, (v) => {
  if (v === 'commits' && !commits.value.length) void loadCommits()
})

async function copyClone(): Promise<void> {
  try {
    await navigator.clipboard.writeText(cloneUrl.value)
    toast.success('clone 地址已复制')
  } catch {
    toast.error('复制失败，请手动选中地址')
  }
}

// —— 新建 / 删除 ——
const showCreate = ref(false)
const formName = ref('')
const formDesc = ref('')
const formErr = ref('')
const saving = ref(false)
function openCreate(): void {
  formName.value = ''
  formDesc.value = ''
  formErr.value = ''
  showCreate.value = true
}
async function doCreate(): Promise<void> {
  saving.value = true
  formErr.value = ''
  try {
    const r = await createGitRepo(formName.value.trim(), formDesc.value.trim())
    showCreate.value = false
    toast.success(`仓库 ${r.name} 已创建`)
    await refresh()
    await openRepo(r.name)
  } catch (e) {
    formErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}
const delTarget = ref<GitCenterRepo | null>(null)
async function doDelete(): Promise<void> {
  const t = delTarget.value
  if (!t) return
  try {
    await deleteGitRepo(t.name)
    toast.success(`仓库 ${t.name} 已删除`)
    if (current.value === t.name) closeRepo()
    delTarget.value = null
    await refresh()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-4xl max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0">
      <DialogHeader>
        <DialogTitle>{{ current ? `仓库 / ${current}` : 'Git 中心' }}</DialogTitle>
        <DialogDescription>
          {{ current
            ? '内网 bare 仓库 · clone/push 无需 token'
            : '内网代码仓库 · 存于 ~/.mysandbox/repos · 无权限限制，能连到端口即可读写' }}
        </DialogDescription>
      </DialogHeader>

      <!-- 仓库列表 -->
      <div v-if="!current" class="flex min-h-0 flex-col gap-3">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">共 {{ repos.length }} 个仓库</p>
          <div class="flex gap-1.5">
            <Button variant="ghost" size="icon-xs" title="刷新" :disabled="loading" @click="refresh">
              <RefreshCw :class="loading ? 'animate-spin' : ''" />
            </Button>
            <Button size="xs" @click="openCreate"><Plus /> 新建仓库</Button>
          </div>
        </div>
        <div class="scroll-thin flex max-h-[58vh] min-h-0 flex-col gap-1.5 overflow-y-auto">
          <div
            v-for="r in repos"
            :key="r.name"
            class="group flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 transition-colors hover:bg-accent/50"
            @click="openRepo(r.name)"
          >
            <GitBranch class="size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <span class="truncate text-sm font-medium">{{ r.name }}.git</span>
                <span v-if="r.empty" class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">空仓库</span>
              </div>
              <p class="truncate text-[11px] text-muted-foreground">{{ r.description || '暂无描述' }}</p>
            </div>
            <span class="hidden shrink-0 text-[11px] text-muted-foreground sm:block">{{ fmtTime(r.updatedAt) }}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              title="删除仓库"
              class="shrink-0 opacity-60 group-hover:opacity-100"
              @click.stop="delTarget = r"
            >
              <Trash2 />
            </Button>
          </div>
          <p v-if="!repos.length && !loading" class="py-10 text-center text-sm text-muted-foreground">
            还没有仓库，点「新建仓库」开始。
          </p>
        </div>
      </div>

      <!-- 仓库详情 -->
      <div v-else class="flex min-h-0 flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="xs" @click="closeRepo"><ArrowLeft /> 返回列表</Button>
          <div class="ml-auto flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1">
            <code class="min-w-0 truncate text-[11px]">{{ cloneUrl }}</code>
            <Button variant="ghost" size="icon-xs" title="复制 clone 地址" @click="copyClone"><Copy /></Button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-1 border-b border-border pb-1.5">
          <Button v-for="t in (['code', 'commits', 'refs'] as Tab[])" :key="t" variant="ghost" size="xs"
            :class="tab === t ? 'bg-accent/60 text-foreground' : 'text-muted-foreground'"
            @click="tab = t">
            {{ t === 'code' ? '代码' : t === 'commits' ? '提交' : '分支 / 标签' }}
          </Button>
          <Button v-if="tab === 'diff'" variant="ghost" size="xs" class="bg-accent/60 text-foreground" @click="tab = 'commits'">
            变更对比
          </Button>
          <div class="ml-auto flex items-center gap-1.5 pl-2 text-xs text-muted-foreground">
            <GitBranch class="size-3.5" />
            <select
              v-model="refName"
              class="max-w-[9rem] rounded border border-border bg-background px-1.5 py-1 text-xs"
              @change="switchRef(refName)"
            >
              <option v-for="b in detail?.branches ?? []" :key="'b' + b.name" :value="b.name">{{ b.name }}</option>
              <option v-for="g in detail?.tags ?? []" :key="'t' + g.name" :value="g.name">{{ g.name }}</option>
            </select>
          </div>
        </div>

        <!-- 代码 / 文件 -->
        <div v-if="tab === 'code'" class="scroll-thin min-h-0 max-h-[52vh] overflow-y-auto">
          <div v-if="path" class="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
            <button type="button" class="hover:text-foreground" @click="goUp">..</button>
            <span>/</span><span class="truncate text-foreground">{{ path }}</span>
          </div>
          <p v-if="tree?.empty" class="py-8 text-center text-sm text-muted-foreground">这个仓库还没有提交。</p>
          <template v-else>
            <div
              v-for="e in tree?.entries ?? []"
              :key="e.path"
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/50"
              @click="e.type === 'tree' ? enterDir(e) : openFile(e)"
            >
              <Folder v-if="e.type === 'tree'" class="size-4 shrink-0 text-sky-500" />
              <File v-else class="size-4 shrink-0 text-muted-foreground" />
              <span class="min-w-0 flex-1 truncate">{{ e.name }}</span>
              <span class="shrink-0 font-mono text-[10px] text-muted-foreground">{{ e.size }}</span>
            </div>
            <div v-if="file" class="mt-3 rounded-lg border bg-muted/20">
              <div class="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
                <File class="size-3.5" /><span class="truncate">{{ file.path }}</span>
                <span v-if="file.binary" class="ml-auto">二进制文件（{{ file.size }} B）</span>
                <span v-else-if="file.truncated" class="ml-auto text-amber-500">已截断</span>
              </div>
              <!-- markdown 走与编辑器预览相同的 marked + DOMPurify 管线 -->
              <div v-if="fileHtml" class="repo-md px-4 py-3 text-sm" v-html="fileHtml" />
              <pre v-else-if="!file.binary" class="scroll-thin overflow-x-auto px-3 py-2 text-xs leading-relaxed"><code>{{ file.content }}</code></pre>
            </div>
          </template>
        </div>

        <!-- 提交历史 -->
        <div v-else-if="tab === 'commits'" class="scroll-thin min-h-0 max-h-[52vh] overflow-y-auto">
          <p v-if="!commits.length" class="py-8 text-center text-sm text-muted-foreground">没有提交记录。</p>
          <button
            v-for="c in commits"
            :key="c.hash"
            type="button"
            class="flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left hover:bg-accent/50"
            @click="openDiff(c.hash)"
          >
            <GitCommitHorizontal class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm">{{ c.subject }}</p>
              <p class="truncate text-[11px] text-muted-foreground">{{ c.author }} · {{ fmtTime(c.date) }}</p>
            </div>
            <code class="shrink-0 font-mono text-[11px] text-muted-foreground">{{ c.short }}</code>
          </button>
          <p v-if="hasMore" class="py-2 text-center text-[11px] text-muted-foreground">仅显示最近 50 条</p>
        </div>

        <!-- 分支 / 标签 -->
        <div v-else-if="tab === 'refs'" class="scroll-thin grid min-h-0 max-h-[52vh] grid-cols-1 gap-3 overflow-y-auto sm:grid-cols-2">
          <div class="rounded-lg border p-3">
            <p class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><GitBranch class="size-3.5" /> 分支</p>
            <button v-for="b in detail?.branches ?? []" :key="b.name" type="button"
              class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/50"
              @click="switchRef(b.name)">
              <span class="min-w-0 flex-1 truncate">{{ b.name }}</span>
              <code class="text-[10px] text-muted-foreground">{{ b.hash }}</code>
            </button>
            <p v-if="!detail?.branches.length" class="py-2 text-xs text-muted-foreground">暂无分支</p>
          </div>
          <div class="rounded-lg border p-3">
            <p class="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Tag class="size-3.5" /> 标签</p>
            <button v-for="t in detail?.tags ?? []" :key="t.name" type="button"
              class="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-accent/50"
              @click="switchRef(t.name)">
              <span class="min-w-0 flex-1 truncate">{{ t.name }}</span>
              <code class="text-[10px] text-muted-foreground">{{ t.hash }}</code>
            </button>
            <p v-if="!detail?.tags.length" class="py-2 text-xs text-muted-foreground">暂无标签</p>
          </div>
        </div>

        <!-- 提交差异 -->
        <div v-else class="scroll-thin min-h-0 max-h-[52vh] overflow-y-auto">
          <p class="mb-2 text-xs text-muted-foreground">
            {{ diff?.from }} → {{ diff?.to }} · {{ diff?.files.length }} 个文件变更
          </p>
          <div v-for="f in diff?.files ?? []" :key="f.path" class="flex gap-2 px-1 py-0.5 text-[11px]">
            <span class="truncate font-mono">{{ f.path }}</span>
            <span class="ml-auto shrink-0 text-emerald-600 dark:text-emerald-400">+{{ f.additions }}</span>
            <span class="shrink-0 text-red-600 dark:text-red-400">-{{ f.deletions }}</span>
          </div>
          <pre class="scroll-thin mt-3 overflow-x-auto rounded border bg-muted/20 p-2 text-[11px] leading-relaxed"><code><span v-for="(l, i) in patchLines" :key="i" :class="lineClass(l)">{{ l }}{{ '\n' }}</span></code></pre>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <!-- 新建仓库 -->
  <Dialog :open="showCreate" @update:open="(v: boolean) => v || (showCreate = false)">
    <DialogContent class="max-w-md max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0">
      <DialogHeader>
        <DialogTitle>新建仓库</DialogTitle>
        <DialogDescription>创建裸仓库，创建后即可用上方地址 clone/push。</DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="repo-name">仓库名</Label>
          <Input id="repo-name" v-model="formName" placeholder="如 my-project" autocomplete="off" />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="repo-desc">描述（可选）</Label>
          <Input id="repo-desc" v-model="formDesc" placeholder="这个仓库是做什么的" autocomplete="off" />
        </div>
        <p v-if="formErr" role="alert" class="text-sm text-destructive">{{ formErr }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="sm" @click="showCreate = false">取消</Button>
          <Button size="sm" :disabled="saving || !formName.trim()" @click="doCreate">
            {{ saving ? '创建中…' : '创建' }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-if="delTarget"
    title="删除仓库"
    :description="`将永久删除 ${delTarget.name}.git 及其中全部提交，不可恢复。`"
    :confirm-text="`删除 ${delTarget.name}`"
    variant="destructive"
    :input="{ label: `输入仓库名 ${delTarget.name} 确认`, placeholder: delTarget.name, confirmCue: delTarget.name }"
    @confirm="doDelete"
    @close="delTarget = null"
  />
</template>

<style scoped>
/* README 的 v-html 不吃 scoped 属性，跟 MarkdownView 同一套最小排版（无 typography 插件）。 */
.repo-md {
  line-height: 1.75;
  overflow-wrap: break-word;
}
.repo-md :deep(h1),
.repo-md :deep(h2),
.repo-md :deep(h3) {
  margin: 1.2em 0 0.5em;
  font-weight: 600;
  line-height: 1.3;
}
.repo-md :deep(h1:first-child) {
  margin-top: 0;
  font-size: 1.6em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}
.repo-md :deep(h2) {
  font-size: 1.3em;
}
.repo-md :deep(h3) {
  font-size: 1.12em;
}
.repo-md :deep(p) {
  margin: 0.6em 0;
}
.repo-md :deep(ul),
.repo-md :deep(ol) {
  margin: 0.6em 0;
  padding-left: 1.6em;
  list-style: disc;
}
.repo-md :deep(code) {
  border-radius: 4px;
  background: var(--color-muted);
  padding: 0.15em 0.4em;
  font-size: 0.85em;
}
.repo-md :deep(pre) {
  margin: 0.8em 0;
  padding: 0.8em 1em;
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-muted);
}
.repo-md :deep(a) {
  color: var(--color-sky-400);
  text-underline-offset: 3px;
}
</style>
