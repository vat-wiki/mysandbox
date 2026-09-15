<script setup lang="ts">
// InfoHint —— 统一的「? 信息图标」入口：短说明悬浮（Tooltip），长说明点开（Popover）。
//   <InfoHint tip="≤30 字短句" />        → hover 形态（桌面 Tooltip）
//   <InfoHint>多段长说明…</InfoHint>      → click 形态（>30 字 / 多段 / 含路径命令）
// 使用规范：
//   - 必须常驻、不许收进 InfoHint 的：状态性警示（未保存修改、运行警告）、校验错误、
//     DialogDescription 至少一句、确认框关键后果句（「数据不可恢复」类只精简措辞）。
//   - 原生 title：菜单项/图标按钮上的保留但 ≤25 字；卡片徽标长 title 换 InfoHint。
// 触屏：reka Tooltip 对 touch 手势不开（pointermove 对 touch 直接 return）——
// 无 hover 设备上 hover 形态降级为点按 Popover，同一份 tip；不降级 = 触屏看不到。
import { computed, useSlots } from "vue"
import { Info } from "lucide-vue-next"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { isCoarse } from "@/composables/useDevice"

const props = withDefaults(
  defineProps<{
    /** 短文案（hover 形态）；传 default slot 时忽略 */
    tip?: string
    side?: "top" | "bottom" | "left" | "right"
    align?: "start" | "center" | "end"
    /** click 形态内容宽度 class */
    width?: string
    /** 图标的无障碍名（aria-label） */
    label?: string
  }>(),
  { side: "top", align: "center", width: "w-72", label: "说明" },
)

const slots = useSlots()
// 有内容 slot = 长说明 → 一律 click 形态（tooltip 藏长文案等于没有——SkillsHubTab 的教训）
const clickMode = computed(() => !!slots.default)

const triggerCls
  = "shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
</script>

<template>
  <!-- click 形态：长说明（可多段/多行/代码） -->
  <Popover v-if="clickMode">
    <PopoverTrigger as-child>
      <button type="button" :aria-label="props.label" :class="triggerCls">
        <Info class="size-3.5" />
      </button>
    </PopoverTrigger>
    <PopoverContent :side="props.side" :align="props.align" :class="props.width" class="p-3">
      <div class="space-y-1.5 text-xs leading-relaxed text-muted-foreground"><slot /></div>
    </PopoverContent>
  </Popover>

  <!-- hover 形态：桌面悬浮 Tooltip；触屏降级为点按 Popover -->
  <Popover v-else-if="isCoarse">
    <PopoverTrigger as-child>
      <button type="button" :aria-label="props.label" :class="triggerCls">
        <Info class="size-3.5" />
      </button>
    </PopoverTrigger>
    <PopoverContent :side="props.side" :align="props.align" class="w-fit max-w-64 p-2.5">
      <p class="text-xs leading-relaxed text-muted-foreground">{{ props.tip }}</p>
    </PopoverContent>
  </Popover>
  <Tooltip v-else>
    <TooltipTrigger as-child>
      <button type="button" :aria-label="props.label" :class="triggerCls">
        <Info class="size-3.5" />
      </button>
    </TooltipTrigger>
    <TooltipContent :side="props.side" class="whitespace-pre-line">{{ props.tip }}</TooltipContent>
  </Tooltip>
</template>
