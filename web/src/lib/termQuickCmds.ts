// 终端快捷指令（手机触屏工具条「指令」面板的数据层）：label + cmd 二元组列表，
// 点条目 = 向 PTY 发送整条命令并回车（发送语义在 Terminal.vue 的 sendSnippet，含 cwd 跟随）。
// 与工具条按钮同取舍：查看偏好只进 localStorage，不进 sidecar；模块级单例，
// 多个终端实例（多组/分屏）共享同一份，改动即时互见。
import { ref } from 'vue'

export interface QuickCmd {
  label: string // 显示名（短，如「web 部署」）
  cmd: string // 实际发送的命令（发送时补 \r）
}

const QUICK_CMDS_KEY = 'mysandbox:term-quick-cmds'

function loadQuickCmds(): QuickCmd[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(QUICK_CMDS_KEY) ?? 'null')
    if (Array.isArray(raw)) {
      const out: QuickCmd[] = []
      const seen = new Set<string>()
      for (const c of raw) {
        if (c && typeof c.label === 'string' && typeof c.cmd === 'string' && c.cmd.trim() && !seen.has(c.label)) {
          out.push({ label: c.label.trim(), cmd: c.cmd })
          seen.add(c.label)
        }
      }
      return out
    }
  } catch {
    /* 坏数据落空列表 */
  }
  return []
}

export const quickCmds = ref<QuickCmd[]>(loadQuickCmds())

function save() {
  try {
    localStorage.setItem(QUICK_CMDS_KEY, JSON.stringify(quickCmds.value))
  } catch {
    /* 不可用就只本次生效 */
  }
}

export function addQuickCmd(label: string, cmd: string) {
  const l = label.trim()
  if (!l || !cmd.trim()) return
  if (quickCmds.value.some((c) => c.label === l)) return
  quickCmds.value.push({ label: l, cmd })
  save()
}

export function updateQuickCmd(i: number, label: string, cmd: string) {
  const c = quickCmds.value[i]
  if (!c || !label.trim() || !cmd.trim()) return
  c.label = label.trim()
  c.cmd = cmd
  save()
}

export function rmQuickCmd(i: number) {
  quickCmds.value.splice(i, 1)
  save()
}
