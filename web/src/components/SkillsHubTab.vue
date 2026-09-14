<script setup lang="ts">
// 技能中心（AI 工具面板页签）。**技能库是中心**，但展示走渐进式披露：
// ① 中心列表默认一行薄行（名称/状态/安装位置概要），点行才展开 = 来源 + 安装管理
//    （位置 chips ✕ 移除 / 虚线 + 装到其他位置 / 新建位置）+ 刷新/移除；
// ② 安装位置（规则级管理：范围切换/删/清缺失）不常驻——头部 Share2 钮唤出，
//    打开即内容态，有缺失残留时钮挂 amber 提醒。
// 添加面板三来源：扫描（本机/容器里已装、未纳管的技能，有货时打开默认落此页）
// / 目录 / git——「扫描」只是添加的发现型入口，与手填路径走同一 API。
// 顶部不再铺概念说明——收在头部 ？tooltip（空态引导见空库文案）。
// 库语义：**静态快照中心**——入库（目录/git）一律拷贝，来源改动不自动进库（不订阅
// 来源）；更新 = 显式动作（行展开「更新」，重拉来源 + 全量分发）。安装位置订阅库：
// 库一变自动跟走。全自动触发（watch 库目录 + 启动追平 + 建容器/容器 start 补发）。
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
import { RefreshCw, Trash2, FolderSync, Globe, Plus, CornerDownRight, Library, ChevronDown, ChevronRight, Info, Share2 } from 'lucide-vue-next'
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

// —— 技能 ↔ 安装位置（中心视图的映射） ——

// 规则的声明技能集（视图 skills 含库里缺失的条目）。
function declaredOf(r: SkillRuleResult): string[] {
  return r.skills.map((s) => s.name)
}

// 某技能已安装到的位置（规则）。
function rulesOf(name: string): SkillRuleResult[] {
  return (hub.value?.rules ?? []).filter((r) => declaredOf(r).includes(name))
}

// 某技能尚未装到的其他位置（展开态里虚线 + 装上）。
function otherRulesOf(name: string): SkillRuleResult[] {
  return (hub.value?.rules ?? []).filter((r) => !declaredOf(r).includes(name))
}

// 来源形态 → 身份色（与容器身份色同机制）：容器来源用容器色，宿主/git 用主色。
function sourceHost(s: SkillRegistryItem): string {
  if (s.from === 'registry') return 'host'
  const idx = s.from.indexOf(':')
  if (idx > 0 && /^[a-z0-9]/.test(s.from.slice(0, idx))) return s.from.slice(0, idx)
  return 'host'
}

// —— 库条目操作：添加 / 移除 / 刷新 / 安装 ——

// 添加面板：三来源——扫描（自动发现，有货时打开默认落这里）/ 目录 / git 仓库。
// 「扫描」不是独立概念，就是添加的发现型入口：扫到的行点添加与手填路径走同一 API。
const showImport = ref(false)
const importMode = ref<'loose' | 'dir' | 'git'>('dir')
function openImport() {
  showImport.value = !showImport.value
  if (showImport.value && looseTotal.value) importMode.value = 'loose'
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
    toast(`${r.replaced ? '已覆盖添加' : '已添加'}：${r.name}（快照——更新点行内「更新」）`)
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
    toast(`${r.replaced ? '已覆盖添加' : '已添加'}：${r.name}（快照——更新点行内「更新」）`)
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

const delReg = ref<SkillRegistryItem | null>(null)
async function doDeleteReg() {
  const s = delReg.value
  if (!s) return
  delReg.value = null
  err.value = ''
  try {
    reg.value = await registryRemoveSkill(s.name)
    toast(`已移除：${s.name}（已安装到各处的会在下次同步时从容器清理）`)
    await load()
  } catch (e) {
    fail(e)
  }
}

// —— 显式更新（库是静态快照：来源改动不自动进库，这是来源 → 库的唯一更新通道）。
// 更新即全量分发——订阅侧只认库，装出去的自动跟走。 ——

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

// —— 技能行「安装管理」（展开态内）：chips ✕ 移除 / + 装到其他位置 / 新建位置 ——

const nfTo = ref('')
const nfAll = ref(true)
const nfBusy = ref(false)

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

// —— 规则级管理：范围切换 / 成员清理 / 删 ——

async function toggleScope(r: SkillRuleResult) {
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { all: !r.all })
  } catch (e) {
    fail(e)
  }
}

// 从规则里摘掉一个成员（缺库残留也在这里清）。
async function removeFromRule(r: SkillRuleResult, name: string) {
  await toggleRuleSkill(r, name, false)
}

const expandedRule = ref<string | null>(null)
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

// —— 渐进式披露：技能行默认一行薄行，点行展开（来源 + 安装管理 + 操作）；
//    安装位置/扫描不常驻主视图——头部图标钮唤出（打开即内容态），有事时
//    钮上挂 amber 点（待纳管 / 缺失残留）；概念说明收头部 ？tooltip。 ——
const expandedSkill = ref<string | null>(null)
const showRules = ref(false)
const missingTotal = computed(
  () => (hub.value?.rules ?? []).reduce((n, r) => n + r.skills.filter((k) => !k.ok).length, 0),
)
// 单条规则的库缺失残留数（行上 amber 计数）。
function ruleMissing(r: SkillRuleResult): number {
  return r.skills.filter((k) => !k.ok).length
}

// —— 扫描：添加面板「扫描」页的数据源（本机/容器里已装、未纳管的技能） ——

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
</script>

<template>
  <div class="space-y-4">
    <p
      v-if="err"
      class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >{{ err }}</p>

    <!-- ① 中心：技能库。渐进式：列表默认薄行，概念说明收 ？tooltip（空态引导见空库文案） -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Library class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">技能库</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ reg?.filter((s) => s.exists).length ?? 0 }}
        </Badge>
        <div class="flex-1" />
        <span
          class="shrink-0 cursor-help text-muted-foreground/50"
          title="技能库是中心——库里的每个技能看它装到了哪。库是静态快照：来源改动不自动进库，更新走行内「更新」（重拉来源并分发）；安装位置订阅库，库一变自动跟走；容器新建/重启全自动追平。最顺手的添加入口在文件面板：进到项目目录点「安装技能」就地添加。"
        ><Info class="size-3.5" /></span>
        <Button
          variant="ghost"
          size="icon-xs"
          class="relative shrink-0 text-muted-foreground hover:text-foreground"
          :title="missingTotal ? `安装位置（${missingTotal} 缺失待清）` : '安装位置：范围 / 成员 / 删除'"
          @click="showRules = !showRules"
        >
          <Share2 />
          <span v-if="missingTotal" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
        </Button>
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
        <Button
          variant="ghost"
          size="xs"
          class="relative h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          :title="looseTotal ? `添加（${looseTotal} 个未纳管技能待处理）` : '添加技能：从扫描 / 目录 / git 仓库'"
          @click="openImport"
        >
          <Plus class="size-3.5" /> 添加
          <span v-if="looseTotal" class="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500" />
        </Button>
      </div>

      <!-- 添加面板：扫描 / 目录 / git 仓库 -->
      <div v-if="showImport" class="space-y-2 border-b bg-muted/20 px-3 py-2.5">
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
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 text-[10px] leading-relaxed text-muted-foreground/70">
              扫描本机和各容器里已有的技能——还没纳管的一键添加进库（点 <CornerDownRight class="inline size-3" /> 顺带装到全部容器）。
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
          <p v-if="invErr" class="text-[11px] text-destructive">{{ invErr }}</p>
          <p v-if="!invLocations.length" class="text-[11px] text-muted-foreground/70">没有待纳管的技能——扫到的都已在库里。</p>
          <div v-for="loc in invLocations" :key="loc.name" class="space-y-1">
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
                  title="添加：拷一份快照进技能库（来源改动不自动进库，更新走行内「更新」）"
                  @click="addToRegistry(loc, s.dir, row.spot)"
                >
                  <Library class="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  class="shrink-0 text-muted-foreground hover:text-foreground"
                  title="添加并装到全部容器（~/.claude/skills）"
                  @click="addToRegistry(loc, s.dir, row.spot, true)"
                >
                  <CornerDownRight class="size-3" />
                </Button>
              </div>
            </div>
          </div>
        </template>
        <template v-if="importMode === 'dir'">
          <div class="flex gap-2">
            <Input
              v-model="impDir"
              placeholder="技能目录（须含 SKILL.md）：mytest:~/proj/.claude/skills/xxx 或 ~/path/to/xxx"
              class="h-8 flex-1 font-mono text-xs"
              @keydown.enter="submitImportDir"
            />
            <Button size="sm" class="h-8 shrink-0" :disabled="impBusy || !impDir.trim()" @click="submitImportDir">添加</Button>
          </div>
          <p class="text-[10px] leading-relaxed text-muted-foreground/70">
            目录来源也是快照：拷进库即与来源解耦，源改动不自动进库；要更新在技能行展开里点「更新」。
          </p>
        </template>
        <template v-if="importMode === 'git'">
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
            git 导入 = 快照（版本在仓库侧）；要更新在技能行展开里点「更新」（重拉最新）。库内同名会提示覆盖。
          </p>
        </template>
      </div>

      <!-- 空库 -->
      <div v-if="!reg?.length" class="px-3 py-4 text-center text-[11px] text-muted-foreground/70">
        还没有添加任何技能——点「添加」从扫描/本地目录/git 仓库添加。
      </div>

      <!-- 技能行：收起 = 一行薄行（身份/状态/安装位置概要），点行展开 = 来源 + 安装管理 + 操作 -->
      <div
        v-for="(s, si) in reg ?? []"
        :key="s.name"
        class="px-3 py-2"
        :class="si > 0 ? 'border-t' : ''"
      >
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-2 text-left"
          :title="expandedSkill === s.name ? '收起' : '展开：来源 · 安装位置 · 操作'"
          @click="expandedSkill = expandedSkill === s.name ? null : s.name"
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full"
            :style="{ backgroundColor: containerColor(sourceHost(s)) }"
            :title="`来源：${s.from}`"
          />
          <span class="shrink-0 font-mono text-xs" :class="s.exists ? 'font-medium' : 'text-muted-foreground/50 line-through'">{{ s.name }}</span>
          <Badge v-if="s.exists" variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground" title="静态快照——与来源解耦，更新走行内「更新」">快照</Badge>
          <Badge v-else variant="outline" class="shrink-0 border-transparent bg-destructive/10 px-1 text-[10px] text-destructive">缺失</Badge>
          <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" :title="s.description">{{ s.description }}</span>
          <!-- 安装位置概要：核心语义是「看它装到了哪」，收起态也要能瞥见；多则截断，行展开看全 -->
          <template v-if="s.exists">
            <span
              v-if="!rulesOf(s.name).length"
              class="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
              title="还没装到任何位置——展开行配置"
            >未安装</span>
            <template v-else>
              <span
                v-for="r in rulesOf(s.name).slice(0, 2)"
                :key="r.id"
                class="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                :title="`已安装到 ${r.to}${r.all ? '（全部容器）' : '（仅已有该项目的容器）'}`"
              >{{ r.to }}</span>
              <span v-if="rulesOf(s.name).length > 2" class="shrink-0 text-[10px] text-muted-foreground">+{{ rulesOf(s.name).length - 2 }}</span>
            </template>
          </template>
          <component :is="expandedSkill === s.name ? ChevronDown : ChevronRight" class="size-3 shrink-0 text-muted-foreground" />
        </button>

        <!-- 展开态：来源 + 安装位置管理 + 操作（低频细节都住这里） -->
        <div v-if="expandedSkill === s.name" class="mt-2 space-y-2 rounded border bg-muted/20 px-3 py-2">
          <div class="flex items-center gap-1.5">
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              :style="{ backgroundColor: containerColor(sourceHost(s)) }"
            />
            <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground/50" :title="s.from">{{ s.from }}</span>
          </div>

          <template v-if="s.exists">
            <div class="flex flex-wrap items-center gap-1.5">
              <span
                v-for="r in rulesOf(s.name)"
                :key="r.id"
                class="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                :title="`已安装到 ${r.to}${r.all ? '（全部容器）' : '（仅已有该项目的容器）'}——✕ 移除（下次同步按清单从容器清理）`"
              >
                {{ r.to }}
                <button type="button" class="text-muted-foreground/60 hover:text-destructive" @click="removeFromRule(r, s.name)">✕</button>
              </span>
              <span
                v-for="r in otherRulesOf(s.name)"
                :key="r.id"
                class="flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-foreground"
                title="尚未安装到这个位置——+ 装上"
              >
                {{ r.to }}
                <button type="button" class="text-muted-foreground/60 hover:text-primary" @click="toggleRuleSkill(r, s.name, true)">+</button>
              </span>
              <span v-if="!hub?.rules.length" class="text-[10px] text-muted-foreground/70">还没装到任何位置</span>
            </div>

            <div class="flex items-center gap-2 border-t pt-2">
              <Input
                v-model="nfTo"
                placeholder="新位置（容器内路径，如 ~/proj/.claude/skills）"
                class="h-7 flex-1 font-mono text-[11px]"
                @keydown.enter="createRuleFor(s.name)"
              />
              <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" title="勾选 = 装进全部受管容器；不勾 = 只装已有该项目的容器">
                <Checkbox :model-value="nfAll" @update:model-value="(v) => (nfAll = !!v)" />
                全部容器
              </label>
              <Button size="xs" class="shrink-0 gap-1" :disabled="nfBusy || !nfTo.trim()" @click="createRuleFor(s.name)">
                <Plus class="size-3" /> 安装
              </Button>
            </div>

            <div class="flex items-center gap-1">
              <Button
                v-if="s.from"
                variant="ghost"
                size="xs"
                class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                :title="`从来源重拉快照并分发（${s.from}）`"
                :disabled="!!updatingSkill"
                @click="updateSkill(s)"
              >
                <RefreshCw class="size-3" :class="updatingSkill === s.name ? 'animate-spin' : ''" />
                {{ updatingSkill === s.name ? '更新中…' : '更新' }}
              </Button>
              <div class="flex-1" />
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
          </template>
          <template v-else>
            <p class="text-[10px] leading-relaxed text-muted-foreground/70">内容缺失——来源还在的话点「更新」重拉一份，否则移除后重新添加。</p>
            <div class="flex items-center gap-1">
              <Button
                v-if="s.from"
                variant="ghost"
                size="xs"
                class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-foreground"
                :title="`从来源重拉快照并分发（${s.from}）`"
                :disabled="!!updatingSkill"
                @click="updateSkill(s)"
              >
                <RefreshCw class="size-3" :class="updatingSkill === s.name ? 'animate-spin' : ''" />
                {{ updatingSkill === s.name ? '更新中…' : '更新' }}
              </Button>
              <div class="flex-1" />
              <Button
                variant="ghost"
                size="xs"
                class="h-5 shrink-0 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                title="移除（安装位置里对它的引用会变成缺失，下次同步清理）"
                @click="delReg = s"
              >
                <Trash2 class="size-3" /> 移除
              </Button>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- ② 辅助：安装位置（规则级管理）——不常驻，头部 Share2 钮唤出（打开即内容态） -->
    <div v-if="showRules" class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Share2 class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">安装位置</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">
          {{ hub?.rules.length ?? 0 }}
        </Badge>
        <span class="hidden text-[10px] text-muted-foreground/70 md:inline">成员在技能行展开里管理</span>
        <div class="flex-1" />
      </div>

      <div v-if="!hub?.rules.length" class="px-3 py-2.5 text-[11px] text-muted-foreground/70">
        还没有安装位置——展开技能行添加（新建即建规则）。
      </div>
      <div
        v-for="(t, ti) in hub?.rules ?? []"
        :key="t.id"
        class="px-3 py-1.5"
        :class="ti > 0 ? 'border-t' : ''"
      >
        <div class="flex items-center gap-2">
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
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            :title="expandedRule === t.id ? '收起成员' : '查看成员（含库中缺失的残留）'"
            @click="expandedRule = expandedRule === t.id ? null : t.id"
          >
            <component :is="expandedRule === t.id ? ChevronDown : ChevronRight" class="size-3" />
            {{ t.skills.length }} skill
            <span v-if="ruleMissing(t)" class="text-amber-600 dark:text-amber-400">·{{ ruleMissing(t) }} 缺失</span>
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground hover:text-destructive"
            title="删除此安装位置（它装出去的 skill 按清单从容器清理；容器里用户自装的其他 skill 不动）"
            @click="delRule = t"
          >
            <Trash2 />
          </Button>
        </div>
        <!-- 成员展开：✕ 摘除（缺库残留也在这里清） -->
        <div v-if="expandedRule === t.id" class="mt-1 flex flex-wrap gap-1.5 pl-6">
          <span
            v-for="k in t.skills"
            :key="k.name"
            class="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px]"
            :class="k.ok ? 'text-foreground' : 'text-destructive'"
            :title="k.ok ? '点击 ✕ 从该位置移除' : '库里没有这个技能（残留）——✕ 清掉'"
          >
            {{ k.name }}
            <button type="button" class="text-muted-foreground/60 hover:text-destructive" title="从该位置移除" @click="removeFromRule(t, k.name)">✕</button>
          </span>
          <span v-if="!t.skills.length" class="text-[10px] text-muted-foreground/70">还没有装任何技能</span>
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
