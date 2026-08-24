<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { getToken } from '@/lib/api'

const props = withDefaults(
  // host=true 时连 /ws/host-terminal（宿主终端，PTY 由 server 管理，无容器 id）。
  defineProps<{
    id?: string
    name: string
    termId: string
    shell?: string
    active?: boolean
    host?: boolean
  }>(),
  {
    active: true,
    host: false,
  },
)
// 容器内 mysandbox 命令的联动事件：OSC 7677 payload 解析出的容器内路径。
const emit = defineEmits<{ (e: 'osc-open', path: string): void }>()

// 点 ✕ 关闭时由父组件调用：发 {type:'kill'} 控制帧让后端 tmux kill-session 真杀会话。
// 不在 onBeforeUnmount 里发--刷新页面也会触发 unmount，那时发 kill 会误杀会话、破坏刷新保留。
// fire-and-forget：WS 关闭由随后 Vue 卸载触发的 onBeforeUnmount 完成；kill 帧先于 close 入队，TCP 保序。
function kill() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'kill' }))
    } catch {
      /* socket 已关就忽略，后端靠宽限期兜底清理 */
    }
  }
}
// 建 WS 连接（含事件挂接与心跳）。抽到模块级：断线重连（reconnect）与首连共用。
// termId 不变 -> 后端 attach 回同一 tmux 会话（60s 宽限内），历史/任务都在。
function connectWs() {
  const token = getToken() ?? ''
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const shell = props.shell || 'zsh'
  const base = props.host
    ? `${proto}://${location.host}/ws/host-terminal?token=${encodeURIComponent(token)}`
    : `${proto}://${location.host}/ws/terminal?id=${encodeURIComponent(props.id ?? '')}&token=${encodeURIComponent(token)}`
  const url =
    base +
    `&shell=${encodeURIComponent(shell)}&cols=${term ? term.cols : 80}&rows=${term ? term.rows : 24}` +
    `&termId=${encodeURIComponent(props.termId)}`
  ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'

  ws.onopen = () => {
    connState.value = 'ok'
    term?.writeln(`\x1b[2m>> 连接 ${props.name} (${shell})\x1b[0m`)
  }
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return
    term?.write(new Uint8Array(ev.data as ArrayBuffer))
  }
  // 非正常关闭（非 1000/1001）视为意外断线，置 lost 徽标；点「重连」条或刷新恢复。
  ws.onclose = (ev) => {
    if (hbTimer) {
      clearInterval(hbTimer)
      hbTimer = null
    }
    if (ev.code !== 1000 && ev.code !== 1001) connState.value = 'lost'
    term?.writeln(`\x1b[2m>> 已断开 (${ev.code})\x1b[0m`)
  }
  ws.onerror = () => term?.writeln('\x1b[31m>> socket 错误\x1b[0m')

  // 心跳探测：15s 一个空文本帧。服务端收到未知文本帧走 JSON.parse 失败分支静默忽略；
  // send 抛错（栈已死）则置 lost。TCP 半开（后端挂死不 reset）时 onclose 迟迟不来，
  // 这是前端唯一能感知的手段。
  // 帧里捎带当前尺寸做对账：onResize 只在尺寸变化时触发，任何竞态丢帧（隐藏 tab 挂载时
  // fit 失败、WS 早于 fit 建立、refit 与 resize 帧交错）都会让 PTY/tmux 停在陈旧尺寸，
  // 表现为 TUI（claude 等）只画终端一半宽且永不恢复。后端 resize 分支尺寸不变即跳过，
  // 正常路径零成本；尺寸漂移时这里每 15s 纠正一次，作为 onResize 的兜底。
  hbTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(term ? JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }) : '')
    } catch {
      connState.value = 'lost'
    }
  }, 15_000)
}

// 断线重连：卸掉旧 WS 重建。termId 不变 -> 后端 attach 回同一 tmux 会话（60s 宽限内），
// 历史/正在跑的任务都在。终端上方的「连接已断开 · 点击重连」条走这里。
function reconnect() {
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  ws = null
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = null
  }
  connState.value = 'ok'
  connectWs()
  term?.focus()
}
defineExpose({ kill, reconnect })

const el = ref<HTMLDivElement | null>(null)
let term: XTerm | null = null
let fit: FitAddon | null = null
let ws: WebSocket | null = null
let resizeObs: ResizeObserver | null = null
let rafId = 0
let webglAddon: WebglAddon | null = null
// 断线状态（终端上方覆盖条用）：'ok' | 'lost'。TCP 半开（后端挂死/NAT 超时）时 onclose 不会触发，
// 靠心跳探测置 lost。tmux 会话在后端保留（60s 宽限 + 有活动连接时不杀），重连即恢复。
const connState = ref<'ok' | 'lost'>('ok')
let hbTimer: ReturnType<typeof setInterval> | null = null

// 内置 Cascadia Code Variable 优先（woff2 打包，跨端一致）；彩色 emoji 走系统字体兜底。
const FONT_FAMILY =
  '"Cascadia Code Variable", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace, ' +
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'

// 字号随容器宽度自适应：窄屏不溢出、大屏不显小。
function computeFontSize(): number {
  const w = el.value?.clientWidth ?? window.innerWidth
  if (w < 640) return 13 // 手机：偏大便于触屏阅读
  if (w > 1600) return 15
  return 13
}

// 防抖 fit：合并一帧内的多次尺寸变化，避免拖窗/字号切换时高频抖动；同时同步字号。
function refit() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    rafId = 0
    if (!el.value || el.value.clientWidth === 0) return
    const fs = computeFontSize()
    if (term && term.options.fontSize !== fs) term.options.fontSize = fs
    try {
      fit?.fit()
      term?.focus()
    } catch {
      /* noop */
    }
  })
}

// 切到本 tab：等 display 生效后重算尺寸并聚焦。
watch(
  () => props.active,
  (a) => {
    if (a) nextTick(refit)
  },
)

// 复制/粘贴：tmux 不再劫持鼠标（后端 set -g mouse off），交互层由 xterm.js 接管。
// 剪贴板走 navigator.clipboard（web 终端标准做法，无需 OSC 52）。非 HTTPS / 无权限时静默失败。
async function copyText(s: string) {
  try {
    await navigator.clipboard.writeText(s)
  } catch {
    /* 非 HTTPS / 无权限：静默 */
  }
}
async function pasteText() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  try {
    const t = await navigator.clipboard.readText()
    if (t) ws.send(new TextEncoder().encode(t)) // 走和 onData 同一条 stdin 通道
  } catch {
    /* 静默 */
  }
}
// 右键：有选区复制（并清选区）、无选区粘贴。.prevent 阻止浏览器原生右键菜单。
function onContextMenu() {
  if (term?.hasSelection()) {
    void copyText(term.getSelection()).then(() => term?.clearSelection())
  } else {
    void pasteText()
  }
}

// 滚轮/滚动条：交给 xterm.js 原生处理（与 VSCode 集成终端一致）--tmux 不再开 mouse 劫持，
// 终端流不带鼠标追踪序列，xterm 默认即把滚轮滚 scrollback 并保留右侧滚动条。无需手写 wheel 接管，
// 手写反而会 preventDefault 掉原生滚动、破坏滚动条。

// 字体探测串：终端会用到的 Cascadia 各分片都要触发加载。load() 不带 text 时只拉 latin
// 分片（默认探测文本是 ASCII）；盲文（▐▛█▘▝）、框线（╭─╮│）、箭头等在独立分片里，未就绪时
// WebGL 图集按 fallback 字体栅格化这些字形——宽度错、布局乱，且图集缓存不自动失效。
// 宿主终端连接即时（无 docker exec 延迟兜时间），竞态窗口比容器终端宽得多（实测踩过：
// claude 欢迎框半屏 + 字形错位）。
const FONT_PROBE = 'W█▘▝▐▛▜▌╭╮╰╯─│┌┐└┘├┤┬┴┼═║╔╗╚╝●✢❯⏵⎿→←…'

onMounted(async () => {
  if (!el.value) return
  // 等内置字体就绪再开终端：否则首次 fit 用 fallback 字体的 cell 宽度度量，cols 偏小，
  // 首屏表现为终端只占容器一半宽度、字符网格错位（图标像块拼），拖窗触发重 fit 才恢复。
  // fontsource 在 main.ts 顶部已预取，这里 await 通常瞬时；1.5s 超时兜底防字体源卡住。
  const fontP =
    document.fonts?.load?.(`${computeFontSize()}px "Cascadia Code Variable"`, FONT_PROBE) ??
    Promise.resolve()
  await Promise.race([fontP.catch(() => {}), new Promise<void>((r) => setTimeout(r, 1500))])

  term = new XTerm({
    fontFamily: FONT_FAMILY,
    fontSize: computeFontSize(),
    cursorBlink: true,
    scrollback: 10000, // 回滚行数，与 VSCode 集成终端默认一致（xterm 默认仅 1000）
    theme: { background: '#000000' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.loadAddon(new WebLinksAddon())
  term.open(el.value)
  // 容器内 mysandbox 命令：捕获 OSC 7677（tmux 下走 DCS passthrough，到这里已还原为裸 OSC）。
  // payload 形如 "open;<path>"：action 取首个 ; 之前，路径取其后全部（路径可含 ;）。
  // 返回 true = 已消费，不落入默认处理。
  term.parser.registerOscHandler(7677, (data) => {
    const i = data.indexOf(';')
    if (i >= 0 && data.slice(0, i) === 'open') {
      const path = data.slice(i + 1)
      if (path.startsWith('/')) emit('osc-open', path)
    }
    return true
  })
  // 键盘复制/粘贴拦截。返回 false=吞掉（不发 onData）、true=透传给终端。
  //   - Ctrl+Shift+C：复制选中（无选区也不发 ^C，纯复制键不应中断当前命令）。
  //   - Ctrl+V / Ctrl+Shift+V：粘贴（与桌面终端习惯一致；吞掉 ^V，牺牲 shell 的
  //     quoted-insert/literal-next，web 终端场景粘贴远比它常用）。
  //   - Ctrl+C：有选区时复制并清选区、吞掉；无选区时透传发 ^C=SIGINT（必须 return true）。
  //   其余按键一律透传，不影响 vim/less 等正常输入。
  term.attachCustomKeyEventHandler((e) => {
    if (!(e.ctrlKey && !e.altKey && !e.metaKey)) return true
    if (e.shiftKey && e.code === 'KeyC') {
      if (e.type === 'keydown' && term!.hasSelection()) void copyText(term!.getSelection())
      return false
    }
    // 粘贴：Ctrl+V 和 Ctrl+Shift+V 都匹配（e.code 不区分 shift）。
    // attachCustomKeyEventHandler 对 keydown 和 keyup 各回调一次：不区分 e.type 的话 pasteText
    // 会被调两次（按下 + 抬起）。又因 return false 并不 preventDefault（xterm 的 DOM 监听器忽略
    // 返回值），浏览器照常派发原生 paste 事件，xterm 内置粘贴再经 onData 发一次 —— 三路叠加
    // = 粘贴内容 ×3。故仅 keydown 时手动粘贴并 preventDefault 掉原生 paste；keydown/keyup 一律
    // return false（阻止 xterm 发 ^V=quoted-insert，并避免 keyup 二次粘贴）。
    if (e.code === 'KeyV') {
      if (e.type === 'keydown') {
        e.preventDefault()
        void pasteText()
      }
      return false
    }
    if (e.code === 'KeyC') {
      if (term!.hasSelection()) {
        // keydown 复制并清选区；keyup 不重复写剪贴板。
        if (e.type === 'keydown') void copyText(term!.getSelection()).then(() => term!.clearSelection())
        return false
      }
      return true // 无选区：透传 -> xterm 发 ^C = SIGINT
    }
    return true
  })
  // WebGL 渲染器：栅格化 glyph，等宽对齐更稳（vscode 终端默认即此）。两处降级到 DOM 渲染器：
  //  - 粗指针（手机/平板）：canvas 不支持原生选词复制，DOM 渲染器才能长按选择。
  //  - 非整数 devicePixelRatio（125%/150% 缩放）：webgl addon 的 glyph atlas 在分数像素下
  //    采样偏移会随列数累积——186 列终端右侧错出多格、框线画成楼梯状（实测踩过：claude
  //    TUI 框只渲染左半 + 字形错位，缓冲区数据完好所以复制出的文本是完整的）。addon 用
  //    devicePixelContentBoxSize 修正舍入，但 Firefox 不支持该 API，修正直接失效。
  //    DOM 渲染器逐字符独立定位，不受影响；性能差异在千行 scrollback 级别才可感。
  const isCoarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false
  const fractionalDpr = window.devicePixelRatio % 1 !== 0
  if (!isCoarse && !fractionalDpr) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
      webglAddon = webgl // 持引用：卸载时先 dispose addon，避免 term.dispose 内部清理 renderer 时访问已释放资源
    } catch {
      /* webgl 不可用，回退 DOM 渲染器 */
    }
  }
  // 首次 fit 多阶段兜底：mount 瞬间布局/字体/WebGL 偶发未就绪，单次 fit 可能算错 cols
  // （term 停默认 80 → 视觉终端只占面板一半，拖窗重 fit 才恢复）。多帧覆盖各时序。
  refit()
  requestAnimationFrame(() => refit())
  setTimeout(refit, 200)
  ;(document.fonts?.load?.(`${computeFontSize()}px "Cascadia Code Variable"`, FONT_PROBE) ?? Promise.resolve())
    .then(refit)
    .catch(() => {})

  // 字体分片晚到时 WebGL 图集可能已用 fallback 字体栅格化过字形（宽度错、布局乱，
  // 图集缓存不会自动失效——拖窗 refit 也不恢复）。fonts.ready 后强制清一次图集重栅格化，
  // 这是「claude 欢迎框半屏 + 字形错位」的兜底（容器终端的 docker exec 延迟天然给了字体
  // 加载时间，宿主终端即时连接没有，此问题在宿主侧高发）。
  document.fonts?.ready?.then(() => {
    try {
      webglAddon?.clearTextureAtlas()
    } catch {
      /* addon 已 dispose（context loss）则忽略 */
    }
  })

  // 构建 WS URL 前同步 fit 一次：refit() 把 fit 推到 rAF 里异步执行，此刻 term.cols/rows 仍是
  // xterm 默认 80x24。若 URL 带这个陈旧值，后端 exec.resize 会把 tmux 窗口先缩到 80、等前端
  // rAF fit 完再撑回真实尺寸（shrink-then-grow），且 rAF 的那次 resize 会打断 tmux attach 的
  // 重绘字节流、触发 xterm reflow -> 光标与提示符行解耦、刷新后光标窜到下一行（按回车才复位）。
  // 同步 fit 后 URL 带真实尺寸、后端首帧即 resize 到位，rAF refit 发现尺寸未变不再 reflow。
  try {
    fit?.fit()
  } catch {
    /* noop */
  }

  // 构建 WS（见下方模块级 connectWs）。
  connectWs()

  term.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data))
    }
  })
  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  })
  resizeObs = new ResizeObserver(refit)
  resizeObs.observe(el.value)
  if (props.active) term.focus()
})

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (hbTimer) clearInterval(hbTimer)
  resizeObs?.disconnect()
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  // dispose 顺序：先 addon（WebGL renderer 挂在 term 上，得在 term 还活着时拆），
  // 再 term。反序会触发 term.dispose 内部访问已释放的 renderer -> TypeError。
  try {
    webglAddon?.dispose()
  } catch {
    /* context loss 后再 dispose 偶发报错，忽略 */
  }
  webglAddon = null
  try {
    term?.dispose()
  } catch {
    /* noop */
  }
  term = null
  fit = null
})
</script>

<template>
  <!-- bg-black + 内边距放外层：el 自身不带 padding，FitAddon 量到的 clientWidth/clientHeight 才是
       真实内容区，否则会多算 ~1 行、末行光标被底部边缘切掉一半。 -->
  <div class="relative flex h-full flex-col bg-black px-2 py-1.5">
    <div ref="el" class="flex-1 overflow-hidden" @contextmenu.prevent="onContextMenu" />
    <!-- 断线覆盖条：非正常断开时显示，点击重连（termId 不变 -> 回到同一 tmux 会话） -->
    <button
      v-if="connState === 'lost'"
      class="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-amber-500/90 px-3 py-1 text-xs font-medium text-black"
      @click="reconnect"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-black" />
      连接已断开 · 点击重连
    </button>
  </div>
</template>
