<script setup lang="ts">
// 收编外部容器对话框：列出宿主上非 mysandbox 管理的 docker 容器，三种形态——
// 裸容器（无 compose label）= 接管式收编（默认）：复刻启动方式进 compose 底账并重建，
// 从此可查可改；compose 栈（多容器项目）= 栈级只读收编：全体成员纳管、单入口展示，
// 原底账不动；单容器 compose 容器归入栈逻辑（project 即一行）。
// 列表默认只显示 running（Exited 试验残留是收编 Inbox 的头号噪声），开关可展开。
// 接管是重建性动作（可写层数据丢失、卷无损），确认框挑明；收编是同步动作不走 job。
import { ref, computed, onMounted } from 'vue'
import { RefreshCw, Import, Layers, Box } from 'lucide-vue-next'
import { listAdoptables, adoptService, Unauthorized, type AdoptableContainerView, type AdoptableStackView } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import InfoHint from '@/components/InfoHint.vue'
import { stateLabel } from '@/lib/utils'

const emit = defineEmits<{
  (e: 'adopted', name: string): void
  (e: 'close'): void
}>()

const items = ref<AdoptableContainerView[]>([])
const stacks = ref<AdoptableStackView[]>([])
const loading = ref(false)
const adopting = ref('')
const err = ref('')
const showStopped = ref(false)
const pendingTakeover = ref<AdoptableContainerView | null>(null)

// 栈行默认只显有 running 成员的；bare 行 running 优先已由后端排序
const visibleStacks = computed(() =>
  showStopped.value ? stacks.value : stacks.value.filter((s) => s.running > 0),
)
const visible = computed(() =>
  showStopped.value ? items.value : items.value.filter((x) => x.state === 'running'),
)
const stoppedCount = computed(
  () =>
    items.value.filter((x) => x.state !== 'running').length +
    stacks.value.filter((s) => s.running === 0).length,
)

async function load() {
  loading.value = true
  err.value = ''
  try {
    const v = await listAdoptables()
    items.value = v.items
    stacks.value = v.stacks ?? []
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

// 栈收编：全体成员接入服务网络 + 项目登记（同步秒级，不走 job）；成功后行消失。
async function doAdoptStack(row: AdoptableStackView) {
  if (adopting.value) return
  adopting.value = row.project
  err.value = ''
  try {
    await adoptService(row.project, { stack: true })
    stacks.value = stacks.value.filter((x) => x.project !== row.project)
    emit('adopted', row.project)
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

// 接管确认后的真正动作：走后台 job（进度/取消在服务面板任务横幅），行保留到 job
// 完成后由列表轮询自然出现——这里先关行会误导（容器还在重建中）。
async function doTakeover(row: AdoptableContainerView) {
  if (adopting.value) return
  adopting.value = row.name
  err.value = ''
  try {
    await adoptService(row.name, { takeover: true })
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
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Import class="size-4" /> 收编外部容器
        </DialogTitle>
      </DialogHeader>

      <div class="flex justify-end">
        <InfoHint label="收编方式说明">
          <p>收编 = 接管进 mysandbox 底账，之后由面板统一管理（容器与数据不动）。</p>
          <p><span class="text-foreground">裸容器 → 接管：</span>启动方式复刻进 compose 底账（可查看/修改），之后由 compose 管理，会重建容器。</p>
          <p><span class="text-foreground">compose 栈 → 栈级收编：</span>全体成员纳管、单入口展示，原底账不动。</p>
          <p>都会接入服务网络、LXC 按名字可达。</p>
        </InfoHint>
      </div>

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
        <div v-if="loading && !items.length && !stacks.length" class="px-2 pb-2 text-xs text-muted-foreground/70">扫描中…</div>
        <div v-else-if="!visible.length && !visibleStacks.length" class="px-2 pb-2 text-xs text-muted-foreground/70">
          {{ showStopped ? '没有可收编的外部容器' : '没有运行中的外部容器（展开已停止看看）' }}
        </div>

        <!-- compose 栈：一行一个项目 -->
        <div
          v-for="row in visibleStacks"
          :key="row.project"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
        >
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <Layers class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 truncate text-sm font-medium" :title="row.project">{{ row.project }}</span>
              <Badge variant="outline" class="shrink-0 text-[10px]" title="多容器 compose 项目——栈级收编">栈 · {{ row.containers.length }} 容器</Badge>
              <span class="shrink-0 text-[10px]" :class="row.running > 0 ? 'text-emerald-600' : 'text-muted-foreground'">
                {{ row.running > 0 ? `${row.running} 运行中` : '全部停止' }}
              </span>
            </div>
            <p class="truncate font-mono text-[10px] text-muted-foreground" :title="row.file ?? ''">
              {{ row.file ?? '原文件路径未知（手工启动）' }}
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            class="shrink-0"
            :disabled="!!adopting"
            title="全体成员接入服务网络、单入口展示，原文件不动"
            @click="doAdoptStack(row)"
          >
            {{ adopting === row.project ? '收编中…' : '收编栈' }}
          </Button>
        </div>

        <!-- 裸容器 -->
        <div
          v-for="row in visible"
          :key="row.name"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
        >
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <Box class="size-3.5 shrink-0 text-muted-foreground" />
              <span class="min-w-0 truncate text-sm font-medium" :title="row.name">{{ row.name }}</span>
              <span
                class="shrink-0 text-[10px]"
                :class="row.state === 'running' ? 'text-emerald-600' : 'text-muted-foreground'"
              >{{ stateLabel(row.state) }}</span>
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
            title="复刻启动方式进底账，会重建容器"
            @click="pendingTakeover = row"
          >
            {{ adopting === row.name ? '收编中…' : '接管收编' }}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        v-if="pendingTakeover"
        :title="`接管收编 ${pendingTakeover.name}`"
        :description="`将生成 compose 底账并重建容器由 compose 接管：数据卷无损，未挂载的容器可写层数据会丢失，期间短暂中断。`"
        :input="{ placeholder: '输入容器名确认', confirmCue: pendingTakeover.name }"
        confirm-text="生成底账并接管"
        @confirm="doTakeover(pendingTakeover!)"
        @close="pendingTakeover = null"
      />
    </DialogContent>
  </Dialog>
</template>
