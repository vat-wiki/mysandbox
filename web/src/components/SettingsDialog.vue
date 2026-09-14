<script setup lang="ts">
// 设置弹框（侧栏底部「设置」入口）：全局性配置的集中地，按分区堆叠，当前只有
// 「TestLens」。体量刻意小——弹框即来即走；将来分区多了再考虑主区工作区形态
// （参考 AiWorkspace 的页签升级路径）。
//
// TestLens 分区：往所选目标（本机 + 受管容器）的 home 写两份种子文件（agent-browser
// 的 cdp + testlens CLI 的 host）。约定地址 http://testlens:10004（容器内走 hosts
// 服务块；本机由后端换算 localhost）。项目级 .testlens.json 靠 CLI 的 cwd 向上查找
// 天然优先于 home 种子，不被这里破坏。
import { computed, onMounted, ref, watch } from 'vue'
import { toast } from 'vue-sonner'
import { Globe, Loader2 } from 'lucide-vue-next'
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

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
}>()

const DEFAULT_HOST = 'http://testlens:10004'

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
watch(() => host.value, () => {/* 值变化只影响状态徽标（computed），无需动作 */})

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
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="flex items-center gap-2 text-lg font-semibold">
          设置
        </DialogTitle>
        <DialogDescription class="sr-only">全局性配置：TestLens 批量下发等</DialogDescription>
      </div>

      <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <!-- TestLens 分区 -->
        <section class="space-y-3">
          <div class="flex items-center gap-2">
            <Globe class="size-4 text-muted-foreground" />
            <h3 class="text-sm font-medium">TestLens</h3>
            <span class="text-[11px] text-muted-foreground">云端浏览器 · 会话录制 · 业务自测</span>
          </div>

          <p class="text-xs leading-relaxed text-muted-foreground">
            往所选目标的 home 写入两份配置：<code class="rounded bg-muted px-1">~/.agent-browser/config.json</code>
            与 <code class="rounded bg-muted px-1">~/.testlens.json</code>。项目级
            <code class="rounded bg-muted px-1">.testlens.json</code> 优先于这里的种子，不受影响。
          </p>

          <div class="space-y-1.5">
            <Label for="testlens-host" class="text-xs text-muted-foreground">服务地址</Label>
            <Input id="testlens-host" v-model="host" placeholder="http://testlens:10004" class="font-mono text-xs" />
            <p v-if="view?.suggestedHost" class="text-[11px] text-muted-foreground">
              检测到 testlens 服务，已按约定地址预填。本机会自动换算为 localhost 等价端口。
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
