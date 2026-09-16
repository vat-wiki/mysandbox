<script setup lang="ts">
// 项目级 AI 配置对话框（文件面板 ✨「AI 配置」入口）：Tabs 合并两块 pull 配置——
//  · 模型绑定：provider 绑定写进当前目录（claude 的 .claude/settings.json + opencode 的
//    opencode.json）并落/并入项目规则（跟项目走，start 事件补发）。
//  · 技能：库技能装进当前目录下的 .claude/skills 或 .agents/skills——落点子目录显式可选
//    （此前硬编码 .claude/skills）；home 根不给选、直接落 canonical——两处全局副本
//    （~/.agents/skills 与 ~/.claude/skills）由同步系统各铺一份，装哪边都一样
//    （与后端 installSkillsToSpot 的归一一致）。
// 两块落点都是当前目录（pull 语义：人到哪配到哪），合一个入口心智统一。用居中弹窗而非
// 文件面板内嵌条——表单在窄面板条里展不开（实测挤成一团）。未启用的工具不动既有规则；
// v-if 挂载天然重置状态。
import { ref, computed, onMounted } from 'vue'
import {
  getAiView,
  installAiProject,
  getSkillRegistry,
  installSkills,
  Unauthorized,
  type AiProvider,
  type AiProjectRule,
  type GatewayWire,
  type SkillRegistryItem,
} from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import SkillPickList from '@/components/SkillPickList.vue'
import InfoHint from '@/components/InfoHint.vue'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { toast } from 'vue-sonner'

const props = defineProps<{
  containerId: string // 容器名或 '__host__'（宿主面板）
  containerName: string
  spot: string // 当前浏览目录（模型绑定落点 = 它本身；技能落点 = 它 + 子目录）
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'done'): void
  (e: 'unauthorized'): void
}>()

const isHost = computed(() => props.containerId === '__host__')

// —— tab 可用性：模型绑定要项目目录（home 根是 home 级语义，走「AI 工具 → 智能体配置」）；
// 技能 home 内即可（含 home 根 = 全局落点）。服务组在 FilePanel 层就不给入口。——
const bindingSpot = computed(() => {
  const p = props.spot
  if (!p) return null
  if (!isHost.value && (p === '/home/dev' || !p.startsWith('/home/dev/'))) return null
  return p
})
const canSkills = computed(() => !!props.spot && (isHost.value || props.spot.startsWith('/home/dev')))
// 默认落在可用的 tab（home 根只剩技能；其余先模型绑定）。
const tab = ref(bindingSpot.value ? 'binding' : 'skills')

// —— 模型绑定 ——
const providers = ref<AiProvider[] | null>(null)
const hostHome = ref('')
const existingRule = ref<AiProjectRule | null>(null)
const bindBusy = ref(false)
const bindErr = ref('')
// 每工具一个启用开关（默认关——只送启用的工具，未启用的不动既有规则）。
const claudeOn = ref(false)
const claude = ref('')
const ocOn = ref(false)
const oc = ref<string[]>([])
const ocWires = ref<GatewayWire[]>(['openai-chat'])

// spot → 规则 to（~/rel）归一化：容器按 home 契约前缀，宿主按真实 home（view 回带）。
const ruleKey = computed(() => {
  const spot = bindingSpot.value
  if (!spot) return null
  if (props.containerId === '__host__') {
    const home = hostHome.value.replace(/\/+$/, '')
    if (!home || !spot.startsWith(home + '/')) return null
    return `~/${spot.slice(home.length + 1)}`
  }
  if (!spot.startsWith('/home/dev/')) return null
  return `~/${spot.slice('/home/dev/'.length)}`
})

const anthropicProviders = computed(() => (providers.value ?? []).filter((p) => p.endpoints.anthropic))
const ruleSummary = computed(() => {
  const r = existingRule.value
  if (!r) return ''
  const parts: string[] = []
  if (r.claude) parts.push(`claude → ${r.claude.provider}`)
  if (r.opencode?.providers.length) parts.push(`opencode → ${r.opencode.providers.join('、')}`)
  return parts.join(' · ')
})

async function saveBinding() {
  const spot = bindingSpot.value
  if (!spot) return
  const selection: { claude?: { provider: string }; opencode?: { providers: string[]; wires: GatewayWire[] } } = {}
  if (claudeOn.value) {
    if (!claude.value) {
      bindErr.value = 'Claude Code 已启用：选一个模型服务'
      return
    }
    selection.claude = { provider: claude.value }
  }
  if (ocOn.value) {
    if (!oc.value.length || !ocWires.value.length) {
      bindErr.value = 'OpenCode 已启用：选模型服务与协议'
      return
    }
    selection.opencode = { providers: [...oc.value], wires: [...ocWires.value] }
  }
  if (!selection.claude && !selection.opencode) {
    bindErr.value = '至少启用并配置一个工具'
    return
  }
  bindBusy.value = true
  bindErr.value = ''
  try {
    const r = await installAiProject(props.containerId, spot, selection)
    toast(`项目级 AI 配置 → ${r.to}${r.created ? '（新规则）' : '（并入已有规则）'}`)
    emit('done')
    emit('close')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    bindErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    bindBusy.value = false
  }
}

// —— 技能 ——
// 落点：已在 skills 目录内 = 就地；否则 当前目录 + 子目录（.claude / .agents，显式可选）。
// home 根（容器）不给选——两处全局副本内容一致，直接落 canonical（~/.agents/skills）。
const homeRoot = computed(() => !isHost.value && props.spot === '/home/dev')
const inSkillsDir = computed(() => /\/(\.claude|\.agents)\/skills$/.test(props.spot))
const pickedSubdir = ref<'claude' | 'agents'>('claude')
const skillsSpot = computed(() => {
  if (inSkillsDir.value) return props.spot
  const sub = homeRoot.value || pickedSubdir.value === 'agents' ? '.agents/skills' : '.claude/skills'
  return `${props.spot}/${sub}`
})
// 全局落点（home 根下的 .claude/skills）= 铺本机 + 全部容器；项目落点 = 跟项目走。
// 宿主面板不知道宿主 home 路径，范围由后端按落点自动判定（home 直下 = 全局）。
const scopeText = computed(() =>
  isHost.value
    ? '范围随落点自动判定'
    : homeRoot.value
      ? '全局 · 本机+全部容器'
      : '项目落点 · 跟项目走',
)

const skills = ref<SkillRegistryItem[] | null>(null)
const instBusy = ref(false)
const instErr = ref('')
const picked = ref<string[]>([])

async function installSkillsAt() {
  if (!picked.value.length) return
  instBusy.value = true
  instErr.value = ''
  try {
    const r = await installSkills(props.containerId, skillsSpot.value, picked.value)
    toast(`已安装 ${picked.value.length} 个技能 → ${r.to}${r.all ? '（本机 + 全部容器）' : '（跟项目走）'}`)
    emit('done')
    emit('close')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    instErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    instBusy.value = false
  }
}

function togglePick(name: string, on: boolean) {
  picked.value = on ? [...picked.value, name] : picked.value.filter((n) => n !== name)
}

onMounted(async () => {
  // 两个 tab 各自的数据源独立取、独立降级——一个挂了不挡另一个。
  try {
    const v = await getAiView()
    providers.value = v.providers
    hostHome.value = v.hostHome
    existingRule.value = v.projectRules.find((r) => r.to === ruleKey.value) ?? null
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    bindErr.value = e instanceof Error ? e.message : String(e)
  }
  try {
    skills.value = await getSkillRegistry()
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    instErr.value = e instanceof Error ? e.message : String(e)
  }
})
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>AI 配置</DialogTitle>
        <DialogDescription class="truncate font-mono">
          {{ props.containerName }} : {{ props.spot }}
        </DialogDescription>
      </DialogHeader>

      <Tabs v-model="tab">
        <TabsList class="w-full">
          <TabsTrigger value="binding" :disabled="!bindingSpot" :title="bindingSpot ? '' : '进到项目目录再配置'">模型绑定</TabsTrigger>
          <TabsTrigger value="skills" :disabled="!canSkills">技能</TabsTrigger>
        </TabsList>

        <!-- 模型绑定：项目级配置写进当前目录 + 落规则（跟项目走） -->
        <TabsContent value="binding" class="space-y-3">
          <p
            v-if="existingRule"
            class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400"
          >
            该目录已有项目规则：{{ ruleSummary || '（空）' }}。保存把启用的工具并入这条规则。
          </p>

          <p v-if="providers && !providers.length" class="text-xs text-amber-500/90">
            模型服务库是空的——先在「AI 工具 → 模型服务」添加提供商。
          </p>
          <p v-else-if="!providers" class="text-xs text-muted-foreground">读取模型服务…</p>

          <!-- claude -->
          <div class="space-y-2 rounded-md border p-3">
            <div class="flex items-center gap-2">
              <Checkbox
                id="ai-spot-claude"
                :model-value="claudeOn"
                @update:model-value="(v) => (claudeOn = !!v)"
              />
              <Label for="ai-spot-claude" class="cursor-pointer">Claude Code</Label>
              <span class="ml-auto text-[11px] text-muted-foreground">.claude/settings.json env 注入</span>
            </div>
            <div v-if="claudeOn" class="pl-6">
              <Select :model-value="claude" @update:model-value="(v) => (claude = v as string)">
                <SelectTrigger size="sm" class="w-full">
                  <SelectValue placeholder="选模型服务（anthropic 端点）" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="p in anthropicProviders" :key="p.id" :value="p.id">
                    {{ p.name }}（{{ p.id }}）
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <!-- opencode -->
          <div class="space-y-2 rounded-md border p-3">
            <div class="flex items-center gap-2">
              <Checkbox id="ai-spot-oc" :model-value="ocOn" @update:model-value="(v) => (ocOn = !!v)" />
              <Label for="ai-spot-oc" class="cursor-pointer">OpenCode</Label>
              <span class="ml-auto text-[11px] text-muted-foreground">opencode.json provider 变体</span>
            </div>
            <div v-if="ocOn" class="space-y-2 pl-6">
              <ToggleGroup
                type="multiple"
                size="sm"
                variant="outline"
                class="flex-wrap text-xs"
                :model-value="oc"
                @update:model-value="(v) => (oc = v as string[])"
              >
                <ToggleGroupItem v-for="p in providers ?? []" :key="p.id" :value="p.id">
                  {{ p.name }}（{{ p.id }}）
                </ToggleGroupItem>
              </ToggleGroup>
              <ToggleGroup
                type="multiple"
                size="sm"
                variant="outline"
                class="text-xs"
                :model-value="ocWires"
                @update:model-value="(v) => (ocWires = v as GatewayWire[])"
              >
                <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
                <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
                <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>

          <div class="flex items-start gap-1.5">
            <p class="flex-1 text-[11px] leading-snug text-muted-foreground/80">
              项目级配置优先于 home 级绑定。
            </p>
            <InfoHint label="优先级语义说明">
              <p>优先级按工具自己的合并语义。</p>
              <p>克隆到别的容器，start 时自动跟上。</p>
              <p>未启用的工具不动既有规则。</p>
            </InfoHint>
          </div>
          <p v-if="bindErr" class="text-sm text-destructive">{{ bindErr }}</p>

          <div class="flex justify-end gap-2">
            <Button variant="outline" size="xs" :disabled="bindBusy" @click="emit('close')">取消</Button>
            <Button size="xs" :disabled="bindBusy || !providers" @click="saveBinding">
              {{ bindBusy ? '配置中…' : '保存配置' }}
            </Button>
          </div>
        </TabsContent>

        <!-- 技能：库技能装进当前目录下的 .claude/skills 或 .agents/skills -->
        <TabsContent value="skills" class="space-y-2">
          <!-- 落点子目录：已在 skills 目录内 = 就地；home 根 = 直接落 canonical 不给选 -->
          <div v-if="!inSkillsDir && !homeRoot" class="flex items-center gap-2">
            <span class="shrink-0 text-xs text-muted-foreground">装到</span>
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              class="text-xs"
              :model-value="pickedSubdir"
              @update:model-value="(v) => v && (pickedSubdir = v as 'claude' | 'agents')"
            >
              <ToggleGroupItem value="claude">.claude/skills</ToggleGroupItem>
              <ToggleGroupItem value="agents">.agents/skills</ToggleGroupItem>
            </ToggleGroup>
            <span class="ml-auto text-[10px] text-amber-500/90">{{ scopeText }}</span>
          </div>
          <p v-else class="text-[11px] text-muted-foreground">
            落点 <span class="font-mono">{{ skillsSpot }}</span>
            <span class="ml-1 text-[10px] text-amber-500/90">{{ scopeText }}</span>
            <span v-if="homeRoot" class="block text-muted-foreground/70">全局安装：~/.agents/skills 与 ~/.claude/skills 两处各铺一份</span>
          </p>

          <!-- 库技能多选列表：行形状/过滤/加载空态收在共享组件（与技能中心全局安装弹框同款） -->
          <SkillPickList
            :skills="skills"
            :picked="picked"
            empty-text="技能库是空的——去「AI 工具 → 技能中心」添加，或右键技能目录收进库。"
            @toggle="togglePick"
          >
            <template #error>
              <p v-if="instErr" class="text-xs text-destructive">{{ instErr }}</p>
            </template>
          </SkillPickList>
          <p class="text-[11px] leading-snug text-muted-foreground/70">
            库更新自动跟走，移除自动清理。
          </p>

          <div class="flex justify-end gap-2">
            <Button variant="outline" size="xs" :disabled="instBusy" @click="emit('close')">取消</Button>
            <Button size="xs" :disabled="instBusy || !picked.length" @click="installSkillsAt">
              {{ instBusy ? '安装中…' : `安装（${picked.length}）` }}
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>
