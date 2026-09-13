<script setup lang="ts">
// 安装技能对话框（文件面板「安装技能」入口）：库技能勾选 → 装进指定落点 + 自动落
// 分发规则（pull 语义：人到哪个项目就装到哪）。用居中弹窗与 AI 配置（AiSpotDialog）
// 统一交互语言——内嵌窄条展不开描述与筛选（实测挤）。v-if 挂载天然重置状态。
import { ref, computed, onMounted } from 'vue'
import {
  getSkillRegistry,
  installSkills,
  Unauthorized,
  type SkillRegistryItem,
} from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Search, Loader2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

const props = defineProps<{
  containerId: string // 容器名或 '__host__'（宿主面板）
  containerName: string
  spot: string // 安装落点（…/.claude/skills，容器内路径或宿主绝对路径）
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done'): void
  (e: 'unauthorized'): void
}>()

const isHost = computed(() => props.containerId === '__host__')
// 全局落点（home 根下的 .claude/skills）= 铺本机 + 全部容器；项目落点 = 跟项目走。
// 宿主面板不知道宿主 home 路径，范围由后端按落点自动判定（home 直下 = 全局）。
const scopeText = computed(() =>
  isHost.value
    ? '范围随落点自动判定'
    : props.spot === '/home/dev/.claude/skills'
      ? '全局 · 本机+全部容器'
      : '项目落点 · 跟项目走',
)

const skills = ref<SkillRegistryItem[] | null>(null)
const loading = ref(false)
const busy = ref(false)
const err = ref('')
const picked = ref<string[]>([])
const filter = ref('')

const filtered = computed(() =>
  (skills.value ?? []).filter(
    (s) => s.exists && (!filter.value.trim() || s.name.includes(filter.value.trim())),
  ),
)

async function load() {
  loading.value = true
  err.value = ''
  try {
    skills.value = await getSkillRegistry()
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

function togglePick(name: string, on: boolean) {
  picked.value = on ? [...picked.value, name] : picked.value.filter((n) => n !== name)
}

async function install() {
  if (!picked.value.length) return
  busy.value = true
  err.value = ''
  try {
    const r = await installSkills(props.containerId, props.spot, picked.value)
    toast(`已安装 ${picked.value.length} 个技能 → ${r.to}${r.all ? '（本机 + 全部容器）' : '（跟项目走）'}`)
    emit('done')
    emit('close')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>安装技能</DialogTitle>
        <DialogDescription class="truncate font-mono">
          {{ props.containerName }} : {{ props.spot }}
          <span class="ml-1 font-sans text-[10px] text-amber-500/90">{{ scopeText }}</span>
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-2">
        <div class="flex h-7 items-center gap-1.5 rounded-md border bg-muted/30 px-2">
          <Search class="size-3 shrink-0 text-muted-foreground" />
          <input
            v-model="filter"
            class="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
            placeholder="过滤技能名…"
            @keydown.esc="filter = ''"
          />
        </div>
        <p v-if="err" class="text-xs text-destructive">{{ err }}</p>
        <p v-if="loading" class="flex items-center gap-1.5 py-2 text-xs text-muted-foreground">
          <Loader2 class="size-3 animate-spin" /> 读取技能库…
        </p>
        <div
          v-else-if="!filtered.length"
          class="rounded-md border border-dashed px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground"
        >
          技能库是空的——在文件面板里看到技能目录可右键「注册为技能」就地入库，
          或去「AI 工具 → 技能中心」管理。
        </div>
        <div v-else class="scroll-thin max-h-72 space-y-0.5 overflow-y-auto pr-1">
          <label
            v-for="s in filtered"
            :key="s.name"
            class="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/50"
          >
            <Checkbox class="mt-0.5" :model-value="picked.includes(s.name)" @update:model-value="(v) => togglePick(s.name, !!v)" />
            <span class="shrink-0 pt-0.5 font-mono">{{ s.name }}</span>
            <Badge
              variant="outline"
              class="mt-0.5 shrink-0 border-transparent px-1 text-[9px]"
              :class="s.follow ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'"
            >{{ s.follow ? '跟随' : '快照' }}</Badge>
            <span class="min-w-0 flex-1 pt-0.5 text-[11px] leading-snug text-muted-foreground" :title="s.description">{{ s.description }}</span>
          </label>
        </div>
        <p class="text-[11px] leading-snug text-muted-foreground/70">
          安装 = 拷进该落点并自动登记为分发规则；此后库更新自动跟走，出库自动清理。
        </p>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="outline" size="xs" :disabled="busy" @click="emit('close')">取消</Button>
        <Button size="xs" :disabled="busy || !picked.length" @click="install">
          {{ busy ? '安装中…' : `安装（${picked.length}）` }}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
