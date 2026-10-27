<script setup lang="ts">
// Claude 终端对话框：AI 工具页签的「一键更新」不再走后端批量 npm，而是打开宿主终端、
// 自动运行 claude，把更新/诊断/修复这类容易出事的批量操作交给会逐步验证的 agent。
// 终端用独立 termId（每次打开 = 新 tmux 会话），关闭时 kill 掉，不在宿主留下孤儿会话。
import { ref, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { TerminalSquare } from 'lucide-vue-next'
import { newId } from '@/lib/id'

const emit = defineEmits<{ (e: 'close'): void }>()

const Terminal = defineAsyncComponent(() => import('@/components/Terminal.vue'))

// termId 在对话框挂载时固定：重复渲染/尺寸变化不会换会话。
const termId = newId()
const termRef = ref<{ kill: () => void; sendInput: (s: string) => void } | null>(null)
const ready = ref(false)
const booted = ref(false)
const prompt = ref('')
const selected = ref('')
let bootTimer = 0
let closed = false

// 首帧输出后才发 claude：仅凭 WS open 会抢在 tmux attach 前，输入可能丢。
function onReady() {
  if (ready.value) return
  ready.value = true
  window.setTimeout(() => {
    if (closed) return
    termRef.value?.sendInput('claude\r')
    // 给 Claude TUI 启动留时间：提示词要发进它的输入框，而不是还在启动的 shell。
    bootTimer = window.setTimeout(() => {
      booted.value = true
    }, 1600)
  }, 250)
}

const quickPrompts = [
  {
    key: 'update',
    label: '一键更新',
    text: `请帮我更新本机和所有运行中的受管系统容器里的 AI CLI（claude、codex、opencode、pi、openclaw）。

工作方式：
1. 先跑 mysandbox status 看清本机/容器/模板目标；只操作本机和运行中的受管系统容器，模板不动。
2. 用 mysandbox exec c:<容器名> -- <命令> 在容器里执行，本机命令直接跑。容器里没有 mysandbox 命令就说明种子没到位，先告诉我，不要改用 docker/lxc 绕过。
3. 逐个目标、逐个工具更新：每个 npm install -g <包>@latest 等它完全结束再做下一个；禁止把多个工具塞进一条 npm install 并发批量装，也不要中途重启 mysandbox 服务。
4. 更新前检查 node -v 是否满足该包 engines；不满足就跳过并记原因，不要硬装。
5. 每个工具更新后检查 command -v 和 <命令> --version。若命令消失，检查 npm root -g 下是否残留 .<工具名>-* 隐藏链接/目录，先恢复链接或单独重装该工具。
6. openclaw 不要加 --ignore-scripts；出现 lifecycle pending 时按它的提示补跑 postinstall。
7. 完成后列出三张清单：成功（工具/目标/版本）、跳过（原因）、失败（错误摘要与下一步）。`,
  },
  {
    key: 'versions',
    label: '查版本',
    text: `检查本机和所有运行中的受管系统容器的 AI CLI 版本与命令是否齐全：claude、codex、opencode、pi、openclaw。
先 mysandbox status 列目标，本机直接跑，容器用 mysandbox exec c:<容器名> -- <命令>。
每个目标输出 node -v、command -v <命令>、<命令> --version；缺失或版本异常的单独标出来，最后给一张对照表。`,
  },
  {
    key: 'diagnose',
    label: '诊断丢失',
    text: `诊断「AI CLI 更新后命令消失」的问题。
先找出受影响的本机和容器目标，逐个检查：
1. command -v claude / codex / opencode / pi / openclaw 与 npm ls -g --depth=0 是否一致；
2. npm root -g 下有没有 .<工具名>-* 形式的隐藏链接或目录（npm 中途失败会留下这种回滚残骸）；
3. 对应时间段的 npm 日志（/tmp/.npm/_logs 或 ~/.npm/_logs）里有没有 exit 1、ENOTEMPTY、EACCES；
4. openclaw 额外查 .openclaw-lifecycle-pending 与 engines 要求的 Node 版本。
先只读排查，不要批量重装；给出根因、影响范围和建议的修复顺序。`,
  },
  {
    key: 'repair',
    label: '修复命令',
    text: `修复丢失的 AI CLI 命令（claude、codex、opencode、pi、openclaw）。
先确认 affected 目标：本机与运行中的受管系统容器。对每个缺失命令：
1. 先跑只读检查（command -v、npm ls -g、npm root -g 下的隐藏 .<名>-* 残骸）；
2. 能直接恢复 bin 链接的优先恢复，否则单独 npm install -g <包>@latest 重装这一个工具；
3. 一次只修一个目标的一个工具，装完立刻验证 command -v 和 --version，再继续；
4. 涉及 root 所有文件的（如 openclaw lifecycle pending），先告诉我需要的提权/进容器方式，不要硬改权限。
最后给我逐项修复结果，失败的保留原始错误。`,
  },
]

function pickPrompt(p: (typeof quickPrompts)[number]) {
  selected.value = p.key
  prompt.value = p.text
}

function sendPrompt() {
  const text = prompt.value.trim()
  if (!text || !booted.value) return
  // 括号粘贴：多行提示词整段粘进 Claude 输入框，不会在每个换行处提前提交；再补回车提交。
  termRef.value?.sendInput(`\x1b[200~${text}\x1b[201~\r`)
}

function close() {
  closed = true
  window.clearTimeout(bootTimer)
  // 父组件 v-if 卸载前先杀 tmux 会话；这里与 onBeforeUnmount 双保险（kill 幂等）。
  termRef.value?.kill()
  emit('close')
}

onBeforeUnmount(() => {
  closed = true
  window.clearTimeout(bootTimer)
  termRef.value?.kill()
})
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || close()">
    <DialogContent
      class="flex h-[82dvh] max-w-5xl flex-col gap-0 overflow-hidden p-0 max-md:h-dvh max-md:max-h-none max-md:max-w-full max-md:gap-0 max-md:rounded-none max-md:border-0 max-md:py-0"
    >
      <DialogHeader class="shrink-0 border-b px-4 py-3 pr-12">
        <DialogTitle class="flex items-center gap-2 text-sm">
          <TerminalSquare class="size-4" /> Claude 终端
        </DialogTitle>
        <DialogDescription class="text-xs">
          已在宿主终端启动 <code class="rounded bg-muted px-1 py-0.5">claude</code>；选一个快捷提示词，或直接在终端里对话。
        </DialogDescription>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
        <Terminal
          ref="termRef"
          name="claude"
          :term-id="termId"
          :host="true"
          :active="true"
          @ready="onReady"
        />
        <div v-if="!booted" class="shrink-0 border-t border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-500">
          {{ ready ? '正在启动 Claude，稍候即可发送提示词…' : '正在连接宿主终端…' }}
        </div>
      </div>

      <div class="shrink-0 border-t bg-background px-3 py-2 pb-safe">
        <div class="scroll-thin flex gap-1.5 overflow-x-auto pb-1.5">
          <button
            v-for="p in quickPrompts"
            :key="p.key"
            type="button"
            class="shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors"
            :class="
              selected === p.key
                ? 'border-primary bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            "
            :disabled="!booted"
            :title="booted ? '填入下方输入框，可修改后发送' : '等待 Claude 启动'"
            @click="pickPrompt(p)"
          >
            {{ p.label }}
          </button>
        </div>
        <div class="flex items-end gap-2">
          <textarea
            v-model="prompt"
            rows="2"
            class="scroll-thin max-h-40 min-h-[3.25rem] flex-1 resize-y rounded-md border bg-background px-2.5 py-2 text-xs leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
            :disabled="!booted"
            placeholder="选一个快捷提示词，或在这里输入要给 Claude 的话…（Ctrl+Enter 发送）"
            @keydown.ctrl.enter.prevent="sendPrompt"
            @keydown.meta.enter.prevent="sendPrompt"
          />
          <Button size="sm" class="shrink-0" :disabled="!booted || !prompt.trim()" @click="sendPrompt">
            发送
          </Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
