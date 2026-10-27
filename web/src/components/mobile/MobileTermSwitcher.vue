<script setup lang="ts">
// 手机终端切换条（非模态）：底栏「终端」激活态再点是开关——不铺遮罩、不抢焦点、不盖终端，
// 点条外任意处即收。行 = 组（身份色点 + busy 呼吸标 + 无输出琥珀标 + ·N 屏），
// 右侧固定全局动作：⋯（当前组动作表）/ 所有终端（会话列表）/ 环境列表（容器抽屉）/ 网络信息。
// 桌面不渲染（底栏本身 md:hidden）；popout 无底栏，也不经这里。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FolderTree, Layers, MoreHorizontal, Network } from '@lucide/vue'

export interface TermSwitcherRow {
  id: string
  label: string
  sub?: string
  color: string
  busy: boolean
  attention: boolean
  active: boolean
}

const props = defineProps<{
  open: boolean
  rows: TermSwitcherRow[]
  // 软键盘开着：底栏整条滑出，切换条跟随让位（键盘态下空间归终端）
  keyboardOpen?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  select: [id: string]
  actions: [id: string]
  sessions: []
  environments: []
  network: []
}>()

const barEl = ref<HTMLElement | null>(null)
const activeRow = computed(() => props.rows.find((r) => r.active) ?? null)

function close() {
  emit('update:open', false)
}

// 点条外即收：非模态浮层没有遮罩兜底，点击外部自己管。
// 底栏（data-mobile-bottom-nav）除外——「终端」按钮自己开关，否则 pointerdown 先关、click 又开，
// 条就永远关不掉。
function onPointerDown(e: PointerEvent) {
  if (!props.open) return
  const t = e.target as HTMLElement | null
  if (!t || barEl.value?.contains(t) || t.closest('[data-mobile-bottom-nav]')) return
  close()
}
function onKeydown(e: KeyboardEvent) {
  if (props.open && e.key === 'Escape') close()
}
onMounted(() => {
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKeydown)
})

// 展开时把当前组滚进视野：组多了横滑条默认停在最左，看不到自己在哪。
// 手算 scrollLeft 而不是 scrollIntoView——后者会连带滚动祖先/页面，浮层上表现不可控。
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    await nextTick()
    const el = barEl.value?.querySelector<HTMLElement>('[data-chip-active]')
    const box = el?.parentElement
    if (el && box) box.scrollLeft = el.offsetLeft - (box.clientWidth - el.clientWidth) / 2
  },
)
</script>

<template>
  <Transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="translate-y-2 opacity-0"
    enter-to-class="translate-y-0 opacity-100"
    leave-active-class="transition duration-100 ease-in"
    leave-from-class="translate-y-0 opacity-100"
    leave-to-class="translate-y-2 opacity-0"
  >
    <div
      v-if="open && !keyboardOpen"
      ref="barEl"
      role="toolbar"
      aria-label="终端切换"
      class="absolute inset-x-0 bottom-full z-10 border-t border-border/60 bg-background/95 shadow-[0_-6px_20px_-12px_rgba(0,0,0,0.5)] backdrop-blur md:hidden"
    >
      <div class="flex items-center gap-1 py-1.5 pr-1.5 pl-2">
        <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scroll-thin">
          <p v-if="!rows.length" class="px-2 py-1 text-xs text-muted-foreground">
            还没有终端——点右侧「环境列表」选容器打开
          </p>
          <button
            v-for="row in rows"
            :key="row.id"
            type="button"
            :data-chip-active="row.active ? '' : undefined"
            class="flex h-9 max-w-[13rem] shrink-0 items-center gap-2 rounded-lg border px-2.5 transition-colors"
            :class="
              row.active
                ? 'border-primary/50 bg-accent text-foreground'
                : 'border-border/60 text-muted-foreground active:bg-accent/60'
            "
            :aria-current="row.active ? 'true' : undefined"
            @click="emit('select', row.id)"
          >
            <span class="relative flex size-2 shrink-0">
              <span
                v-if="row.busy"
                class="term-busy-halo absolute -inset-1 rounded-full"
                :style="{ backgroundColor: row.color, '--dot': row.color }"
              />
              <span
                class="relative inline-flex size-2 rounded-full"
                :class="row.busy && 'term-busy-dot'"
                :style="{ backgroundColor: row.color }"
              />
            </span>
            <span class="truncate text-xs" :class="row.active && 'font-medium text-foreground'">{{ row.label }}</span>
            <span v-if="row.sub" class="shrink-0 text-[10px] tabular-nums text-muted-foreground">{{ row.sub }}</span>
            <!-- 无输出提醒标（tmux bell 形态，切回即消） -->
            <span v-if="row.attention" class="size-1.5 shrink-0 rounded-full bg-amber-400" title="有输出等待查看" />
          </button>
        </div>
        <!-- 全局动作固定在右侧不参与横滑：⋯ 只对当前组，其余三条是「跳转」而非组动作 -->
        <div class="flex shrink-0 items-center gap-0.5 border-l border-border/60 pl-1">
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-accent disabled:pointer-events-none disabled:opacity-40"
            :disabled="!activeRow"
            title="组动作（新开一组 / 独立窗口 / 提醒 / 隐藏 / 关闭）"
            aria-label="当前组动作"
            @click="activeRow && emit('actions', activeRow.id)"
          >
            <MoreHorizontal class="size-4.5" />
          </button>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-accent"
            title="所有终端（含其他窗口）"
            aria-label="所有终端（含其他窗口）"
            @click="emit('sessions')"
          >
            <Layers class="size-4" />
          </button>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-accent"
            title="环境列表（容器 / SSH）"
            aria-label="环境列表（容器 / SSH）"
            @click="emit('environments')"
          >
            <FolderTree class="size-4" />
          </button>
          <button
            type="button"
            class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-accent"
            title="网络信息（当前组容器）"
            aria-label="网络信息（当前组容器）"
            @click="emit('network')"
          >
            <Network class="size-4" />
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>
