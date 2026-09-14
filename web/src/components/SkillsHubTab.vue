<script setup lang="ts">
// 技能中心（AI 工具面板页签）。**技能库是个人技能池**——总数有限、都是自己挑的，
// 不摆列表：pill 流式一墙排开，一眼全览。点击 pill → Popover 就地全管：
// ① 安装位置勾选器：勾/取消即装/卸（勾选 = 并进规则，取消 = 摘出，下次同步从容器
//    清理），行内顺手管位置（范围切换/删除/新建位置）；
// ② 底部动作行：更新（显式重拉快照并分发）/ 移除（confirm）——一个 popover = 一个
//    技能的全部操作面。
// ③ 安装位置（规则清单）降级为底部折叠条：范围切换 / 成员数 / 清缺失 / 删位置。
// 添加面板（扫描/目录/git）是头部「+ 添加」Popover。pill 状态语言：实线 = 已装
// （名字后 ·N = 装了几处），虚线灰 = 未安装，红 = 内容缺失。
// 库语义：静态快照——来源改动不自动进库，更新 = 显式动作。安装位置订阅库：库一变
// 自动跟走；容器新建/重启全自动追平。
import { ref, computed, onMounted } from 'vue'
import {
  getSkillHub,
  getSkillInventory,
  getSkillRegistry,
  registryAddSkill,
  registryRemoveSkill,
  registryUpdateSkill,
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  RefreshCw,
  Trash2,
  FolderSync,
  Globe,
  Plus,
  CornerDownRight,
  Library,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
} from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

// 全局位置（铺全部受管容器）的缺省范围。
const GLOBAL_TO = '~/.claude/skills'

const hub = ref<SkillHubView | null>(null)
const inv = ref<SkillInventoryView | null>(null)
const invLoading = ref(false)
const invErr = ref('')
const err = ref('')

async function load() {
  err.value = ''
  try {
    hub.value = await getSkillHub()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
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

// —— 技能 ↔ 安装位置（规则）——

// 规则的声明技能集（视图 skills 含库里缺失的条目）。
function declaredOf(r: SkillRuleResult): string[] {
  return r.skills.map((s) => s.name)
}

// 某技能已安装到的位置（规则）。
function rulesOf(name: string): SkillRuleResult[] {
  return (hub.value?.rules ?? []).filter((r) => declaredOf(r).includes(name))
}

// 某技能尚未装到的其他位置（勾选器里未勾的行）。
function otherRulesOf(name: string): SkillRuleResult[] {
  return (hub.value?.rules ?? []).filter((r) => !declaredOf(r).includes(name))
}

// 单条规则的库缺失残留数（折叠条 amber 计数）。
function ruleMissing(r: SkillRuleResult): number {
  return r.skills.filter((k) => !k.ok).length
}

const missingTotal = computed(
  () => (hub.value?.rules ?? []).reduce((n, r) => n + ruleMissing(r), 0),
)

// 来源形态 → 身份色（与容器身份色同机制）：容器来源用容器色，宿主/git 用主色。
function sourceHost(s: SkillRegistryItem): string {
  if (s.from === 'registry') return 'host'
  const idx = s.from.indexOf(':')
  if (idx > 0 && /^[a-z0-9]/.test(s.from.slice(0, idx))) return s.from.slice(0, idx)
  return 'host'
}

// —— pill 状态语言 ——

// 装到几处（= 含它的规则数）。
function installedCount(s: SkillRegistryItem): number {
  return rulesOf(s.name).length
}

function pillClass(s: SkillRegistryItem): string {
  if (!s.exists) return 'border-destructive/30 bg-destructive/5 text-destructive/80'
  if (!installedCount(s)) return 'border-dashed text-muted-foreground hover:text-foreground'
  return 'border-line text-foreground hover:bg-accent/40'
}

function pillTitle(s: SkillRegistryItem): string {
  const desc = s.description ? `${s.description}` : ''
  if (!s.exists) return `${s.name}（内容缺失——点击更新重拉或移除）`
  const n = installedCount(s)
  const where = n ? `已装 ${n} 处` : '未安装——点击安装'
  return desc ? `${s.name}：${desc}（${where}）` : `${s.name}（${where}）`
}

// —— 行内「安装位置」勾选器 ——（一个技能一个 popover，单开）

const openSkill = ref<string | null>(null)

function openInstall(name: string) {
  nfTo.value = ''
  openSkill.value = name
}

// 勾/取消 = 并进/摘出规则（摘出后下次同步按清单从容器清理）。
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

// 范围切换：全部容器 ⇄ 仅已有该项目的容器。
async function toggleScope(r: SkillRuleResult) {
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { all: !r.all })
  } catch (e) {
    fail(e)
  }
}

// 新建位置并装上当前技能（勾选器底部一行输入）。
const nfTo = ref('')
const nfAll = ref(true)
const nfBusy = ref(false)

async function createRuleFor(name: string) {
  const to = nfTo.value.trim()
  if (!to) return
  nfBusy.value = true
  err.value = ''
  try {
    hub.value = await addSkillRule(to, nfAll.value, [name])
    nfTo.value = ''
    nfAll.value = true
    toast(`已安装：${name} → ${to}`)
  } catch (e) {
    fail(e)
  } finally {
    nfBusy.value = false
  }
}

// —— 行 ⋯ 菜单：更新 / 移除 ——

// 显式更新（库是静态快照：来源改动不自动进库，这是来源 → 库的唯一更新通道）。
// 更新即全量分发——订阅侧只认库，装出去的自动跟走。
const updatingSkill = ref('')
async function updateSkill(s: SkillRegistryItem) {
  if (updatingSkill.value) return
  updatingSkill.value = s.name
  err.value = ''
  try {
    const r = await registryUpdateSkill(s.name)
    const containers = r.sync.rules.flatMap((x) => x.containers)
    const bad = containers.filter((c) => !c.ok)
    if (bad.length) {
      toast.error(`库已更新，分发部分失败：${bad.map((f) => `${f.name === '__host__' ? '本机' : f.name} — ${f.error}`).join('；')}`)
    } else {
      toast(`已更新：${s.name}（已按安装位置分发）`)
    }
    await Promise.all([load(), loadReg(), loadInv()])
  } catch (e) {
    fail(e)
  } finally {
    updatingSkill.value = ''
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
    if (openSkill.value === s.name) openSkill.value = null
    toast(`已移除：${s.name}（已安装到各处的会在下次同步时从容器清理）`)
    await load()
  } catch (e) {
    fail(e)
  }
}

// —— 添加面板（头部 Popover）：扫描 / 目录 / git 三来源 ——

const showImport = ref(false)
const importMode = ref<'loose' | 'dir' | 'git'>('dir')
function toggleImport(v: boolean) {
  showImport.value = v
  if (v && looseTotal.value) importMode.value = 'loose'
}
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
    toast(`${r.replaced ? '已覆盖添加' : '已添加'}：${r.name}（快照——更新用行上 ⋯ 菜单）`)
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
    toast(`${r.replaced ? '已覆盖添加' : '已添加'}：${r.name}（快照——更新用行上 ⋯ 菜单）`)
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

// 从扫描行添加。thenGlobal = 添加后并进全局位置（一步到位装到全部容器）。
// 同名 → 确认后覆盖（确认框记住 thenGlobal，覆盖后继续装到全部容器）。
const regConfirm = ref<{ from: string; name: string; thenGlobal?: boolean } | null>(null)
async function addToRegistry(loc: SkillInventoryLocation, dir: string, spot: string, thenGlobal = false) {
  const from = (loc.kind === 'host' ? '~' : `${loc.name}:~`) + `/${spot}/${dir}`
  try {
    const r = await registryAddSkill(from)
    toast(`已添加：${r.name}`)
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
    toast(`已覆盖添加：${c.name}`)
    if (c.thenGlobal) await ensureGlobalHas(r.name)
    await Promise.all([loadReg(), load()])
  } catch (e) {
    fail(e)
  }
}

async function ensureGlobalHas(name: string) {
  let view = hub.value
  if (!view) {
    view = await getSkillHub()
    hub.value = view
  }
  const g = view.rules.find((t) => t.to === GLOBAL_TO)
  if (g) {
    const declared = declaredOf(g)
    if (!declared.includes(name)) hub.value = await updateSkillRule(g.id, { skills: [...declared, name] })
  } else {
    hub.value = await addSkillRule(GLOBAL_TO, true, [name])
  }
  toast(`已装到全部容器（${GLOBAL_TO}）`)
}

// —— 扫描页数据源（本机/容器里已装、未纳管的技能） ——

interface InvSpotRow {
  spot: string
  skills: SkillInventoryLocation['skills']
}
const looseTotal = computed(
  () => inv.value?.locations.reduce((n, l) => n + l.skills.filter((s) => !s.managed).length, 0) ?? 0,
)
// 只展示带未纳管技能的位置（已纳管的位置没有筛选价值）。
const invLocations = computed<SkillInventoryLocation[]>(() => {
  const locs = inv.value?.locations ?? []
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

// —— 立即同步（watch/启动追平之外的手动兜底）——
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
      toast.error(`skills 同步部分失败：${bad.map((f) => `${f.name === '__host__' ? '本机' : f.name} — ${f.error}`).join('；')}`)
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

// —— 底部折叠条：安装位置（规则清单，低频整理）——

const showRules = ref(false)

// 清掉规则里库里已缺失的残留成员（库出库/目录被外部删后的死引用）。
async function cleanMissing(r: SkillRuleResult) {
  const keep = r.skills.filter((k) => k.ok).map((k) => k.name)
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { skills: keep })
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
</script>

<template>
  <div class="flex flex-col gap-3">
    <p
      v-if="err"
      class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >{{ err }}</p>

    <!-- ① 技能 pill 墙：个人技能池，数目有限——流式排开一眼全览，点击 pill 就地全管 -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Library class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">技能库</span>
        <span
          class="shrink-0 cursor-help text-muted-foreground/50"
          title="个人技能池——pill 一眼全览：实线 = 已装（·N = 装了几处），虚线灰 = 未安装，红 = 缺失。点击 pill 管「装到哪」/ 更新 / 移除；来源改动不自动进库，更新走显式动作。"
        ><Info class="size-3.5" /></span>
        <div class="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-foreground"
          title="立即同步（平时全自动——watch/启动追平/建容器补发；这里是手动兜底）"
          :disabled="syncing"
          @click="syncNow"
        >
          <FolderSync :class="syncing ? 'animate-pulse' : ''" />
        </Button>
        <Popover :open="showImport" @update:open="toggleImport">
          <PopoverTrigger as-child>
            <Button variant="ghost" size="xs" class="h-6 shrink-0 gap-1 px-1.5 text-[11px]">
              <Plus class="size-3.5" /> 添加<span
                v-if="looseTotal"
                class="text-[10px] text-amber-600 dark:text-amber-400"
              >·{{ looseTotal }}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="end" class="w-96">
            <div class="flex gap-1">
              <button
                type="button"
                class="rounded border px-2 py-0.5 text-[11px] transition-colors"
                :class="importMode === 'loose' ? 'border-primary/40 bg-primary/10 text-primary' : 'border-line text-muted-foreground hover:text-foreground'"
                @click="importMode = 'loose'"
              >扫描<span v-if="looseTotal" class="text-amber-600 dark:text-amber-400"> ·{{ looseTotal }}</span></button>
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
            <template v-if="importMode === 'loose'">
              <div class="mt-2 flex items-center gap-2">
                <span class="min-w-0 flex-1 text-[10px] leading-relaxed text-muted-foreground/70">
                  本机和各容器里已有的技能——一键收进库。
                </span>
                <Button
                  variant="ghost"
                  size="xs"
                  class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                  :disabled="invLoading"
                  @click="loadInv"
                >
                  <RefreshCw class="size-3" :class="invLoading ? 'animate-spin' : ''" /> 重扫
                </Button>
              </div>
              <p v-if="invErr" class="mt-1 text-[11px] text-destructive">{{ invErr }}</p>
              <p v-if="!invLocations.length" class="mt-1 text-[11px] text-muted-foreground/70">没有待纳管的技能——扫到的都已在库里。</p>
              <div v-for="loc in invLocations" :key="loc.name" class="mt-1.5">
                <div class="flex items-center gap-2">
                  <span
                    class="size-2 shrink-0 rounded-full"
                    :style="{ backgroundColor: loc.kind === 'host' ? 'var(--color-primary)' : containerColor(loc.name) }"
                  />
                  <span class="text-xs font-medium">{{ loc.kind === 'host' ? '本机' : loc.name }}</span>
                  <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
                    {{ loc.skills.length }}
                  </Badge>
                </div>
                <div v-if="!loc.ok" class="text-[11px] text-destructive">{{ loc.error }}</div>
                <div v-for="row in spotRows(loc)" :key="row.spot" class="pl-3">
                  <div class="font-mono text-[10px] text-muted-foreground/70" title="skills 目录位置">~/{{ row.spot }}</div>
                  <div v-for="s in row.skills" :key="s.dir" class="flex items-baseline gap-2 pl-3">
                    <span class="shrink-0 font-mono text-[11px]">{{ s.name }}</span>
                    <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="shrink-0 text-muted-foreground hover:text-foreground"
                      title="收进技能库（快照）"
                      @click="addToRegistry(loc, s.dir, row.spot)"
                    >
                      <Library class="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      class="shrink-0 text-muted-foreground hover:text-foreground"
                      title="收进库并装到全部容器（~/.claude/skills）"
                      @click="addToRegistry(loc, s.dir, row.spot, true)"
                    >
                      <CornerDownRight class="size-3" />
                    </Button>
                  </div>
                </div>
              </div>
            </template>
            <template v-else-if="importMode === 'dir'">
              <div class="mt-2 flex gap-2">
                <Input
                  v-model="impDir"
                  placeholder="技能目录（须含 SKILL.md）：mytest:~/proj/…/xxx 或 ~/path/to/xxx"
                  class="h-8 flex-1 font-mono text-xs"
                  @keydown.enter="submitImportDir"
                />
                <Button size="sm" class="h-8 shrink-0" :disabled="impBusy || !impDir.trim()" @click="submitImportDir">添加</Button>
              </div>
              <p class="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
                拷一份快照进库，与来源解耦；要更新点 pill 弹层里的「更新」。
              </p>
            </template>
            <template v-else>
              <div class="mt-2 flex gap-2">
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
              <div v-if="impCandidates" class="mt-1.5">
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
                <Button size="sm" class="mt-1.5 h-7" :disabled="impBusy || !impPicked" @click="doImportGit">导入选中</Button>
              </div>
              <p class="mt-1.5 text-[10px] leading-relaxed text-muted-foreground/70">
                导入 = 快照（版本在仓库侧）；要更新点 pill 弹层里的「更新」。库内同名会提示覆盖。
              </p>
            </template>
          </PopoverContent>
        </Popover>
      </div>

      <!-- 空库 / 报错 -->
      <div v-if="regErr" class="px-3 py-4 text-center text-[11px] text-destructive">{{ regErr }}</div>
      <div v-else-if="!reg?.length" class="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
        还没有添加任何技能——点「添加」从扫描/本地目录/git 仓库收进库。
      </div>

      <!-- pill 墙：实线 = 已装（·N 处），虚线 = 未安装，红 = 缺失；点击 pill = popover 全管 -->
      <div v-else class="flex flex-wrap gap-1.5 px-3 py-3">
        <Popover
          v-for="s in reg"
          :key="s.name"
          :open="openSkill === s.name"
          @update:open="(v: boolean) => (v ? openInstall(s.name) : (openSkill = null))"
        >
          <PopoverTrigger as-child>
            <button
              type="button"
              class="flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors"
              :class="pillClass(s)"
              :title="pillTitle(s)"
            >
              <Loader2
                v-if="updatingSkill === s.name"
                class="size-2.5 shrink-0 animate-spin text-muted-foreground"
              />
              <span
                v-else
                class="size-1.5 shrink-0 rounded-full"
                :style="{ backgroundColor: containerColor(sourceHost(s)) }"
              />
              <span class="font-mono">{{ s.name }}</span>
              <span v-if="s.exists && installedCount(s)" class="text-[9px] opacity-60">·{{ installedCount(s) }}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent side="bottom" align="start" class="w-80 p-2">
            <div v-if="hub?.rules.length" class="flex flex-col">
              <div
                v-for="r in [...rulesOf(s.name), ...otherRulesOf(s.name)]"
                :key="r.id"
                class="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/50"
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded py-0.5 text-left"
                  :title="`已安装到 ${r.to}${r.all ? '（全部受管容器）' : '（仅已有该项目的容器）'}——点击勾/取消（取消后下次同步从容器清理）`"
                  @click="toggleRuleSkill(r, s.name, !declaredOf(r).includes(s.name))"
                >
                  <Checkbox
                    :model-value="declaredOf(r).includes(s.name)"
                    tabindex="-1"
                    class="pointer-events-none shrink-0"
                  />
                  <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ r.to }}</span>
                </button>
                <button
                  type="button"
                  class="shrink-0 rounded border px-1 py-0.5 text-[9px] transition-colors"
                  :class="r.all
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
                  :title="r.all ? '装进全部受管容器——点击改为仅已有该项目的容器' : '只装已有该项目的容器——点击改为全部容器'"
                  @click="toggleScope(r)"
                >
                  {{ r.all ? '全部容器' : '仅项目' }}
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  class="shrink-0 text-muted-foreground/50 hover:text-destructive"
                  title="删除此安装位置（它装出去的 skill 按清单从容器清理；用户自装的其他 skill 不动）"
                  @click="delRule = r"
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
            <p v-else class="px-1 py-1 text-[10px] text-muted-foreground/70">还没有安装位置——下面新建一个。</p>
            <div class="mt-1.5 flex items-center gap-1.5 border-t pt-1.5">
              <Input
                v-model="nfTo"
                placeholder="新位置：~/proj/.claude/skills"
                class="h-7 flex-1 font-mono text-[11px]"
                @keydown.enter="createRuleFor(s.name)"
              />
              <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted-foreground" title="勾选 = 装进全部受管容器；不勾 = 只装已有该项目的容器">
                <Checkbox :model-value="nfAll" @update:model-value="(v) => (nfAll = !!v)" />
                全部
              </label>
              <Button size="xs" class="shrink-0" :disabled="nfBusy || !nfTo.trim()" @click="createRuleFor(s.name)">安装</Button>
            </div>
            <!-- 动作行：更新（显式重拉快照并分发）+ 来源备忘 + 移除 -->
            <div class="mt-1.5 flex items-center gap-1 border-t pt-1.5">
              <Button
                variant="ghost"
                size="xs"
                class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                title="从来源重拉快照并全量分发（来源改动不自动进库——这是唯一更新通道）"
                :disabled="!!updatingSkill"
                @click="updateSkill(s)"
              >
                <RefreshCw class="size-3" :class="updatingSkill === s.name ? 'animate-spin' : ''" />
                {{ updatingSkill === s.name ? '更新中…' : '更新' }}
              </Button>
              <span
                class="min-w-0 flex-1 truncate text-right font-mono text-[9px] text-muted-foreground/40"
                :title="s.from"
              >{{ s.from }}</span>
              <Button
                variant="ghost"
                size="xs"
                class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                title="移除（已安装到各处的会在下次同步时从容器清理）"
                @click="delReg = s"
              >
                <Trash2 class="size-3" /> 移除
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>

    <!-- ② 安装位置（规则清单）：低频整理，底部折叠条 -->
    <div v-if="hub?.rules.length" class="rounded-md border">
      <button
        type="button"
        class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left"
        :title="showRules ? '收起' : '展开：范围 / 清缺失 / 删除位置'"
        @click="showRules = !showRules"
      >
        <Globe class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs text-muted-foreground">安装位置</span>
        <span class="text-xs">{{ hub.rules.length }}</span>
        <span
          v-if="missingTotal"
          class="text-[10px] text-amber-600 dark:text-amber-400"
          title="规则里有库里已不存在的技能残留——展开后可清掉"
        >·{{ missingTotal }} 缺失</span>
        <div class="flex-1" />
        <component :is="showRules ? ChevronDown : ChevronRight" class="size-3 shrink-0 text-muted-foreground" />
      </button>
      <div v-if="showRules" class="border-t">
        <div
          v-for="(t, ti) in hub.rules"
          :key="t.id"
          class="flex items-center gap-2 px-3 py-1.5"
          :class="ti > 0 ? 'border-t' : ''"
        >
          <Globe v-if="t.all" class="size-3.5 shrink-0 text-muted-foreground" />
          <FolderSync v-else class="size-3.5 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="t.to">{{ t.to }}</span>
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
          <span class="shrink-0 text-[10px] text-muted-foreground">
            {{ t.skills.length }} skill<span v-if="ruleMissing(t)" class="text-amber-600 dark:text-amber-400"> ·{{ ruleMissing(t) }} 缺失</span>
          </span>
          <Button
            v-if="ruleMissing(t)"
            variant="ghost"
            size="xs"
            class="h-5 shrink-0 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
            title="清掉库里已不存在的残留引用"
            @click="cleanMissing(t)"
          >清缺失</Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground/40 hover:text-destructive"
            title="删除此安装位置（它装出去的 skill 按清单从容器清理；用户自装的其他 skill 不动）"
            @click="delRule = t"
          >
            <Trash2 />
          </Button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="delRule"
      title="删除安装位置"
      :description="`删除安装位置 ${delRule.to}？它装出去的 skill 将按清单从对应容器中清理（容器里用户自装的其他 skill 不动）。`"
      confirm-text="删除"
      variant="destructive"
      @confirm="doDeleteRule"
      @close="delRule = null"
    />
    <ConfirmDialog
      v-if="regConfirm"
      title="覆盖添加"
      :description="`技能库里已有「${regConfirm.name}」。用 ${regConfirm.from} 的内容覆盖它？${regConfirm.thenGlobal ? '覆盖后会继续装到全部容器。' : ''}`"
      confirm-text="覆盖"
      variant="destructive"
      @confirm="doConfirmRegistry"
      @close="regConfirm = null"
    />
    <ConfirmDialog
      v-if="delReg"
      title="移除技能"
      :description="`把「${delReg.name}」从技能库移除？安装位置里对它的引用会变成「缺失」，下次同步时从对应容器清理。`"
      confirm-text="移除"
      variant="destructive"
      @confirm="doDeleteReg"
      @close="delReg = null"
    />
  </div>
</template>
