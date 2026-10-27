<script setup lang="ts">
// 账户管理面板（owner）：受限账户的增删改——账户 = 只能操作白名单容器的第二凭证层
// （终端 + 文件面板），分享给他人用时在这里开账户、勾容器。与 BasePanel 同款 Dialog
// 壳（路由承载，App 渲染）。
import { ref, computed, onMounted } from 'vue'
import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  listContainers, Unauthorized,
  type AccountView,
  type ContainerView,
} from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import { toast } from 'vue-sonner'
import { MoreHorizontal, Plus, Trash2, KeyRound, Pencil } from 'lucide-vue-next'

const emit = defineEmits<{ (e: 'close'): void }>()

const accounts = ref<AccountView[]>([])
const containers = ref<ContainerView[]>([])
const loading = ref(false)

async function refresh() {
  loading.value = true
  try {
    const [a, c] = await Promise.all([
      listAccounts(),
      listContainers().catch(() => ({ items: [] as ContainerView[] })),
    ])
    accounts.value = a.items
    containers.value = c.items
  } catch (e) {
    if (e instanceof Unauthorized) return emit('close')
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

// —— 新建 / 编辑表单（一个 Dialog 两用；editName 非空 = 编辑态）——
const showForm = ref(false)
const editName = ref('')
const formName = ref('')
const formPass = ref('')
const formContainers = ref<string[]>([])
const saving = ref(false)
const formErr = ref('')

const containerChoices = computed(() =>
  containers.value
    .filter((c) => c.managed || c.adopted)
    .map((c) => ({ id: c.name, label: c.displayName || c.name })),
)

function openCreate() {
  editName.value = ''
  formName.value = ''
  formPass.value = ''
  formContainers.value = []
  formErr.value = ''
  showForm.value = true
}
function openEdit(a: AccountView) {
  editName.value = a.name
  formName.value = a.name
  formPass.value = ''
  formContainers.value = [...a.containers]
  formErr.value = ''
  showForm.value = true
}
function toggleContainer(id: string) {
  const i = formContainers.value.indexOf(id)
  if (i >= 0) formContainers.value.splice(i, 1)
  else formContainers.value.push(id)
}
async function save() {
  saving.value = true
  formErr.value = ''
  try {
    if (editName.value) {
      const patch: { password?: string; containers?: string[] } = {}
      if (formPass.value) patch.password = formPass.value
      patch.containers = [...formContainers.value]
      await updateAccount(editName.value, patch)
      toast.success(`账户 ${editName.value} 已更新`)
    } else {
      await createAccount(formName.value.trim(), formPass.value, [...formContainers.value])
      toast.success(`账户 ${formName.value.trim()} 已创建`)
    }
    showForm.value = false
    await refresh()
  } catch (e) {
    formErr.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

// —— 删除 ——
const delTarget = ref<AccountView | null>(null)
async function doDelete() {
  const t = delTarget.value
  if (!t) return
  try {
    await deleteAccount(t.name)
    toast.success(`账户 ${t.name} 已删除`)
    delTarget.value = null
    await refresh()
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-lg max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0">
      <DialogHeader>
        <DialogTitle>账户管理</DialogTitle>
        <DialogDescription>
          账户仅能访问授权容器（终端 + 文件面板），主 token 不受影响。
        </DialogDescription>
      </DialogHeader>

      <div class="flex max-h-[60vh] min-h-0 flex-col gap-1 overflow-y-auto scroll-thin">
        <div
          v-for="a in accounts"
          :key="a.name"
          class="flex items-center gap-2 rounded-lg border px-2.5 py-2"
        >
          <KeyRound class="size-3.5 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ a.name }}</p>
            <p class="truncate text-[11px] text-muted-foreground">
              {{ a.containers.length ? a.containers.join('、') : '未授权任何容器' }}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-xs" title="操作">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem @click="openEdit(a)">
                <Pencil /> 编辑
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" @click="delTarget = a">
                <Trash2 /> 删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <p v-if="!accounts.length && !loading" class="py-6 text-center text-xs text-muted-foreground">
          还没有账户。
        </p>
      </div>

      <div class="flex justify-end">
        <Button size="sm" @click="openCreate">
          <Plus /> 新建账户
        </Button>
      </div>
    </DialogContent>
  </Dialog>

  <!-- 新建/编辑表单 -->
  <Dialog :open="showForm" @update:open="(v: boolean) => v || (showForm = false)">
    <DialogContent class="max-w-md max-md:h-dvh max-md:max-w-full max-md:rounded-none max-md:border-0">
      <DialogHeader>
        <DialogTitle>{{ editName ? `编辑账户 ${editName}` : '新建账户' }}</DialogTitle>
        <DialogDescription>
          密码至少 6 位；勾选授权容器。
        </DialogDescription>
      </DialogHeader>
      <div class="flex flex-col gap-3">
        <div class="flex flex-col gap-1.5">
          <Label for="acct-name">账户名</Label>
          <Input
            id="acct-name"
            v-model="formName"
            :disabled="!!editName"
            placeholder="小写字母开头，如 alice"
            autocomplete="off"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="acct-pass">{{ editName ? '新密码（留空不改）' : '密码' }}</Label>
          <Input
            id="acct-pass"
            v-model="formPass"
            type="password"
            :placeholder="editName ? '留空保持原密码' : '至少 6 位'"
            autocomplete="new-password"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label>授权容器</Label>
          <div class="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md border p-1.5 scroll-thin">
            <button
              v-for="c in containerChoices"
              :key="c.id"
              type="button"
              class="flex items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50"
              @click="toggleContainer(c.id)"
            >
              <span
                class="flex size-3.5 shrink-0 items-center justify-center rounded border"
                :class="formContainers.includes(c.id) ? 'border-primary bg-primary text-primary-foreground' : ''"
              >
                <span v-if="formContainers.includes(c.id)" class="text-[9px] leading-none">✓</span>
              </span>
              {{ c.label }}
            </button>
            <p v-if="!containerChoices.length" class="px-2 py-3 text-xs text-muted-foreground">
              没有受管理的容器可授权
            </p>
          </div>
        </div>
        <p v-if="formErr" role="alert" class="text-sm text-destructive">{{ formErr }}</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="sm" @click="showForm = false">取消</Button>
          <Button
            size="sm"
            :disabled="saving || !formName.trim() || (!editName && formPass.length < 6)"
            @click="save"
          >
            {{ saving ? '保存中…' : '保存' }}
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <!-- 删除确认：输账户名（删除即收回分享凭证，同删容器的确认强度） -->
  <ConfirmDialog
    v-if="delTarget"
    title="删除账户"
    :description="`将删除账户 ${delTarget.name} 并立即收回其访问凭证。该账户的终端会话不受影响。`"
    confirm-text="删除"
    variant="destructive"
    :input="{ label: `输入账户名 ${delTarget.name} 确认`, placeholder: delTarget.name, confirmCue: delTarget.name }"
    @confirm="doDelete"
    @close="delTarget = null"
  />
</template>
