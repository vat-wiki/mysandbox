<script setup lang="ts">
// 全局 hosts 配置面板：编辑一份统一 /etc/hosts 内容，保存即生效——写入侧车并立即
// 应用到所有运行中容器；容器重启时 mysandbox 经 docker events 自动重新应用（重启不丢）。
// 新建容器在创建时经 Docker --add-host（ExtraHosts）注入。「强制应用」是兜底（自动应用
// 失败/手改过容器内 hosts 时用）。只想对部分容器一次性覆写：容器列表勾选后走
//「批量配置 → hosts 覆写」。编辑器用公共 CodeEditor（Monaco，hosts 词法高亮）。
import { ref, computed, onMounted, defineAsyncComponent } from 'vue'
import {
  getHosts,
  getHostHosts,
  putHosts,
  applyHosts,
  Unauthorized,
  type HostsView,
  type HostsApplyResult,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
// Monaco 编辑器壳（面板本身被 App.vue defineAsyncComponent 懒加载，monaco chunk 不进首屏）
const CodeEditor = defineAsyncComponent(() => import('@/components/CodeEditor.vue'))
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const emit = defineEmits<{ (e: 'close'): void }>()

const content = ref('')
// 最近一次「已持久化」快照，用于脏检测。panel 打开时 = 初始加载内容（无论是否已保存）。
const savedContent = ref('')
const isCustom = ref(false)
const isHostDefault = ref(false)
const hostError = ref('')
// '' | 'save' | 'apply' | 'host'
const busy = ref('')
const err = ref('')
const result = ref<HostsApplyResult | null>(null)
// 是否在「应用」二次确认中
const pendingApply = ref(false)
// 保存的是空内容（未应用到容器）时的提示
const emptySaved = ref(false)

const dirty = computed(() => content.value !== savedContent.value)

async function refresh() {
  busy.value = 'host'
  try {
    const v: HostsView = await getHosts()
    content.value = v.content
    savedContent.value = v.content
    isCustom.value = v.isCustom
    isHostDefault.value = v.isHostDefault
    hostError.value = v.hostError ?? ''
    err.value = ''
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}
onMounted(refresh)

async function useHost() {
  busy.value = 'host'
  try {
    const r = await getHostHosts()
    if (r.error) {
      hostError.value = r.error
      err.value = r.error
      return
    }
    content.value = r.content
    hostError.value = ''
    err.value = ''
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

async function save() {
  busy.value = 'save'
  err.value = ''
  result.value = null
  try {
    const r = await putHosts(content.value)
    savedContent.value = content.value
    isCustom.value = true
    isHostDefault.value = false
    // 保存即生效：展示应用结果（null = 空内容未应用）
    result.value = r.applied
    if (r.applied == null) {
      err.value = ''
      emptySaved.value = true
    } else {
      emptySaved.value = false
    }
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

function apply() {
  pendingApply.value = true
}
async function doApply() {
  pendingApply.value = false
  busy.value = 'apply'
  result.value = null
  err.value = ''
  try {
    result.value = await applyHosts(content.value)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = ''
  }
}

</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
      <!-- 头 -->
      <div class="flex items-center gap-3 border-b px-5 py-3 pr-10">
        <DialogTitle class="text-lg font-semibold">全局 hosts 配置</DialogTitle>
        <DialogDescription class="sr-only"
          >统一编辑所有容器的 /etc/hosts，默认预填宿主机内容</DialogDescription
        >
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <!-- 状态行 -->
        <div class="mb-3 flex items-center gap-2 text-xs">
          <span v-if="isCustom" class="inline-flex items-center gap-1.5 text-emerald-500">
            <span class="h-2 w-2 rounded-full bg-emerald-500" />已保存自定义内容
          </span>
          <span v-else-if="isHostDefault" class="inline-flex items-center gap-1.5 text-muted-foreground">
            <span class="h-2 w-2 rounded-full bg-zinc-400" />未保存，当前显示宿主机内容
          </span>
          <span v-if="dirty" class="text-amber-500">· 有未保存改动</span>
        </div>
        <p v-if="hostError" class="mb-3 text-xs text-destructive">{{ hostError }}</p>

        <!-- Monaco 编辑器（hosts 高亮） -->
        <CodeEditor
          v-model="content"
          language="hosts"
          class="h-72 rounded-md border"
          @save="save"
        />

        <!-- 警示块 -->
        <div class="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          保存后立即应用到所有运行中的容器；容器重启时 mysandbox 经 docker events
          自动重新应用，重启不再丢失。新建容器在创建时经 Docker
          <code class="font-mono">--add-host</code>（ExtraHosts）注入，但只能表达 host:ip
          对，注释与多别名会丢失。只想对部分容器一次性覆写？在容器列表勾选后用「批量配置
          → hosts 覆写」。
        </div>

        <p v-if="err" class="mt-3 text-sm text-destructive">{{ err }}</p>
        <p v-if="emptySaved" class="mt-3 text-xs text-muted-foreground">
          已保存空内容，未应用到容器。
        </p>

        <!-- 结果表 -->
        <div v-if="result" class="mt-4 space-y-2">
          <div class="text-sm">
            <span class="text-emerald-500">成功 {{ result.ok }}</span>
            <span class="ml-3 text-destructive">失败 {{ result.failed }}</span>
            <span v-if="result.skipped > 0" class="ml-3 text-muted-foreground"
              >跳过 {{ result.skipped }}（已是最新）</span
            >
            <span class="ml-3 text-muted-foreground">共 {{ result.total }}</span>
          </div>
          <p v-if="result.total === 0" class="text-xs text-muted-foreground">没有运行中的容器。</p>
          <div v-else class="overflow-hidden rounded-lg border">
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
                      v-if="it.stderr"
                      class="max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-destructive/80"
                      >{{ it.stderr.trim() }}</pre
                    >
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <!-- 底部：左侧次要动作（重置素材），右侧主操作组 -->
      <div class="flex items-center gap-2 border-t px-5 py-3">
        <Button variant="ghost" size="sm" :disabled="!!busy" @click="useHost">
          <span v-if="busy === 'host'">读取中…</span>用宿主机内容
        </Button>
        <span class="min-w-0 flex-1" />
        <Button variant="outline" size="sm" :disabled="!!busy" @click="emit('close')"
          >关闭</Button
        >
        <Button size="sm" :disabled="!dirty || !!busy" @click="save">
          <span v-if="busy === 'save'">保存并应用中…</span>保存并应用
        </Button>
        <Button variant="outline" size="sm" :disabled="!!busy" @click="apply">
          <span v-if="busy === 'apply'">应用中…</span>强制应用到运行中容器…
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    v-if="pendingApply"
    title="强制应用到运行中容器"
    description="将以 root 强制覆盖所有运行中容器的 /etc/hosts。通常无需手动操作：保存即自动应用、容器重启也会自动追上；仅在自动应用失败或你在容器内手动改过 /etc/hosts 时使用。"
    confirm-text="强制应用"
    @confirm="doApply"
    @close="pendingApply = false"
  />
</template>
