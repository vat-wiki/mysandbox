<script setup lang="ts">
// 设置详情弹框（SettingsMenu popup 各分区的落点）：本体只承载大体量配置详情——
// TestLens（就地操作）/ 集群（ClusterPanel）/ 浏览器通知（开关与推送）。
// 目录层已升格为锚定按钮的 SettingsMenu popup（2026-10-22），AI 配置也只从那里
// 跳主区工作区页签；本弹框按 section prop 直落对应分区，不再有内部导航。
// 就地/上下文配置（文件面板 ✨、容器右键覆盖、Inbox 收编）是 pull 语义，不进这里。
//
// TestLens 分区：往所选目标（本机 + 受管容器）的 home 写两份种子文件（agent-browser
// 的 cdp + testlens CLI 的 host）。约定地址 http://testlens:10004（容器内走 hosts
// 服务块；本机由后端换算 localhost）。项目级 .testlens.json 靠 CLI 的 cwd 向上查找
// 天然优先于 home 种子，不被这里破坏。
import { computed, onMounted, ref } from 'vue'
import { toast } from 'vue-sonner'
import { Bell, Loader2 } from 'lucide-vue-next'
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
import ClusterPanel from '@/components/ClusterPanel.vue'
import {
  notifyAvailable,
  notifyPermission,
  quietNotifyEnabled,
  requestNotifyPermission,
  setQuietNotifyEnabled,
  type NotifyPermission,
} from '@/lib/browserNotify'
import { pushSupported, pushEnabled, enablePush, disablePush } from '@/lib/pushNotify'


const props = defineProps<{
  section: 'testlens' | 'cluster' | 'notify'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'unauthorized'): void
}>()

const SECTION_TITLE: Record<typeof props.section, string> = {
  testlens: 'TestLens',
  cluster: '集群',
  notify: '浏览器通知',
}
const SECTION_DESC: Record<typeof props.section, string> = {
  testlens: 'TestLens 配置批量下发',
  cluster: '跨机组网与资源互通',
  notify: '无输出提醒的系统通知出口',
}

const DEFAULT_HOST = 'http://testlens:10004'

// —— 浏览器通知（「无输出提醒」的站外延伸，lib/browserNotify）——
// 弹框每次打开都重建：开关/权限状态从浏览器现场回填，不存本地副本。
// 授权必须用户手势触发——点开开关那一刻申请；被拒则开关弹回并提示去站点设置恢复
// （浏览器拒绝后 JS 再也拿不到 requestPermission 的弹窗，只能用户手动解禁）。
const notifySupported = notifyAvailable()
const notifyPerm = ref<NotifyPermission>(notifyPermission())
const notifyOn = ref(quietNotifyEnabled())

async function toggleNotify(v: boolean) {
  if (!v) {
    setQuietNotifyEnabled(false)
    notifyOn.value = false
    return
  }
  if (notifySupported && notifyPerm.value === 'default') {
    notifyPerm.value = await requestNotifyPermission()
  }
  if (notifySupported && notifyPerm.value !== 'granted') {
    toast.warning('浏览器通知权限被拒绝', {
      description: '请在浏览器地址栏的站点设置里把「通知」改回允许，再回来开启。',
    })
    notifyOn.value = false
    return
  }
  setQuietNotifyEnabled(true)
  notifyOn.value = true
}

// 目录页入口行的状态摘要。
const notifySummary = computed(() => {
  if (!notifySupported) return '浏览器不支持'
  if (notifyPerm.value === 'denied') return '权限被拒绝'
  return notifyOn.value ? '已开启' : '关闭'
})

// —— Web Push（锁屏/页面未开的站外推送，lib/pushNotify）——
const pushOk = pushSupported()
const pushOn = ref(pushEnabled())
const pushBusy = ref(false)

async function togglePush(v: boolean) {
  if (pushBusy.value) return
  pushBusy.value = true
  try {
    if (!v) {
      await disablePush()
      pushOn.value = false
      return
    }
    if (await enablePush()) {
      pushOn.value = true
    } else {
      pushOn.value = false
      toast.warning('推送开启失败', {
        description: '通知权限被拒或浏览器不支持——推送需要 https / localhost 访问。',
      })
    }
  } catch (e) {
    pushOn.value = false
    toast.error('推送开启失败', { description: e instanceof Error ? e.message : String(e) })
  } finally {
    pushBusy.value = false
  }
}

const view = ref<TestlensView | null>(null)
const loading = ref(false)
const applying = ref(false)
const host = ref('')
const picked = ref<Set<string>>(new Set())

// 首次打开优先回填落点里一致的实际配置；值有冲突时退回约定建议，避免替用户选边。
function initialHostFor(v: TestlensView): string {
  const values = v.targets
    .filter((t) => !t.error)
    .flatMap((t) => [t.agentBrowser, t.testlensJson])
    .filter((value): value is string => Boolean(value))
  if (values.length && values.every((value) => value === values[0])) return values[0]
  return v.suggestedHost || DEFAULT_HOST
}

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
    if (!host.value) host.value = initialHostFor(v)
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

// TestLens 状态只有该分区用得到；集群/通知分区打开时不打这趟 API。
if (props.section === 'testlens') onMounted(load)
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[88vh] flex-col gap-0 overflow-hidden p-0 max-md:h-dvh max-md:max-h-none max-md:max-w-full max-md:rounded-none max-md:border-0 max-md:pt-safe sm:max-w-lg">
      <div class="flex items-center border-b px-5 py-3 pr-10">
        <DialogTitle class="text-lg font-semibold">{{ SECTION_TITLE[props.section] }}</DialogTitle>
        <DialogDescription class="sr-only">{{ SECTION_DESC[props.section] }}</DialogDescription>
      </div>

      <!-- TestLens 详情层 -->
      <div v-if="props.section === 'testlens'" class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <section class="space-y-3">
          <div class="flex items-center gap-1.5">
            <p class="text-xs leading-relaxed text-muted-foreground">写入 agent-browser 与 testlens 配置。</p>
            <InfoHint label="写入位置说明">
              <p>两份种子：<code class="rounded bg-muted px-1">~/.agent-browser/config.json</code> 与 <code class="rounded bg-muted px-1">~/.testlens.json</code>。</p>
              <p>项目级 <code class="rounded bg-muted px-1">.testlens.json</code> 优先于这里的种子，不受影响。</p>
            </InfoHint>
          </div>

          <div class="space-y-1.5">
            <Label for="testlens-host" class="text-xs text-muted-foreground">服务地址</Label>
            <Input id="testlens-host" v-model="host" placeholder="http://testlens:10004" class="font-mono text-xs" />
            <p v-if="view?.suggestedHost" class="text-[11px] text-muted-foreground">
              已按检测到的 testlens 服务预填。
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

      <!-- 集群分区 -->
      <div v-else-if="props.section === 'cluster'" class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <ClusterPanel @unauthorized="emit('unauthorized')" />
      </div>

      <!-- 浏览器通知详情层 -->
      <div v-else-if="props.section === 'notify'" class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <section class="space-y-4">
          <p class="text-xs leading-relaxed text-muted-foreground">
            页面不在前台时，agent 完成或等待输入会发系统通知，点击直达终端。
          </p>
          <label class="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 hover:bg-accent/50">
            <Checkbox
              :model-value="notifyOn"
              :disabled="!notifySupported"
              @update:model-value="(v) => toggleNotify(v === true)"
            />
            <span class="text-sm">无输出时发浏览器通知</span>
          </label>
          <p v-if="!notifySupported" class="text-xs text-amber-500">
            当前浏览器不支持通知（需要 https / localhost 访问），开关不可用——琥珀标不受影响。
          </p>
          <p v-else-if="notifyPerm === 'denied'" class="text-xs text-amber-500">
            通知权限已被拒绝：请在浏览器地址栏的站点设置里把「通知」改回允许，再回来开启。
          </p>
          <p v-else-if="notifyPerm === 'default' && !notifyOn" class="text-xs text-muted-foreground">
            开启时会向浏览器申请通知权限。
          </p>
          <div class="my-1 border-t" />
          <label class="flex cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 hover:bg-accent/50">
            <Checkbox
              :model-value="pushOn"
              :disabled="!pushOk || pushBusy"
              @update:model-value="(v) => togglePush(v === true)"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-sm">锁屏推送（Web Push）</span>
              <span class="block text-xs text-muted-foreground">
                页面关闭或锁屏也能收到，点击直达终端
              </span>
            </span>
          </label>
          <p v-if="!pushOk" class="text-xs text-muted-foreground">
            当前浏览器不支持 Web Push（需要 https 访问；iOS Safari 需先添加到主屏幕）。
          </p>
          <p v-else class="text-xs text-muted-foreground">
            仅推送 agent 等待输入事件；有控制台在线时不推。
          </p>
        </section>
      </div>
    </DialogContent>
  </Dialog>
</template>
