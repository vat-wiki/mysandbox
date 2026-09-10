<script setup lang="ts">
// 收编外部容器对话框：列出宿主上非 mysandbox 管理的 docker 容器（无 label），一键
// 纳入服务层管理——sidecar 登记 + 接入服务网络（LXC 容器按名字可达）。收编是同步
// 动作（秒级），不走 job；成功后行消失（已被收编），父级经 changed 即时刷侧栏。
// 布局照抄 TermSessionsDialog 的「拉列表 + 行操作 + loading/err」模式。
import { ref, onMounted } from 'vue'
import { RefreshCw, Inbox } from 'lucide-vue-next'
import { listAdoptables, adoptService, Unauthorized, type AdoptableContainerView } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { stateLabel } from '@/lib/utils'

const emit = defineEmits<{
  (e: 'adopted', name: string): void
  (e: 'close'): void
}>()

const items = ref<AdoptableContainerView[]>([])
const loading = ref(false)
const adopting = ref('')
const err = ref('')

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

async function doAdopt(row: AdoptableContainerView) {
  if (adopting.value) return
  adopting.value = row.name
  err.value = ''
  try {
    await adoptService(row.name)
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
          <Inbox class="size-4" /> 收编外部容器
        </DialogTitle>
      </DialogHeader>

      <p class="text-xs text-muted-foreground">
        把宿主上 mysandbox 之外的 docker 容器纳入管理：接入服务网络、LXC 容器按名字可达，
        面板提供终端/文件/日志/端口。容器本体与原网络不动；删除请找它自己的编排方。
      </p>

      <p
        v-if="err"
        class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >{{ err }}</p>

      <div class="-mx-1 max-h-[55vh] overflow-y-auto px-1 scroll-thin">
        <div class="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
          <span>外部容器</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="ml-auto size-5"
            :disabled="loading"
            title="重新扫描"
            @click="load"
          >
            <RefreshCw :class="loading ? 'animate-spin' : ''" />
          </Button>
        </div>
        <div v-if="loading && !items.length" class="px-2 pb-2 text-xs text-muted-foreground/70">扫描中…</div>
        <div v-else-if="!items.length" class="px-2 pb-2 text-xs text-muted-foreground/70">
          没有可收编的外部容器
        </div>
        <div
          v-for="row in items"
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
            @click="doAdopt(row)"
          >
            {{ adopting === row.name ? '收编中…' : '收编' }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
