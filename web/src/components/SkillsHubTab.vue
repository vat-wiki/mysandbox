<script setup lang="ts">
// 技能中心（AI 工具面板页签）。「库 → 规则」两层：
// ① 已安装：本机 + 各容器实际装着的 skills（只读扫描，标准落点 + 各项目下的
//    .claude/skills）。散装的（未被任何规则管理）可一键入库 / 入库并装到全局。
// ② 技能库：唯一技能真相源——目录来源入库 = 跟随刷新（源改库跟，源删冻结），
//    git 导入 = 快照（重导入即更新）。
// ③ 安装规则：{库内技能集合, 去向, 范围}。全局去向铺全部受管容器；项目去向只装
//    已有该项目的容器（项目克隆到哪 skill 跟到哪）。库内同名唯一，无冲突概念。
// 全自动触发（watch + 启动追平 + 建容器/容器 start 补发）。
import { ref, computed, onMounted } from 'vue'
import {
  getSkillHub,
  getSkillInventory,
  getSkillRegistry,
  registryAddSkill,
  registryRemoveSkill,
  registryProbeGit,
  registryImportGit,
  addSkillRule,
  updateSkillRule,
  deleteSkillRule,
  syncSkills,
  Unauthorized,
  type SkillHubView,
  type SkillRuleResult,
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
import { RefreshCw, Trash2, FolderSync, Globe, Plus, PackageSearch, CornerDownRight, Library } from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

// 全局规则的缺省去向（铺全部受管容器）。
const GLOBAL_TO = '~/.claude/skills'

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

onMounted(() => {
  void load()
  void loadInv()
  void loadReg()
})

function fail(e: unknown) {
  if (e instanceof Unauthorized) {
    emit('unauthorized')
    return
  }
  err.value = e instanceof Error ? e.message : String(e)
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

// —— 技能库导入（两种来源：目录 / git 仓库）——

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
    toast(`${r.replaced ? '已覆盖入库' : '已入库'}：${r.name}（目录来源，跟随源更新）`)
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
    toast(`${r.replaced ? '已覆盖入库' : '已入库'}：${r.name}（git 快照，更新请重新导入）`)
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

// 入库（从已安装散装行）。thenGlobal = 入库后并进全局规则（一步到位装到全部容器）。
// 同名 → 确认后覆盖（确认框记住 thenGlobal，覆盖后继续装到全局）。
const regConfirm = ref<{ from: string; name: string; thenGlobal?: boolean } | null>(null)
async function addToRegistry(loc: SkillInventoryLocation, dir: string, spot: string, thenGlobal = false) {
  const from = (loc.kind === 'host' ? '~' : `${loc.name}:~`) + `/${spot}/${dir}`
  try {
    const r = await registryAddSkill(from)
    toast(`已入库：${r.name}`)
    if (thenGlobal) await ensureGlobalHas(r.name)
    await Promise.all([loadReg(), load()])
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('已有同名')) regConfirm.value = { from, name: dir, thenGlobal }
    else fail(e)
  }
}
async function doConfirmRegistry() {
  const c = regConfirm.value
  if (!c) return
  regConfirm.value = null
  try {
    const r = await registryAddSkill(c.from, true)
    toast(`已覆盖入库：${c.name}`)
    if (c.thenGlobal) await ensureGlobalHas(r.name)
    await Promise.all([loadReg(), load()])
  } catch (e) {
    fail(e)
  }
}

// 确保全局规则包含某技能（无全局规则则建）。
async function ensureGlobalHas(name: string) {
  let view = hub.value
  if (!view) {
    view = await getSkillHub()
    hub.value = view
  }
  const g = view.rules.find((t) => t.to === GLOBAL_TO)
  if (g) {
    const declared = g.skills.map((s) => s.name)
    if (!declared.includes(name)) {
      hub.value = await updateSkillRule(g.id, { skills: [...declared, name] })
    }
  } else {
    hub.value = await addSkillRule(GLOBAL_TO, true, [name])
  }
  toast(`已装到全局（${GLOBAL_TO}，全部容器）`)
}

// 库整体装到全局：现存库技能全部并进全局规则（新建则建）。
const dispatching = ref(false)
async function dispatchRegistry() {
  const names = (reg.value ?? []).filter((s) => s.exists).map((s) => s.name)
  if (!names.length) return
  dispatching.value = true
  err.value = ''
  try {
    let view = hub.value
    if (!view) {
      view = await getSkillHub()
      hub.value = view
    }
    const g = view.rules.find((t) => t.to === GLOBAL_TO)
    if (g) {
      const declared = g.skills.map((s) => s.name)
      const merged = [...new Set([...declared, ...names])]
      if (merged.length !== declared.length) hub.value = await updateSkillRule(g.id, { skills: merged })
    } else {
      hub.value = await addSkillRule(GLOBAL_TO, true, names)
    }
    toast(`已把 ${names.length} 个库技能装到全局`)
  } catch (e) {
    fail(e)
  } finally {
    dispatching.value = false
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
    await load()
  } catch (e) {
    fail(e)
  }
}

// —— 安装规则：新建 / 范围 / 技能勾选 / 删 ——

const showNew = ref(false)
const nf = ref({ to: GLOBAL_TO, all: true, skills: [] as string[] })
const submitting = ref(false)

async function submitNew() {
  const to = nf.value.to.trim()
  if (!to) return
  submitting.value = true
  err.value = ''
  try {
    hub.value = await addSkillRule(to, nf.value.all, nf.value.skills)
    showNew.value = false
    nf.value = { to: GLOBAL_TO, all: true, skills: [] }
    toast(`已添加规则：${to}`)
  } catch (e) {
    fail(e)
  } finally {
    submitting.value = false
  }
}

// 规则的声明技能集（视图 skills 含库里缺失的条目）。
function declaredOf(r: SkillRuleResult): string[] {
  return r.skills.map((s) => s.name)
}

async function toggleScope(r: SkillRuleResult) {
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { all: !r.all })
  } catch (e) {
    fail(e)
  }
}

// 勾/取消勾一个技能（PATCH 全量声明集；取消勾选的技能下次同步从容器收回）。
async function toggleRuleSkill(r: SkillRuleResult, name: string, on: boolean) {
  const declared = declaredOf(r)
  const next = on ? (declared.includes(name) ? declared : [...declared, name]) : declared.filter((n) => n !== name)
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { skills: next })
  } catch (e) {
    fail(e)
  }
}

const delRule = ref<SkillRuleResult | null>(null)
async function doDeleteRule() {
  const r = delRule.value
  if (!r) return
  delRule.value = null
  err.value = ''
  try {
    hub.value = await deleteSkillRule(r.id)
  } catch (e) {
    fail(e)
  }
}

// 规则的技能勾选面板（展开哪个规则）。
const editing = ref<string | null>(null)

// —— 立即同步（watch/启动追平之外的手动兜底；顺带刷新 follow 条目）——
const syncing = ref(false)
async function syncNow() {
  if (syncing.value) return
  syncing.value = true
  err.value = ''
  try {
    const r = await syncSkills()
    const containers = r.rules.flatMap((x) => x.containers)
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
      <b class="font-medium">技能库</b>是唯一真相源：目录来源跟随源更新，git 导入为快照。
      <b class="font-medium">安装规则</b>把库里的技能装到去向（全局铺全部容器 / 项目去向跟项目走），
      源变化、容器新建/重启都自动追平。下面的<b class="font-medium">已安装</b>是发现视图：看到好的散装 skill 一键入库。
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
        没有散装的 skill——扫到的都已进安装规则。要看各容器实际装了什么，勾「显示分发副本」。
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
          <div class="font-mono text-[10px] text-muted-foreground/70" title="skills 目录位置">~/{{ row.spot }}</div>
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
              title="已被某条安装规则管理——取消勾选/删除规则时会自动从这里清理"
            >已分发</Badge>
            <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
            <Button
              v-if="!s.managed"
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              title="入库：拷一份进技能库（目录来源，跟随源更新）"
              @click="addToRegistry(loc, s.dir, row.spot)"
            >
              <Library class="size-3" />
            </Button>
            <Button
              v-if="!s.managed"
              variant="ghost"
              size="icon-xs"
              class="shrink-0 text-muted-foreground hover:text-foreground"
              title="入库并装到全局（~/.claude/skills，全部容器）"
              @click="addToRegistry(loc, s.dir, row.spot, true)"
            >
              <CornerDownRight class="size-3" />
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- 技能库：唯一技能真相源（放什么用户定） -->
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
          :disabled="dispatching || !reg?.some((s) => s.exists)"
          title="把库里的全部技能装进全局规则（~/.claude/skills，全部容器）"
          @click="dispatchRegistry"
        >
          <CornerDownRight class="size-3" /> 装到全局…
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
          <p class="text-[10px] leading-relaxed text-muted-foreground/70">
            目录来源 = 跟随：源目录改动自动刷新库并分发；源删了库内容冻结保留。
          </p>
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
          <p class="text-[10px] leading-relaxed text-muted-foreground/70">
            git 导入 = 快照（版本在仓库侧）；要更新重新导入即可。库内同名会提示覆盖。
          </p>
        </template>
      </div>

      <div v-if="!reg?.length" class="px-3 py-2.5 text-[11px] text-muted-foreground/70">
        库是空的——从目录或 git 仓库导入技能，或在上面已安装列表里把散装的 skill 一键入库。
      </div>
      <div
        v-for="(s, si) in reg ?? []"
        :key="s.name"
        class="flex items-center gap-2 px-3 py-1.5"
        :class="si > 0 ? 'border-t' : ''"
      >
        <span class="shrink-0 font-mono text-xs" :class="s.exists ? '' : 'text-muted-foreground/50 line-through'">{{ s.name }}</span>
        <Badge v-if="!s.exists" variant="outline" class="shrink-0 border-transparent bg-destructive/10 px-1 text-[10px] text-destructive">缺失</Badge>
        <Badge
          variant="outline"
          class="shrink-0 border-transparent px-1 text-[10px]"
          :class="s.follow ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'"
          :title="s.follow ? '跟随源目录：源改动自动刷新库并分发' : '快照：git 导入的副本，更新请重新导入'"
        >{{ s.follow ? '跟随' : '快照' }}</Badge>
        <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
        <span class="hidden shrink-0 font-mono text-[10px] text-muted-foreground/50 md:block" :title="s.from">{{ s.from }}</span>
        <Button
          v-if="s.follow"
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          title="立即从来源刷新这个技能（全量同步）"
          :disabled="syncing"
          @click="syncNow"
        >
          <RefreshCw :class="syncing ? 'animate-spin' : ''" />
        </Button>
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

    <!-- 安装规则：{库内技能集合, 去向, 范围} -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <FolderSync class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">安装规则</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ hub?.rules.length ?? 0 }}
        </Badge>
        <div class="flex-1" />
        <Button
          variant="ghost"
          size="xs"
          class="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          @click="showNew = !showNew"
        >
          <Plus class="size-3.5" /> 新建规则
        </Button>
      </div>

      <!-- 新建规则表单：去向 + 范围 + 技能勾选 -->
      <div v-if="showNew" class="space-y-2 border-b bg-muted/20 px-3 py-2.5">
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
          <Button size="sm" class="h-8 shrink-0" :disabled="submitting || !nf.to.trim()" @click="submitNew">
            {{ submitting ? '添加中…' : '添加' }}
          </Button>
        </div>
        <div v-if="reg?.some((s) => s.exists)" class="flex flex-wrap gap-x-3 gap-y-1.5 pl-14">
          <label v-for="s in reg.filter((x) => x.exists)" :key="s.name" class="flex cursor-pointer items-center gap-1.5 text-[11px]">
            <Checkbox
              :model-value="nf.skills.includes(s.name)"
              @update:model-value="(v) => (nf.skills = v ? [...nf.skills, s.name] : nf.skills.filter((n) => n !== s.name))"
            />
            <span class="font-mono">{{ s.name }}</span>
          </label>
        </div>
        <p v-else class="pl-14 text-[11px] text-muted-foreground/70">
          库还是空的——先在上面导入技能（不勾技能也可以先建去向，之后再勾）。
        </p>
      </div>

      <div v-if="!hub?.rules.length" class="px-3 py-2.5 text-[11px] text-muted-foreground/70">
        还没有安装规则——点「新建规则」，或在上面已安装列表里把散装 skill 一键装到全局。
      </div>

      <div
        v-for="(t, ti) in hub?.rules ?? []"
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
            title="删除此规则（它装出去的 skill 按清单从容器清理；容器里用户自装的其他 skill 不动）"
            @click="delRule = t"
          >
            <Trash2 />
          </Button>
        </div>

        <!-- 技能清单（勾选面板展开时显示全库 checkbox；收起时显示已勾的） -->
        <div v-if="editing === t.id" class="mt-1.5 rounded border bg-muted/20 px-3 py-2">
          <div class="flex flex-wrap gap-x-3 gap-y-1.5">
            <label
              v-for="s in reg?.filter((x) => x.exists) ?? []"
              :key="s.name"
              class="flex cursor-pointer items-center gap-1.5 text-[11px]"
            >
              <Checkbox
                :model-value="declaredOf(t).includes(s.name)"
                @update:model-value="(v) => toggleRuleSkill(t, s.name, !!v)"
              />
              <span class="font-mono">{{ s.name }}</span>
            </label>
          </div>
          <div class="mt-1.5 flex items-center justify-between">
            <span class="text-[10px] text-muted-foreground/70">勾选即生效（自动同步到容器）；取消勾选的会从容器清理。</span>
            <Button variant="ghost" size="xs" class="h-5 text-[10px]" @click="editing = null">收起</Button>
          </div>
        </div>
        <div v-else-if="t.skills.length" class="mt-1 pl-4">
          <div
            v-for="k in t.skills"
            :key="k.name"
            class="flex items-center gap-2 py-0.5"
          >
            <FolderSync class="size-3 shrink-0 text-muted-foreground/70" />
            <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ k.name }}</span>
            <span
              v-if="!k.ok"
              class="shrink-0 text-[10px] text-destructive"
              title="库里没有这个技能（目录被外部删了/元数据残留）——其他技能照常分发"
            >库中缺失</span>
          </div>
          <button
            type="button"
            class="mt-1 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            @click="editing = t.id"
          >
            编辑技能…
          </button>
        </div>
        <div v-else class="mt-1 flex items-center gap-2 pl-4">
          <span class="text-[11px] text-muted-foreground/70">还没有装任何技能</span>
          <button
            type="button"
            class="text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            @click="editing = t.id"
          >
            编辑技能…
          </button>
        </div>
      </div>
    </div>

    <div class="flex justify-end">
      <Button size="sm" :disabled="syncing" @click="syncNow">
        <FolderSync :class="syncing ? 'animate-pulse' : ''" /> {{ syncing ? '同步中…' : '立即同步' }}
      </Button>
    </div>

    <ConfirmDialog
      v-if="delRule"
      title="删除安装规则"
      :description="`删除去往 ${delRule.to} 的规则？它装出去的 skill 将按清单从对应容器中清理（容器里用户自装的其他 skill 不动）。`"
      confirm-text="删除"
      variant="destructive"
      @confirm="doDeleteRule"
      @close="delRule = null"
    />
    <ConfirmDialog
      v-if="regConfirm"
      title="覆盖入库"
      :description="`技能库里已有「${regConfirm.name}」。用 ${regConfirm.from} 的内容覆盖它？${regConfirm.thenGlobal ? '覆盖后会继续装到全局。' : ''}`"
      confirm-text="覆盖"
      variant="destructive"
      @confirm="doConfirmRegistry"
      @close="regConfirm = null"
    />
    <ConfirmDialog
      v-if="delReg"
      title="出库"
      :description="`把「${delReg.name}」移出技能库？安装规则里对它的引用会变成「库中缺失」，下次同步时从对应容器清理。`"
      confirm-text="出库"
      variant="destructive"
      @confirm="doDeleteReg"
      @close="delReg = null"
    />
  </div>
</template>
