<script setup lang="ts">
import { ref, defineAsyncComponent } from 'vue'
import {
  batchGit,
  batchSshReseed,
  batchSshAppendKey,
  batchExec,
  applyHosts,
  getHosts,
  Unauthorized,
  type BatchResult,
} from '@/lib/api'
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
}

// 跳全局 hosts 面板：先关自己再开面板，避免两个 Dialog 叠层
function goHosts() {
  emit('close')
  emit('open-hosts')
}

// 通用命令排首位（无预设意图的高频动作）；git/ssh 是「装完配一次」类相邻；
// hosts 覆写殿后并与全局面板拉开命名距离。
const tabs: { key: string; label: string }[] = [
  { key: 'exec', label: '通用命令' },
  { key: 'git', label: 'Git 身份' },
  { key: 'ssh', label: 'SSH' },
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
