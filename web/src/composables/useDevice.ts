import { useMediaQuery } from '@vueuse/core'

// 设备形态单例（模块级共享同一 media query 实例，import 即用）：
// - isPhone：<768px 视为手机形态（与侧栏 md:w-64 的断点对齐，≥768 恒走桌面路径）。
//   纯样式差异用 max-md: 前缀表达，JS 分支用 isPhone，二者同界。
// - isCoarse：主指针为触摸。交互能力差异（hover 依赖的显隐）用它判断，
//   CSS 侧对应 pointer-coarse: 前缀——窄桌面窗口仍有鼠标 hover，别用 max-md 代替。
export const isPhone = useMediaQuery('(max-width: 767px)')
export const isCoarse = useMediaQuery('(pointer: coarse)')
