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
const emit = defineEmits<{ (e: 'submit', token: string): void }>()

const input = ref('')
function submit() {
  // 校验失败不清空输入：token 多为粘贴的一次性长串，清掉重来太惩罚性。
  if (input.value.trim()) emit('submit', input.value.trim())
}
</script>

<template>
  <div class="mx-auto mt-20 max-w-md">
    <div class="mb-7 flex flex-col items-center">
      <img src="/logo.svg" alt="mysandbox" class="h-24 w-24" />
    </div>
    <Card>
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
    </Card>
    <p class="mt-4 text-center text-xs text-muted-foreground">
      仅监听 127.0.0.1 · 持有 token = 宿主 root 等价
    </p>
  </div>
</template>
