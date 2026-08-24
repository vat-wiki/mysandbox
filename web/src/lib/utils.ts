import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 容器稳定色：hash(容器id) -> hsl hue。同容器永远同色，黑底上鲜明。
// 用于终端 tab 色条 + 容器列表表格行色条，两边一致关联、一眼分组。
export function containerColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 65%, 58%)`
}
