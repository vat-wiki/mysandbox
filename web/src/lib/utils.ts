import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 容器状态点/标签：侧栏列表与批量配置左栏共用，改色只改这一处。
export function stateColor(state: string): string {
  if (state === 'running') return 'bg-emerald-500'
  if (state === 'exited' || state === 'dead') return 'bg-zinc-500'
  if (state === 'paused') return 'bg-amber-500'
  return 'bg-blue-500'
}

// 状态徽章中文映射：界面全中文，唯独 state 是英文小写原样透出，观感割裂。
export function stateLabel(state: string): string {
  const m: Record<string, string> = {
    running: '运行中',
    exited: '已停止',
    dead: '已失效',
    paused: '已暂停',
    created: '已创建',
    restarting: '重启中',
  }
  return m[state] ?? state
}

// 容器稳定色：hash(容器id) -> hsl hue。同容器永远同色，黑底上鲜明。
// 用于终端 tab 色条 + 容器列表表格行色条，两边一致关联、一眼分组。
export function containerColor(id: string): string {
  return containerColorA(id, 1)
}

// 容器色带透明度变体（侧栏窄边 rail 的图标底色等淡染场景）：与 containerColor 同一
// hash、只补 alpha（legacy hsl 逗号语法 + 第四参，浏览器全支持）。
export function containerColorA(id: string, alpha: number): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 65%, 58%, ${alpha})`
}
