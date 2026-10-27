<script setup lang="ts">
// 快捷指令面板（手机终端工具条「指令」键弹出）：**只负责运行**——
// 点条目 = 发送整条命令并回车（run 事件交回 Terminal.vue，含 cwd 跟随）并收起面板。
// 配置（增删改 / 调序）与工具条按键配置同级，统一收在全屏「终端工具条」页的
// 指令分区；面板右上「配置」直接跳过去（emit config），不再有「管理」态——
// 同一个列表在运行态和配置态语义相反（点 = 执行 vs 点 = 编辑）的问题随之消失。
// 数据在 lib/termToolbar.ts（localStorage 模块级单例——多终端实例共享一份）。
// 运行行的 pointerdown.prevent 防抢终端焦点（软键盘收起闪一下 + composition 被吞）。
// 形态 = 带遮罩的底部 sheet（壳 = BottomPanel），与移动端 action sheet 一致；层级压过工具条本体。
import { computed, ref } from 'vue'
import { ChevronRight, Search, Settings2, X } from '@lucide/vue'
import { quickCmds, recentCmds, type QuickCmd } from '@/lib/termToolbar'
import BottomPanel from '@/components/mobile/BottomPanel.vue'

defineProps<{ open: boolean }>()
const emit = defineEmits<{
  'update:open': [value: boolean]
  run: [cmd: string]
  config: []
}>()

// —— 搜索 + 最近 3 条置顶（完整列表不重复最近项）——
const query = ref('')
const q = computed(() => query.value.trim().toLowerCase())
function matches(c: QuickCmd) {
  return !q.value || c.label.toLowerCase().includes(q.value) || c.cmd.toLowerCase().includes(q.value)
}
const groups = computed<{ label: string; items: QuickCmd[] }[]>(() => {
  const filtered = quickCmds.value.filter(matches)
  if (q.value) return [{ label: '', items: filtered }]
  const rec = recentCmds.value.slice(0, 3)
  const recIds = new Set(rec.map((c) => c.id))
  const rest = filtered.filter((c) => !recIds.has(c.id))
  return [
    ...(rec.length ? [{ label: '最近', items: rec }] : []),
    ...(rest.length ? [{ label: rec.length ? '其他' : '', items: rest }] : []),
  ]
})
const noResults = computed(() => !!q.value && !groups.value.some((g) => g.items.length))

function close() {
  emit('update:open', false)
}

function runCmd(cmd: string) {
  emit('run', cmd)
  close()
}

// 「配置」= 关面板 + 开工具条设置（同一拍）。面板本身不持焦点，但终端 textarea
// 可能还挂着焦点（软键盘会顶到刚打开的设置页上）——先显式 blur 再跳。
function openConfig() {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  emit('config')
}
</script>

<template>
  <BottomPanel :open="open" label="快捷指令" layer="terminal" @update:open="emit('update:open', $event)">
    <div class="flex items-center justify-between gap-3 px-4 pt-3 pb-1">
      <p class="text-base font-semibold">快捷指令</p>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-sm text-muted-foreground transition-colors active:bg-accent"
          @click="openConfig"
        >
          <Settings2 class="size-3.5" />
          配置
        </button>
        <button
          type="button"
          class="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
          @click="close"
        >
          <X class="size-4" />
          <span class="sr-only">关闭</span>
        </button>
      </div>
    </div>
    <!-- 搜索：指令多时直接筛；无指令时不占位 -->
    <div v-if="quickCmds.length" class="px-3 pb-2">
      <div class="flex h-9 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2">
        <Search class="size-3.5 shrink-0 text-muted-foreground" />
        <input
          v-model="query"
          class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder="搜索指令…"
          spellcheck="false"
          enterkeyhint="search"
        />
        <button
          v-if="query"
          type="button"
          class="flex size-6 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
          @click="query = ''"
        >
          <X class="size-3.5" />
          <span class="sr-only">清除</span>
        </button>
      </div>
    </div>
    <div class="px-2 pb-1">
      <div v-if="!quickCmds.length" class="px-4 py-8 text-center">
        <p class="text-sm text-muted-foreground">还没有快捷指令</p>
        <p class="mt-1 text-xs text-muted-foreground">在「工具条设置 → 指令」里添加，如「部署」= cd ~/web && npm run build</p>
        <button
          type="button"
          class="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
          @click="openConfig"
        >去添加</button>
      </div>
      <p v-else-if="noResults" class="px-4 py-8 text-center text-sm text-muted-foreground">没有匹配的指令</p>
      <template v-for="g in groups" :key="g.label || 'all'">
        <div v-if="g.items.length">
          <p v-if="g.label" class="px-3 pt-2 pb-1 text-[11px] font-semibold text-muted-foreground">{{ g.label }}</p>
          <button
            v-for="c in g.items"
            :key="c.id"
            type="button"
            class="flex min-h-14 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors active:bg-accent"
            @pointerdown.prevent
            @click="runCmd(c.cmd)"
          >
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ c.label }}</span>
              <span class="mt-0.5 block truncate font-mono text-xs text-muted-foreground">{{ c.cmd }}</span>
            </span>
            <ChevronRight class="size-4 shrink-0 text-muted-foreground/60" />
          </button>
        </div>
      </template>
    </div>
    <!-- 显式取消：没有黑幕兜底后，别让用户只能靠「点空白」猜怎么退 -->
    <div class="mx-2 border-t border-border/60 pt-1 pb-0.5">
      <button
        type="button"
        class="flex min-h-12 w-full items-center justify-center rounded-xl text-sm text-muted-foreground active:bg-accent"
        @click="close"
      >
        取消
      </button>
    </div>
  </BottomPanel>
</template>
