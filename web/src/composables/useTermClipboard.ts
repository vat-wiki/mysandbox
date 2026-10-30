// 终端复制/粘贴（从 Terminal.vue 抽出，2026-10-26）：文本剪贴板、图片粘贴（上传落盘 +
// 粘路径）、容器剪贴板桥（原生 [Image #1] 体验）、以及 clipboard API 不可用时的兜底
// 输入框。所有发送统一走注入的 send（= 组件的 stdin 闸门），这里不碰 WS 细节。
import { nextTick, ref } from 'vue'
import { toast } from 'vue-sonner'
import type { Terminal as XTerm } from '@xterm/xterm'
import { getTermFg, pushTerminalClipboard, resolveTermPath, writeFileBase64 } from '@/lib/api'

export interface TermClipboardDeps {
  term: () => XTerm | null
  /** 连接是否可写（图片/文本粘贴都要求 attach 完成） */
  connected: () => boolean
  /** 发 stdin（唯一出口：组件的 sendRaw → sendStdin，含 pendingInput 闸门） */
  send: (s: string) => void
  /** 图片落盘目标 id（容器/宿主/服务/SSH 哨兵），空串 = 无法确定 */
  fileTargetId: () => string
  termId: () => string
  /** 当前后端（msmux 时前台命令走事件流而非 tmux 探测） */
  backend: () => 'tmux' | 'msmux'
  foreground: () => string
  /** 容器 id：只有容器终端有 xclip shim 种子（宿主/服务/SSH 不走桥） */
  bridgeContainerId: () => string | undefined
}

function legacyCopy(s: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = s
  // 移出可视区但保持可聚焦；readonly 防软键盘弹出，防止页面滚到底
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  ta.setAttribute('readonly', '')
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

function fileToBase64(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(f)
  })
}

// —— 剪贴板桥（100% 原生体验的那条路）——
// 浏览器剪贴板 → /api/terminal-clipboard 暂存 → 容器内 xclip/wl-paste shim（经 peer
// GET /clipboard 取）→ 前台 AI CLI 调它自己的原生剪贴板读取（xclip 链）→ [Image #1]
// 内联附加。只对容器终端成立：shim 靠宿主种子铺进 LXC 容器 home，宿主/服务/SSH 没有
// 种子机制（宿主终端里 CC 读的是宿主自己的剪贴板，本地访问时本来就和浏览器同源）。
const SHELL_COMMANDS = new Set(['zsh', 'bash', 'sh', 'dash', 'ash', 'fish', 'sudo', 'su'])

export function useTermClipboard(deps: TermClipboardDeps) {
  const pasteFallback = ref(false)
  const pasteText = ref('')
  const fallbackTa = ref<HTMLTextAreaElement | null>(null)

  async function copyText(s: string): Promise<boolean> {
    if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(s)
        return true
      } catch {
        /* 权限被拒等：落 execCommand 兜底 */
      }
    }
    // execCommand 要求同步在用户手势里调——本函数若被 await 了别的异步操作后才调到这里，
    // 手势可能已过期，但 Chrome/Edge 对 copy 的手势检查较松，值得一试。
    if (legacyCopy(s)) return true
    toast.error('复制失败：剪贴板不可用（非 https 访问时浏览器禁用剪贴板 API）')
    return false
  }

  function copySelection() {
    const term = deps.term()
    if (term?.hasSelection()) void copyText(term.getSelection()).then(() => term.clearSelection())
  }

  async function imageToPngB64(f: Blob): Promise<string> {
    // 浏览器剪贴板可能是 jpeg/webp；CC 的取图链只认 png/bmp——canvas 统一转 PNG。
    const bmp = await createImageBitmap(f)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('png encode failed'))), 'image/png'),
    )
    bmp.close()
    return fileToBase64(blob)
  }

  // 返回 true = 桥已送达（^V 已转发，别再路径粘贴）；false = 落路径粘贴。
  async function tryBridgePaste(first: File): Promise<boolean> {
    const containerId = deps.bridgeContainerId()
    if (!containerId || !deps.connected()) return false
    try {
      const b64 = await imageToPngB64(first)
      await pushTerminalClipboard({ image: { b64 } })
      if (deps.backend() === 'msmux') {
        // msmux 事件已给出权威前台命令；bridge 仍要问 shim 是否在位，但不再解析 tmux。
        const fgCommand = deps.foreground()
        if (!fgCommand || SHELL_COMMANDS.has(fgCommand)) return false
        const fg = await getTermFg(containerId, deps.termId(), 'msmux')
        // ^V 转发和 tmux 分支一样不能省：剪贴板已推到宿主暂存区，但 claude 只有收到
        // Ctrl+V 才会去调 xclip shim 取图——漏发就是「判据全过、静默无事发生」
        // （v0.9.0 迁移时 msmux 分支漏了这行，容器 mux 会话图片粘贴失效到 v0.15.11）。
        if (!fg.bridge) return false
        deps.send('\x16')
        return true
      }
      const fg = await getTermFg(containerId, deps.termId())
      // 前台是普通 shell：^V 会被解释成 quoted-insert 白吃一个键，粘贴落空 → 路径粘贴。
      // 老容器没补种（bridge=false）：^V 后 CLI 找不到 xclip，无事发生 → 路径粘贴。
      if (!fg.bridge || SHELL_COMMANDS.has(fg.command)) return false
      deps.send('\x16')
      return true
    } catch {
      // 桥链路任何一环失败（读图/编码/推送/fg 查询）：粘贴不因桥失败而丢。
      return false
    }
  }

  async function pasteImageFiles(files: File[]) {
    if (!deps.connected()) {
      toast.error('终端未连接，图片粘贴失败')
      return
    }
    const target = deps.fileTargetId()
    if (!target) {
      toast.error('无法确定粘贴目标，图片粘贴失败')
      return
    }
    try {
      // home 用 resolve('~') 权威解析（容器 /home/dev、宿主/服务/SSH 各自的 HOME），
      // 不硬编码——resolve 要求会话在，粘贴场景必然满足。
      const home = (await resolveTermPath(target, deps.termId(), '~')).path
      const extOf = (t: string) =>
        ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' })[t] ?? 'png'
      const paths: string[] = []
      for (const f of files) {
        const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${extOf(f.type)}`
        const path = `${home}/.claude-pastes/${name}`
        await writeFileBase64(target, path, await fileToBase64(f))
        paths.push(path)
      }
      deps.send(paths.join(' '))
      toast.success(paths.length === 1 ? `图片已粘贴：${paths[0]}` : `已粘贴 ${paths.length} 张图片到 ${home}/.claude-pastes/`)
    } catch (e) {
      toast.error(`图片粘贴失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function pasteClipboard() {
    if (!deps.connected()) return
    if (navigator.clipboard) {
      // 图片优先：secure context 下 Ctrl+V 在 keydown 被 preventDefault（见
      // attachCustomKeyEventHandler 注释），原生 paste 事件不再派发——这里唯一能拿到图片的
      // 通道是 clipboard.read()（Chromium/Safari 支持）。Firefox 无此 API 且 readText 对
      // 图片剪贴板返回空串 → 落兜底弹框（Firefox + https 的图片粘贴不支持，浏览器能力边界）。
      if (navigator.clipboard.read) {
        try {
          const files: File[] = []
          for (const item of await navigator.clipboard.read()) {
            const t = item.types.find((t) => t.startsWith('image/'))
            if (t) files.push(new File([await item.getType(t)], 'clipboard', { type: t }))
          }
          if (files.length) {
            // 桥优先（100% 原生体验）：推剪贴板 + 转发 ^V，前台 CLI（claude 等）自己调
            // xclip shim 走原生附加；没桥/前台是 shell → 落路径粘贴。
            if (await tryBridgePaste(files[0])) return
            await pasteImageFiles(files)
            return
          }
        } catch {
          /* read() 被拒（权限/失焦）：落文本路径 */
        }
      }
      try {
        const t = await navigator.clipboard.readText()
        if (t) deps.send(t) // 走和 onData 同一条 stdin 通道
        return
      } catch {
        /* Firefox 常态拒绝 readText：落兜底对话框 */
      }
    }
    pasteFallback.value = true // clipboard 不可用/被拒：弹兜底输入框（textarea 原生粘贴永远可用）
    nextTick(() => fallbackTa.value?.focus())
  }

  // 原生 paste 事件入口（非 https 的 Ctrl+V / 移动端长按）：clipboardData 免权限自带 files。
  // 必须 capture + 命中图片时 stopPropagation——xterm 的 paste handler 注册在 textarea 上且
  // 首行就 stopPropagation（handlePasteEvent），普通冒泡监听永远轮不到我们；反向地，我们不
  // 压掉它的话它会对空 text 再粘一遍（无害但不干净）。纯文本粘贴不拦，xterm 内置通道照走。
  function onTermPaste(e: ClipboardEvent) {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    void pasteImageFiles(files)
  }

  // 右键：有选区复制（并清选区）、无选区粘贴。.prevent 阻止浏览器原生右键菜单。
  function onContextMenu() {
    const term = deps.term()
    if (term?.hasSelection()) {
      void copyText(term.getSelection()).then(() => term.clearSelection())
    } else {
      void pasteClipboard()
    }
  }

  // —— 手机触屏工具条（重度终端使用的核心补充）——
  // 触屏没有右键/Ctrl 组合，复制粘贴/Esc/方向键/Ctrl+C 中断全走这条工具条（模板里 md:hidden）。
  // 粘贴优先走 navigator.clipboard.readText；iOS Safari 常态性拒绝读取（需用户手势且默认不授权），
  // 拒绝时自动弹兜底输入框——用户在 textarea 里系统级长按粘贴，确认后走同一条 stdin 通道发送。
  async function toolPaste() {
    if (navigator.clipboard) {
      try {
        const t = await navigator.clipboard.readText()
        if (t) deps.send(t)
        return
      } catch {
        /* readText 被拒：开兜底输入框 */
      }
    }
    pasteFallback.value = true // clipboard 不可用（非 https）/被拒：同 pasteClipboard 的兜底
    nextTick(() => fallbackTa.value?.focus())
  }
  function toolPasteConfirm() {
    if (pasteText.value) deps.send(pasteText.value)
    pasteText.value = ''
    pasteFallback.value = false
  }
  // 系统级粘贴（Ctrl+V / 长按）落进 textarea 时 paste 事件自带 clipboardData —— 直接自动发送，
  // 不再要求点「发送到终端」；个别环境 paste 事件不带数据时不拦默认行为，让文本进 textarea，
  // 由 input(insertFromPaste) 补一枪。两个都扑空才需要手动点按钮（按钮保留作兜底）。
  function fallbackSend(text: string) {
    if (!text) return
    deps.send(text)
    pasteText.value = ''
    pasteFallback.value = false
  }
  function onFallbackPaste(e: ClipboardEvent) {
    // 图片分支：兜底弹框只在剪贴板 API 不可用时出现，但 paste 事件的 files 依然可用
    // （Firefox + https 粘图片走这里——readText 对图片剪贴板是空串才落的弹框）。
    const imgs = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
    if (imgs.length) {
      e.preventDefault()
      fallbackSend('')
      void pasteImageFiles(imgs)
      return
    }
    const t = e.clipboardData?.getData('text')
    if (!t) return
    e.preventDefault()
    fallbackSend(t)
  }
  function onFallbackInput(e: InputEvent) {
    if (e.inputType === 'insertFromPaste' && pasteText.value) fallbackSend(pasteText.value)
  }

  return {
    pasteFallback,
    pasteText,
    fallbackTa,
    copyText,
    copySelection,
    pasteClipboard,
    onTermPaste,
    onContextMenu,
    toolPaste,
    toolPasteConfirm,
    fallbackSend,
    onFallbackPaste,
    onFallbackInput,
  }
}
