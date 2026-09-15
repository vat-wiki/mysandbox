<script setup lang="ts">
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import {
  batchGit,
  batchSshReseed,
  batchSshAppendKey,
  batchExec,
  applyHosts,
  Unauthorized,
  type BatchResult,
} from '@/lib/api'
import { stateColor, stateLabel } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
// Monaco 编辑器壳：exec/hosts tab 的高亮编辑。异步引入——git/ssh tab 打开零成本，
// 首次进 exec/hosts 才拉 monaco chunk（此后全站共享缓存）。
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))
import { ArrowLeft } from 'lucide-vue-next'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import InfoHint from '@/components/InfoHint.vue'

const props = defineProps<{
  // 可选容器全集（受管理/已纳入的），选择在对话框左栏完成——入口不依赖侧栏选择态。
  // state 用于左栏状态点与停机提示（exec/git/ssh/hosts 走 lxc-attach 停机必失败）。
  containers: { id: string; label: string; ip?: string | null; state?: string | null }[]
}>()
const emit = defineEmits<{
  (e: 'done'): void
  (e: 'close'): void
  (e: 'unauthorized'): void
}>()

// 容器勾选：默认全选（批量配置的典型场景就是「对全部来一遍」，不想要的单独取消）。
// ids 是提交用的派生视图；空选时执行按钮置灰。
const checked = ref<Set<string>>(new Set(props.containers.map((c) => c.id)))
const ids = computed(() => props.containers.filter((c) => checked.value.has(c.id)).map((c) => c.id))
const allChecked = computed(
  () => props.containers.length > 0 && props.containers.every((c) => checked.value.has(c.id)),
)
function toggleCheck(id: string) {
  const s = new Set(checked.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  checked.value = s
}
function toggleCheckAll() {
  checked.value = allChecked.value
    ? new Set()
    : new Set(props.containers.map((c) => c.id))
}

// tab / sshMode 放宽为 string，避免 reka-ui AcceptableValue 与字面量联合冲突
const tab = ref<string>('exec')
const busy = ref(false)
const err = ref('')
// 结果态：执行完成后右栏整体切走（表单/结果不混在一个滚动区里）。
// result=null 即编辑态；backToEdit 只清结果，表单内容原样保留（换 key 重推是常态）。
const result = ref<BatchResult | null>(null)
// 本次结果关联的 tab，结果标题用它说清「刚执行的是什么」
const resultOfTab = ref('')

// 停机容器提示：所选中有几个不在跑。
// 只提示不阻断：停机容器在后端按单容器收敛成 fail 结果，不拖垮整批。
const stoppedSelected = computed(
  () =>
    ids.value.filter(
      (id) => props.containers.find((c) => c.id === id)?.state && props.containers.find((c) => c.id === id)!.state !== 'running',
    ).length,
)

// 各 tab 表单
const gitName = ref('')
const gitEmail = ref('')
const sshMode = ref<string>('reseed')
const sshKey = ref('')
const execCommand = ref('')
const execTimeout = ref<number | undefined>(undefined)
// 命令框编辑器选项：无行号（短命令框省左栏），空内容显示占位提示
const execEditorOptions = {
  placeholder: 'echo "hello" > ~/note.txt',
  lineNumbers: 'off',
}
// hosts tab：对所选容器的一次性覆写内容（空起步，手填或粘贴）。编辑用 Monaco
// （hosts 词法高亮）；覆写是显式动作——新容器的默认来自模板容器，与这里无关。
const hostsContent = ref('')

function resetResult() {
  result.value = null
  err.value = ''
}

async function run(fn: () => Promise<BatchResult>) {
  busy.value = true
  resetResult()
  try {
    result.value = await fn()
    resultOfTab.value = tab.value
    emit('done')
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

function submit() {
  if (tab.value === 'exec') {
    if (!execCommand.value.trim()) {
      err.value = 'command 不能为空'
      return
    }
    const timeoutMs = execTimeout.value != null ? execTimeout.value * 1000 : undefined
    run(() => batchExec(ids.value, execCommand.value, timeoutMs))
  } else if (tab.value === 'git') {
    if (!gitName.value.trim() || !gitEmail.value.trim()) {
      err.value = '用户名和邮箱都必填'
      return
    }
    run(() => batchGit(ids.value, gitName.value.trim(), gitEmail.value.trim()))
  } else if (tab.value === 'ssh') {
    if (sshMode.value === 'append-key' && !sshKey.value.trim()) {
      err.value = '请粘贴公钥'
      return
    }
    run(() =>
      sshMode.value === 'reseed'
        ? batchSshReseed(ids.value)
        : batchSshAppendKey(ids.value, sshKey.value.trim()),
    )
  } else {
    if (!hostsContent.value.trim()) {
      err.value = 'hosts 内容不能为空'
      return
    }
    // 对已选容器显式覆写 /etc/hosts（服务块由后端自动组合进内容）
    run(() => applyHosts(hostsContent.value, ids.value))
  }
}

function onTab(v: string | number) {
  tab.value = String(v)
  resetResult()
}

// 通用命令排首位（无预设意图的高频动作）；git/ssh 是「装完配一次」类相邻；
// hosts 覆写殿后（一次性显式动作）。AI 网关/技能中心在「AI 工具」工作区（AiWorkspace.vue，文件 tab 栏单例页）。
const tabs: { key: string; label: string }[] = [
  { key: 'exec', label: '通用命令' },
  { key: 'git', label: 'Git 身份' },
  { key: 'ssh', label: 'SSH' },
  { key: 'hosts', label: 'hosts 覆写' },
]
const tabLabelOf = (key: string) => tabs.find((t) => t.key === key)?.label ?? key
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <!-- 宽模态左右分栏：左栏选容器（第一公民，不再挤头部一行 chip），右栏任务 tab +
         表单占满高度。执行后右栏整体切结果态，表单与结果不共一个滚动区。
         md 以下分栏放不下，左栏折叠回横向 chip 行（移动端不退化）。 -->
    <DialogContent
      class="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
    >
      <!-- 头 -->
      <div class="border-b px-5 py-3 pr-10">
        <DialogTitle class="text-lg font-semibold">批量配置</DialogTitle>
        <DialogDescription class="sr-only">对所选容器批量执行配置或命令</DialogDescription>
      </div>

      <div class="flex min-h-0 flex-1 max-md:flex-col">
        <!-- 左栏：容器选择。md+ 独立列（滚动与右栏独立），max-md 折叠为横向 chip 行。 -->
        <aside
          class="flex min-h-0 shrink-0 flex-col border-r max-md:border-r-0 max-md:border-b md:w-56"
        >
          <div class="flex items-center justify-between px-3 pt-3 md:px-4">
            <span class="text-xs font-medium text-muted-foreground"
              >容器 {{ ids.length }} / {{ containers.length }}</span
            >
            <button
              type="button"
              class="text-xs text-muted-foreground transition-colors hover:text-foreground"
              @click="toggleCheckAll"
            >
              {{ allChecked ? '全不选' : '全选' }}
            </button>
          </div>
          <!-- 桌面：卡片列表（名称 + 状态点 + IP），独立滚动 -->
          <div class="scroll-thin mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 max-md:hidden md:px-4">            <!-- 两行卡片（同侧栏形态）：名称行挤不下 checkbox+点+IP，第一行放名与勾选，第二行放 IP -->
            <label
              v-for="c in containers"
              :key="c.id"
              class="flex cursor-pointer select-none flex-col gap-1 rounded-md border px-2.5 py-2 text-sm transition-colors hover:bg-accent/50 has-[[data-state=checked]]:border-primary/60"
            >
              <span class="flex items-center gap-2">
                <span
                  :class="['h-2 w-2 shrink-0 rounded-full', stateColor(c.state ?? '')]"
                  :title="stateLabel(c.state ?? '')"
                />
                <span class="min-w-0 flex-1 truncate font-mono" :title="c.label">{{ c.label }}</span>
                <Checkbox
                  :model-value="checked.has(c.id)"
                  @update:model-value="() => toggleCheck(c.id)"
                />
              </span>
              <span class="flex items-center justify-between pl-4 text-[11px] text-muted-foreground">
                <span class="font-mono">{{ c.ip ?? stateLabel(c.state ?? '') }}</span>
              </span>
            </label>
          </div>
          <!-- 移动端：横向流式 chip 行（沿用旧形态，窄屏放不下两栏） -->
          <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1.5 px-3 pb-2.5 md:hidden">
            <label
              v-for="c in containers"
              :key="c.id"
              class="flex cursor-pointer select-none items-center gap-1.5 text-sm"
            >
              <Checkbox :model-value="checked.has(c.id)" @update:model-value="() => toggleCheck(c.id)" />
              <span class="font-mono">{{ c.label }}</span>
              <span v-if="c.ip" class="font-mono text-xs text-muted-foreground">{{ c.ip }}</span>
            </label>
          </div>
        </aside>

        <!-- 结果态：右栏整体切换（表单/结果互斥，切换 tab 也回编辑态） -->
        <div v-if="result" class="flex min-h-0 flex-1 flex-col">
          <div class="scroll-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1">
              <h3 class="text-sm font-medium">
                {{ tabLabelOf(resultOfTab) }} · 执行结果
              </h3>
              <span class="text-sm text-emerald-500">成功 {{ result.ok }}</span>
              <span class="text-sm text-destructive">失败 {{ result.failed }}</span>
              <span class="text-sm text-muted-foreground">共 {{ result.total }}</span>
            </div>
            <div class="mt-3 overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow class="bg-muted/50">
                    <TableHead class="h-8 text-xs font-medium">容器</TableHead>
                    <TableHead class="h-8 text-xs font-medium">结果</TableHead>
                    <TableHead class="h-8 text-xs font-medium">输出</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="it in result.items" :key="it.id" class="align-top">
                    <!-- 左栏选的是 displayName（build-box），后端 result 只带容器名（dev）——
                         用 id 映射回展示名，两栏对得上，用户才认得出哪行是哪个容器 -->
                    <TableCell class="font-mono text-xs">{{
                      props.containers.find((c) => c.id === it.id)?.label ?? it.name
                    }}</TableCell>
                    <TableCell class="text-xs">
                      <span v-if="it.ok" class="text-emerald-500">ok</span>
                      <span v-else class="text-destructive">fail ({{ it.exitCode }})</span>
                    </TableCell>
                    <TableCell class="text-xs">
                      <div v-if="it.error" class="text-destructive">{{ it.error }}</div>
                      <pre
                        v-if="it.stdout"
                        class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-muted-foreground"
                        >{{ it.stdout.trim() }}</pre
                      >
                      <pre
                        v-if="it.stderr"
                        class="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-destructive/80"
                        >{{ it.stderr.trim() }}</pre
                      >
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </div>
          <div class="flex justify-end gap-2 border-t px-5 py-3">
            <Button variant="outline" @click="resetResult">
              <ArrowLeft class="size-3.5" /> 返回编辑
            </Button>
            <Button @click="emit('close')">完成</Button>
          </div>
        </div>

        <!-- 编辑态：任务 tab + 表单 -->
        <Tabs v-else :model-value="tab" class="flex min-h-0 flex-1 flex-col gap-0" @update:model-value="onTab">
          <!-- tab 栏：自然宽度胶囊轨道（不 grid 等分，避免窄 label 挤在一起）；
               手机上横向滚动（5 个胶囊在窄屏放不下，shrink-0 保单个胶囊不被压扁） -->
          <div class="overflow-x-auto border-b px-5 py-3 scroll-thin">
            <TabsList class="gap-1">
              <TabsTrigger
                v-for="t in tabs"
                :key="t.key"
                :value="t.key"
                class="shrink-0 px-3 text-xs"
                >{{ t.label }}</TabsTrigger
              >
            </TabsList>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4 scroll-thin">
            <!-- 停机提示：本任务走 lxc-attach，所选里有停机容器时点名（不阻断，后端单容器收敛 fail） -->
            <div
              v-if="stoppedSelected"
              class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              所选有 {{ stoppedSelected }} 个容器未运行——本操作需容器在跑，这部分会失败。
            </div>

            <!-- exec：shell 高亮编辑（Monaco 异步加载，外层定高盒防止布局跳动） -->
            <TabsContent value="exec" class="space-y-3">
              <div class="flex flex-col gap-1.5">
                <Label>命令（sh -c）</Label>
                <div class="h-48 overflow-hidden rounded-md border">
                  <CodeEditor
                    v-model="execCommand"
                    language="shell"
                    class="h-full"
                    :options="execEditorOptions"
                    @save="submit"
                  />
                </div>
              </div>
              <div class="flex items-center gap-2">
                <Label for="b-exec-timeout" class="text-xs text-muted-foreground"
                  >超时（秒，留空=不限）</Label
                >
                <Input
                  id="b-exec-timeout"
                  v-model.number="execTimeout"
                  type="number"
                  min="1"
                  placeholder="60"
                  class="w-24 max-md:w-20"
                />
              </div>
            </TabsContent>

            <!-- git -->
            <TabsContent value="git" class="space-y-3">
              <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div class="space-y-1.5">
                  <Label for="b-git-name">git 用户名</Label>
                  <Input id="b-git-name" v-model="gitName" placeholder="dev" />
                </div>
                <div class="space-y-1.5">
                  <Label for="b-git-email">git 邮箱</Label>
                  <Input id="b-git-email" v-model="gitEmail" placeholder="dev@local" />
                </div>
              </div>
              <p class="text-xs text-muted-foreground">
                对每个容器覆写 git 全局 user.name/email。
              </p>
            </TabsContent>

            <!-- ssh -->
            <TabsContent value="ssh" class="space-y-2">
              <RadioGroup v-model="sshMode" class="flex items-center gap-4">
                <div class="flex items-center gap-1.5">
                  <RadioGroupItem id="ssh-reseed" value="reseed" />
                  <Label for="ssh-reseed" class="font-normal">重新拷贝宿主 ~/.ssh</Label>
                </div>
                <div class="flex items-center gap-1.5">
                  <RadioGroupItem id="ssh-append" value="append-key" />
                  <Label for="ssh-append" class="font-normal">追加公钥</Label>
                </div>
              </RadioGroup>
              <p v-if="sshMode === 'reseed'" class="text-xs text-muted-foreground">
                清空 ~/.ssh 并从 /mnt/host/.ssh 重新拷贝（权限 700/600）。
              </p>
              <Textarea
                v-else
                v-model="sshKey"
                rows="4"
                placeholder="ssh-ed25519 AAAA... user@host"
                class="font-mono text-xs"
              />
            </TabsContent>

            <!-- hosts：对已选容器一次性覆写 /etc/hosts -->
            <TabsContent value="hosts" class="space-y-3">
              <div class="flex flex-col gap-1.5">
                <Label>hosts 内容（一次性覆写所选容器）</Label>
                <div class="h-64 overflow-hidden rounded-md border">
                  <CodeEditor
                    v-model="hostsContent"
                    language="hosts"
                    class="h-full"
                    @save="submit"
                  />
                </div>
              </div>
              <div
                class="flex items-start gap-1.5 rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
              >
                <p class="flex-1">以 root 覆写这 {{ ids.length }} 个容器的 /etc/hosts，写入即持久。</p>
                <InfoHint label="hosts 维护语义说明">
                  <p>mysandbox 只维护文件尾部的服务发现块（应用容器变化会自动重建该块），其余内容不再被动。</p>
                  <p>想改新容器的默认 hosts？去改模板容器。</p>
                </InfoHint>
              </div>
            </TabsContent>

            <p v-if="err" class="mt-3 text-sm text-destructive">{{ err }}</p>
          </div>

          <!-- 底部按钮 -->
          <div class="flex justify-end gap-2 border-t px-5 py-3">
            <Button variant="outline" @click="emit('close')">关闭</Button>
            <Button :disabled="busy || !ids.length" @click="submit"
              >{{ busy ? '执行中…' : `执行（对 ${ids.length} 个容器）` }}</Button
            >
          </div>
        </Tabs>
      </div>
    </DialogContent>
  </Dialog>
</template>
