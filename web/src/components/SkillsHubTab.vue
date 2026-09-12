<script setup lang="ts">
// 技能中心（AI 工具面板页签）。「资产 → 分发」两层：
// ① 已安装：本机 + 各容器实际装着的 skills（只读扫描，标准落点 + 各项目下的
//    .claude/skills），落点行可一键「分发」。
// ② 分发规则：把一个 skills 目录装进容器（底层 = hub 目标：一个去向聚合多个来源，
//    重名按顺序先到先得）。新建 = 来源 + 去向 + 范围一张表单（去向已存在则并入来源）。
// 全自动触发（watch + 启动追平 + 建容器/容器 start 补发），config.skills.sync 底部只读展示。
import { ref, onMounted, computed, nextTick } from 'vue'
import {
  getSkillHub,
  getSkillInventory,
  getSkillRegistry,
  registryAddSkill,
  registryRemoveSkill,
  registryProbeGit,
  registryImportGit,
  addSkillHubTarget,
  updateSkillHubTarget,
  deleteSkillHubTarget,
  addSkillHubTargetSource,
  updateSkillHubTargetSource,
  deleteSkillHubTargetSource,
  syncSkills,
  Unauthorized,
  type SkillHubView,
  type SkillHubTargetView,
  type SkillHubSourceView,
  type SkillInventoryView,
  type SkillInventoryLocation,
  type SkillRegistryItem,
  type SkillGitCandidate,
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  RefreshCw,
  Trash2,
  ArrowUp,
  ArrowDown,
  FolderSync,
  Globe,
  Plus,
  PackageSearch,
  CornerDownRight,
  Library,
} from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

const hub = ref<SkillHubView | null>(null)
const inv = ref<SkillInventoryView | null>(null)
const invLoading = ref(false)
const invErr = ref('')
const loading = ref(false)
const err = ref('')

async function load() {
  loading.value = true
  err.value = ''
  try {
    hub.value = await getSkillHub()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function loadInv() {
  invLoading.value = true
  invErr.value = ''
  try {
    inv.value = await getSkillInventory()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    invErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    invLoading.value = false
  }
}
onMounted(() => {
  void load()
  void loadInv()
  void loadReg()
})

// —— 技能库（registry）：用户策展的权威技能集 ——

const reg = ref<SkillRegistryItem[] | null>(null)
const regErr = ref('')

async function loadReg() {
  regErr.value = ''
  try {
    reg.value = await getSkillRegistry()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    regErr.value = e instanceof Error ? e.message : String(e)
  }
}

// 导入表单（两种来源：目录 / git 仓库）
const showImport = ref(false)
const importMode = ref<'dir' | 'git'>('dir')
const impDir = ref('')
const impUrl = ref('')
const impCandidates = ref<SkillGitCandidate[] | null>(null)
const impPicked = ref('')
const impBusy = ref(false)

async function submitImportDir() {
  const from = impDir.value.trim()
  if (!from) return
  impBusy.value = true
  err.value = ''
  try {
    const r = await registryAddSkill(from)
    toast(`${r.replaced ? '已覆盖入库' : '已入库'}：${r.name}`)
    impDir.value = ''
    await loadReg()
  } catch (e) {
    fail(e)
  } finally {
    impBusy.value = false
  }
}

async function probeGit() {
  const url = impUrl.value.trim()
  if (!url) return
  impBusy.value = true
  err.value = ''
  try {
    const r = await registryProbeGit(url)
    impCandidates.value = r.candidates
    impPicked.value = r.candidates[0]?.path ?? ''
    if (!r.candidates.length) toast('仓库里没探测到技能（找 SKILL.md）')
  } catch (e) {
    fail(e)
  } finally {
    impBusy.value = false
  }
}

async function doImportGit() {
  const url = impUrl.value.trim()
  if (!url || !impPicked.value) return
  impBusy.value = true
  err.value = ''
  try {
    const r = await registryImportGit(url, impPicked.value)
    toast(`${r.replaced ? '已覆盖入库' : '已入库'}：${r.name}`)
    impUrl.value = ''
    impCandidates.value = null
    impPicked.value = ''
    await loadReg()
  } catch (e) {
    fail(e)
  } finally {
    impBusy.value = false
  }
}

// 入库（从已安装散装行）：from 精确到技能目录；同名 → 确认后覆盖。
const regConfirm = ref<{ from: string; name: string } | null>(null)
async function addToRegistry(loc: SkillInventoryLocation, dir: string, spot: string) {
  const from = (loc.kind === 'host' ? '~' : `${loc.name}:~`) + `/${spot}/${dir}`
  try {
    await registryAddSkill(from)
    toast(`已入库：${dir}`)
    await loadReg()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('已有同名')) regConfirm.value = { from, name: dir }
    else fail(e)
  }
}
async function doConfirmRegistry() {
  const c = regConfirm.value
  if (!c) return
  regConfirm.value = null
  try {
    await registryAddSkill(c.from, true)
    toast(`已覆盖入库：${c.name}`)
    await loadReg()
  } catch (e) {
    fail(e)
  }
}

const delReg = ref<SkillRegistryItem | null>(null)
async function doDeleteReg() {
  const s = delReg.value
  if (!s) return
  delReg.value = null
  err.value = ''
  try {
    reg.value = await registryRemoveSkill(s.name)
    toast(`已出库：${s.name}（已在分发中的会在下次同步时从容器清理）`)
  } catch (e) {
    fail(e)
  }
}

// 库整体分发：预填 from='registry' 的新建分发。
function dispatchRegistry() {
  if (!reg.value?.length) return
  nf.value.from = 'registry'
  showNew.value = true
  void nextTick(() => newFormRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}

function fail(e: unknown) {
  if (e instanceof Unauthorized) {
    emit('unauthorized')
    return
  }
  err.value = e instanceof Error ? e.message : String(e)
}

// 源的展示名（冲突归属/来源标注）：registry = 技能库；容器:路径 → 容器名段；
// 宿主路径 → 末段目录。
function sourceLabel(from: string): string {
  if (from === 'registry') return '技能库'
  const idx = from.indexOf(':')
  if (idx > 0) return from.slice(0, idx)
  const parts = from.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || from
}

// —— 已安装：位置 × 落点分组视图数据 ——

interface InvSpotRow {
  spot: string
  skills: SkillInventoryLocation['skills']
}

// 分发副本默认折叠：容器的 skills 目录大多是分发的结果，把结果当资产罗列只会
// 刷屏（同一 skill 在 N 个容器重复）。默认只看「散装的」（未被任何规则管理的）
// ——那才是待筛选的新资产；开关展开 = 运行时视角（确认某容器实际能用什么）。
const showManaged = ref(localStorage.getItem('mysandbox:skills-show-managed') === '1')
function toggleShowManaged(v: unknown) {
  showManaged.value = !!v
  localStorage.setItem('mysandbox:skills-show-managed', showManaged.value ? '1' : '0')
}

const invTotal = computed(() => inv.value?.locations.reduce((n, l) => n + l.skills.length, 0) ?? 0)
const looseTotal = computed(
  () => inv.value?.locations.reduce((n, l) => n + l.skills.filter((s) => !s.managed).length, 0) ?? 0,
)

// 默认只显示带散装 skill 的位置（全分发了的位置不占屏）；开关后显示全部。
const invLocations = computed<SkillInventoryLocation[]>(() => {
  const locs = inv.value?.locations ?? []
  if (showManaged.value) return locs
  return locs
    .map((l) => ({ ...l, skills: l.skills.filter((s) => !s.managed) }))
    .filter((l) => l.skills.length > 0)
})

function spotRows(loc: SkillInventoryLocation): InvSpotRow[] {
  const map = new Map<string, InvSpotRow>()
  for (const s of loc.skills) {
    let row = map.get(s.spot)
    if (!row) {
      row = { spot: s.spot, skills: [] }
      map.set(s.spot, row)
    }
    row.skills.push(s)
  }
  return [...map.values()]
}

// —— 新建分发（来源 + 去向 + 范围一张表单；去向已存在则并入其来源）——
const showNew = ref(false)
const nf = ref({ from: '', to: '~/.claude/skills', all: true })
const submitting = ref(false)
const newFormRef = ref<HTMLElement | null>(null)

// 从已安装扫描出候选（宿主 = ~/spot；容器 = <名>:~/spot），库是第一候选。
const sourceOptions = computed(() => {
  const out: { value: string; label: string }[] = []
  if (reg.value?.length) out.push({ value: 'registry', label: `技能库（${reg.value.length} 个技能）` })
  for (const loc of inv.value?.locations ?? []) {
    const spots = [...new Set(loc.skills.map((s) => s.spot))]
    for (const spot of spots) {
      const value = loc.kind === 'host' ? `~/${spot}` : `${loc.name}:~/${spot}`
      out.push({ value, label: `${loc.kind === 'host' ? '本机' : loc.name} · ~/${spot}` })
    }
  }
  return out
})

// 已安装行「分发」：预填来源并展开表单。
function startDispatch(loc: SkillInventoryLocation, spot: string) {
  nf.value.from = loc.kind === 'host' ? `~/${spot}` : `${loc.name}:~/${spot}`
  showNew.value = true
  void nextTick(() => newFormRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
}

async function submitNew() {
  const from = nf.value.from.trim()
  const to = nf.value.to.trim()
  if (!from || !to) return
  submitting.value = true
  err.value = ''
  try {
    let tid = hub.value?.targets.find((t) => t.to === to)?.id
    if (!tid) {
      try {
        const v = await addSkillHubTarget(to, nf.value.all)
        hub.value = v
        tid = v.targets.find((t) => t.to === to)?.id
      } catch (e) {
        if (!(e instanceof Unauthorized)) {
          // 去向已存在（缓存过期/并发）→ 刷新后并入
          const v = await getSkillHub()
          hub.value = v
          tid = v.targets.find((t) => t.to === to)?.id
          if (!tid) throw e
        } else {
          throw e
        }
      }
    }
    if (!tid) throw new Error(`目标创建失败：${to}`)
    hub.value = await addSkillHubTargetSource(tid, from)
    showNew.value = false
    nf.value = { from: '', to: '~/.claude/skills', all: true }
    toast(`已添加分发：${sourceLabel(from)} → ${to}`)
  } catch (e) {
    fail(e)
  } finally {
    submitting.value = false
  }
}

// —— 分发规则：范围 / 删 ——
async function toggleScope(t: SkillHubTargetView) {
  err.value = ''
  try {
    hub.value = await updateSkillHubTarget(t.id, { all: !t.all })
  } catch (e) {
    fail(e)
  }
}
const delTarget = ref<SkillHubTargetView | null>(null)
async function doDeleteTarget() {
  const t = delTarget.value
  if (!t) return
  delTarget.value = null
  err.value = ''
  try {
    hub.value = await deleteSkillHubTarget(t.id)
  } catch (e) {
    fail(e)
  }
}

// —— 规则内来源：添加 / 启停 / 排序 / 删 ——
const addFrom = ref<Record<string, string>>({})
const addingSource = ref<string | null>(null)
async function submitSource(t: SkillHubTargetView) {
  const from = (addFrom.value[t.id] ?? '').trim()
  if (!from) return
  addingSource.value = t.id
  err.value = ''
  try {
    hub.value = await addSkillHubTargetSource(t.id, from)
    addFrom.value[t.id] = ''
  } catch (e) {
    fail(e)
  } finally {
    addingSource.value = null
  }
}
async function patchSource(t: SkillHubTargetView, s: SkillHubSourceView, patch: { enabled?: boolean; move?: number }) {
  err.value = ''
  try {
    hub.value = await updateSkillHubTargetSource(t.id, s.id, patch)
  } catch (e) {
    fail(e)
  }
}
const delSource = ref<{ t: SkillHubTargetView; s: SkillHubSourceView } | null>(null)
async function doDeleteSource() {
  const d = delSource.value
  if (!d) return
  delSource.value = null
  err.value = ''
  try {
    hub.value = await deleteSkillHubTargetSource(d.t.id, d.s.id)
  } catch (e) {
    fail(e)
  }
}

// —— 立即同步（watch/启动追平之外的手动兜底；静态规则 + 中心一起跑）——
const syncing = ref(false)
async function syncNow() {
  if (syncing.value) return
  syncing.value = true
  err.value = ''
  try {
    const r = await syncSkills()
    const containers = [
      ...r.rules.flatMap((x) => x.containers),
      ...(r.hub?.targets.flatMap((x) => x.containers) ?? []),
    ]
    const bad = containers.filter((c) => !c.ok)
    if (bad.length) {
      toast.error(`skills 同步部分失败：${bad.map((f) => `${f.name} — ${f.error}`).join('；')}`)
    } else {
      const changed = containers.reduce((n, c) => n + c.changed, 0)
      const removed = containers.reduce((n, c) => n + c.removed, 0)
      const parts = [changed ? `更新 ${changed} 个文件` : '', removed ? `清理 ${removed} 个陈旧` : ''].filter(Boolean)
      toast(`skills 已同步${parts.length ? '：' + parts.join('，') : '：全部已是最新'}`)
    }
    await Promise.all([load(), loadInv(), loadReg()])
  } catch (e) {
    fail(e)
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs leading-relaxed text-muted-foreground">
      <b class="font-medium">技能库</b>：你自己定的技能集（自产 + 外部导入），入库即与来源解耦。
      <b class="font-medium">分发规则</b>：把一个 skills 目录（或整个库）装进容器——源变化自动同步，
      容器重启/新建自动补齐。下面的<b class="font-medium">已安装</b>是发现视图：看到好的散装 skill 一键入库。
    </p>

    <p
      v-if="err"
      class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >{{ err }}</p>

    <!-- 已安装：默认只看散装（未分发）的技能；开关展开运行时全貌 -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <PackageSearch class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">已安装</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ showManaged ? `${invTotal} skill` : `${looseTotal} 待筛选` }}
        </Badge>
        <div class="flex-1" />
        <label
          class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
          title="分发出的副本默认不展示（各容器大量重复）；勾选后按容器展示全部已安装（运行时视角）"
        >
          <Checkbox :model-value="showManaged" @update:model-value="toggleShowManaged" />
          显示分发副本
        </label>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground"
          title="重新扫描"
          :disabled="invLoading"
          @click="loadInv"
        >
          <RefreshCw :class="invLoading ? 'animate-spin' : ''" />
        </Button>
      </div>
      <p v-if="invErr" class="px-3 py-2 text-[11px] text-destructive">{{ invErr }}</p>
      <div
        v-if="!invLocations.length"
        class="px-3 py-2.5 text-[11px] text-muted-foreground/70"
      >
        没有散装的 skill——扫到的都已进分发规则。要看各容器实际装了什么，勾「显示分发副本」。
      </div>
      <div
        v-for="(loc, li) in invLocations"
        :key="loc.name"
        class="px-3 py-1.5"
        :class="li > 0 ? 'border-t' : ''"
      >
        <div class="flex items-center gap-2">
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :style="{ backgroundColor: loc.kind === 'host' ? 'var(--color-primary)' : containerColor(loc.name) }"
          />
          <span class="text-xs font-medium">{{ loc.kind === 'host' ? '本机' : loc.name }}</span>
          <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
            {{ loc.skills.length }}
          </Badge>
        </div>
        <div v-if="!loc.ok" class="pl-4 text-[11px] text-destructive">{{ loc.error }}</div>
        <div v-else-if="!loc.skills.length" class="pl-4 text-[11px] text-muted-foreground/70">无 skill</div>
        <div v-for="row in spotRows(loc)" :key="row.spot" class="mt-1 pl-4">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/70" title="skills 目录位置">~/{{ row.spot }}</span>
            <Button
              variant="ghost"
              size="xs"
              class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
              :title="`把这个目录的 skills 分发到容器`"
              @click="startDispatch(loc, row.spot)"
            >
              <CornerDownRight class="size-3" /> 分发…
            </Button>
          </div>
          <div
            v-for="s in row.skills"
            :key="s.dir"
            class="flex items-baseline gap-2 pl-3"
          >
            <span class="shrink-0 font-mono text-[11px]">{{ s.name }}</span>
            <Badge
              v-if="s.managed"
              variant="outline"
              class="shrink-0 border-transparent bg-primary/10 px-1 text-[10px] text-primary"
              title="已被某个分发规则管理——摘除来源/删除规则时会自动从这里清理"
            >已分发</Badge>
            <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
            <Button
              v-if="!s.managed"
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              title="入库：拷一份进技能库（与来源解耦），之后从库分发"
              @click="addToRegistry(loc, s.dir, row.spot)"
            >
              <Library class="size-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 技能库：用户策展的权威技能集（放什么用户定） -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Library class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">技能库</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ reg?.filter((s) => s.exists).length ?? 0 }}
        </Badge>
        <div class="flex-1" />
        <Button variant="ghost" size="xs" class="h-6 shrink-0 gap-1 px-1.5 text-[11px]" @click="showImport = !showImport">
          <Plus class="size-3.5" /> 导入
        </Button>
        <Button
          variant="ghost"
          size="xs"
          class="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          :disabled="!reg?.some((s) => s.exists)"
          title="把整个库作为一个来源挂到分发规则"
          @click="dispatchRegistry"
        >
          <CornerDownRight class="size-3" /> 分发…
        </Button>
      </div>

      <!-- 导入表单：目录 / git 仓库 -->
      <div v-if="showImport" class="space-y-2 border-b bg-muted/20 px-3 py-2.5">
        <div class="flex gap-1">
          <button
            type="button"
            class="rounded border px-2 py-0.5 text-[11px] transition-colors"
            :class="importMode === 'dir' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line text-muted-foreground hover:text-foreground'"
            @click="importMode = 'dir'"
          >从目录</button>
          <button
            type="button"
            class="rounded border px-2 py-0.5 text-[11px] transition-colors"
            :class="importMode === 'git' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line text-muted-foreground hover:text-foreground'"
            @click="importMode = 'git'"
          >从 git 仓库</button>
        </div>
        <template v-if="importMode === 'dir'">
          <div class="flex gap-2">
            <Input
              v-model="impDir"
              placeholder="技能目录（须含 SKILL.md）：mytest:~/proj/.claude/skills/xxx 或 ~/path/to/xxx"
              class="h-8 flex-1 font-mono text-xs"
              @keydown.enter="submitImportDir"
            />
            <Button size="sm" class="h-8 shrink-0" :disabled="impBusy || !impDir.trim()" @click="submitImportDir">入库</Button>
          </div>
        </template>
        <template v-else>
          <div class="flex gap-2">
            <Input
              v-model="impUrl"
              placeholder="git 仓库地址：https://github.com/user/repo"
              class="h-8 flex-1 font-mono text-xs"
              @keydown.enter="probeGit"
            />
            <Button size="sm" class="h-8 shrink-0" :disabled="impBusy || !impUrl.trim()" @click="probeGit">
              {{ impBusy ? '探测中…' : impCandidates ? '重扫' : '探测' }}
            </Button>
          </div>
          <div v-if="impCandidates" class="space-y-1">
            <p v-if="!impCandidates.length" class="text-[11px] text-muted-foreground/70">没探测到技能（找 SKILL.md）</p>
            <label
              v-for="c in impCandidates"
              :key="c.path"
              class="flex cursor-pointer items-center gap-2 text-[11px]"
            >
              <Checkbox :model-value="impPicked === c.path" @update:model-value="(v) => (impPicked = v ? c.path : '')" />
              <span class="font-mono">{{ c.name }}</span>
              <span class="text-muted-foreground">{{ c.path === '.' ? 'repo 根' : c.path }}</span>
            </label>
            <Button size="sm" class="h-7" :disabled="impBusy || !impPicked" @click="doImportGit">导入选中</Button>
          </div>
        </template>
        <p class="text-[10px] leading-relaxed text-muted-foreground/70">
          入库 = 拷一份进库（与来源解耦，源删了库还在）；库内同名会提示覆盖。
        </p>
      </div>

      <div v-if="!reg?.length" class="px-3 py-2.5 text-[11px] text-muted-foreground/70">
        库是空的——从目录或 git 仓库导入技能，或在下面已安装列表里把散装的 skill 一键入库。
      </div>
      <div
        v-for="(s, si) in reg ?? []"
        :key="s.name"
        class="flex items-center gap-2 px-3 py-1.5"
        :class="si > 0 ? 'border-t' : ''"
      >
        <span class="shrink-0 font-mono text-xs" :class="s.exists ? '' : 'text-muted-foreground/50 line-through'">{{ s.name }}</span>
        <Badge v-if="!s.exists" variant="outline" class="shrink-0 border-transparent bg-destructive/10 px-1 text-[10px] text-destructive">缺失</Badge>
        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
        <span class="hidden shrink-0 font-mono text-[10px] text-muted-foreground/50 md:block" :title="s.from">{{ s.from }}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-destructive"
          title="出库（已在分发中的会在下次同步时从容器清理）"
          @click="delReg = s"
        >
          <Trash2 />
        </Button>
      </div>
    </div>

    <!-- 分发规则：一个去向聚合多个来源 -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <FolderSync class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">分发规则</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ hub?.targets.length ?? 0 }}
        </Badge>
        <div class="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          class="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          @click="showNew = !showNew"
        >
          <Plus class="size-3.5" /> 新建分发
        </Button>
      </div>

      <!-- 新建分发表单 -->
      <div v-if="showNew" ref="newFormRef" class="space-y-2 border-b bg-muted/20 px-3 py-2.5">
        <div class="flex items-center gap-2">
          <span class="w-12 shrink-0 text-[11px] text-muted-foreground">来源</span>
          <Input
            v-model="nf.from"
            placeholder="目录路径：mytest:~/proj/.claude/skills 或 ~/proj/.claude/skills"
            class="h-8 flex-1 font-mono text-xs"
          />
          <Select :model-value="nf.from" @update:model-value="(v) => (nf.from = String(v ?? ''))">
            <SelectTrigger class="h-8 w-36 shrink-0 text-[11px]" title="从已安装扫描结果中选择">
              <SelectValue placeholder="从已安装选" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem v-for="o in sourceOptions" :key="o.value" :value="o.value" class="text-[11px]">
                  {{ o.label }}
                </SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-2">
          <span class="w-12 shrink-0 text-[11px] text-muted-foreground">装到</span>
          <Input
            v-model="nf.to"
            placeholder="容器内路径，如 ~/.claude/skills"
            class="h-8 flex-1 font-mono text-xs"
          />
          <label
            class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground"
            title="勾选 = 装进全部受管容器；不勾 = 只装已有该项目的容器（项目克隆到哪 skill 跟到哪）"
          >
            <Checkbox :model-value="nf.all" @update:model-value="(v) => (nf.all = !!v)" />
            全部容器
          </label>
          <Button size="sm" class="h-8 shrink-0" :disabled="submitting || !nf.from.trim() || !nf.to.trim()" @click="submitNew">
            {{ submitting ? '添加中…' : '添加' }}
          </Button>
        </div>
        <p class="text-[10px] leading-relaxed text-muted-foreground/70">
          「装到」路径已在其他规则里时，来源会并入那条规则（范围沿用该规则现有的设置）。
        </p>
      </div>

      <div v-if="!hub?.targets.length" class="px-3 py-2.5 text-[11px] text-muted-foreground/70">
        还没有分发规则——点「新建分发」，或在上面已安装列表里选个目录直接分发。
      </div>

      <div
        v-for="(t, ti) in hub?.targets ?? []"
        :key="t.id"
        class="px-3 py-2"
        :class="ti > 0 ? 'border-t' : ''"
      >
        <!-- 规则头：去向 + 范围 + 删 -->
        <div class="flex items-center gap-2">
          <Globe v-if="t.all" class="size-3.5 shrink-0 text-muted-foreground" />
          <FolderSync v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium" :title="t.to">{{ t.to }}</span>
          <button
            type="button"
            class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition-colors"
            :class="t.all
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
            :title="t.all ? '装进全部受管容器——点击改为仅已有该项目的容器' : '只装已有该项目的容器——点击改为全部容器'"
            @click="toggleScope(t)"
          >
            {{ t.all ? '全部容器' : '仅已有该项目' }}
          </button>
          <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
            {{ t.skills.length }} skill
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground hover:text-destructive"
            title="删除此分发（它装出去的 skill 按清单从容器清理；容器里用户自装的其他 skill 不动）"
            @click="delTarget = t"
          >
            <Trash2 />
          </Button>
        </div>

        <!-- 装到容器里的内容与归属 -->
        <div v-if="t.skills.length" class="mt-1 pl-4">
          <div
            v-for="k in t.skills"
            :key="k.name"
            class="flex items-center gap-2 py-0.5"
          >
            <FolderSync class="size-3 shrink-0 text-muted-foreground/70" />
            <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ k.name }}</span>
            <Badge variant="outline" class="shrink-0 border-transparent bg-primary/10 text-[10px] text-primary">
              来自 {{ sourceLabel(t.sources.find((s) => s.id === k.sourceId)?.from ?? '') }}
            </Badge>
            <span
              v-if="k.conflicts.length"
              class="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
              :title="`${k.conflicts.map((id) => t.sources.find((s) => s.id === id)?.from).join('、')} 也提供同名 skill，顺序在后者让位`"
            >{{ k.conflicts.length }} 源重名</span>
          </div>
        </div>
        <div v-else class="mt-1 pl-4 text-[11px] text-muted-foreground/70">
          还没有可装的内容——在下面挂来源
        </div>

        <!-- 来源列表 -->
        <div
          v-for="(s, si) in t.sources"
          :key="s.id"
          class="mt-1 flex items-center gap-2 rounded pl-4"
          :class="si > 0 ? 'pt-1' : ''"
        >
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            :style="{ backgroundColor: containerColor(sourceLabel(s.from)) }"
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate font-mono text-xs" :class="s.enabled ? '' : 'text-muted-foreground/50 line-through'" :title="s.from">{{ s.from }}</span>
              <Badge v-if="!s.enabled" variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">停用</Badge>
            </div>
            <div class="truncate text-[11px] text-muted-foreground">
              <template v-if="s.error"><span class="text-destructive">{{ s.error }}</span></template>
              <template v-else-if="s.enabled && s.skills.length">{{ s.skills.length }} 个 skill</template>
              <template v-else>空源</template>
            </div>
          </div>
          <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" title="启用/停用（停用后其 skill 退出该去向并从容器清理）">
            <Checkbox :model-value="s.enabled" @update:model-value="(v) => patchSource(t, s, { enabled: !!v })" />
            启用
          </label>
          <Button variant="ghost" size="icon-xs" class="shrink-0" title="上移（提高优先级）" :disabled="si === 0" @click="patchSource(t, s, { move: -1 })">
            <ArrowUp />
          </Button>
          <Button variant="ghost" size="icon-xs" class="shrink-0" title="下移" :disabled="si === t.sources.length - 1" @click="patchSource(t, s, { move: 1 })">
            <ArrowDown />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground hover:text-destructive"
            title="摘除来源（其 skill 退出该去向并从容器清理）"
            @click="delSource = { t, s }"
          >
            <Trash2 />
          </Button>
        </div>

        <!-- 再挂一个来源 -->
        <div class="mt-2 flex gap-2 pl-4">
          <Input
            v-model="addFrom[t.id]"
            placeholder="再挂一个来源目录…"
            class="h-8 flex-1 font-mono text-xs"
            @keydown.enter="submitSource(t)"
          />
          <Button size="sm" class="h-8 shrink-0" :disabled="addingSource === t.id || !addFrom[t.id]?.trim()" @click="submitSource(t)">
            <Plus class="size-3.5" /> 挂上
          </Button>
        </div>
      </div>
    </div>

    <!-- config 静态规则（只读展示） -->
    <div v-if="hub?.configRules.length" class="rounded-md border border-dashed px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
      <p class="mb-1 font-semibold">config.yaml 静态规则（{{ hub.configRules.length }} 条，独立于上面的规则）</p>
      <p v-for="r in hub.configRules" :key="r.from + r.to" class="font-mono">{{ r.from }} → {{ r.to }}</p>
      <p class="mt-1">改它去 ~/.config/mysandbox/config.yaml（重启服务生效）；同去向别同时用规则和分发规则。</p>
    </div>

    <div class="flex justify-end">
      <Button size="sm" :disabled="syncing" @click="syncNow">
        <FolderSync :class="syncing ? 'animate-pulse' : ''" /> {{ syncing ? '同步中…' : '立即同步' }}
      </Button>
    </div>

    <ConfirmDialog
      v-if="delTarget"
      title="删除分发"
      :description="`删除去往 ${delTarget.to} 的分发？它装出去的 skill 将按清单从对应容器中清理（容器里用户自装的其他 skill 不动）；其下挂的来源一并移除。`"
      confirm-text="删除"
      variant="destructive"
      @confirm="doDeleteTarget"
      @close="delTarget = null"
    />
    <ConfirmDialog
      v-if="delSource"
      title="摘除来源"
      :description="`从去往 ${delSource.t.to} 的分发摘除 ${delSource.s.from}？它提供的 skill 将退出该去向，下次同步时从对应容器中清理（不影响它挂载的其他去向）。`"
      confirm-text="摘除"
      variant="destructive"
      @confirm="doDeleteSource"
      @close="delSource = null"
    />
    <ConfirmDialog
      v-if="regConfirm"
      title="覆盖入库"
      :description="`技能库里已有「${regConfirm.name}」。用 ${regConfirm.from} 的内容覆盖它？`"
      confirm-text="覆盖"
      variant="destructive"
      @confirm="doConfirmRegistry"
      @close="regConfirm = null"
    />
    <ConfirmDialog
      v-if="delReg"
      title="出库"
      :description="`把「${delReg.name}」移出技能库？已在分发中的它会在下次同步时从对应容器清理（库外的来源不受影响）。`"
      confirm-text="出库"
      variant="destructive"
      @confirm="doDeleteReg"
      @close="delReg = null"
    />
  </div>
</template>
