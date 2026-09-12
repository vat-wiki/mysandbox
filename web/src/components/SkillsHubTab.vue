<script setup lang="ts">
// 技能中心（AI 工具面板页签）：以「目标」为中心的多源聚合管理 UI。一个目标 =
// 分发位置（全局 ~/.claude/skills 或某项目的 .claude/skills）+ 挂在其下的多个源；
// 同一 from 可挂到多个目标。目标内重名按源顺序先到先得；范围：全局目标铺全部
// 容器，项目目标只同步到已有该项目的容器。全自动触发（watch + 启动追平 + 建容器/
// 容器 start 补发），这里只是「看得见、管得了」。config.skills.sync 静态规则底部只读展示。
import { ref, onMounted } from 'vue'
import {
  getSkillHub,
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
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { RefreshCw, Trash2, ArrowUp, ArrowDown, FolderSync, Globe, Plus } from 'lucide-vue-next'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from 'vue-sonner'

const emit = defineEmits<{
  (e: 'unauthorized'): void
}>()

const hub = ref<SkillHubView | null>(null)
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
onMounted(load)

// 源的展示名（冲突归属/来源标注）：容器:路径 → 容器名段；宿主路径 → 末段目录。
function sourceLabel(from: string): string {
  const idx = from.indexOf(':')
  if (idx > 0) return from.slice(0, idx)
  const parts = from.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || from
}

function fail(e: unknown) {
  if (e instanceof Unauthorized) {
    emit('unauthorized')
    return
  }
  err.value = e instanceof Error ? e.message : String(e)
}

// —— 目标：添加 / 改范围 / 删 ——
const newTo = ref('')
const newAll = ref(false)
const addingTarget = ref(false)
async function submitTarget() {
  if (!newTo.value.trim()) return
  addingTarget.value = true
  err.value = ''
  try {
    hub.value = await addSkillHubTarget(newTo.value.trim(), newAll.value)
    newTo.value = ''
    newAll.value = false
  } catch (e) {
    fail(e)
  } finally {
    addingTarget.value = false
  }
}
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

// —— 源（目标内）：添加 / 启停 / 排序 / 删 ——
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
    await load()
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
      以<b class="font-medium">目标</b>为中心：每个目标位置聚合它自己的多个源（目标内重名按源顺序先到先得），
      分发到对应容器——全局目标铺全部容器；项目目标只同步到<b class="font-medium">已有该项目的容器</b>
      （项目克隆到哪 skill 跟到哪，容器重启自动补齐）。源文件变化自动同步（watch）。同一源目录可挂到多个目标。
    </p>

    <p
      v-if="err"
      class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >{{ err }}</p>

    <!-- 目标卡片 -->
    <div
      v-for="(t, ti) in hub?.targets ?? []"
      :key="t.id"
      class="rounded-md border"
      :class="ti > 0 ? 'mt-3' : ''"
    >
      <!-- 目标头：位置 + 范围切换 + 删 -->
      <div class="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        <Globe v-if="t.all" class="size-3.5 shrink-0 text-muted-foreground" />
        <FolderSync v-else class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate font-mono text-xs font-medium" :title="t.to">{{ t.to }}</span>
        <button
          type="button"
          class="shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition-colors"
          :class="t.all
            ? 'border-primary/40 bg-primary/10 text-primary'
            : 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'"
          :title="t.all ? '分发到全部受管容器——点击改为仅已有该项目的容器' : '仅同步到已有该项目的容器——点击改为全部容器'"
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
          title="删除目标（其分发的 skill 按清单从容器清理）"
          @click="delTarget = t"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 聚合结果：目标内 skill 与归属 -->
      <div v-if="t.skills.length" class="border-b px-3 py-1.5">
        <div
          v-for="k in t.skills"
          :key="k.name"
          class="flex items-center gap-2 py-0.5"
        >
          <FolderSync class="size-3 shrink-0 text-muted-foreground/70" />
          <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ k.name }}</span>
          <Badge variant="outline" class="shrink-0 border-transparent bg-primary/10 text-[10px] text-primary">
            {{ sourceLabel(t.sources.find((s) => s.id === k.sourceId)?.from ?? '') }}
          </Badge>
          <span
            v-if="k.conflicts.length"
            class="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
            :title="`${k.conflicts.map((id) => t.sources.find((s) => s.id === id)?.from).join('、')} 也提供同名 skill，顺序在后者让位`"
          >{{ k.conflicts.length }} 源重名</span>
        </div>
      </div>
      <div v-else class="border-b px-3 py-1.5 text-[11px] text-muted-foreground/70">
        还没有可聚合的内容——在下面挂源
      </div>

      <!-- 目标下的源列表 -->
      <div
        v-for="(s, si) in t.sources"
        :key="s.id"
        class="flex items-center gap-2 px-3 py-1.5"
        :class="si > 0 ? 'border-t' : ''"
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
        <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" title="启用/停用（停用后其 skill 退出该目标并从容器清理）">
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
          title="摘除源（其 skill 退出该目标并从容器清理）"
          @click="delSource = { t, s }"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 挂源到该目标 -->
      <div class="border-t px-3 py-2">
        <div class="flex gap-2">
          <Input
            v-model="addFrom[t.id]"
            placeholder="mytest:~/testlens/.claude/skills 或 ~/projects/xxx/.claude/skills"
            class="h-8 flex-1 font-mono text-xs"
            @keydown.enter="submitSource(t)"
          />
          <Button size="sm" class="h-8 shrink-0" :disabled="addingSource === t.id || !addFrom[t.id]?.trim()" @click="submitSource(t)">
            <Plus class="size-3.5" /> 挂源
          </Button>
        </div>
      </div>
    </div>

    <!-- 添加目标 -->
    <div class="rounded-md border border-dashed px-3 py-2.5">
      <div class="flex items-center gap-2">
        <Input
          v-model="newTo"
          placeholder="新目标路径，如 ~/proj/.claude/skills"
          class="h-8 flex-1 font-mono text-xs"
          @keydown.enter="submitTarget"
        />
        <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" title="全部容器（不勾 = 仅已有该项目的容器）">
          <Checkbox :model-value="newAll" @update:model-value="(v) => (newAll = !!v)" />
          全部容器
        </label>
        <Button size="sm" class="h-8 shrink-0" :disabled="addingTarget || !newTo.trim()" @click="submitTarget">
          {{ addingTarget ? '添加中…' : '添加目标' }}
        </Button>
      </div>
    </div>

    <!-- config 静态规则（只读展示） -->
    <div v-if="hub?.configRules.length" class="rounded-md border border-dashed px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
      <p class="mb-1 font-semibold">config.yaml 静态规则（{{ hub.configRules.length }} 条，独立于中心）</p>
      <p v-for="r in hub.configRules" :key="r.from + r.to" class="font-mono">{{ r.from }} → {{ r.to }}</p>
      <p class="mt-1">改它去 ~/.config/mysandbox/config.yaml（重启服务生效）；同目标别同时用规则和中心。</p>
    </div>

    <div class="flex justify-end">
      <Button size="sm" :disabled="syncing" @click="syncNow">
        <FolderSync :class="syncing ? 'animate-pulse' : ''" /> {{ syncing ? '同步中…' : '立即同步' }}
      </Button>
    </div>

    <ConfirmDialog
      v-if="delTarget"
      title="删除目标"
      :description="`删除目标 ${delTarget.to}？它分发过的 skill 将按清单从对应容器中清理（容器里用户自装的其他 skill 不动）；其下挂的源定义一并移除。`"
      confirm-text="删除"
      variant="destructive"
      @confirm="doDeleteTarget"
      @close="delTarget = null"
    />
    <ConfirmDialog
      v-if="delSource"
      title="摘除源"
      :description="`从目标 ${delSource.t.to} 摘除 ${delSource.s.from}？它提供的 skill 将退出该目标，下次同步时从对应容器中清理（不影响它挂载的其他目标）。`"
      confirm-text="摘除"
      variant="destructive"
      @confirm="doDeleteSource"
      @close="delSource = null"
    />
  </div>
</template>
