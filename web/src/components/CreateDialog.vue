<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { createContainer, getHosts, Unauthorized } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

const emit = defineEmits<{ (e: 'created'): void; (e: 'close'): void; (e: 'open-hosts'): void }>()

const name = ref('')
const description = ref('')
// git 身份不放这里：批量配置一次能管所有容器，逐个新建时填是重复劳动。
// 新建对话框回归容器本身的参数：名字/描述/IP。
const ipMode = ref<'auto' | 'manual' | string>('auto')
const manualIp = ref('')
const busy = ref(false)
const err = ref('')
// 全局 hosts 提示：新建容器创建时会自动应用，这里只告知会带什么、要改去哪改，
// 不做编辑入口（hosts 是全局共享资产，编辑归 HostsPanel，避免 per-container 误解）。
const hostsCount = ref<number | null>(null)

onMounted(() => {
  getHosts()
    .then((v) => {
      hostsCount.value = v.content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length
    })
    .catch((e) => {
      if (e instanceof Unauthorized) emit('close')
      /* 预读失败不阻塞创建流程，提示行不显示条数 */
    })
})

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/
const nameOk = computed(() => NAME_RE.test(name.value.trim()))

function onClose() {
  emit('close')
}

async function submit() {
  if (!nameOk.value) {
    err.value = '名称不合法（^[a-z0-9][a-z0-9-]{1,30}$）'
    return
  }
  busy.value = true
  err.value = ''
  try {
    await createContainer({
      name: name.value.trim(),
      description: description.value || undefined,
      ip: ipMode.value === 'manual' ? manualIp.value.trim() || undefined : undefined,
    })
    emit('created')
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>新建容器</DialogTitle>
        <DialogDescription>配置名称与 IP。</DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="c-name">名称 *</Label>
          <Input id="c-name" v-model="name" placeholder="web-2" />
          <p v-if="name && !nameOk" class="text-xs text-destructive">
            仅小写字母/数字/连字符，2-31 位
          </p>
        </div>

        <div class="space-y-1.5">
          <Label for="c-desc">描述</Label>
          <Input id="c-desc" v-model="description" placeholder="（可选）" />
        </div>

        <div class="space-y-1.5">
          <Label>IP</Label>
          <RadioGroup v-model="ipMode" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="ip-auto" value="auto" />
              <Label for="ip-auto" class="font-normal">自动分配</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="ip-manual" value="manual" />
              <Label for="ip-manual" class="font-normal">手动</Label>
            </div>
          </RadioGroup>
          <Input v-if="ipMode === 'manual'" v-model="manualIp" placeholder="10.88.10.30" />
        </div>

        <p class="text-xs leading-relaxed text-muted-foreground">
          容器为固定 IP 直连，宿主与其他容器可直接访问其任意端口，无需端口映射。
        </p>

        <!-- 全局 hosts 提示：自动生效、可跳转编辑，与批量配置/HostsPanel 的互跳模式一致 -->
        <p class="text-xs leading-relaxed text-muted-foreground">
          创建时自动应用全局 hosts{{ hostsCount != null ? `（${hostsCount} 条）` : '' }}。
          <Button
            variant="link"
            size="xs"
            class="h-auto p-0 align-baseline text-xs"
            @click="emit('open-hosts')"
            >去编辑</Button
          >
        </p>

        <p v-if="err" class="text-sm text-destructive">{{ err }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="onClose">取消</Button>
        <Button :disabled="busy || !nameOk" @click="submit">
          {{ busy ? '创建中…' : '创建并启动' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
