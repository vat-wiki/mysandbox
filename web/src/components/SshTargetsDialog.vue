<script setup lang="ts">
// SSH 主机管理对话框（侧栏终端区「添加 / 管理」入口）：现有目标（点击直开终端、
// 可删）+ ~/.ssh/config 候选（点击预填表单）+ 手动添加。目标存 sidecar
// state.json（server/sshTerminal.ts），这里只存「怎么连」——凭据缺省走宿主 ssh
// （keys / agent / ssh config 别名含跳板）；密码为可选填项（服务端本地存储、
// 经 sshpass 自动应答，API 不回明文），另有备注等可选项。
import { ref, onMounted, watch, computed } from 'vue'
import { RefreshCw, Server, Trash2, ArrowRight, KeyRound, Pencil } from 'lucide-vue-next'
import {
  listSshTargets,
  addSshTarget,
  updateSshTarget,
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

// —— 添加 / 编辑表单（候选导入 = 预填，确认仍走这里；编辑模式名称与目的地锁定）——
const name = ref('')
const host = ref('')
const user = ref('')
const port = ref('')
const password = ref('')
const note = ref('')
const adding = ref(false)
// 编辑态：editing = 目标名。密码留空 = 保持不变；勾「清除」= 发空串删除已存密码。
const editing = ref<string | null>(null)
const clearPassword = ref(false)
const editHasPassword = computed(
  () => !!editing.value && !!targets.value.find((x) => x.name === editing.value)?.hasPassword,
)

function editTarget(t: SshTargetView) {
  editing.value = t.name
  name.value = t.name
  host.value = t.host
  user.value = t.user || ''
  port.value = t.port ? String(t.port) : ''
  note.value = t.note || ''
  password.value = ''
  clearPassword.value = false
}

function exitEdit() {
  editing.value = null
  name.value = host.value = user.value = port.value = password.value = note.value = ''
}

// 右键「编辑 / 改密码」入口：父级把目标名经 prefillEdit 传进来（列表未就绪时等加载）。
// immediate：对话框按 v-if 挂载，挂上时 prop 已有值，普通 watch 不会再触发。
const props = defineProps<{ prefillEdit?: string | null }>()
watch(
  () => props.prefillEdit,
  async (n) => {
    if (!n) return
    if (!targets.value.length) await load()
    const t = targets.value.find((x) => x.name === n)
    if (t) editTarget(t)
  },
  { immediate: true },
)

async function submit() {
  if (!editing.value && (!name.value.trim() || !host.value.trim())) {
    err.value = '名称与目的地都必填'
    return
  }
  adding.value = true
  err.value = ''
  try {
    if (editing.value) {
      // 密码：留空不发送（保持不变）；勾清除发 ''；填了发新值。
      await updateSshTarget(editing.value, {
        user: user.value.trim() || '',
        port: port.value.trim() ? Number(port.value.trim()) : '',
        ...(clearPassword.value ? { password: '' } : password.value ? { password: password.value } : {}),
        note: note.value.trim(),
      })
      exitEdit()
    } else {
      await addSshTarget({
        name: name.value.trim(),
        host: host.value.trim(),
        user: user.value.trim() || undefined,
        port: port.value.trim() ? Number(port.value.trim()) : undefined,
        password: password.value || undefined,
        note: note.value.trim() || undefined,
      })
      name.value = host.value = user.value = port.value = password.value = note.value = ''
    }
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
  editing.value = null
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
    <DialogContent class="max-w-lg max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0 max-md:pt-safe">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Server class="size-4" /> SSH 主机
        </DialogTitle>
      </DialogHeader>

      <div class="flex justify-end">
        <InfoHint label="接入方式说明">
          <p>远程主机作为「终端」接入，会话在远端 tmux 上；凭据缺省复用本机 ssh（密钥 / agent）。</p>
          <p>密码为可选填项：仅存本机 sidecar（0600），经 sshpass 自动应答，不出 API；不填则用密钥，首连可在终端交互确认。</p>
          <p>会话跨重启存活；~/.ssh/config 别名（含跳板）直接生效。</p>
        </InfoHint>
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
            <span class="flex items-center gap-1 truncate text-sm">
              {{ t.name }}
              <KeyRound v-if="t.hasPassword" class="size-3 shrink-0 text-muted-foreground" aria-label="已存密码" />
            </span>
            <span class="block truncate font-mono text-[10px] text-muted-foreground">{{ destLabel(t) }}</span>
            <span v-if="t.note" class="block truncate text-[10px] text-muted-foreground/80">{{ t.note }}</span>
          </button>
          <Button variant="outline" size="xs" class="shrink-0" @click="emit('open', t)">
            终端 <ArrowRight />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="shrink-0 text-muted-foreground hover:text-foreground"
            title="编辑 / 改密码"
            @click="editTarget(t)"
          >
            <Pencil />
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

      <!-- 手动添加 / 编辑：候选点击后这里预填，确认仍显式提交。编辑态名称与目的地锁定，
           密码留空 = 不改，勾「清除」= 删除已存密码。 -->
      <div class="border-t border-border pt-3">
        <div v-if="editing" class="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" class="border-transparent bg-primary/10 text-[10px] text-primary">编辑</Badge>
          <span class="min-w-0 flex-1 truncate">正在编辑 <span class="font-medium text-foreground">{{ editing }}</span>，名称与目的地不可改</span>
          <button type="button" class="shrink-0 text-muted-foreground hover:text-foreground" @click="exitEdit">取消</button>
        </div>
        <div class="grid grid-cols-[1fr_2fr] gap-2">
          <Input v-model="name" :disabled="!!editing" placeholder="名称（显示名）" class="h-8 text-xs" />
          <Input v-model="host" :disabled="!!editing" placeholder="目的地 host / user@host / 别名" class="h-8 font-mono text-xs" />
          <Input v-model="user" placeholder="用户名（可选）" class="h-8 text-xs" />
          <Input v-model="port" placeholder="端口（可选）" class="h-8 text-xs" />
          <Input
            v-model="password"
            type="password"
            autocomplete="new-password"
            :placeholder="editing ? '密码（留空 = 不修改）' : '密码（可选）'"
            class="h-8 text-xs"
          />
          <Input v-model="note" placeholder="备注（可选）" class="h-8 text-xs" />
        </div>
        <label v-if="editing && editHasPassword" class="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="clearPassword" type="checkbox" class="size-3 accent-primary" />
          清除已存密码（改用密钥 / 手动输密码）
        </label>
        <Button size="sm" class="mt-2 w-full" :disabled="adding" @click="submit">
          {{ adding ? '保存中…' : editing ? '保存修改' : '添加主机' }}
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
