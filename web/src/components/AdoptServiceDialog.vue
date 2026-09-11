<script setup lang="ts">
// 收编外部容器对话框：列出宿主上非 mysandbox 管理的 docker 容器，两种形态——
// 裸容器（无 compose label）= 接管式收编（默认）：复刻启动方式进 compose 底账并重建，
// 从此可查可改；compose 栈容器 = 只读收编（底账在原编排方，本体不动）。
// 列表默认只显示 running（Exited 试验残留是收编 Inbox 的头号噪声），开关可展开。
// 接管是重建性动作（可写层数据丢失、卷无损），确认框挑明；只读收编秒级同步不走 job。
import { ref, computed, onMounted } from 'vue'
import { RefreshCw, Import } from 'lucide-vue-next'
import { listAdoptables, adoptService, Unauthorized, type AdoptableContainerView } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { stateLabel } from '@/lib/utils'

const emit = defineEmits<{
  (e: 'adopted', name: string): void
  (e: 'close'): void
}>()

const items = ref<AdoptableContainerView[]>([])
const loading = ref(false)
const adopting = ref('')
const err = ref('')
const showStopped = ref(false)
const pendingTakeover = ref<AdoptableContainerView | null>(null)

const visible = computed(() =>
  showStopped.value ? items.value : items.value.filter((x) => x.state === 'running'),
)
const stoppedCount = computed(() => items.value.filter((x) => x.state !== 'running').length)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const v = await listAdoptables()
    items.value = v.items
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

// 接管确认后的真正动作：走后台 job（进度/取消在服务面板任务横幅），行保留到 job
// 完成后由列表轮询自然出现——这里先关行会误导（容器还在重建中）。
async function doTakeover(row: AdoptableContainerView) {
  if (adopting.value) return
  adopting.value = row.name
  err.value = ''
  try {
    await adoptService(row.name, true)
    pendingTakeover.value = null
    emit('adopted', row.name)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    adopting.value = ''
  }
}

// 只读收编（compose 栈容器）：同步秒级，成功后行消失。
async function doAdoptReadonly(row: AdoptableContainerView) {
  if (adopting.value) return
  adopting.value = row.name
  err.value = ''
  try {
    await adoptService(row.name, false)
    items.value = items.value.filter((x) => x.name !== row.name)
    emit('adopted', row.name)
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('close')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    adopting.value = ''
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Import class="size-4" /> 收编外部容器
        </DialogTitle>
      </DialogHeader>

      <p class="text-xs text-muted-foreground">
        裸容器（docker run 起家）收编 = <span class="text-foreground">接管</span>：启动方式复刻进
        compose 底账（可查看/修改），之后由 compose 管理；compose 栈容器只做
        <span class="text-foreground">只读收编</span>（底账归原编排方）。两者都会接入服务网络、
        LXC 按名字可达。
      </p>

      <p
        v-if="err"
        class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >{{ err }}</p>

      <div class="-mx-1 max-h-[55vh] overflow-y-auto px-1 scroll-thin">
        <div class="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
          <span>外部容器</span>
          <label class="ml-auto flex cursor-pointer items-center gap-1.5 text-xs font-normal">
            <input v-model="showStopped" type="checkbox" class="accent-primary" />
            显示已停止<span v-if="stoppedCount">（{{ stoppedCount }}）</span>
          </label>
          <Button
            variant="ghost"
            size="icon-xs"
            class="size-5"
            :disabled="loading"
            title="重新扫描"
            @click="load"
          >
            <RefreshCw :class="loading ? 'animate-spin' : ''" />
          </Button>
        </div>
        <div v-if="loading && !items.length" class="px-2 pb-2 text-xs text-muted-foreground/70">扫描中…</div>
        <div v-else-if="!visible.length" class="px-2 pb-2 text-xs text-muted-foreground/70">
          {{ showStopped ? '没有可收编的外部容器' : '没有运行中的外部容器（展开已停止看看）' }}
        </div>
        <div
          v-for="row in visible"
          :key="row.name"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
        >
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <span class="min-w-0 truncate text-sm font-medium" :title="row.name">{{ row.name }}</span>
              <span
                class="shrink-0 text-[10px]"
                :class="row.state === 'running' ? 'text-emerald-600' : 'text-muted-foreground'"
              >{{ stateLabel(row.state) }}</span>
              <Badge
                v-if="row.compose"
                variant="outline"
                class="shrink-0 text-[10px]"
                title="compose 栈容器——只读收编，配置归原编排方管"
              >compose 栈</Badge>
              <Badge
                v-if="row.onServiceNetwork"
                variant="outline"
                class="shrink-0 border-transparent bg-primary/15 text-[10px] text-primary"
                title="已在服务网络上，收编时直接复用现 IP"
              >已在服务网络</Badge>
            </div>
            <p class="truncate font-mono text-[10px] text-muted-foreground" :title="`${row.image} · ${row.networks}`">
              {{ row.image }} · {{ row.networks }}
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            class="shrink-0"
            :disabled="!!adopting"
            :title="row.compose ? '只读收编：接入服务网络 + 纳入面板，本体不动' : '接管式收编：复刻启动方式进 compose 底账（会重建容器）'"
            @click="row.compose ? doAdoptReadonly(row) : (pendingTakeover = row)"
          >
            {{ adopting === row.name ? '收编中…' : row.compose ? '只读收编' : '接管收编' }}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        v-if="pendingTakeover"
        :title="`接管收编 ${pendingTakeover.name}`"
        :description="`将按当前容器形状生成 compose 底账（~/.config/mysandbox/compose/${pendingTakeover.name}/compose.yaml），然后重建容器由 compose 接管：数据卷无损，容器可写层里未挂载的数据会丢失，运行短暂中断。`"
        :input="{ placeholder: '输入容器名确认', confirmCue: pendingTakeover.name }"
        confirm-text="生成底账并接管"
        @confirm="doTakeover(pendingTakeover!)"
        @close="pendingTakeover = null"
      />
    </DialogContent>
  </Dialog>
</template>
