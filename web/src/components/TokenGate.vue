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

// 两种登录形态：owner（粘贴主 token，默认）与受限账户（用户名+密码，分享场景）。
// 账户入口折叠成一行链接——owner 是绝对主角，账户登录只服务被分享的人，不抢视线。
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
          <p class="mt-3 text-center">
            <button
              type="button"
              class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              @click="mode = 'account'"
            >
              受限账户登录
            </button>
          </p>
        </CardContent>
      </template>
      <template v-else>
        <CardHeader>
          <CardTitle>受限账户登录</CardTitle>
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
          <p class="mt-3 text-center">
            <button
              type="button"
              class="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              @click="mode = 'token'"
            >
              使用访问令牌
            </button>
          </p>
        </CardContent>
      </template>
    </Card>
    <p class="mt-4 text-center text-xs text-muted-foreground">
      仅监听 127.0.0.1 · 持有 token = 宿主 root 等价
    </p>
  </div>
</template>
