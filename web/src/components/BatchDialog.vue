<script setup lang="ts">
import { ref, defineAsyncComponent } from 'vue'
import {
  batchGit,
  batchSshReseed,
  batchSshAppendKey,
  batchExec,
  batchAiConfig,
  getAiGateway,
  applyHosts,
  getHosts,
  Unauthorized,
  type BatchResult,
  type GatewayWire,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const props = defineProps<{
  ids: string[]
  names: string[]
}>()
const emit = defineEmits<{
  (e: 'done'): void
  (e: 'close'): void
  (e: 'unauthorized'): void
  (e: 'open-hosts'): void
}>()

// tab / sshMode 放宽为 string，避免 reka-ui AcceptableValue 与字面量联合冲突
const tab = ref<string>('exec')
const busy = ref(false)
const err = ref('')
const result = ref<BatchResult | null>(null)

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
// hosts tab：预读全局已保存内容（侧车 hosts.txt），可改后对已选容器应用。
// 编辑用 Monaco（hosts 词法高亮），与全局 hosts 面板同观感；「已选容器」而非
// 「所有容器」是这里与 HostsPanel 的关键差异——HostsPanel 是全局持久视角，这是定向一次性视角。
const hostsContent = ref('')
const hostsLoaded = ref(false)

// ai tab：两路端点（openai / anthropic）+ key + 工具勾选（opencode/pi 行内联
// wire 协议多选，ToggleGroup multiple）。打开时预填最近一次下发存档。
const aiAnthropicUrl = ref('')
const aiOpenaiUrl = ref('')
const aiKey = ref('')
const aiModels = ref('')
const aiSetDefault = ref(false)
const aiTools = ref({ claude: true, codex: true, opencode: true, pi: true })
// 工具级 wire 多选；claude 固定 anthropic、codex 固定 responses 都没有选择器
const aiWire = ref<{ opencode?: string[]; pi?: string[] }>({})
const aiLoaded = ref(false)

function resetResult() {
  result.value = null
  err.value = ''
}

async function run(fn: () => Promise<BatchResult>) {
  busy.value = true
  resetResult()
  try {
    result.value = await fn()
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
    run(() => batchExec(props.ids, execCommand.value, timeoutMs))
  } else if (tab.value === 'git') {
    if (!gitName.value.trim() || !gitEmail.value.trim()) {
      err.value = '用户名和邮箱都必填'
      return
    }
    run(() => batchGit(props.ids, gitName.value.trim(), gitEmail.value.trim()))
  } else if (tab.value === 'ssh') {
    if (sshMode.value === 'append-key' && !sshKey.value.trim()) {
      err.value = '请粘贴公钥'
      return
    }
    run(() =>
      sshMode.value === 'reseed'
        ? batchSshReseed(props.ids)
        : batchSshAppendKey(props.ids, sshKey.value.trim()),
    )
  } else if (tab.value === 'ai') {
    const t = aiTools.value
    const any = t.claude || t.codex || t.opencode || t.pi
    if (!any) {
      err.value = '至少勾选一个工具'
      return
    }
    if (!aiKey.value.trim()) {
      err.value = 'API Key 必填'
      return
    }
    // 端点需求按工具+wire 集合推导（与后端校验同规则）
    const multiTools = ['opencode', 'pi'] as const
    const wiresOfTool = (tool: 'opencode' | 'pi'): string[] => aiWire.value[tool] ?? ['openai-chat']
    const needsOpenai =
      t.codex ||
      multiTools.some((tool) => t[tool] && wiresOfTool(tool).some((w) => w !== 'anthropic-messages'))
    const needsAnthropic =
      t.claude ||
      multiTools.some((tool) => t[tool] && wiresOfTool(tool).includes('anthropic-messages'))
    if (needsOpenai && !/^https?:\/\//.test(aiOpenaiUrl.value.trim())) {
      err.value = '需要 OpenAI 兼容 Base URL（codex 或有工具选了 openai 系协议）'
      return
    }
    if (needsAnthropic && !/^https?:\/\//.test(aiAnthropicUrl.value.trim())) {
      err.value = '需要 Anthropic 兼容 Base URL（claude 或有工具选了 anthropic 协议）'
      return
    }
    if ((t.opencode || t.pi) && !aiModels.value.trim()) {
      err.value = 'opencode/pi 需要至少一个模型 ID（逗号分隔）'
      return
    }
    run(() =>
      batchAiConfig(props.ids, {
        endpoints: {
          ...(needsOpenai ? { openai: { baseUrl: aiOpenaiUrl.value.trim() } } : {}),
          ...(needsAnthropic ? { anthropic: { baseUrl: aiAnthropicUrl.value.trim() } } : {}),
        },
        apiKey: aiKey.value.trim(),
        tools: { ...t },
        wire: {
          opencode: aiWire.value.opencode as GatewayWire[] | undefined,
          pi: aiWire.value.pi as GatewayWire[] | undefined,
        },
        models: aiModels.value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
        setDefault: aiSetDefault.value,
      }),
    )
  } else {
    if (!hostsContent.value.trim()) {
      err.value = 'hosts 内容不能为空'
      return
    }
    // 对已选容器覆写 /etc/hosts（不保存全局——想改全局配置去 hosts 面板）
    run(() => applyHosts(hostsContent.value, props.ids))
  }
}

function onTab(v: string | number) {
  tab.value = String(v)
  resetResult()
  // hosts tab 首次进入时预读全局 hosts 内容
  if (tab.value === 'hosts' && !hostsLoaded.value) {
    hostsLoaded.value = true
    getHosts()
      .then((v) => {
        hostsContent.value = v.content
      })
      .catch(() => {
        /* 预读失败不阻塞，textarea 留空可手填 */
      })
  }
  // ai tab 首次进入时预填最近一次下发存档。只补空字段、不碰勾选——
  // 否则「用户先勾后填」时迟到的响应会把勾选打回去（实测踩过：勾了 opencode/pi，
  // 回包落地的瞬间被存档里的 false 覆盖，提交时仍是未勾）。
  if (tab.value === 'ai' && !aiLoaded.value) {
    aiLoaded.value = true
    getAiGateway()
      .then(({ config }) => {
        if (!config) return
        if (!aiAnthropicUrl.value.trim() && config.endpoints.anthropic)
          aiAnthropicUrl.value = config.endpoints.anthropic.baseUrl
        if (!aiOpenaiUrl.value.trim() && config.endpoints.openai)
          aiOpenaiUrl.value = config.endpoints.openai.baseUrl
        if (config.wire)
          aiWire.value = {
            opencode: config.wire.opencode ? [...config.wire.opencode] : undefined,
            pi: config.wire.pi ? [...config.wire.pi] : undefined,
          }
        if (!aiKey.value.trim()) aiKey.value = config.apiKey
        if (!aiModels.value.trim()) aiModels.value = (config.models ?? []).join(', ')
      })
      .catch(() => {
        /* 无存档/读取失败不阻塞，表单留空手填 */
      })
  }
}

// 跳全局 hosts 面板：先关自己再开面板，避免两个 Dialog 叠层
function goHosts() {
  emit('close')
  emit('open-hosts')
}

// 通用命令排首位（无预设意图的高频动作）；git/ssh 是「装完配一次」类相邻；
// AI 网关是换 key/换网关的批量重推；hosts 覆写殿后并与全局面板拉开命名距离。
const tabs: { key: string; label: string }[] = [
  { key: 'exec', label: '通用命令' },
  { key: 'git', label: 'Git 身份' },
  { key: 'ssh', label: 'SSH' },
  { key: 'ai', label: 'AI 网关' },
  { key: 'hosts', label: 'hosts 覆写' },
]
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent
      class="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
    >
      <!-- 头 -->
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-5 py-3 pr-10">
        <DialogTitle class="text-lg font-semibold">批量配置</DialogTitle>
        <span class="truncate text-sm text-muted-foreground"
          >已选 {{ ids.length }} 个：{{ names.join('、') }}</span
        >
        <DialogDescription class="sr-only">对所选容器批量执行配置或命令</DialogDescription>
      </div>

      <Tabs :model-value="tab" class="flex min-h-0 flex-1" @update:model-value="onTab">
        <!-- tab 栏：自然宽度胶囊轨道（不 grid 等分，避免窄 label 挤在一起） -->
        <div class="border-b px-5 py-3">
          <TabsList class="gap-1">
            <TabsTrigger
              v-for="t in tabs"
              :key="t.key"
              :value="t.key"
              class="flex-none px-3 text-xs"
              >{{ t.label }}</TabsTrigger
            >
          </TabsList>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
                class="w-24"
              />
            </div>
          </TabsContent>

          <!-- git -->
          <TabsContent value="git" class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
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
              对每个容器执行 git config --global user.name/email，覆盖现有配置。
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
              清空 ~/.ssh 后从挂载的 /mnt/host/.ssh 重新拷贝（含 id_* 与 known_hosts），权限自动设为 700/600。
            </p>
            <Textarea
              v-else
              v-model="sshKey"
              rows="4"
              placeholder="ssh-ed25519 AAAA... user@host"
              class="font-mono text-xs"
            />
          </TabsContent>

          <!-- ai：网关端点直写各 CLI 配置文件（rootfs 直写，容器无需在跑）。
               两个 URL 并排（用到哪条校验哪条）；协议选择内联在各工具行的三态组里，
               claude 固定 anthropic、codex 只有 openai 系两态。 -->
          <TabsContent value="ai" class="space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label for="b-ai-openai">OpenAI 兼容 Base URL</Label>
                <Input
                  id="b-ai-openai"
                  v-model="aiOpenaiUrl"
                  placeholder="http://10.12.135.150:7800/openai/v1"
                />
              </div>
              <div class="space-y-1.5">
                <Label for="b-ai-anthropic">Anthropic 兼容 Base URL</Label>
                <Input
                  id="b-ai-anthropic"
                  v-model="aiAnthropicUrl"
                  placeholder="http://10.12.135.150:7800/anthropic"
                />
              </div>
            </div>
            <div class="space-y-1.5">
              <Label for="b-ai-key">API Key</Label>
              <Input id="b-ai-key" v-model="aiKey" type="password" placeholder="sk-…" />
            </div>
            <!-- 工具行：勾选 + 行内协议。claude/codex 协议由工具能力决定没有选择器；
                 opencode/pi 是多选（ToggleGroup multiple），每个选中协议注册一个
                 provider 变体，工具内按模型切。 -->
            <div class="space-y-2 rounded-md border p-3">
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label class="flex w-32 items-center gap-1.5 text-sm">
                  <Checkbox
                    id="ai-claude"
                    :checked="aiTools.claude"
                    @update:checked="(v: boolean) => (aiTools.claude = !!v)"
                  />
                  Claude Code
                </label>
                <span class="text-[11px] text-muted-foreground">anthropic 协议（固定）</span>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label class="flex w-32 items-center gap-1.5 text-sm">
                  <Checkbox
                    id="ai-codex"
                    :checked="aiTools.codex"
                    @update:checked="(v: boolean) => (aiTools.codex = !!v)"
                  />
                  Codex
                </label>
                <span class="text-[11px] text-muted-foreground">responses 协议（官方已停 chat）</span>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label class="flex w-32 items-center gap-1.5 text-sm">
                  <Checkbox
                    id="ai-opencode"
                    :checked="aiTools.opencode"
                    @update:checked="(v: boolean) => (aiTools.opencode = !!v)"
                  />
                  OpenCode
                </label>
                <ToggleGroup
                  type="multiple"
                  size="sm"
                  variant="outline"
                  :model-value="aiWire.opencode ?? ['openai-chat']"
                  class="text-xs"
                  @update:model-value="(v) => (aiWire.opencode = (v as string[]).length ? (v as string[]) : undefined)"
                >
                  <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
                  <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
                  <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label class="flex w-32 items-center gap-1.5 text-sm">
                  <Checkbox
                    id="ai-pi"
                    :checked="aiTools.pi"
                    @update:checked="(v: boolean) => (aiTools.pi = !!v)"
                  />
                  Pi
                </label>
                <ToggleGroup
                  type="multiple"
                  size="sm"
                  variant="outline"
                  :model-value="aiWire.pi ?? ['openai-chat']"
                  class="text-xs"
                  @update:model-value="(v) => (aiWire.pi = (v as string[]).length ? (v as string[]) : undefined)"
                >
                  <ToggleGroupItem value="openai-chat">chat</ToggleGroupItem>
                  <ToggleGroupItem value="openai-responses">responses</ToggleGroupItem>
                  <ToggleGroupItem value="anthropic-messages">anthropic</ToggleGroupItem>
                </ToggleGroup>
              </div>
              <p class="text-[11px] leading-snug text-muted-foreground">
                多选协议时每个协议注册一个独立接入点（myapikey-chat / -responses / -anthropic），工具内按模型切换。
              </p>
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  id="ai-default"
                  :checked="aiSetDefault"
                  @update:checked="(v: boolean) => (aiSetDefault = !!v)"
                />
                设为默认 provider（codex 设 model_provider；opencode/pi 用首个协议变体 + 首个模型）
              </label>
            </div>
            <div class="space-y-1.5">
              <Label for="b-ai-models">模型 ID（逗号分隔，opencode/pi 必填）</Label>
              <Input id="b-ai-models" v-model="aiModels" placeholder="claude-sonnet-4-5, gpt-5" />
            </div>
            <div
              class="rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
            >
              直接写入这 {{ ids.length }} 个容器的 home 配置文件——容器不必在运行，CLI
              下次启动即生效：claude 走 settings.json env 注入；codex 加 provider（key 经
              ~/.zshrc 环境变量，固定走 responses）；opencode / pi 在配置里内联 key，按所选
              协议注册接入点。已有配置只合并本方案的键，不会整体覆盖；重复执行幂等。
              API Key 会明文落盘在各容器内。
            </div>
          </TabsContent>

          <!-- hosts：对已选容器一次性覆写 /etc/hosts（区别于全局 hosts 面板） -->
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
              class="rounded-md border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground"
            >
              已预填全局 hosts 配置（可修改，仅本次应用、不保存全局）。以 root 覆写这
              {{ ids.length }} 个容器的 /etc/hosts，一次性生效（容器重启后恢复全局配置——全局配置会自动追上）。
              <Button
                variant="link"
                size="xs"
                class="h-auto p-0 align-baseline text-[11px]"
                @click="goHosts"
                >想统一保存、让新建容器也生效？打开全局 hosts 配置</Button
              >
            </div>
          </TabsContent>

          <p v-if="err" class="mt-3 text-sm text-destructive">{{ err }}</p>

          <!-- 结果 -->
          <div v-if="result" class="mt-4 space-y-2">
            <div class="text-sm">
              <span class="text-emerald-500">成功 {{ result.ok }}</span>
              <span class="ml-3 text-destructive">失败 {{ result.failed }}</span>
              <span class="ml-3 text-muted-foreground">共 {{ result.total }}</span>
            </div>
            <div class="overflow-hidden rounded-lg border">
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
                    <TableCell class="font-mono text-xs">{{ it.name }}</TableCell>
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
        </div>
      </Tabs>

      <!-- 底部按钮 -->
      <div class="flex justify-end gap-2 border-t px-5 py-3">
        <Button variant="outline" @click="emit('close')">关闭</Button>
        <Button :disabled="busy" @click="submit">{{ busy ? '执行中…' : '执行' }}</Button>
      </div>
    </DialogContent>
  </Dialog>
</template>
