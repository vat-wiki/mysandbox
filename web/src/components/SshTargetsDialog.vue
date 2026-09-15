<script setup lang="ts">
// SSH 主机管理对话框（侧栏终端区「添加 / 管理」入口）：现有目标（点击直开终端、
// 可删）+ ~/.ssh/config 候选（点击预填表单）+ 手动添加。目标存 sidecar
// state.json（server/sshTerminal.ts），这里只存「怎么连」——凭据全走宿主 ssh
// （keys / agent / ssh config 别名含跳板），不新增任何凭据存储。
import { ref, onMounted } from 'vue'
import { RefreshCw, Server, Trash2, ArrowRight } from 'lucide-vue-next'
import {
  listSshTargets,
  addSshTarget,
  deleteSshTarget,
  listSshConfigHosts,
  Unauthorized,
  type SshTargetView,
  type SshConfigHost,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { containerColor } from '@/lib/utils'
import InfoHint from '@/components/InfoHint.vue'

const emit = defineEmits<{
  (e: 'changed'): void
  // 点击已有目标：直开终端（父级收对话框、建组聚焦）
  (e: 'open', t: SshTargetView): void
  (e: 'close'): void
  (e: 'unauthorized'): void
}>()

const targets = ref<SshTargetView[]>([])
const candidates = ref<SshConfigHost[]>([])
const loading = ref(false)
const err = ref('')

async function load() {
  loading.value = true
  err.value = ''
  try {
    const [t, c] = await Promise.all([listSshTargets(), listSshConfigHosts()])
    targets.value = t.targets
    candidates.value = c.hosts.filter((x) => !targets.value.some((y) => y.name === x.name))
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
onMounted(load)

// —— 添加表单（候选导入 = 预填，确认仍走这里）——
const name = ref('')
const host = ref('')
const user = ref('')
const port = ref('')
const adding = ref(false)
async function submit() {
  if (!name.value.trim() || !host.value.trim()) {
    err.value = '名称与目的地都必填'
    return
  }
  adding.value = true
  err.value = ''
  try {
    await addSshTarget({
      name: name.value.trim(),
      host: host.value.trim(),
      user: user.value.trim() || undefined,
      port: port.value.trim() ? Number(port.value.trim()) : undefined,
    })
    name.value = host.value = user.value = port.value = ''
    await load()
    emit('changed')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    adding.value = false
  }
}

function useCandidate(c: SshConfigHost) {
  name.value = c.name
  host.value = c.host || c.name
  user.value = c.user || ''
  port.value = c.port ? String(c.port) : ''
}

// —— 删除（会话本体在远端 tmux，不受影响；只摘掉面板入口）——
const delTarget = ref<SshTargetView | null>(null)
async function doDelete() {
  const t = delTarget.value
  if (!t) return
  delTarget.value = null
  try {
    await deleteSshTarget(t.name)
    await load()
    emit('changed')
  } catch (e) {
    if (e instanceof Unauthorized) {
      emit('unauthorized')
      return
    }
    err.value = e instanceof Error ? e.message : String(e)
  }
}

function destLabel(t: { name?: string; host?: string; user?: string; port?: number }): string {
  return `${t.user ? t.user + '@' : ''}${t.host || t.name || ''}${t.port ? ':' + t.port : ''}`
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Server class="size-4" /> SSH 主机
        </DialogTitle>
      </DialogHeader>

      <div class="flex items-start gap-1.5">
        <p class="text-xs text-muted-foreground">
          远程主机作为「终端」接入，会话在远端 tmux 上；凭据复用本机 ssh，这里不存密码。
        </p>
        <InfoHint tip="会话跨重启存活；密钥 / agent / ~/.ssh/config 别名（含跳板）直接生效。" />
      </div>

      <p
        v-if="err"
        class="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
      >{{ err }}</p>

      <div class="-mx-1 max-h-[46vh] overflow-y-auto px-1 scroll-thin">
        <div class="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-semibold text-muted-foreground">
          <span>已有目标</span>
          <Button
            variant="ghost"
            size="icon-xs"
            class="ml-auto size-5"
            :disabled="loading"
            title="刷新"
            @click="load"
          >
            <RefreshCw :class="loading ? 'animate-spin' : ''" />
          </Button>
        </div>
        <div v-if="!targets.length" class="px-2 pb-2 text-xs text-muted-foreground/70">
          还没有 SSH 主机
        </div>
        <div
          v-for="t in targets"
          :key="t.name"
          class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
        >
          <span class="h-2 w-2 shrink-0 rounded-full" :style="{ backgroundColor: containerColor(t.name) }" />
          <button
            type="button"
            class="min-w-0 flex-1 text-left"
            @click="emit('open', t)"
          >
            <span class="block truncate text-sm">{{ t.name }}</span>
            <span class="block truncate font-mono text-[10px] text-muted-foreground">{{ destLabel(t) }}</span>
          </button>
          <Button variant="outline" size="xs" class="shrink-0" @click="emit('open', t)">
            终端 <ArrowRight />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground hover:text-destructive"
            title="删除目标"
            @click="delTarget = t"
          >
            <Trash2 />
          </Button>
        </div>

        <!-- ~/.ssh/config 候选：点击预填下方表单（不做静默导入——名字/目的地仍由你确认） -->
        <template v-if="candidates.length">
          <div class="mt-2 border-t border-border px-2 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
            从 ~/.ssh/config 导入
          </div>
          <div
            v-for="c in candidates"
            :key="c.name"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/50"
          >
            <Badge variant="outline" class="shrink-0 border-transparent bg-primary/10 text-[10px] text-primary">候选</Badge>
            <button type="button" class="min-w-0 flex-1 text-left" @click="useCandidate(c)">
              <span class="block truncate text-sm">{{ c.name }}</span>
              <span class="block truncate font-mono text-[10px] text-muted-foreground">{{ destLabel(c) }}</span>
            </button>
            <Button variant="outline" size="xs" class="shrink-0" @click="useCandidate(c)">预填</Button>
          </div>
        </template>
      </div>

      <!-- 手动添加：候选点击后这里预填，确认仍显式提交 -->
      <div class="border-t border-border pt-3">
        <div class="grid grid-cols-[1fr_2fr] gap-2">
          <Input v-model="name" placeholder="名称（显示名）" class="h-8 text-xs" />
          <Input v-model="host" placeholder="目的地 host / user@host / 别名" class="h-8 font-mono text-xs" />
          <Input v-model="user" placeholder="用户名（可选）" class="h-8 text-xs" />
          <Input v-model="port" placeholder="端口（可选）" class="h-8 text-xs" />
        </div>
        <Button size="sm" class="mt-2 w-full" :disabled="adding" @click="submit">
          {{ adding ? '添加中…' : '添加主机' }}
        </Button>
      </div>

      <ConfirmDialog
        v-if="delTarget"
        title="删除 SSH 主机"
        :description="`删除 ${delTarget.name}（${destLabel(delTarget)}）？远端 tmux 会话不受影响，本面板入口移除。`"
        confirm-text="删除"
        variant="destructive"
        @confirm="doDelete"
        @close="delTarget = null"
      />
    </DialogContent>
  </Dialog>
</template>
