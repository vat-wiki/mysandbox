<script setup lang="ts">
// 设置弹框（侧栏底部「设置」入口）：全局性配置的目录页——两层结构：
// 列表层给各配置的入口行（行尾带状态摘要，一眼看全）；轻量配置（TestLens）点进
// 弹框内就地操作，大体量配置（AI 工具）只给跳转入口——主区工作区页签（AiWorkspace，
// VSCode 设置页模式）才是它的家，弹框不复制内容免得双载体同步维护。就地/上下文
// 配置（文件面板 ✨、容器右键覆盖、Inbox 收编）是 pull 语义，不进这里。
//
// TestLens 分区：往所选目标（本机 + 受管容器）的 home 写两份种子文件（agent-browser
// 的 cdp + testlens CLI 的 host）。约定地址 http://testlens:10004（容器内走 hosts
// 服务块；本机由后端换算 localhost）。项目级 .testlens.json 靠 CLI 的 cwd 向上查找
// 天然优先于 home 种子，不被这里破坏。
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Bot, ChevronLeft, ChevronRight, Globe, Loader2 } from 'lucide-vue-next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  getTestlensView,
  installTestlens,
  HOST_ID,
  Unauthorized,
  type TestlensView,
} from '@/lib/api'
import InfoHint from '@/components/InfoHint.vue'

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
  // AI 配置入口行：跳转主区 AI 工具页签（ContainerList 的 openAi()），弹框随之关闭
  (e: 'open-ai'): void
}>()

const DEFAULT_HOST = 'http://testlens:10004'

// 两层导航：'list' 目录页 / 'testlens' TestLens 详情。将来加分区 = 加一个 section 值
// + 一条入口行。
const section = ref<'list' | 'testlens'>('list')

const view = ref<TestlensView | null>(null)
const loading = ref(false)
const applying = ref(false)
const host = ref('')
const picked = ref<Set<string>>(new Set())

// 目标期望值：本机把约定服务名换算 localhost（与后端 install 同规则，仅用于状态展示）。
function expectedFor(t: TestlensView['targets'][number]): string {
  if (t.id !== HOST_ID) return host.value
  try {
    const u = new URL(host.value)
    if (u.hostname === 'testlens') u.hostname = 'localhost'
    return u.toString().replace(/\/$/, '')
  } catch {
    return host.value
  }
}

type Status = 'unset' | 'match' | 'diff' | 'error'
function statusOf(t: TestlensView['targets'][number]): Status {
  if (t.error) return 'error'
  const exp = expectedFor(t)
  if (!t.agentBrowser && !t.testlensJson) return 'unset'
  return t.agentBrowser === exp && t.testlensJson === exp ? 'match' : 'diff'
}
const STATUS_META: Record<Status, { label: string; cls: string }> = {
  unset: { label: '未配置', cls: 'bg-muted text-muted-foreground' },
  match: { label: '已配置', cls: 'bg-emerald-500/15 text-emerald-500' },
  diff: { label: '值不同', cls: 'bg-amber-500/15 text-amber-500' },
  error: { label: '不可达', cls: 'bg-destructive/15 text-destructive' },
}

// 列表层状态摘要：N/M 台已配置（列表打开时 view 可能还没回来，兜底「…」）。
const testlensSummary = computed(() => {
  if (!view.value || loading.value) return '…'
  const ok = view.value.targets.filter((t) => statusOf(t) === 'match').length
  return `${ok}/${view.value.targets.length} 台已配置`
})

async function load() {
  loading.value = true
  try {
    const v = await getTestlensView()
    view.value = v
    if (!host.value) host.value = v.suggestedHost || DEFAULT_HOST
    // 默认全选（重拉 view 后保持用户已勾的子集，只补新目标）。
    for (const t of v.targets) picked.value.add(t.id)
  } catch (e) {
    // 401 才上抛换 token 门；其余错误就地提示（误发 unauthorized 会把整个控制台踢回令牌页）。
    if (e instanceof Unauthorized) return emit('unauthorized')
    toast.error('加载 TestLens 配置失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    loading.value = false
  }
}

async function apply() {
  if (!picked.value.size) return
  applying.value = true
  try {
    const r = await installTestlens(host.value.trim(), [...picked.value])
    const wrote = r.items.filter((i) => i.ok && i.files.some((f) => f.action !== 'same')).length
    const same = r.ok - wrote
    const failed = r.items.filter((i) => !i.ok)
    const parts: string[] = []
    if (wrote) parts.push(`${wrote} 台写入`)
    if (same) parts.push(`${same} 台已是该值`)
    if (failed.length) parts.push(`${failed.length} 台失败`)
    toast[failed.length ? 'warning' : 'success'](`TestLens 配置：${parts.join(' · ') || '无事发生'}`, {
      description: failed.map((i) => `${i.name}：${i.error}`).join('\n') || undefined,
    })
    await load()
  } catch (e) {
    if (e instanceof Unauthorized) return emit('unauthorized')
    toast.error('应用失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    applying.value = false
  }
}

onMounted(load)
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
      <div class="flex items-center border-b px-5 py-3 pr-10">
        <!-- TestLens 详情层给返回键回目录页 -->
        <button
          v-if="section !== 'list'"
          type="button"
          class="mr-1 -ml-1 rounded p-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          title="返回"
          @click="section = 'list'"
        >
          <ChevronLeft class="size-4" />
        </button>
        <DialogTitle class="text-lg font-semibold">
          {{ section === 'list' ? '设置' : 'TestLens' }}
        </DialogTitle>
        <DialogDescription class="sr-only">
          {{ section === 'list' ? '全局性配置的入口目录' : 'TestLens 配置批量下发' }}
        </DialogDescription>
      </div>

      <!-- 目录页：各全局配置的入口行 -->
      <div v-if="section === 'list'" class="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-accent/50"
          @click="emit('open-ai')"
        >
          <Bot class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">AI 配置</span>
            <span class="block truncate text-xs text-muted-foreground">
              技能中心 · 模型供应商 · Agent 工具——在主区「AI 工具」页签管理
            </span>
          </span>
          <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
        </button>
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-accent/50"
          @click="section = 'testlens'"
        >
          <Globe class="size-4 shrink-0 text-muted-foreground" />
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">TestLens</span>
            <span class="block truncate text-xs text-muted-foreground">
              云端浏览器 · 会话录制 · 业务自测——种子文件批量下发
            </span>
          </span>
          <span class="shrink-0 text-xs text-muted-foreground">{{ testlensSummary }}</span>
          <ChevronRight class="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>

      <!-- TestLens 详情层 -->
      <div v-else class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <section class="space-y-3">
          <div class="flex items-center gap-1.5">
            <p class="text-xs leading-relaxed text-muted-foreground">往所选目标的 home 写入 agent-browser 与 testlens 两份配置。</p>
            <InfoHint label="写入位置说明">
              <p>两份种子：<code class="rounded bg-muted px-1">~/.agent-browser/config.json</code> 与 <code class="rounded bg-muted px-1">~/.testlens.json</code>。</p>
              <p>项目级 <code class="rounded bg-muted px-1">.testlens.json</code> 优先于这里的种子，不受影响。</p>
            </InfoHint>
          </div>

          <div class="space-y-1.5">
            <Label for="testlens-host" class="text-xs text-muted-foreground">服务地址</Label>
            <Input id="testlens-host" v-model="host" placeholder="http://testlens:10004" class="font-mono text-xs" />
            <p v-if="view?.suggestedHost" class="text-[11px] text-muted-foreground">
              检测到 testlens 服务，已按约定地址预填（本机自动换算 localhost）。
            </p>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <Label class="text-xs text-muted-foreground">落点（{{ picked.size }}/{{ view?.targets.length ?? 0 }}）</Label>
              <button
                v-if="view"
                type="button"
                class="text-[11px] text-muted-foreground hover:text-foreground"
                @click="picked.size === view.targets.length ? picked.clear() : view.targets.forEach((t) => picked.add(t.id))"
              >
                {{ picked.size === view.targets.length ? '全不选' : '全选' }}
              </button>
            </div>
            <div v-if="loading" class="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2 class="size-3.5 animate-spin" /> 读取目标状态…
            </div>
            <div v-else-if="view" class="max-h-56 space-y-1 overflow-y-auto rounded-md border p-1.5">
              <label
                v-for="t in view.targets"
                :key="t.id"
                class="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 hover:bg-accent/50"
              >
                <Checkbox
                  :model-value="picked.has(t.id)"
                  @update:model-value="(v) => (v ? picked.add(t.id) : picked.delete(t.id))"
                />
                <span class="min-w-0 flex-1 truncate text-xs" :class="t.error ? 'text-muted-foreground' : ''">
                  {{ t.name }}
                </span>
                <span
                  class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
                  :class="STATUS_META[statusOf(t)].cls"
                  :title="t.error || [t.agentBrowser, t.testlensJson].filter(Boolean).join('\n') || ''"
                >{{ STATUS_META[statusOf(t)].label }}</span>
              </label>
            </div>
          </div>

          <div class="flex justify-end">
            <Button size="sm" :disabled="applying || loading || !picked.size || !host.trim()" @click="apply">
              <Loader2 v-if="applying" class="size-3.5 animate-spin" />
              应用到所选
            </Button>
          </div>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
