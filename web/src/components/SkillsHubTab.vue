<script setup lang="ts">
// 技能中心（AI 工具面板页签）。**技能库是个人技能池**——就几个、都是自己挑的，
// 用大卡片铺开：名称/描述在卡面，操作收敛两级——
// ① 卡面 = 名称 + 状态（amber「未安装」/ N 处计数 / 红调缺失）+ 描述，零杂音；
// ② 安装是显式动作：卡脚左下「＋ 安装」就地展开——选既有位置（下拉，沿用其范围）
//    或「新位置」：选目标（本机 / 运行中容器）+ 可视化浏览目录选落点（不手填；
//    停着的容器列不了目录故不出现，浏览从各端 home 起步）；
// ③ 卡脚右侧 ⋯ 菜单收低频动作：安装位置（就地展开该技能的位置视图——范围切换/
//    卸载）、更新（显式重拉快照并分发）、移除（confirm）。
// ④ 添加面板（扫描/目录/git）是头部「+ 添加」Popover；位置级删除（整条规则）在底部
//    安装位置折叠条。
// 库语义：静态快照——来源改动不自动进库，更新 = 显式动作。安装位置订阅库：库一变
// 自动跟走；容器新建/重启全自动追平。规则 CRUD 的响应即全量同步（hubView 顺带跑），
// 卸载后的清理、孤儿收回都在这一次同步里落地。
import { ref, computed, onMounted } from 'vue'
import {
  getSkillHub,
  getSkillInventory,
  getSkillRegistry,
  getAiView,
  registryAddSkill,
  registryRemoveSkill,
  registryUpdateSkill,
  registryProbeGit,
  registryImportGit,
  addSkillRule,
  updateSkillRule,
  deleteSkillRule,
  syncSkills,
  listContainers,
  listFiles,
  HOST_ID,
  Unauthorized,
  type SkillHubView,
  type SkillRuleResult,
  type SkillInventoryView,
  type SkillInventoryLocation,
  type SkillRegistryItem,
  type SkillGitCandidate,
  type ContainerView,
  type FileEntry,
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  RefreshCw,
  Trash2,
  FolderSync,
  FolderOpen,
  Globe,
  Plus,
  CornerDownRight,
  Library,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  Folder,
  MoreHorizontal,
  X,
} from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

// 全局位置（铺本机 + 全部受管容器）的缺省范围。
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

// 某技能尚未装到的其他位置（「＋ 安装」下拉的可选项）。
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

// —— 卡面状态 ——

// 装到几处（= 含它的规则数）。
function installedCount(s: SkillRegistryItem): number {
  return rulesOf(s.name).length
}

// 范围切换：本机 + 全部容器 ⇄ 仅已有该项目的机器。
async function toggleScope(r: SkillRuleResult) {
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, { all: !r.all })
  } catch (e) {
    fail(e)
  }
}

// 卸载 = 从该位置摘掉当前技能（规则保留——位置级删除在底部安装位置条）。
// 响应即全量同步，摘掉的下一次清理从容器收回。
const unloadingRule = ref('')
async function unloadSkill(r: SkillRuleResult, name: string) {
  if (unloadingRule.value) return
  unloadingRule.value = r.id
  err.value = ''
  try {
    hub.value = await updateSkillRule(r.id, {
      skills: declaredOf(r).filter((n) => n !== name),
    })
    toast(`已卸载：${name} ✕ ${r.to}（下次同步从容器清理）`)
  } catch (e) {
    fail(e)
  } finally {
    unloadingRule.value = ''
  }
}

// 卡上「＋ 安装」（卡脚左下角）：就地展开安装面板——选既有位置（下拉，沿用其范围）
// 或「新位置」（选目标 + 浏览目录选落点，不手填）。
const NEW_SPOT = '__new__' // 下拉的哨兵项 = 新位置
const installOpenFor = ref<string | null>(null)
const pickRuleId = ref<string>(NEW_SPOT)
const nfBusy = ref(false)

function openInstall(name: string) {
  pickRuleId.value = NEW_SPOT
  installOpenFor.value = name
  void ensureBrowseTargets()
}

async function doInstall(name: string) {
  const target = installOpenFor.value
  if (!target || nfBusy.value) return
  nfBusy.value = true
  err.value = ''
  try {
    const rule = (hub.value?.rules ?? []).find((r) => r.id === pickRuleId.value)
    if (rule) {
      const declared = declaredOf(rule)
      if (!declared.includes(name)) {
        hub.value = await updateSkillRule(rule.id, { skills: [...declared, name] })
      }
      toast(`已安装：${name} → ${rule.to}`)
    } else {
      const to = ruleToOf(brTarget.value, brPath.value)
      if (!to) return
      hub.value = await addSkillRule(to, nfAll.value, [name])
      toast(`已安装：${name} → ${to}`)
    }
    installOpenFor.value = null
  } catch (e) {
    fail(e)
  } finally {
    nfBusy.value = false
  }
}

// ⋯ 菜单里的「安装位置」：查看/卸载/范围切换/清缺失收在这里管（卡面不铺位置行）。
const spotsOpenFor = ref<string | null>(null)

// —— 新位置的目标 + 目录浏览（file API：宿主 HOST_ID / 运行中容器，停着列不了） ——

// 目标行：id 传 listFiles（HOST_ID 哨兵 / 容器名），label 展示。
interface BrTarget { id: string; label: string }
const brTargets = ref<BrTarget[]>([])
const brTarget = ref<BrTarget | null>(null)
// 浏览起步 = 各端 home 契约路径（容器 /home/dev；宿主 home 来自 /api/ai/view 的
// hostHome——后端专门为「面板端不知宿主 home」下发的，探不中就落到 /）。
const brPath = ref('')
const brEntries = ref<FileEntry[]>([])
const brParent = ref<string | null>(null)
const brErr = ref('')
const brLoading = ref(false)
const nfAll = ref(true)
const hostHome = ref('')
// 浏览列只看目录（落点是目录），点进去换目录；面包屑逐级回跳。
const brDirs = computed(() => brEntries.value.filter((e) => e.type === 'dir'))
const brHome = computed(() => (brTarget.value?.id === HOST_ID ? hostHome.value || '/' : '/home/dev'))

async function ensureBrowseTargets() {
  if (brTargets.value.length) return
  try {
    const [ctrs, ai] = await Promise.all([listContainers(), getAiView()])
    hostHome.value = ai.hostHome
    // 文件 API 只对运行中容器可用（exec）；本机恒在首位。
    brTargets.value = [
      { id: HOST_ID, label: '本机' },
      ...ctrs.items
        .filter((c) => c.state === 'running')
        .map((c) => ({ id: c.id, label: c.displayName || c.name })),
    ]
    if (!brTarget.value) setBrTarget(brTargets.value[0] ?? null)
  } catch (e) {
    if (e instanceof Unauthorized) emit('unauthorized')
    else brErr.value = e instanceof Error ? e.message : String(e)
  }
}

function setBrTarget(t: BrTarget | null) {
  brTarget.value = t
  brErr.value = ''
  if (!t) return
  brPath.value = brHome.value
  void loadBrDir(brPath.value)
}

async function loadBrDir(p: string) {
  if (!brTarget.value) return
  brLoading.value = true
  brErr.value = ''
  try {
    const v = await listFiles(brTarget.value.id, p)
    brPath.value = v.path
    brEntries.value = v.entries
    brParent.value = v.parent
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    brErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    brLoading.value = false
  }
}

// 面包屑段（浏览路径拆段，含根）。
const brCrumbs = computed(() => {
  const p = brPath.value || '/'
  const parts = p.split('/').filter(Boolean)
  return [
    { label: '/', path: '/' },
    ...parts.map((seg, i) => ({ label: seg, path: '/' + parts.slice(0, i + 1).join('/') })),
  ]
})

// 浏览路径（容器绝对 /home/dev/x，宿主绝对 /home/leon/x）→ 规则 to（~ 形式，全局唯一）。
function ruleToOf(t: BrTarget | null, p: string): string | null {
  if (!t || !p) return null
  if (t.id === HOST_ID) {
    const home = hostHome.value
    return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
  }
  const home = '/home/dev'
  if (p === home) return '~'
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length)
  return p
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

// 从扫描行添加。thenGlobal = 添加后并进全局位置（一步到位装到本机 + 全部容器）。
// 同名 → 确认后覆盖（确认框记住 thenGlobal，覆盖后继续装到本机 + 全部容器）。
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
  toast(`已装到本机 + 全部容器（${GLOBAL_TO}）`)
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

    <!-- ① 技能收藏架：大卡片铺开，状态零折叠——名称/描述/位置/来源全在卡面，操作零弹层 -->
    <div class="rounded-md border">
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Library class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="text-xs font-semibold">技能库</span>
        <span
          class="shrink-0 cursor-help text-muted-foreground/50"
          title="个人技能池——每张卡一件技能：左下「＋ 安装」选位置落装；⋯ 菜单管安装位置/更新/移除；来源改动不自动进库，更新走显式动作；位置订阅库，库一变装出去的自动跟走。"
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
                      title="收进库并装到本机 + 全部容器（~/.claude/skills）"
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
                拷一份快照进库，与来源解耦；要更新点卡片上的「更新」。
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
                导入 = 快照（版本在仓库侧）；要更新点卡片上的「更新」。库内同名会提示覆盖。
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

      <!-- 技能收藏架：大卡片铺开——名称 + 描述 + 卡脚（左「＋ 安装」/ 右 ⋯ 菜单：
           安装位置 · 更新 · 移除），卡面零杂音 -->
      <div v-else class="grid gap-3 px-4 py-4 [grid-template-columns:repeat(auto-fill,minmax(340px,1fr))]">
        <div
          v-for="s in reg"
          :key="s.name"
          class="relative flex flex-col gap-2.5 overflow-hidden rounded-xl border p-4 transition-colors"
          :class="!s.exists ? 'border-destructive/30 bg-destructive/5' : 'hover:border-line hover:bg-accent/20'"
        >
          <!-- 卡头：名称 + 状态 -->
          <div class="flex min-w-0 items-center gap-2">
            <span class="min-w-0 truncate font-mono text-sm font-medium" :class="!s.exists ? 'text-destructive/80 line-through' : ''">{{ s.name }}</span>
            <Loader2 v-if="updatingSkill === s.name" class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            <span
              v-else-if="s.exists && !installedCount(s)"
              class="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
              title="还没装到任何位置——卡脚「＋ 安装」选择位置"
            >未安装</span>
            <Badge
              v-if="!s.exists"
              variant="outline"
              class="shrink-0 border-transparent bg-destructive/10 px-1 text-[10px] text-destructive"
            >缺失</Badge>
            <div class="flex-1" />
            <span
              v-if="s.exists && installedCount(s)"
              class="shrink-0 cursor-help text-[10px] text-muted-foreground/50"
              :title="rulesOf(s.name).map((r) => `${r.to}${r.all ? '（本机+全部容器）' : '（有该项目）'}`).join('\n')"
            >{{ installedCount(s) }} 处</span>
          </div>

          <!-- 描述：完整铺开（卡片够大，不折叠不藏气泡） -->
          <p v-if="s.description" class="text-xs leading-relaxed text-muted-foreground">{{ s.description }}</p>

          <!-- ＋ 安装：就地展开——选既有位置（沿用其范围）或新位置（选目标+浏览目录） -->
          <div v-if="s.exists && installOpenFor === s.name" class="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-2">
            <div class="flex items-center gap-1.5">
              <Select v-model="pickRuleId">
                <SelectTrigger size="sm" class="h-7 min-w-0 max-w-52 flex-1 text-[11px]">
                  <SelectValue placeholder="选安装位置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="r in otherRulesOf(s.name)"
                    :key="r.id"
                    :value="r.id"
                    class="text-[11px]"
                  >{{ r.to }}（{{ r.all ? '本机+全部容器' : '有该项目' }}）</SelectItem>
                  <SelectItem :value="NEW_SPOT" class="text-[11px]">＋ 新位置…</SelectItem>
                </SelectContent>
              </Select>
              <Button size="xs" class="shrink-0" :disabled="nfBusy" @click="doInstall(s.name)">安装</Button>
              <Button variant="ghost" size="xs" class="h-7 shrink-0 px-1.5 text-[11px] text-muted-foreground" @click="installOpenFor = null">取消</Button>
            </div>

            <!-- 新位置：目标（本机/运行中容器）+ 目录浏览选落点 -->
            <template v-if="pickRuleId === NEW_SPOT">
              <div class="flex flex-wrap items-center gap-1.5">
                <Select
                  :model-value="brTarget?.id ?? ''"
                  @update:model-value="(v) => setBrTarget(brTargets.find((t) => t.id === v) ?? null)"
                >
                  <SelectTrigger size="sm" class="h-6 w-40 text-[11px]">
                    <SelectValue placeholder="目标" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="t in brTargets" :key="t.id" :value="t.id" class="text-[11px]">{{ t.label }}</SelectItem>
                  </SelectContent>
                </Select>
                <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted-foreground" title="勾选 = 装进本机 + 全部受管容器；不勾 = 只装已有该项目的机器">
                  <Checkbox :model-value="nfAll" @update:model-value="(v) => (nfAll = !!v)" />
                  全部
                </label>
                <span class="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground/70" :title="ruleToOf(brTarget, brPath) ?? ''">
                  {{ ruleToOf(brTarget, brPath) }}
                </span>
              </div>
              <!-- 面包屑 -->
              <div class="flex min-w-0 flex-wrap items-center gap-0.5 text-[10px] text-muted-foreground">
                <template v-for="(c, i) in brCrumbs" :key="c.path">
                  <span v-if="i > 0" class="opacity-50">/</span>
                  <button
                    type="button"
                    class="cursor-pointer rounded px-0.5 hover:text-foreground"
                    :class="i === brCrumbs.length - 1 ? 'text-foreground' : ''"
                    @click="loadBrDir(c.path)"
                  >{{ c.label }}</button>
                </template>
                <Loader2 v-if="brLoading" class="size-3 shrink-0 animate-spin text-muted-foreground" />
              </div>
              <p v-if="brErr" class="text-[10px] text-destructive">{{ brErr }}</p>
              <!-- 目录列表：只列目录（落点是目录），当前目录即落点 -->
              <div class="scroll-thin max-h-40 min-h-12 overflow-y-auto rounded border bg-card">
                <p v-if="!brDirs.length && !brLoading" class="px-2 py-2 text-center text-[10px] text-muted-foreground/60">没有子目录——就装在当前目录。</p>
                <button
                  v-for="d in brDirs"
                  :key="d.name"
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-accent/50"
                  @click="loadBrDir(brPath === '/' ? '/' + d.name : brPath + '/' + d.name)"
                >
                  <Folder class="size-3 shrink-0 text-muted-foreground/70" />
                  <span class="min-w-0 truncate font-mono">{{ d.name }}</span>
                </button>
              </div>
            </template>
          </div>
          <!-- ＋ 安装面板：就地展开——选既有位置（沿用其范围）或新位置（选目标+浏览目录）。
               展开时替换卡脚的「＋ 安装」钮（左下角入口，展开方向朝上占满卡内余量）。 -->
          <div v-if="s.exists && installOpenFor === s.name" class="flex flex-col gap-1.5 rounded-md border bg-muted/20 p-2">
            <div class="flex items-center gap-1.5">
              <Select v-model="pickRuleId">
                <SelectTrigger size="sm" class="h-7 min-w-0 max-w-52 flex-1 text-[11px]">
                  <SelectValue placeholder="选安装位置" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="r in otherRulesOf(s.name)"
                    :key="r.id"
                    :value="r.id"
                    class="text-[11px]"
                  >{{ r.to }}（{{ r.all ? '本机+全部容器' : '有该项目' }}）</SelectItem>
                  <SelectItem :value="NEW_SPOT" class="text-[11px]">＋ 新位置…</SelectItem>
                </SelectContent>
              </Select>
              <Button size="xs" class="shrink-0" :disabled="nfBusy" @click="doInstall(s.name)">安装</Button>
              <Button variant="ghost" size="xs" class="h-7 shrink-0 px-1.5 text-[11px] text-muted-foreground" @click="installOpenFor = null">取消</Button>
            </div>

            <!-- 新位置：目标（本机/运行中容器）+ 目录浏览选落点 -->
            <template v-if="pickRuleId === NEW_SPOT">
              <div class="flex flex-wrap items-center gap-1.5">
                <Select
                  :model-value="brTarget?.id ?? ''"
                  @update:model-value="(v) => setBrTarget(brTargets.find((t) => t.id === v) ?? null)"
                >
                  <SelectTrigger size="sm" class="h-6 w-40 text-[11px]">
                    <SelectValue placeholder="目标" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="t in brTargets" :key="t.id" :value="t.id" class="text-[11px]">{{ t.label }}</SelectItem>
                  </SelectContent>
                </Select>
                <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] text-muted-foreground" title="勾选 = 装进本机 + 全部受管容器；不勾 = 只装已有该项目的机器">
                  <Checkbox :model-value="nfAll" @update:model-value="(v) => (nfAll = !!v)" />
                  全部
                </label>
                <span class="ml-auto min-w-0 truncate font-mono text-[10px] text-muted-foreground/70" :title="ruleToOf(brTarget, brPath) ?? ''">
                  {{ ruleToOf(brTarget, brPath) }}
                </span>
              </div>
              <!-- 面包屑 -->
              <div class="flex min-w-0 flex-wrap items-center gap-0.5 text-[10px] text-muted-foreground">
                <template v-for="(c, i) in brCrumbs" :key="c.path">
                  <span v-if="i > 0" class="opacity-50">/</span>
                  <button
                    type="button"
                    class="cursor-pointer rounded px-0.5 hover:text-foreground"
                    :class="i === brCrumbs.length - 1 ? 'text-foreground' : ''"
                    @click="loadBrDir(c.path)"
                  >{{ c.label }}</button>
                </template>
                <Loader2 v-if="brLoading" class="size-3 shrink-0 animate-spin text-muted-foreground" />
              </div>
              <p v-if="brErr" class="text-[10px] text-destructive">{{ brErr }}</p>
              <!-- 目录列表：只列目录（落点是目录），当前目录即落点 -->
              <div class="scroll-thin max-h-40 min-h-12 overflow-y-auto rounded border bg-card">
                <p v-if="!brDirs.length && !brLoading" class="px-2 py-2 text-center text-[10px] text-muted-foreground/60">没有子目录——就装在当前目录。</p>
                <button
                  v-for="d in brDirs"
                  :key="d.name"
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-[11px] hover:bg-accent/50"
                  @click="loadBrDir(brPath === '/' ? '/' + d.name : brPath + '/' + d.name)"
                >
                  <Folder class="size-3 shrink-0 text-muted-foreground/70" />
                  <span class="min-w-0 truncate font-mono">{{ d.name }}</span>
                </button>
              </div>
            </template>
          </div>

          <!-- 卡脚：左「＋ 安装」/ 右来源备忘 + ⋯ 菜单（安装位置 · 更新 · 移除） -->
          <div class="mt-auto flex items-center gap-1 border-t pt-2.5">
            <button
              v-if="s.exists && installOpenFor !== s.name"
              type="button"
              class="w-fit cursor-pointer rounded px-1 py-0.5 text-[10px] text-muted-foreground/60 transition-colors hover:text-foreground"
              title="安装到某个位置——选既有位置或浏览目录新建落点"
              @click="openInstall(s.name)"
            >
              ＋ 安装
            </button>
            <span
              class="min-w-0 flex-1 truncate text-right font-mono text-[10px] text-muted-foreground/40"
              :title="s.from"
            >{{ s.from }}</span>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button variant="ghost" size="icon-xs" class="shrink-0 text-muted-foreground hover:text-foreground" title="更多操作">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end">
                <DropdownMenuItem
                  v-if="s.exists"
                  :disabled="!installedCount(s) && !hub?.rules.length"
                  @click="spotsOpenFor = s.name"
                >
                  <FolderOpen /> 安装位置<span v-if="installedCount(s)" class="ml-auto pl-3 text-[10px] text-muted-foreground">{{ installedCount(s) }}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  :disabled="!!updatingSkill"
                  :title="!s.exists ? '从来源重拉快照恢复（来源还在的话）' : '从来源重拉快照并全量分发（来源改动不自动进库——这是唯一更新通道）'"
                  @click="updateSkill(s)"
                >
                  <RefreshCw /> {{ updatingSkill === s.name ? '更新中…' : '更新' }}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" title="移除（已安装到各处的会在下次同步时从容器清理）" @click="delReg = s">
                  <Trash2 /> 移除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <!-- ⋯ 菜单「安装位置」：该技能的位置视图——查看 / 范围切换 / 卸载，就地管理 -->
          <div v-if="s.exists && spotsOpenFor === s.name" class="flex flex-col gap-0.5 rounded-md border bg-muted/20 p-2">
            <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span>安装位置</span>
              <div class="flex-1" />
              <button type="button" class="cursor-pointer rounded px-1 hover:text-foreground" title="收起" @click="spotsOpenFor = null">
                <X class="size-3" />
              </button>
            </div>
            <p v-if="!installedCount(s)" class="px-1 py-1 text-[11px] text-muted-foreground/60">还没有安装——用左下角「＋ 安装」。</p>
            <div
              v-for="r in rulesOf(s.name)"
              :key="r.id"
              class="flex items-center gap-1 rounded-md px-1.5 py-1 -mx-1 hover:bg-accent/40"
            >
              <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ r.to }}</span>
              <button
                type="button"
                class="shrink-0 rounded border px-1 py-0.5 text-[9px] transition-colors"
                :class="r.all
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
                :title="r.all ? '装进本机 + 全部受管容器——点击改为仅已有该项目的机器' : '只装已有该项目的机器——点击改回本机 + 全部容器'"
                @click="toggleScope(r)"
              >
                {{ r.all ? '本机+全部容器' : '有该项目' }}
              </button>
              <Button
                variant="ghost"
                size="icon-xs"
                class="shrink-0 text-muted-foreground/50 hover:text-destructive"
                title="从该位置卸载（位置保留，下次同步从容器清理）"
                :disabled="!!unloadingRule"
                @click="unloadSkill(r, s.name)"
              >
                <Loader2 v-if="unloadingRule === r.id" class="animate-spin" />
                <X v-else />
              </Button>
            </div>
          </div>
        </div>
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
            :title="t.all ? '装进本机 + 全部受管容器——点击改为仅已有该项目的机器' : '只装已有该项目的机器——点击改回本机 + 全部容器'"
            @click="toggleScope(t)"
          >
            {{ t.all ? '本机+全部容器' : '有该项目' }}
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
      :description="`技能库里已有「${regConfirm.name}」。用 ${regConfirm.from} 的内容覆盖它？${regConfirm.thenGlobal ? '覆盖后会继续装到本机 + 全部容器。' : ''}`"
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
