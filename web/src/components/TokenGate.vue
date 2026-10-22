<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import InfoHint from '@/components/InfoHint.vue'

defineProps<{ checking: boolean; err: string }>()
const emit = defineEmits<{
  (e: 'submit', token: string): void
  (e: 'account-login', name: string, password: string): void
}>()

// 两种登录形态平级：owner（主 token）与受限账户（用户名+密码，分享场景）。
// 卡片顶部分段切换而不是折叠链接——被分享的访客打开页面第一眼是 token 输入框，
// 会以为自己没权限（实测反馈「太不显眼」），两个入口都得看得见。
const mode = ref<'token' | 'account'>('token')
const input = ref('')
function submit() {
  // 校验失败不清空输入：token 多为粘贴的一次性长串，清掉重来太惩罚性。
  if (input.value.trim()) emit('submit', input.value.trim())
}
const acctName = ref('')
const acctPass = ref('')
function submitAccount() {
  if (acctName.value.trim() && acctPass.value) {
    emit('account-login', acctName.value.trim(), acctPass.value)
  }
}
</script>

<template>
  <div class="mx-auto mt-20 max-w-md">
    <div class="mb-7 flex flex-col items-center">
      <img src="/logo.svg" alt="mysandbox" class="h-24 w-24" />
    </div>
    <Card>
      <!-- 分段切换：两个入口平级可见（账户登录是访客的唯一路径，藏链接会迷路） -->
      <div class="mx-5 mt-5 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
        <button
          type="button"
          role="tab"
          class="rounded-md px-3 py-1.5 text-sm transition-colors"
          :class="mode === 'token' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          :aria-selected="mode === 'token'"
          @click="mode = 'token'"
        >
          访问令牌
        </button>
        <button
          type="button"
          role="tab"
          class="rounded-md px-3 py-1.5 text-sm transition-colors"
          :class="mode === 'account' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          :aria-selected="mode === 'account'"
          @click="mode = 'account'"
        >
          账户登录
        </button>
      </div>
      <template v-if="mode === 'token'">
        <CardHeader>
          <CardTitle class="flex items-center gap-1.5">
            访问令牌
            <InfoHint tip="也保存在 ~/.config/mysandbox/config.yaml" />
          </CardTitle>
          <CardDescription>
            首次启动 <code class="rounded bg-muted px-1">mysandbox</code> 时会在终端打印 token——粘贴到下面即可。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div class="flex gap-2">
            <Input
              v-model="input"
              type="password"
              placeholder="粘贴 token"
              autofocus
              class="flex-1"
              :class="err ? 'border-destructive focus-visible:ring-destructive' : ''"
              @keyup.enter="submit"
            />
            <Button :disabled="checking || !input.trim()" @click="submit">
              {{ checking ? '验证中…' : '进入' }}
            </Button>
          </div>
          <!-- role=alert：校验失败时读屏器立即播报，视觉 + 无障碍双通道 -->
          <p v-if="err" role="alert" class="mt-3 text-sm text-destructive">{{ err }}</p>
        </CardContent>
      </template>
      <template v-else>
        <CardHeader>
          <CardTitle>账户登录</CardTitle>
          <CardDescription>账户只能访问被授权的系统容器（终端 + 文件面板）。</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="flex flex-col gap-2">
            <Input
              v-model="acctName"
              placeholder="账户名"
              autofocus
              autocomplete="username"
              :class="err ? 'border-destructive focus-visible:ring-destructive' : ''"
              @keyup.enter="submitAccount"
            />
            <div class="flex gap-2">
              <Input
                v-model="acctPass"
                type="password"
                placeholder="密码"
                autocomplete="current-password"
                :class="err ? 'border-destructive focus-visible:ring-destructive' : ''"
                @keyup.enter="submitAccount"
              />
              <Button :disabled="checking || !acctName.trim() || !acctPass" @click="submitAccount">
                {{ checking ? '登录中…' : '登录' }}
              </Button>
            </div>
          </div>
          <p v-if="err" role="alert" class="mt-3 text-sm text-destructive">{{ err }}</p>
        </CardContent>
      </template>
    </Card>
    <p class="mt-4 text-center text-xs text-muted-foreground">
      仅监听 127.0.0.1 · 持有 token = 宿主 root 等价
    </p>
  </div>
</template>
