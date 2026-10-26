// 终端里的 OSC 集成与路径链接（从 Terminal.vue 抽出，2026-10-26）：窗口标题、容器内
// 深链、shell cwd、OSC 52 代写剪贴板，以及 Ctrl+点击打开路径的链接 provider + tooltip。
// 只读写 xterm 实例与事件出口，WS/连接生命周期不在这里。
import type { Terminal as XTerm } from '@xterm/xterm'
import { findPathTokens } from '@/lib/termPaths'

export interface TermLinkEvents {
  title(title: string): void
  cwd(path: string): void
  oscOpen(path: string): void
  linkOpen(path: string, line?: number, col?: number): void
}

export interface TermLinksDeps {
  term: () => XTerm | null
  events: TermLinkEvents
  /** OSC 52 代写剪贴板（组件注入 copyText，含权限失败提示） */
  copy: (text: string) => void
}

export function useTermLinks(deps: TermLinksDeps) {
  // 路径链接 tooltip：挂在 term.element 内的动态 DOM（带 xterm-hover class——xterm 的
  // mousemove 会沿 composedPath 找到它，视为「仍在链接上」不误触发 leave）。
  // pointer-events:none 让它永不抢鼠标事件。leave() 里必须移除：xterm 在行重绘/resize/
  // mouseleave/跨 cell 时都会清当前链接。样式在 Terminal.vue 的非 scoped <style>
  //（动态 DOM 带不上 Vue scoped 的 data 属性）。
  let linkTip: HTMLDivElement | null = null
  let linkProv: { dispose(): void } | null = null

  function showLinkTip(ev: MouseEvent, path: string) {
    const root = deps.term()?.element
    if (!root) return
    if (!linkTip) {
      linkTip = document.createElement('div')
      linkTip.className = 'ms-term-link-tip xterm-hover'
      root.appendChild(linkTip)
    }
    const short = path.length > 64 ? path.slice(0, 61) + '…' : path
    linkTip.textContent = `Ctrl+点击打开 ${short}`
    linkTip.style.left = `${ev.clientX + 10}px`
    linkTip.style.top = `${ev.clientY + 14}px`
  }

  function hideLinkTip() {
    linkTip?.remove()
    linkTip = null
  }

  /** 在 term 建好后调用一次：注册 OSC 处理器与路径链接 provider。 */
  function register() {
    const term = deps.term()
    if (!term) return
    // OSC 0/2（窗口标题）：shell 钩子（scripts/zshrc / 宿主 ~/.zshrc 的 preexec/precmd）
    // 与 TUI 应用（CC/opencode）发的标题，经 tmux set-titles on（session 级选项）转发到
    // 这里——ContainerList 拿去更新 tab 标签/popout 窗口标题。plain shell 降级（无 tmux）
    // 时序列直达，同样走这里，链路两种模式天然覆盖。
    term.onTitleChange((t) => deps.events.title(t.trim()))
    // 容器内 mysandbox 命令：捕获 OSC 7677（tmux 下走 DCS passthrough，到这里已还原为裸 OSC）。
    // payload 形如 "open;<path>"：action 取首个 ; 之前，路径取其后全部（路径可含 ;）。
    // 返回 true = 已消费，不落入默认处理。
    term.parser.registerOscHandler(7677, (data) => {
      const i = data.indexOf(';')
      if (i >= 0 && data.slice(0, i) === 'open') {
        const path = data.slice(i + 1)
        if (path.startsWith('/')) deps.events.oscOpen(path)
      }
      return true
    })
    // OSC 7（shell cwd 上报）：zsh precmd 钩子（scripts/zshrc）每次出提示符时发
    // `file://<路径>`（tmux 下 DCS passthrough 包裹，到这里已还原为裸 OSC）。业界标准
    // 的 shell 集成序列（iTerm2/VS Code/WezTerm 同款），cd 生效即上报——文件面板跟随
    // 的事件源，取代轮询。兼容他方 shell 集成（VS Code 端等）发的不带/带 host 的
    // file:// URI，且可能做了 percent 编码（我们 zshrc 发原样路径，解码失败就原样用）。
    term.parser.registerOscHandler(7, (data) => {
      const rest = data.startsWith('file://') ? data.slice(7) : data
      let p = rest.startsWith('/') ? rest : rest.slice(Math.max(rest.indexOf('/'), 0))
      if (!p.startsWith('/')) return true
      try {
        p = decodeURIComponent(p)
      } catch {
        /* 原样路径里本就有 %（未编码形态）：解码失败按原文用 */
      }
      deps.events.cwd(p)
      return true
    })
    // OSC 52（应用请终端代写剪贴板）：容器里没有 X 环境，xclip/wl-copy 全失败，唯一的
    // 复制通道就是它。xterm.js 核心不实现——不接的话应用提示「已复制」但剪贴板纹丝不动
    //（VSCode 终端实现了 OSC 52，所以同样的 opencode 在 VSCode 里能复制）。
    // payload：`<selection>;<base64|?>`；? = 查询剪贴板（只回空——我们只做写入侧，
    // 读回会话里粘贴已有 navigator.clipboard 通道，且查询有剪贴板内容外泄面）。
    // tmux 下它以 DCS passthrough 到达，xterm 解包后仍是 52 号 OSC，无需特判。
    term.parser.registerOscHandler(52, (data) => {
      const i = data.indexOf(';')
      if (i < 0) return true
      if (data.slice(i + 1) === '?') return true // 查询：不回应
      // base64 → UTF-8：atob 出的是 latin1 字节，中文等非 ASCII 必须经 Uint8Array 解码
      try {
        const b64 = data.slice(i + 1)
        const bin = atob(b64)
        const bytes = new Uint8Array(bin.length)
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k)
        const text = new TextDecoder().decode(bytes)
        if (text) deps.copy(text)
      } catch {
        /* 非法 base64：静默 */
      }
      return true
    })
    // 路径链接 provider（Ctrl+点击打开）。必须在 WebLinksAddon 之后注册：xterm 按注册
    // 顺序取第一个命中位置的链接，URL 撞位时归 web-links，别调换顺序。
    // 宽字符映射是核心：translateToString 的字符串索引 ≠ cell 列（CJK 占 2 cell，其后还有
    // 1 个 width=0 的续格），必须 cell walk 建「字符串索引 -> cell 列」映射（xterm 内部
    // web-links 的 _mapStrIdx 同款手法）。
    linkProv = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const t = deps.term()
        if (!t) return callback(undefined)
        const line = t.buffer.active.getLine(bufferLineNumber - 1)
        // 折行续行跳过：URL 折行后的 /xxx 段会误配，且不支持跨行 token（v1 限制）
        if (!line || line.isWrapped) return callback(undefined)
        const limit = Math.min(line.length, t.cols) // resize 后 line.length 可能 > cols（陈旧尾格）
        const cell = t.buffer.active.getNullCell() // 复用 scratch cell，避免逐格建对象
        const cellOf: number[] = [] // 字符串索引 -> 所在 cell 的 0 基列
        const widthAt: number[] = [] // cell 列 -> 宽度
        let text = ''
        for (let x = 0; x < limit; x++) {
          if (!line.getCell(x, cell)) break
          const w = cell.getWidth()
          widthAt[x] = w
          if (w === 0) continue // 宽字符续格：不产生字符串内容
          const chars = cell.getChars()
          for (let k = 0; k < chars.length; k++) cellOf.push(x)
          text += chars
        }
        // 快速出局：scrollback 大量鼠标移动时不做无谓扫描
        if (!text.includes('/') && !text.includes('~')) return callback(undefined)
        const toks = findPathTokens(text)
        if (!toks.length) return callback(undefined)
        callback(
          toks.map((tk) => ({
            range: {
              // xterm 的 range 是 1 基；_linkAtPosition 用闭区间 start<=x<=end，end.x 是
              // 末字符的下一列（与 web-links 的 _mapStrIdx 返回值同语义；实测 underline
              // 宽度 = x2-x1 = token 精确 cell 数）。末字符是宽字符时 +1 覆盖续格。
              start: { x: cellOf[tk.start]! + 1, y: bufferLineNumber },
              end: {
                x: cellOf[tk.end - 1]! + 1 + (widthAt[cellOf[tk.end - 1]!] === 2 ? 1 : 0),
                y: bufferLineNumber,
              },
            },
            text: tk.path,
            // 显式声明 hover 装饰（缺省值也是全开，显式写防止默认值随版本漂移）。
            decorations: { underline: true, pointerCursor: true },
            // 只在按住 Ctrl/Cmd（macOS）时激活；普通点击 no-op，选区/聚焦等原生行为不受影响。
            activate(event: MouseEvent) {
              if (!(event.ctrlKey || event.metaKey)) return
              deps.events.linkOpen(tk.path, tk.line, tk.col)
            },
            hover(event: MouseEvent) {
              showLinkTip(event, tk.path)
            },
            leave() {
              hideLinkTip()
            },
          })),
        )
      },
    })
  }

  function dispose() {
    try {
      linkProv?.dispose()
    } catch {
      /* 终端已 dispose：忽略 */
    }
    linkProv = null
    hideLinkTip()
  }

  return { register, dispose, hideLinkTip }
}
