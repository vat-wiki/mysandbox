<script setup lang="ts">
// 技能中心（AI 工具面板页签）：多源 skills 聚合池的管理 UI。源列表存 sidecar
// （state.skillsHub，server/skillSync.ts）——增删/启停/排序即改列表（数组顺序 =
// 重名优先级），聚合与分发全自动（watch + 启动追平 + 建容器补发），这里只是
// 「看得见、管得了」。config.skills.sync 静态规则在底部只读展示。
import { ref, onMounted } from 'vue'
import {
  getSkillHub,
  addSkillHubSource,
  updateSkillHubSource,
  deleteSkillHubSource,
  setSkillHubTo,
  syncSkills,
  Unauthorized,
  type SkillHubView,
} from '@/lib/api'
import { containerColor } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RefreshCw, Trash2, ArrowUp, ArrowDown, FolderSync } from 'lucide-vue-next'
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

// 源的展示名（冲突归属/来源列用它）：容器:路径 → 容器名段；宿主路径 → 末段目录。
function sourceLabel(from: string): string {
  const idx = from.indexOf(':')
  if (idx > 0) return from.slice(0, idx)
  const parts = from.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || from
}

// —— 添加源 ——
const from = ref('')
const adding = ref(false)
async function submitAdd() {
  if (!from.value.trim()) return
  adding.value = true
  err.value = ''
  try {
    hub.value = await addSkillHubSource(from.value.trim())
    from.value = ''
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    adding.value = false
  }
}

// —— 启停 / 排序 / 删除 ——
async function patchSource(id: string, patch: { enabled?: boolean; move?: number }) {
  err.value = ''
  try {
    hub.value = await updateSkillHubSource(id, patch)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}
const delSource = ref<SkillHubView['sources'][number] | null>(null)
async function doDelete() {
  const s = delSource.value
  if (!s) return
  delSource.value = null
  err.value = ''
  try {
    hub.value = await deleteSkillHubSource(s.id)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

// —— 分发目标 ——
const toEdit = ref('')
const toEditing = ref(false)
const toSaving = ref(false)
function startToEdit() {
  if (!hub.value) return
  toEdit.value = hub.value.to
  toEditing.value = true
}
async function saveTo() {
  if (!toEdit.value.trim()) return
  toSaving.value = true
  err.value = ''
  try {
    hub.value = await setSkillHubTo(toEdit.value.trim())
    toEditing.value = false
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    toSaving.value = false
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
    const bad = r.rules.flatMap((x) => x.containers.filter((c) => !c.ok))
    const hubBad = r.hub?.containers.filter((c) => !c.ok) ?? []
    const failed = [...bad, ...hubBad]
    if (failed.length) {
      toast.error(`skills 同步部分失败：${failed.map((f) => `${f.name} — ${f.error}`).join('；')}`)
    } else {
      const changed = [...r.rules, ...(r.hub ? [r.hub] : [])].reduce(
        (n, x) => n + x.containers.reduce((m, c) => m + c.changed, 0),
        0,
      )
      const removed = [...r.rules, ...(r.hub ? [r.hub] : [])].reduce(
        (n, x) => n + x.containers.reduce((m, c) => m + c.removed, 0),
        0,
      )
      const parts = [changed ? `更新 ${changed} 个文件` : '', removed ? `清理 ${removed} 个陈旧` : ''].filter(Boolean)
      toast(`skills 已同步${parts.length ? '：' + parts.join('，') : '：全部已是最新'}`)
    }
    await load()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    syncing.value = false
  }
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-xs leading-relaxed text-muted-foreground">
      多个「源」（容器内项目的 skills 目录或宿主路径）聚合进中心，再统一分发到全部受管容器的目标目录。
      源文件变化自动同步（watch），新建容器自动带上最新。重名 skill 按源顺序先到先得，可拖顺序调优先级。
    </p>

    <p
      v-if="err"
      class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
    >{{ err }}</p>

    <!-- 源列表 -->
    <div class="rounded-md border">
      <div class="flex items-center justify-between border-b px-3 py-2">
        <span class="text-xs font-semibold text-muted-foreground">源（顺序 = 重名优先级）</span>
        <Button variant="ghost" size="icon-xs" class="size-5" :disabled="loading" title="刷新" @click="load">
          <RefreshCw :class="loading ? 'animate-spin' : ''" />
        </Button>
      </div>
      <div v-if="!hub?.sources.length" class="px-3 py-3 text-xs text-muted-foreground/70">
        还没有源——把项目里的 skills 目录加进来，比如 mytest:~/testlens/.claude/skills
      </div>
      <div
        v-for="(s, i) in hub?.sources ?? []"
        :key="s.id"
        class="flex items-center gap-2 px-3 py-2"
        :class="i > 0 ? 'border-t' : ''"
      >
        <span
          class="h-2 w-2 shrink-0 rounded-full"
          :style="{ backgroundColor: containerColor(sourceLabel(s.from)) }"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="truncate font-mono text-xs" :class="s.enabled ? '' : 'text-muted-foreground/50 line-through'" :title="s.from">{{ s.from }}</span>
            <Badge
              v-if="s.skills.filter((n) => hub?.skills.some((k) => k.name === n && k.conflicts.includes(s.id))).length"
              variant="outline"
              class="shrink-0 border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-600 dark:text-amber-400"
            >重名</Badge>
            <Badge v-if="!s.enabled" variant="outline" class="shrink-0 border-transparent bg-muted px-1 text-[10px] text-muted-foreground">停用</Badge>
          </div>
          <div class="truncate text-[11px] text-muted-foreground">
            <template v-if="s.error"><span class="text-destructive">{{ s.error }}</span></template>
            <template v-else-if="s.enabled && s.skills.length">{{ s.skills.length }} 个 skill：{{ s.skills.join('、') }}</template>
            <template v-else>空源</template>
          </div>
        </div>
        <label class="flex shrink-0 cursor-pointer items-center gap-1 text-[11px] text-muted-foreground" title="启用/停用（停用后其 skill 退出中心并从容器清理）">
          <Checkbox :model-value="s.enabled" @update:model-value="(v) => patchSource(s.id, { enabled: !!v })" />
          启用
        </label>
        <Button variant="ghost" size="icon-xs" class="shrink-0" title="上移（提高优先级）" :disabled="i === 0" @click="patchSource(s.id, { move: -1 })">
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon-xs" class="shrink-0" title="下移" :disabled="i === (hub?.sources.length ?? 0) - 1" @click="patchSource(s.id, { move: 1 })">
          <ArrowDown />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          class="shrink-0 text-muted-foreground hover:text-destructive"
          title="移除源"
          @click="delSource = s"
        >
          <Trash2 />
        </Button>
      </div>

      <!-- 添加源 -->
      <div class="border-t px-3 py-2.5">
        <div class="flex gap-2">
          <Input
            v-model="from"
            placeholder="mytest:~/testlens/.claude/skills 或 ~/projects/xxx/.claude/skills"
            class="h-8 font-mono text-xs"
            @keydown.enter="submitAdd"
          />
          <Button size="sm" class="h-8 shrink-0" :disabled="adding || !from.trim()" @click="submitAdd">
            {{ adding ? '添加中…' : '添加源' }}
          </Button>
        </div>
      </div>
    </div>

    <!-- 聚合结果 + 目标 -->
    <div class="rounded-md border">
      <div class="flex items-center justify-between border-b px-3 py-2">
        <span class="text-xs font-semibold text-muted-foreground">中心内容（{{ hub?.skills.length ?? 0 }} 个 skill）</span>
        <!-- 分发目标 -->
        <div class="flex items-center gap-1.5">
          <template v-if="toEditing">
            <Input v-model="toEdit" class="h-6 w-44 font-mono text-[11px]" @keydown.enter="saveTo" />
            <Button size="xs" variant="outline" :disabled="toSaving" @click="saveTo">保存</Button>
          </template>
          <template v-else>
            <button
              type="button"
              class="font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              title="改分发目标"
              @click="startToEdit"
            >→ {{ hub?.to }}</button>
          </template>
        </div>
      </div>
      <div v-if="!hub?.skills.length" class="px-3 py-3 text-xs text-muted-foreground/70">
        中心为空——聚合自上方启用的源
      </div>
      <div
        v-for="(k, i) in hub?.skills ?? []"
        :key="k.name"
        class="flex items-center gap-2 px-3 py-1.5"
        :class="i > 0 ? 'border-t' : ''"
      >
        <FolderSync class="size-3.5 shrink-0 text-muted-foreground" />
        <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ k.name }}</span>
        <Badge variant="outline" class="shrink-0 border-transparent bg-primary/10 text-[10px] text-primary">
          {{ sourceLabel(hub?.sources.find((s) => s.id === k.sourceId)?.from ?? '') }}
        </Badge>
        <span
          v-if="k.conflicts.length"
          class="shrink-0 text-[10px] text-amber-600 dark:text-amber-400"
          :title="`${k.conflicts.map((id) => hub?.sources.find((s) => s.id === id)?.from).join('、')} 也提供同名 skill，顺序在后者让位`"
        >{{ k.conflicts.length }} 源重名</span>
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
      v-if="delSource"
      title="移除源"
      :description="`移除 ${delSource.from}？它提供的 skill 将退出中心，下次同步时从各容器的 ${hub?.to ?? '~/.claude/skills'} 中清理（容器里用户自装的其他 skill 不动）。`"
      confirm-text="移除"
      variant="destructive"
      @confirm="doDelete"
      @close="delSource = null"
    />
  </div>
</template>
