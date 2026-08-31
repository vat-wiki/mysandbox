<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { createContainer, getBaseHosts, Unauthorized } from '@/lib/api'
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

const emit = defineEmits<{ (e: 'created'): void; (e: 'close'): void }>()

const name = ref('')
const description = ref('')
// git 身份不放这里：批量配置一次能管所有容器，逐个新建时填是重复劳动。
// 新建对话框回归容器本身的参数：名字/描述/IP。
const ipMode = ref<'auto' | 'manual' | string>('auto')
const manualIp = ref('')
const busy = ref(false)
const err = ref('')

// hosts 来源：模板 rootfs（克隆原样继承，缺省）/ 宿主 /etc/hosts（整体覆写）。
// 预览为只读展示（<details> 默认收起）——想改默认去改模板容器，这里不做编辑入口。
const hostsSource = ref<'template' | 'host'>('template')
const hostsPreview = ref<{ template: string | null; host: string | null } | null>(null)
const hostsShown = computed(() =>
  hostsSource.value === 'host' ? hostsPreview.value?.host : hostsPreview.value?.template,
)

onMounted(() => {
  getBaseHosts()
    .then((v) => {
      hostsPreview.value = v
    })
    .catch((e) => {
      if (e instanceof Unauthorized) emit('close')
      /* 预读失败不阻塞创建流程，预览显示读不到 */
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
      hosts: hostsSource.value,
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

        <div class="space-y-1.5">
          <Label>hosts 来源</Label>
          <RadioGroup v-model="hostsSource" class="flex items-center gap-4">
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="hosts-template" value="template" />
              <Label for="hosts-template" class="font-normal">模板容器</Label>
            </div>
            <div class="flex items-center gap-1.5">
              <RadioGroupItem id="hosts-host" value="host" />
              <Label for="hosts-host" class="font-normal">宿主机</Label>
            </div>
          </RadioGroup>
          <details class="group rounded-md border bg-muted/30">
            <summary
              class="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <span
                class="transition-transform group-open:rotate-90"
                aria-hidden="true"
                >▸</span
              >
              预览所选源的内容
            </summary>
            <div class="border-t px-3 py-2">
              <pre
                v-if="hostsShown"
                class="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-muted-foreground"
                >{{ hostsShown }}</pre
              >
              <p v-else class="text-[11px] text-muted-foreground">
                读取失败或来源不存在（模板未就绪 / 宿主 /etc/hosts 不可读）。
              </p>
            </div>
          </details>
          <p class="text-xs leading-relaxed text-muted-foreground">
            模板源 = 克隆模板容器的 /etc/hosts；想改默认直接改模板容器。
          </p>
        </div>

        <p class="text-xs leading-relaxed text-muted-foreground">
          容器为固定 IP 直连，宿主与其他容器可直接访问其任意端口，无需端口映射。
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
