<script setup lang="ts">
import { ref, computed, inject, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { CaseSensitive, ChevronDown, ChevronUp, Regex, WholeWord, X } from 'lucide-vue-next'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { authToken, writeFileBase64, resolveTermPath, pushTerminalClipboard, getTermFg, HOST_ID, sshGroupId, serviceFileId } from '@/lib/api'
import { noteTermOutput } from '@/lib/terminalActivity'
import { muxAgentAvailable } from '@/lib/mux'
import { RESTORED_TERM_IDS } from '@/lib/termlayout'
import { isCoarse, isPhone } from '@/composables/useDevice'
import { KEY_POOL } from '@/lib/termToolbar'
import { usePhoneToolbar } from '@/composables/usePhoneToolbar'
import ToolbarSettingsDialog from '@/components/ToolbarSettingsDialog.vue'
import QuickCmdsSheet from '@/components/QuickCmdsSheet.vue'

const props = withDefaults(
  // host=true 时连 /ws/host-terminal（宿主终端，PTY 由 server 管理，无容器 id）。
  // ssh 时连 /ws/ssh-terminal（远程主机，PTY 链 = script → ssh → 远端 tmux，shell 参数
  // 不适用——远端 shell 由远端自己决定）。
  // fromTermId = 分屏来源 pane 的 termId（仅分屏时由 TermLayoutNode 传入）：后端首次
  // 创建新会话时继承源 pane 的当前目录。放进 URL 而非 localStorage 布局树——cwd 只在
  // 新会话创建那一刻有意义，刷新后（会话必已存在、纯 attach）随内存映射消失即不再传。
  defineProps<{
    id?: string
    name: string
    termId: string
    shell?: string
    active?: boolean
    host?: boolean
    // docker 服务终端：连 /ws/service-terminal（PTY = 宿主 tmux 窗口跑 docker exec）。
    service?: string
    // SSH 主机终端：连 /ws/ssh-terminal（PTY = script 包 ssh，会话在远端 tmux 专用 socket）。
    ssh?: string
    fromTermId?: string
    // 显式后端：新建终端组时菜单里二选一给定就固定；undefined = 服务端 mux.backend
    // （深链/恢复会话等未显式选择路径）。没有 auto。
    backend?: 'tmux' | 'msmux'
  }>(),
  {
    active: true,
    host: false,
  },
)
// 容器内 mysandbox 命令的联动事件：OSC 7677 payload 解析出的容器内路径；
// link-open 是终端 buffer 里 Ctrl+点击路径链接（path 为原始 token，可相对/带 ~，
// 行列来自栈跟踪式 `:行:列` 后缀）；title 是窗口标题变化（OSC 0/2：shell 钩子的
// 执行命令/空闲路径、CC·opencode 的任务标题——经 tmux set-titles 转发到这里，
// ContainerList 拿去更新 tab 标签）。
const emit = defineEmits<{
  (e: 'osc-open', path: string): void
  (e: 'link-open', path: string, line?: number, col?: number): void
  (e: 'title', title: string): void
  // pane 获得焦点（xterm onFocus）：ContainerList 拿去让文件面板跟随最后聚焦的 pane。
  // 程序性恢复聚焦（refit 的 term.focus()）不上抛——见下方 suppressFocusEmit。
  (e: 'focus'): void
  // 终端输入了回车（onData 含 \r）：文件面板借此做即时的 cwd 跟随检查，消除 cd 后
  // 等轮询的体感延迟。
  (e: 'enter'): void
  // shell 集成上报 cwd（OSC 7，zsh precmd 发射）：cd 生效即到达，零轮询零请求的
  // 事件流。老容器/SSH/宿主无种子不上报，由 FilePanel 的 1s 轮询兜底。
  (e: 'cwd', path: string): void
  // msmux 上报前台进程名：图片粘贴桥用它绕开 tmux 专属的 REST fg 探测。
  (e: 'foreground', command: string): void
  // 收到首帧终端输出（二进制帧）：父组件据此注入首条命令/提示词。不用 onopen——
  // 那时后端 tmux 可能还没 attach 完，直接写 PTY 有概率丢输入。
  (e: 'ready'): void
  // 实际生效的终端后端（在线探测 + attach 完成）：pane 头部据此显示后端徽标。
  // msmux 是默认静默选路的，不显式上抛用户永远无从知道当前走的哪条。
  (e: 'backend', backend: 'tmux' | 'msmux'): void
}>()

// 点 ✕ 关闭时由父组件调用：发 {type:'kill'} 控制帧让后端 tmux kill-session 真杀会话。
// 不在 onBeforeUnmount 里发--刷新页面也会触发 unmount，那时发 kill 会误杀会话、破坏刷新保留。
// CONNECTING 时也不能跳过（原实现只查 OPEN）：断线自动重连未完成的窗口里点 ✕，kill 帧
// 被静默丢弃 → 服务端当纯 detach → 会话永活（「所有终端」里一直挂着、看似 ✕ 没生效）。
// 挂到 open 再发；close 先行入队，TCP 保序，服务端先收 kill 再见断开，wantKill 落地。
// fire-and-forget：open 前组件就卸载也无妨——没送到 kill 就当纯 detach（真 tmux 语义）。
function kill() {
  // 在线探测/建连窗口内用户就点了 ✕：记下来，等 socket 建好立即补发。
  if (!ws) {
    pendingKill = true
    return
  }
  const send = () => {
    try {
      ws?.send(JSON.stringify({ type: 'kill' }))
    } catch {
      /* socket 已关就忽略：没送到 kill 就当纯 detach，会话保留（真 tmux 语义） */
    }
    try {
      ws?.close(1000)
    } catch {
      /* noop */
    }
  }
  if (ws.readyState === WebSocket.OPEN) send()
  else if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener('open', send, { once: true })
    // 连接失败（onerror 后 open 永不来）：随组件卸载一并丢弃，无需额外清理
  }
}

// 当前视口内容快照（逐行文本拼接）：「无输出提醒」的内容基线用——离开时快照 vs
// 安静判定时快照，相同 = 只是重绘（attach 整屏还原/重连/resize），不算新内容。
// 只取底部 rows 行（用户看到的画面）：⚠️ buffer.getLine(y) 的 y 是**全缓冲区绝对行号**，
// 0 = scrollback 顶——从 0 读会把「最老的 24 行」当视口（输出一超屏哈希就永远冻结，
// 基线恒等于当前，内容门槛全废，实测踩过）；文本行不含颜色/光标属性，重绘前后逐字节稳定。
function screenHash(): string | undefined {
  if (!term) return undefined
  const buf = term.buffer.active
  const from = Math.max(0, buf.length - term.rows)
  const lines: string[] = []
  for (let y = from; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  return lines.join('\n')
}

// 剥 ANSI 序列（CSI + OSC）：delta 锚点匹配要用纯文本与 buffer 行（translateToString
// 本身已剥序列）对齐，写入时才用原始行（带色）。
const ANSI_SEQ = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g

// 重连增量回填：后端在 resume=1 时发 history-delta（最近 2000 物理行、含当前屏、带
// SGR）。前端拿 buffer 尾部（= 断线瞬间的最后一屏，必然也是 delta 内容里的一段）做
// 锚点，在 delta 里定位后只写入其后的部分——断线窗口期内错过的输出原位补齐、零重复。
// 找不到锚点（窗口期输出超 -2000 行 / 重连间列宽变化 reflow / 纯空屏无区分度）就静默
// 放弃，等同旧行为（只靠 attach 重绘恢复当前屏）。capture 用物理行（无 -J）正是为了
// 与 buffer 逐行对应；跨列宽的 reflow 会自然导致匹配失败，无需特判。
function applyHistoryDelta(text: string): void {
  const t = term
  if (!t) return
  const lines = text.split('\n')
  const buf = t.buffer.active
  // 锚点 = buffer 最后几行。我们自己写进 buffer 的横幅（>> 已断开 / >> 连接 / >> socket
  // 错误）不在 tmux 历史里，滤掉再取；全空锚点（清屏后的空画面）没有区分度，直接放弃。
  const ANCHOR = 6
  const raw: string[] = []
  for (let y = Math.max(0, buf.length - (ANCHOR + 4)); y < buf.length; y++) {
    raw.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  const anchor = raw.filter((l) => !l.startsWith('>> ')).slice(-ANCHOR)
  if (anchor.length < ANCHOR || anchor.every((l) => l === '')) return
  const plain = lines.map((l) => l.replace(ANSI_SEQ, '').replace(/\s+$/, ''))
  for (let i = 0; i + ANCHOR <= plain.length; i++) {
    let hit = true
    for (let j = 0; j < ANCHOR; j++) {
      if (plain[i + j] !== anchor[j]) {
        hit = false
        break
      }
    }
    if (!hit) continue
    // 锚点之后 = 断线窗口输出；delta 比一屏长时末尾还挂着重连时的当前屏（capture 默认
    // 到可见屏底），这 rows 行不写——交给 attach 重绘画进视口，否则滚动区出现整屏重复。
    const restCount = lines.length - (i + ANCHOR)
    const rest = restCount > t.rows ? lines.slice(i + ANCHOR, lines.length - t.rows) : lines.slice(i + ANCHOR)
    // 前缀复位 SGR：-e 行可能以未闭合的属性态结束，别带进后续输出流。结尾不加 CRLF：
    // 光标停在哪由 attach 重绘的绝对定位接管。
    if (rest.length) t.write(`\x1b[0m${rest.join('\r\n')}`)
    return
  }
}

// 搜索选项固定开装饰：xterm 的全部高亮和结果统计只有在 decorations 启用时才工作。
// incremental 让输入过程中的命中延续选区，避免每敲一个字符都从头跳一遍。
function searchOptions() {
  return {
    caseSensitive: searchCaseSensitive.value,
    regex: searchRegex.value,
    wholeWord: searchWholeWord.value,
    incremental: true,
    decorations: {
      matchBackground: '#3f3f46',
      matchBorder: '#52525b',
      matchOverviewRuler: '#71717a',
      activeMatchBackground: '#b45309',
      activeMatchBorder: '#fbbf24',
      activeMatchColorOverviewRuler: '#fbbf24',
    },
  }
}

function runSearch(direction: 'next' | 'previous') {
  if (!search || !searchQuery.value) {
    searchResultIndex.value = -1
    searchResultCount.value = 0
    search?.clearDecorations()
    return
  }
  const query = searchQuery.value
  if (direction === 'next') search.findNext(query, searchOptions())
  else search.findPrevious(query, searchOptions())
}

function openSearch() {
  searchVisible.value = true
  void nextTick(() => {
    searchInput.value?.focus()
    searchInput.value?.select()
    runSearch('next')
  })
}

function closeSearch() {
  searchVisible.value = false
  searchQuery.value = ''
  searchResultIndex.value = -1
  searchResultCount.value = 0
  search?.clearDecorations()
  term?.focus()
}
// 建 WS 连接（含事件挂接与心跳）。抽到模块级：断线重连（reconnect）、tab 激活懒挂载与
// 首连共用。termId 不变 -> 后端 attach 回同一 tmux 会话（无限期保留，直到显式 ✕ 或 shell 退出）。
// quiet：程序性连接/断开（tab 切换的 detach/attach）不打 banner——每次切 tab 都写
// 「>> 连接/>> 已断开」两行会把 scrollback 刷成切换日志；意外断线路径照常提示。
let connectSeq = 0
let pendingKill = false
// attach 完成前的 stdin 暂存：服务端 /ws/* 在 attach 未完成时会丢弃二进制帧（mux 侧
// sid==null 直接 return），建连窗口内用户敲的键就无声消失。入队等首帧（history/输出）
// 到达即 flush——顺序保真，窗口通常 <300ms；再加 2s 兜底定时器，防「会话永远无输出」
// 时输入滞留。kill 帧同款手法（见上）。
let pendingInput: string[] = []
let inputReady = false
let inputFlushTimer: ReturnType<typeof setTimeout> | null = null
// shell 退出（mux {type:'exit'} 帧）：置位后 onclose 不再写「已断开 (1000)」——
// 会话结束是正常路径，不是断线，提示语也不同。
let sessionEnded = false
// 发 stdin 的唯一出口：attach 未完成先入队。onData / sendRaw / 粘贴全走这里。
// 连接不在 OPEN（重连空窗：旧 socket CLOSING、新 socket 未建 / CONNECTING / 首帧未到）
// 一律入队而不是丢弃——手机回前台、agent 断连重连的窗口里敲的键曾经被这里无声吃掉
//（表现就是「重连后快捷键/输入无效」）。上限兜底：连接死透（服务端不可达）时不无限积压。
const PENDING_INPUT_MAX = 512
function queueStdin(s: string) {
  pendingInput.push(s)
  if (pendingInput.length > PENDING_INPUT_MAX) pendingInput.splice(0, pendingInput.length - PENDING_INPUT_MAX)
}
function sendStdin(s: string) {
  if (ws && ws.readyState === WebSocket.OPEN && inputReady) {
    ws.send(new TextEncoder().encode(s))
    return
  }
  queueStdin(s)
}
function markInputReady() {
  if (!inputReady) {
    inputReady = true
    if (inputFlushTimer) {
      clearTimeout(inputFlushTimer)
      inputFlushTimer = null
    }
  }
  flushPendingInput()
}
// 入队输入的冲刷：OPEN 且闸门已开时整体发出。onopen（重连前敲的键）与 markInputReady
//（首帧到达 / 2s 兜底定时器）都会调，保证任何入队路径都有冲刷出口、不滞留。
function flushPendingInput() {
  if (!pendingInput.length || !ws || ws.readyState !== WebSocket.OPEN) return
  const blob = pendingInput.join('')
  pendingInput = []
  ws.send(new TextEncoder().encode(blob))
}

// msmux 的目标命名与 server/muxDeploy.ts 一致：host | c:<容器> | s:<服务> | ssh:<目标>。
function muxTargetOf(): string {
  if (props.host) return 'host'
  if (props.service) return `s:${props.service}`
  if (props.ssh) return `ssh:${props.ssh}`
  return props.id ? `c:${props.id}` : ''
}

async function connectWs(quiet = false) {
  const seq = ++connectSeq
  wsQuiet = quiet
  const token = authToken()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // SSH 远端 shell 由远端自己决定（不传 shell）；其余目标沿用 defaultShell。
  const shell = props.ssh ? '' : props.shell || 'zsh'
  const target = muxTargetOf()
  const useMux = await muxAgentAvailable(target, props.backend)
  currentBackend = useMux ? 'msmux' : 'tmux'
  // 等在线探测期间组件可能已被切走/重建：过期连接直接作废。
  if (seq !== connectSeq || !props.active) return
  const cols = term ? term.cols : 80
  const rows = term ? term.rows : 24
  let url: string
  if (useMux) {
    const q = new URLSearchParams({
      target,
      termId: props.termId,
      cols: String(cols),
      rows: String(rows),
      create: '1',
      token,
    })
    if (shell) q.set('shell', shell)
    if (props.fromTermId) q.set('from', props.fromTermId)
    if (backfilled) q.set('resume', '1')
    url = `${proto}://${location.host}/ws/mux-terminal?${q}`
  } else {
    const base = props.host
      ? `${proto}://${location.host}/ws/host-terminal?token=${encodeURIComponent(token)}`
      : props.ssh
        ? `${proto}://${location.host}/ws/ssh-terminal?target=${encodeURIComponent(props.ssh)}&token=${encodeURIComponent(token)}`
        : props.service
          ? `${proto}://${location.host}/ws/service-terminal?name=${encodeURIComponent(props.service)}&token=${encodeURIComponent(token)}`
          : `${proto}://${location.host}/ws/terminal?id=${encodeURIComponent(props.id ?? '')}&token=${encodeURIComponent(token)}`
    url =
      base +
      (props.ssh ? '' : `&shell=${encodeURIComponent(shell)}`) +
      `&cols=${cols}&rows=${rows}` +
      `&termId=${encodeURIComponent(props.termId)}` +
      (props.fromTermId ? `&from=${encodeURIComponent(props.fromTermId)}` : '') +
      // 重连（本组件已回填过一次）告诉后端走增量分支：history-delta 只补断线窗口的输出，
      // 而不是把整个历史重写一遍（scrollback 里已有内容，全量回填会整体重复）。
      (backfilled ? '&resume=1' : '')
  }
  ws = new WebSocket(url)
  if (pendingKill) {
    pendingKill = false
    kill()
  }
  const sock = ws
  ws.binaryType = 'arraybuffer'
  // 每条连接重置 stdin 闸门与会话结束标记：pendingInput 跨连接保留（建连窗口的击键
  // 不因重连丢失），inputReady 等新连接首帧再打开。
  inputReady = false
  sessionEnded = false
  if (inputFlushTimer) clearTimeout(inputFlushTimer)
  inputFlushTimer = setTimeout(markInputReady, 2_000)

  ws.onopen = () => {
    connState.value = 'ok'
    // 重连成功：取消未落笔的断线横幅；若横幅已写出（慢重连），补一行「已重连」闭环，
    // 别让回滚末尾那行「已断开 (1006)」成了最后状态。
    if (closeBannerTimer) {
      clearTimeout(closeBannerTimer)
      closeBannerTimer = null
    }
    if (closeBannerShown) {
      closeBannerShown = false
      term?.writeln('\x1b[2m>> 已重连\x1b[0m')
    }
    const label = useMux ? 'msmux' : shell
    // 横幅只在「新建终端的首连」写一次：恢复布局出来的重连（wsQuiet 或 termId 属
    // RESTORED_TERM_IDS）一律静默，避免刷新/回前台时 scrollback 被连接日志刷花。
    if (!wsQuiet && !restoredTermIds.has(props.termId)) {
      term?.writeln(`\x1b[2m>> 连接 ${props.name}${label ? ` (${label})` : ''}\x1b[0m`)
    }
    emit('backend', useMux ? 'msmux' : 'tmux')
  }
  ws.onmessage = (ev) => {
    // 刷新/重建连接时旧 socket 可能还有排队消息先到：丢弃，别写进刚 reset 的 buffer。
    if (ws !== sock) return
    // 文本帧 = 服务端控制帧（二进制才是终端流）。目前只有 history：tmux pane 历史回填
    // （后端 attach 前 capture-pane 发来），写入 scrollback 后 tmux 整屏重绘落在空视口上。
    if (typeof ev.data === 'string') {
      try {
        const m = JSON.parse(ev.data) as { type?: string; text?: string }
        if (m.type === 'history') {
          // history 帧到达即视为完成过一次全量回填，后续重连一律走 resume 增量。
          // 空历史（新会话尚无 scrollback）也要置位：否则重连 resume=0 全量重写，
          // 与 buffer 里已有的内容整体重复。
          if (!backfilled) {
            backfilled = true
            // N 行历史 + rows 个 CRLF = N+rows-1 个换行：恰好全部推进 scrollback、零空行
            // 缝隙、光标落底行（数学上精确成立，与 N 无关）；重绘的绝对定位画在空视口上。
            if (m.text) term?.write(m.text.split('\n').join('\r\n') + '\r\n'.repeat(term?.rows ?? 24))
          }
        } else if (m.type === 'history-delta' && m.text) {
          // 重连增量：补断线窗口期内错过的输出（锚点去重，见 applyHistoryDelta）。
          applyHistoryDelta(m.text)
        } else if (m.type === 'modes' && m.text) {
          // msmux resume 补发终端输入模式（?1000/?1003/?1006 鼠标上报、?2004 括号粘贴）：
          // 断线窗口内 app 改过模式就靠这帧重同步。触屏滚动的 SGR 滚轮转换
          // （setupTouchScroll altWheel）依赖 xterm 的 mouseTrackingMode，缺了它 claude
          // 在手机上没法滚。首次 attach 的模式随首屏 Data 帧来，不经此分支。
          term?.write(m.text)
        } else if (m.type === 'title' && typeof m.text === 'string') {
          // 重连/刷新后的标题恢复：pane title 留在 tmux 里不会随 attach 重发（历史回填
          // 只有可见文本），服务端 attach 前读 #T 补发此帧（terminal.ts / hostTerminal.ts）。
          emit('title', m.text)
        } else if (m.type === 'cwd' && typeof m.text === 'string' && m.text) {
          emit('cwd', m.text)
        } else if (m.type === 'foreground' && typeof m.text === 'string') {
          foregroundCommand = m.text
          emit('foreground', m.text)
        } else if (m.type === 'error' && typeof m.text === 'string' && m.text) {
          // 服务端 attach 失败（agent 未连接/会话名非法/create 失败）：随后就是 1011，
          // close code 本身不带原因——不消费这帧，用户只能看到无来由的「已断开 (1011)」。
          term?.writeln(`\x1b[31m>> ${m.text}\x1b[0m`)
        } else if (m.type === 'exit') {
          // shell 退出（mux）：会话本体终结，是正常路径不是断线。写明示语并拦下 onclose
          // 的「已断开 (1000)」；quiet（程序性重连）也要写——否则终端静默变死、输入无声丢弃。
          sessionEnded = true
          term?.writeln('\x1b[2m>> 会话已结束（shell 退出）；点击重连会开新会话\x1b[0m')
        }
        // 控制帧是 attach 完成后的随附物（history/title/cwd/foreground 都在 attach 成功
        // 后补发）：到此即可放行 stdin。error 帧的下一步是 1011，不开闸。
        if (m.type !== 'error') markInputReady()
      } catch {
        /* 非法控制帧忽略 */
      }
      return
    }
    // 终端数据帧 = 有输出：登记最后输出时刻（「无输出提醒」用，见 lib/terminalActivity）。
    // 非激活 tab 已 detach（懒挂载）不再收流，登记只对当前激活 tab 生效；历史回填（文本帧）
    // 不算。prime 窗口内的帧只点亮光晕、不进提醒资格（attach 重绘/初始 prompt 是打开自带画面）。
    noteTermOutput(props.termId)
    const bytes = new Uint8Array(ev.data as ArrayBuffer)
    term?.write(bytes)
    if (!readySent) {
      readySent = true
      emit('ready')
    }
    markInputReady()
  }
  // 非正常关闭（非 1000/1001）视为意外断线，置 lost 徽标；点「重连」条或刷新恢复。
  ws.onclose = (ev) => {
    // 陈旧关闭守卫：detach/重连已把 ws 换成新连接后，旧 socket 的 onclose 才迟到——
    // 不能碰新连接的 hbTimer/状态（否则新连接的心跳被清掉，半开探测从此失灵）。
    if (ws !== sock) return
    if (hbTimer) {
      clearInterval(hbTimer)
      hbTimer = null
    }
    if (ev.code !== 1000 && ev.code !== 1001) connState.value = 'lost'
    // shell 已退出（exit 帧处理过）不再写「已断开」——正常终结不是断线，提示语在 exit 分支。
    // 横幅延迟 1.5s 落笔（见 closeBannerTimer 注释）：快速重连直接取消，不污染 scrollback。
    if (!wsQuiet && !sessionEnded) {
      const code = ev.code
      closeBannerTimer = setTimeout(() => {
        closeBannerTimer = null
        closeBannerShown = true
        term?.writeln(`\x1b[2m>> 已断开 (${code})\x1b[0m`)
      }, 1_500)
    }
  }
  // onerror 不写横幅：错误后面必然跟着 onclose（「已断开 (code)」或 lost 徽标 + 重连条），
  // 单独一行「socket 错误」只是噪声——手机上回前台/网络抖动每次都刷两三行，把回滚刷花。
  ws.onerror = () => {}

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

// 断线重连：卸掉旧 WS 重建。termId 不变 -> 后端 attach 回同一 tmux 会话（无时限保留），
// 历史/正在跑的任务都在。终端上方的「连接已断开 · 点击重连」条与自愈路径（recoverOnReturn）
// 都走这里。quiet：不写「连接/已断开」横幅——lost 徽标 + 重连条已经把状态说清楚了，重连
// 成功不需要再往回滚里写一行；手机上回前台自愈一次刷两三行横幅会把 scrollback 刷花。
function reconnect(quiet = false) {
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
  connectWs(quiet)
  // 触摸设备不程序性聚焦（弹系统键盘）：自愈重连由 pointerdown 捕获触发，跟着 focus
  // 会把软键盘在用户没点终端的时候弹出来（点文件 tab / 底部导航都会中招）。
  if (!isCoarse.value) term?.focus()
}

// 程序化输入出口（Claude 终端对话框用）：与键盘输入同通道，调用方负责带回车。
function sendInput(s: string) {
  sendRaw(s)
}
defineExpose({ kill, reconnect, refresh: refreshTerminal, screenHash, sendInput })

// 非激活 tab 的懒挂载（detach）：终端组全部常驻 DOM（v-show 切换、组件不卸载），但
// WS 只留给激活 tab——非激活 tab 不再吃输出流，省掉三样：xterm 对不可见输出的 VT 解析
// CPU（输出风暴时是真成本）、服务端每个 attach client 的输出扇出、心跳/半开探测。代价
// 是切回该 tab 时一拍重连（resume=1 增量回填，锚点去重零重复，~100ms）。组件与 buffer
// 原样保留，tmux 会话在服务端不受影响（会话只被显式 kill 或 shell 退出终结）。
function detachWs() {
  if (!ws) return
  wsQuiet = true // 程序性断开不打 banner；陈旧 onclose 守卫保证不碰后续连接的状态
  try {
    ws.close()
  } catch {
    /* noop */
  }
  ws = null
  if (hbTimer) {
    clearInterval(hbTimer)
    hbTimer = null
  }
}

// 页面回到前台/窗口重新聚焦/网络恢复/任意用户交互时，意外断线的终端立即自愈。离开期间
// 浏览器、系统休眠或网络切换可能已把 WebSocket 关掉；用户切回来就是要看，不该再等一次
// 手动点击。有些回前台路径 visibilitychange/focus 都不触发（手机息屏唤醒、页面一直
// visible 只是断网恢复），所以交互事件也兜底——lost 状态下任何点击/按键即重连。
function recoverOnReturn() {
  if (!document.hidden && connState.value === 'lost') reconnect(true)
}

const el = ref<HTMLDivElement | null>(null)
// 根容器（带键盘占位 padding 的那层）：软键盘自适应要量它底边到布局视口底的距离，
// 扣掉布局自带的底部留白（移动端底部 tab 的 pb），见 usePhoneToolbar 的 setupViewportWatch。
const rootEl = ref<HTMLDivElement | null>(null)
let term: XTerm | null = null
// 程序性聚焦抑制标志：refit 的 term.focus() 是「切 tab 恢复/窗口 resize」的附带动作，
// 不代表用户把焦点落在哪个 pane——DOM focus 事件在 focus() 调用内同步派发，同步开关
// 即可拦住。分屏新 pane / 点击 pane / 重连按钮的聚焦是真实落焦，照常上抛。
let suppressFocusEmit = false
// 焦点落位双通道：上抛（文件面板跟随最后聚焦的 pane）+ 手机工具条焦点闸
// （termFocused 归属 usePhoneToolbar，tb 在下方声明——监听器挂载后才触发，无 TDZ 问题）。
const onFocusIn = () => {
  tb.onFocusedIn()
  if (!suppressFocusEmit) emit('focus')
}
const onFocusOut = () => {
  tb.onFocusedOut()
}
let fit: FitAddon | null = null
let ws: WebSocket | null = null
// 恢复会话的叶子 termId（ContainerList 注入）：恢复出来的重连不写「>> 连接」横幅——
// 刷新/回前台时往 scrollback 刷连接日志是噪声；只有新建终端的首连才写（见 onopen）。
const restoredTermIds = inject(RESTORED_TERM_IDS) ?? new Set<string>()
// 当前连接是否程序性静默（tab 切换的 detach/attach 路径）：onopen/onclose 不写 banner。
// 共享可变量而非闭包捕获：detach 要让「已存在连接」的 onclose 也静默，只能事后改标记
// （同一时刻至多一条活连接，事件读到的值必然对应当前连接）。
let wsQuiet = false
let resizeObs: ResizeObserver | null = null
let rafId = 0
let webglAddon: WebglAddon | null = null
let linkProv: { dispose(): void } | null = null
let search: SearchAddon | null = null
// 断线状态（终端上方覆盖条用）：'ok' | 'lost'。TCP 半开（后端挂死/NAT 超时）时 onclose 不会触发，
// 靠心跳探测置 lost。tmux 会话在后端无限期保留（真 tmux 语义），重连即恢复。
const connState = ref<'ok' | 'lost'>('ok')
const searchVisible = ref(false)
const searchQuery = ref('')
const searchInputWidth = computed(() => {
  const text = searchQuery.value || '搜索终端…'
  const units = [...text].reduce((width, char) => width + ((char.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0)
  return `${Math.max(8, units + 1)}ch`
})
const searchResultIndex = ref(-1)
const searchResultCount = ref(0)
const searchCaseSensitive = ref(false)
const searchRegex = ref(false)
const searchWholeWord = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)
let hbTimer: ReturnType<typeof setInterval> | null = null
// tmux 历史回填只做一次（组件首连）：reconnect 时 term 实例还在、scrollback 已有内容，
// 再回填会重复整段历史。断线期间产生的输出留在 tmux 历史里滚不到（可接受的缺口）。
let backfilled = false
// 断线横幅延迟落笔：自愈/手动重连大多在 1.5s 内完成，直接取消——重连成功后回滚末尾
// 躺着一行「已断开 (1006)」会被当成「还断着」（重连静默下它是屏幕最后一行）。
// 慢重连（横幅已写出）由 onopen 补一行「已重连」闭环。refreshTerminal 清空 buffer 时一并复位。
let closeBannerTimer: ReturnType<typeof setTimeout> | null = null
let closeBannerShown = false
// ready 只在本次挂载内发一次：首个二进制帧 = 后端已 attach、PTY 可以稳定接收输入。
let readySent = false
// 当前连接是否走 msmux；foreground 事件只在 msmux 后端可用。
let currentBackend: 'tmux' | 'msmux' = 'tmux'
// msmux 最新前台进程名；断线/重连后由 attach 元数据恢复。
let foregroundCommand = ''

// 内置 Cascadia Code Variable 优先（woff2 打包，跨端一致）；彩色 emoji 走系统字体兜底。
const FONT_FAMILY =
  '"Cascadia Code Variable", "Cascadia Code", ui-monospace, SFMono-Regular, Menlo, Consolas, ' +
  '"Noto Sans Mono CJK SC", "Noto Sans Mono CJK JP", "Microsoft YaHei Mono", "PingFang SC", ' +
  'monospace, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"'

// 字号随容器宽度自适应：窄屏不溢出、大屏不显小。用户显式调过（触屏工具条 A±）则
// 记忆优先（clamp 10–18），跨 pane/刷新保持。
const FONT_SIZE_KEY = 'mysandbox:term-font-size'
function computeFontSize(): number {
  const saved = Number(localStorage.getItem(FONT_SIZE_KEY))
  if (Number.isFinite(saved) && saved >= 10 && saved <= 18) return saved
  const w = el.value?.clientWidth ?? window.innerWidth
  if (w < 640) return 13 // 手机：偏大便于触屏阅读
  if (w > 1600) return 15
  return 13
}
// 触屏工具条 A±：写记忆并立即重算（refit 内会同步 term.options.fontSize）。
function stepFontSize(delta: number) {
  const cur = computeFontSize()
  const next = Math.max(10, Math.min(18, cur + delta))
  try {
    localStorage.setItem(FONT_SIZE_KEY, String(next))
  } catch {
    /* 不可用就只本次生效 */
  }
  refit()
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
      // 强制重算 xterm 内部滚动区（切回 tab 后「滚动不到最下面」的修复）。
      // xterm 5.5 的 Viewport._innerRefresh 直接读 viewport 的 offsetHeight，而
      // display:none 期间该值是 0——隐藏 tab 收到会推进外层 buffer 的输出（首载
      // 恢复多组 tab 时的历史回填、断线时的 ">> 已断开" writeln 等）时滚动区高度
      // 被算短整整一个视口，最底一行屏永远够不着；且 tmux 原地重绘不滚外层 buffer、
      // 尺寸也没变，syncScrollArea 之后不再被调用，错误一直留到刷新页面。fit 对
      // 「尺寸没变」是纯 no-op，救不了；这里在可见路径上强制 immediate 重算一次，
      // 健康态下是幂等写、零副作用。
      const vp = (
        term as unknown as {
          _core?: { viewport?: { syncScrollArea?: (immediate?: boolean) => void } }
        }
      )._core?.viewport
      vp?.syncScrollArea?.(true)
      // 粘贴兜底对话框打开期间不抢焦点：term.focus() 会把光标拉回终端，
      // 用户正要在兜底 textarea 里长按/Ctrl+V 粘贴。
      // 触摸设备恒不程序性聚焦：切 tab / resize 的自动 focus 会直接弹系统键盘，
      // 键盘交给用户点终端区域时 xterm 自己的落焦（那是显式手势）。
      if (!pasteFallback.value && !isCoarse.value) {
        suppressFocusEmit = true
        try {
          term?.focus()
        } finally {
          suppressFocusEmit = false
        }
      }
    } catch {
      /* noop */
    }
  })
}

// 切到本 tab：等 display 生效后重算尺寸并聚焦；非激活期间 WS 已 detach（懒挂载，见
// detachWs），这里重连，resume=1 增量回填补上断开窗口的输出（buffer 零重复）。
watch(
  () => props.active,
  (a) => {
    if (a) {
      nextTick(() => {
        // 等 display 生效后先同步 fit 拿真实 cols/rows 再连——恢复时非激活组是
        // display:none 挂载、term 停在 80x24 默认值，URL 带垃圾值会让后端先缩后撑
        // （shrink-then-grow，见 onMounted 同步 fit 注释）；refit 本体推 rAF 异步，
        // 这里不能只靠它。
        try {
          if (el.value?.clientWidth) fit?.fit()
        } catch {
          /* noop */
        }
        if (!ws || ws.readyState > WebSocket.OPEN) {
          connState.value = 'ok'
          connectWs(true)
        }
        refit()
      })
    } else {
      detachWs()
    }
  },
)

// 复制/粘贴：tmux 不再劫持鼠标（后端 set -g mouse off），交互层由 xterm.js 接管。
// 剪贴板走 navigator.clipboard；OSC 52（TUI 应用请终端代写剪贴板）也汇到 copyText
// （见下方 registerOscHandler(52)）。
// 非 https 环境（http://局域网IP 访问）navigator.clipboard 是 undefined——一律走
// execCommand 兜底 + toast 提示，不再静默吞（否则 Ctrl+C 复制 / Ctrl+V 粘贴双双无声失败）。
// execCommand 必须在用户手势事件栈里同步调用：keydown（Ctrl+C/V 路径）与 click（工具条/右键）
// 都是合法手势；不能 await 后再调（手势已过期，Firefox 直接拒绝）。
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
async function pasteClipboard() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
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
      if (t) sendStdin(t) // 走和 onData 同一条 stdin 通道
      return
    } catch {
      /* Firefox 常态拒绝 readText：落兜底对话框 */
    }
  }
  pasteFallback.value = true // clipboard 不可用/被拒：弹兜底输入框（textarea 原生粘贴永远可用）
  nextTick(() => fallbackTa.value?.focus())
}

// —— 图片粘贴（Claude Code 等 AI CLI 的图片输入）——
// CLI 在 Linux 读剪贴板图片走 xclip/wl-paste，无头容器里不存在；浏览器剪贴板里的图片
// 二进制也进不了 PTY 字节流。改为「上传落盘 + 粘路径」：图片经文件端点写到目标 home 的
// .claude-pastes/，再把绝对路径发进终端——CLI 对图片路径是一等公民（拖拽同款），消息
// 发出即读图。文件端点四侧（容器/宿主/服务/SSH）同形，fileTargetId 按哨兵分发。
const fileTargetId = computed(() =>
  props.host
    ? HOST_ID
    : props.ssh
      ? sshGroupId(props.ssh)
      : props.service
        ? serviceFileId(props.service)
        : props.id ?? '',
)
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
  if (props.host || props.ssh || props.service || !props.id) return false
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    const b64 = await imageToPngB64(first)
    await pushTerminalClipboard({ image: { b64 } })
    if (currentBackend === 'msmux') {
      // msmux 事件已给出权威前台命令；bridge 仍要问 shim 是否在位，但不再解析 tmux。
      if (!foregroundCommand || SHELL_COMMANDS.has(foregroundCommand)) return false
      const fg = await getTermFg(props.id, props.termId, 'msmux')
      return fg.bridge
    }
    const fg = await getTermFg(props.id, props.termId)
    // 前台是普通 shell：^V 会被解释成 quoted-insert 白吃一个键，粘贴落空 → 路径粘贴。
    // 老容器没补种（bridge=false）：^V 后 CLI 找不到 xclip，无事发生 → 路径粘贴。
    if (!fg.bridge || SHELL_COMMANDS.has(fg.command)) return false
    sendRaw('\x16')
    return true
  } catch {
    // 桥链路任何一环失败（读图/编码/推送/fg 查询）：粘贴不因桥失败而丢。
    return false
  }
}
async function pasteImageFiles(files: File[]) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast.error('终端未连接，图片粘贴失败')
    return
  }
  const target = fileTargetId.value
  if (!target) {
    toast.error('无法确定粘贴目标，图片粘贴失败')
    return
  }
  try {
    // home 用 resolve('~') 权威解析（容器 /home/dev、宿主/服务/SSH 各自的 HOME），
    // 不硬编码——resolve 要求会话在，粘贴场景必然满足。
    const home = (await resolveTermPath(target, props.termId, '~')).path
    const extOf = (t: string) =>
      ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' })[t] ?? 'png'
    const paths: string[] = []
    for (const f of files) {
      const name = `paste-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${extOf(f.type)}`
      const path = `${home}/.claude-pastes/${name}`
      await writeFileBase64(target, path, await fileToBase64(f))
      paths.push(path)
    }
    sendRaw(paths.join(' '))
    toast.success(paths.length === 1 ? `图片已粘贴：${paths[0]}` : `已粘贴 ${paths.length} 张图片到 ${home}/.claude-pastes/`)
  } catch (e) {
    toast.error(`图片粘贴失败：${e instanceof Error ? e.message : String(e)}`)
  }
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
  if (term?.hasSelection()) {
    void copyText(term.getSelection()).then(() => term?.clearSelection())
  } else {
    void pasteClipboard()
  }
}

// —— 手机触屏工具条（重度终端使用的核心补充）——
// 触屏没有右键/Ctrl 组合，复制粘贴/Esc/方向键/Ctrl+C 中断全走这条工具条（模板里 md:hidden）。
// 粘贴优先走 navigator.clipboard.readText；iOS Safari 常态性拒绝读取（需用户手势且默认不授权），
// 拒绝时自动弹兜底输入框——用户在 textarea 里系统级长按粘贴，确认后走同一条 stdin 通道发送。
const pasteFallback = ref(false)
const pasteText = ref('')
const fallbackTa = ref<HTMLTextAreaElement | null>(null)
async function toolPaste() {
  if (navigator.clipboard) {
    try {
      const t = await navigator.clipboard.readText()
      if (t) sendRaw(t)
      return
    } catch {
      /* readText 被拒：开兜底输入框 */
    }
  }
  pasteFallback.value = true // clipboard 不可用（非 https）/被拒：同 pasteClipboard 的兜底
  nextTick(() => fallbackTa.value?.focus())
}
function toolPasteConfirm() {
  if (pasteText.value) sendRaw(pasteText.value)
  pasteText.value = ''
  pasteFallback.value = false
}
// 系统级粘贴（Ctrl+V / 长按）落进 textarea 时 paste 事件自带 clipboardData —— 直接自动发送，
// 不再要求点「发送到终端」；个别环境 paste 事件不带数据时不拦默认行为，让文本进 textarea，
// 由 input(insertFromPaste) 补一枪。两个都扑空才需要手动点按钮（按钮保留作兜底）。
function fallbackSend(text: string) {
  if (!text) return
  sendRaw(text)
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
// 选区状态（候选池「复制」按钮的禁用态用）：term 实例非响应式，选区变化时同步到 ref。
// onSelectionChange 覆盖拖选/清选；工具条渲染期间手动同步一次。
const termHasSel = ref(false)
function syncSel() {
  termHasSel.value = !!term?.hasSelection()
}
// 工具条滚动只动本地 xterm scrollback，不向 PTY 发 PageUp/PageDown：
// 这样翻历史时不会影响正在运行的 TUI/交互程序，也不会被识别成按键。
function toolScroll(pages: number) {
  term?.scrollPages(pages)
}
function toolScrollEnd(top: boolean) {
  if (top) term?.scrollToTop()
  else term?.scrollToBottom()
}
// 真正刷新：本地 buffer 里的行一旦被 reflow/宽字符错位写坏，repaint 只会把坏内容再画一遍。
// 清 buffer 后按 resume=0 重连，服务端 capture-pane 全量回填 + tmux attach 重画当前屏，
// 等价于在终端里 detach/attach 一次。代价是回到最新输出、丢弃本地多出 tmux 的历史。
function refreshTerminal() {
  const currentTerm = term
  if (!currentTerm) return
  // 顺带清一次字形图集，避免 WebGL 图集损坏在重建后继续存在。
  try {
    ;(currentTerm as unknown as TerminalViewportHost)._core?.viewport?.syncScrollArea?.(true)
    webglAddon?.clearTextureAtlas()
  } catch {
    /* 渲染器重建中/上下文丢失时忽略 */
  }
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
  currentTerm.reset()
  backfilled = false
  // buffer 清空后旧横幅已不存在，别再补「已重连」、也别让延迟横幅写进新现场。
  if (closeBannerTimer) {
    clearTimeout(closeBannerTimer)
    closeBannerTimer = null
  }
  closeBannerShown = false
  connState.value = 'ok'
  connectWs(true) // 程序性重连：不要往刚清空的 buffer 写「连接/断开」横幅
  if (!isCoarse.value) {
    suppressFocusEmit = true
    try {
      currentTerm.focus()
    } finally {
      suppressFocusEmit = false
    }
  }
}
// 直发 stdin（与 onData 同通道）：工具条按键/粘贴共用。
function sendRaw(s: string) {
  sendStdin(s)
}
// —— 手机软键盘 + 触屏工具条（usePhoneToolbar 整体归属，边界规则见其头注）——
// 焦点闸 / 键盘态（kbOpen/kbShift）/ 粘滞修饰 / 分页 / 长按连发全在 composable；
// 这里注入终端本体能力（发键/滚动/粘贴/复制/刷新/字号）并保留短语发送
// （工具条短语键与快捷指令面板共用）。
const tb = usePhoneToolbar({
  rootEl,
  el,
  sendRaw,
  emitEnter: () => emit('enter'),
  toolScroll,
  toolScrollEnd,
  toolPaste,
  copySelection: () => {
    if (term?.hasSelection()) void copyText(term.getSelection()).then(() => term?.clearSelection())
  },
  refreshTerminal,
  stepFontSize,
  textarea: () => term?.textarea ?? null,
})
const {
  termFocused,
  kbOpen,
  kbShift,
  kbToolbarTop,
  toolbarEl,
  saveFocusAnchor,
  ctrlSticky,
  altSticky,
  sendToolSeq,
  runKeyBtn,
  tbDown,
  stopRepeat,
  toolPages,
  tbPage,
  settingsOpen,
  cmdsOpen,
  runQuickCmd,
  tbTouchStart,
  tbTouchEnd,
} = tb
function sendSnippet(s: string) {
  sendRaw(s + '\r')
  emit('enter') // 短语多带命令语义，与工具条回车一致走 cwd 跟随
}

// —— 触屏滚动接管（touch 设备）——
// xterm 内建在 bindMouse 里注册的 touchstart/touchmove 滚 viewport 真机上不可靠：touchmove
// 非被动但滚动途中不 preventDefault，浏览器手势判定抢走手势后直接 touchcancel，终端纹丝
// 不动（桌面 wheel 同一注册点，所以桌面无感）。这里 capture 阶段自管：preventDefault 在手
// 保证 touchmove 必达，stopPropagation 防 xterm 内部 handler 双重滚动。touchstart/touchend
// 不截获——点按聚焦、长按等原生行为保持。顺带补惯性滑动（xterm 内建无 momentum，长历史
// 1:1 跟手翻不动）。普通缓冲只动本地 scrollback、不向 PTY 发字节；备用屏 + 应用开鼠标
// 上报时例外——触摸位移转 SGR 滚轮发给应用（见 altWheel/sendWheelRows），否则 claude
// 这类全屏 TUI 在手机上完全没法滚。
//
// ⚠️ 必须走 term.scrollLines()（整行）而不是直改 .xterm-viewport.scrollTop（像素）：xterm 的
// 权威滚动状态是 ydisp（整行坐标），viewport 每次渲染刷新都把 scrollTop 重置回 ydisp × 行高——
// 像素直改会被吃掉、凑满一行才跳一格（实测一卡一卡）。滚轮同理是按行滚动，这里把触摸位移
// 像素累积、凑整行调 scrollLines，与滚轮同路径、无对齐打架。
let touchCleanup: (() => void) | null = null
let momentumRaf = 0
function stopMomentum() {
  if (momentumRaf) cancelAnimationFrame(momentumRaf)
  momentumRaf = 0
}
function setupTouchScroll() {
  const root = el.value
  if (!root) return
  let tracking = false
  let lastY = 0
  let lastT = 0
  let vel = 0 // px/ms，指数平滑后的瞬时速度
  let accPx = 0 // 未凑满整行的像素余量
  const rowHeightOf = (): number => {
    // viewport._currentRowHeight 是 xterm 内部行高（与 scrollTop 同一坐标系）；
    // 内部形状拿不到时用 rows DOM 实测兜底。
    const core = term as unknown as { _core?: { viewport?: { _currentRowHeight?: number } } }
    const h = core?._core?.viewport?._currentRowHeight
    if (h && h > 0) return h
    const rowsEl = term?.element?.querySelector('.xterm-rows') as HTMLElement | null
    return rowsEl && term ? rowsEl.getBoundingClientRect().height / term.rows : 20
  }
  // 像素 → 整行：余量留在 accPx，凑满一行才调 scrollLines（亚行位移不丢，下次继续凑）
  const scrollByPx = (px: number) => {
    accPx += px
    const rows = Math.trunc(accPx / rowHeightOf())
    if (rows !== 0 && term) {
      accPx -= rows * rowHeightOf()
      if (altWheel()) sendWheelRows(rows)
      else term.scrollLines(rows)
    }
  }
  // 备用屏（全屏 TUI）+ 应用开了鼠标上报（claude 开 ?1000h/?1003h/?1006h，实测确认）：
  // 本地 scrollback 没内容可滚（ybase 恒 0），触摸位移转成 SGR 滚轮序列发给 PTY，
  // 让应用自己滚（claude 滚 transcript）——与桌面滚轮同构（xterm 对鼠标追踪中的真实
  // 滚轮就是这么发的）。应用没开鼠标上报时保持 no-op：触摸滚动不该给纯 TUI 发位移。
  const altWheel = (): boolean =>
    !!term &&
    term.buffer.active.type === 'alternate' &&
    term.modes.mouseTrackingMode !== 'none'
  const sendWheelRows = (rows: number) => {
    if (!term) return
    const col = Math.ceil(term.cols / 2)
    const row = Math.ceil(term.rows / 2)
    const btn = rows < 0 ? 64 : 65 // 64=滚轮上（看更早），65=滚轮下
    const n = Math.min(Math.abs(rows), 6) // 惯性高速限流，一次手势别刷爆 PTY
    for (let i = 0; i < n; i++) sendRaw(`\x1b[<${btn};${col};${row}M`)
  }
  const onStart = (e: TouchEvent) => {
    stopMomentum()
    tracking = e.touches.length === 1
    if (!tracking) return
    lastY = e.touches[0].clientY
    lastT = e.timeStamp
    vel = 0
    accPx = 0
  }
  const onMove = (e: TouchEvent) => {
    if (!tracking || e.touches.length !== 1) {
      tracking = false // 多指（双指残留）丢弃，防跳变
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const y = e.touches[0].clientY
    const dy = lastY - y
    const dt = Math.max(1, e.timeStamp - lastT)
    lastY = y
    lastT = e.timeStamp
    if (dy === 0) return
    scrollByPx(dy)
    vel = vel * 0.8 + (dy / dt) * 0.2
  }
  const onEnd = () => {
    if (!tracking) return
    tracking = false
    // 惯性 glide：按毫秒速度外推，指数衰减 τ≈0.3s（每秒剩 3%）——自然减速不急刹
    if (Math.abs(vel) < 0.1) return
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      scrollByPx(vel * dt)
      vel *= Math.pow(0.03, dt / 1000)
      if (Math.abs(vel) > 0.02) momentumRaf = requestAnimationFrame(step)
      else momentumRaf = 0
    }
    momentumRaf = requestAnimationFrame(step)
  }
  root.addEventListener('touchstart', onStart, { capture: true, passive: true })
  root.addEventListener('touchmove', onMove, { capture: true, passive: false })
  root.addEventListener('touchend', onEnd, { capture: true })
  root.addEventListener('touchcancel', onEnd, { capture: true })
  touchCleanup = () => {
    stopMomentum()
    root.removeEventListener('touchstart', onStart, { capture: true })
    root.removeEventListener('touchmove', onMove, { capture: true })
    root.removeEventListener('touchend', onEnd, { capture: true })
    root.removeEventListener('touchcancel', onEnd, { capture: true })
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

// —— 路径链接识别（Ctrl+点击打开）——
// 规则：token 以 / ~/ ./ ../ 开头或恰好是裸 ~；前一字符（若有）必须是空白或 "'=[({<
// 之一（防 URL/普通词中段误配；`?a=/tmp/x` 的 = 后可配是刻意保留——`--out=/path` 场景）；
// 主体字符集 [A-Za-z0-9._~+@%$-] 加 /；结尾剥句读；支持 :行(:列) 后缀（栈跟踪）。
// 明确不匹配：不含 / 的裸文件名（防误报）、// 开头（协议相对 URL）、跨行 wrap、含空格路径。
interface PathToken {
  start: number
  end: number
  path: string
  line?: number
  col?: number
}
const PRE_BOUNDARY = /[\s"'=[({<]/
const TOKEN_CHAR = /[A-Za-z0-9._~+@%$-]/
const TRAIL_PUNCT = /[.,;:)\]"'`]/

function findPathTokens(text: string): PathToken[] {
  const out: PathToken[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '/' && ch !== '~' && ch !== '.') continue
    if (i > 0 && !PRE_BOUNDARY.test(text[i - 1]!)) continue
    let start = -1
    if (ch === '/') {
      if (text[i + 1] === '/') {
        i++ // // 开头 = 协议相对 URL，不碰
        continue
      }
      start = i
    } else if (text.startsWith('~/', i) || text.startsWith('./', i) || text.startsWith('../', i)) {
      start = i
    } else if (ch === '~' && !(text[i + 1] && TOKEN_CHAR.test(text[i + 1]!))) {
      start = i // 裸 ~ = home（~user 形态不支持）
    } else {
      continue
    }
    let j = start + 1
    while (j < text.length && (TOKEN_CHAR.test(text[j]!) || text[j] === '/')) j++
    let raw = text.slice(start, j)
    while (raw.length > 1 && TRAIL_PUNCT.test(raw[raw.length - 1]!)) raw = raw.slice(0, -1)
    if (raw.length < 2 && raw !== '~') continue // 单个 / 噪音太大（散文里的斜杠）
    if (!raw.includes('/') && raw !== '~') continue // 裸文件名不匹配（防误报）
    // :行(:列) 后缀：不在字符集内，须从原文另行消费
    let line: number | undefined
    let col: number | undefined
    const lm = /^:(\d{1,7})(?::(\d{1,7}))?/.exec(text.slice(start + raw.length))
    if (lm) {
      line = Number(lm[1])
      if (lm[2]) col = Number(lm[2])
    }
    const end = start + raw.length + (line !== undefined ? lm![0].length : 0)
    out.push({ start, end, path: raw, line, col })
    i = end - 1
  }
  return out
}

// xterm 5.5 的 CSI S 直接 splice 滚动区行，绕过了 BufferService.scroll 的 scrollback
// 路径：顶部行被丢弃，滚动区外内容也可能被应用重绘后残留/覆盖。这里接管 SU，让它走
// 同一个 buffer 滚动实现——顶部行进 scrollback，滚动区外的固定行保持原位。
type ScrollRegionInputHandler = {
  _activeBuffer?: { scrollTop: number; scrollBottom: number }
  _bufferService?: { isUserScrolling?: boolean; scroll?: (attr: unknown) => void }
  _dirtyRowTracker?: { markRangeDirty?: (start: number, end: number) => void }
  _eraseAttrData?: () => unknown
}

type TerminalViewportHost = {
  _core?: { viewport?: { syncScrollArea?: (immediate?: boolean) => void } }
}

function registerScrollRegionHandler() {
  const currentTerm = term
  if (!currentTerm) return
  currentTerm.parser.registerCsiHandler({ final: 'S' }, (params) => {
    const inputHandler = (
      currentTerm as unknown as { _core?: { _inputHandler?: ScrollRegionInputHandler } }
    )._core?._inputHandler
    const buffer = inputHandler?._activeBuffer
    const bufferService = inputHandler?._bufferService
    const eraseAttrData = inputHandler?._eraseAttrData?.bind(inputHandler)
    const markRangeDirty = inputHandler?._dirtyRowTracker?.markRangeDirty?.bind(
      inputHandler._dirtyRowTracker,
    )
    if (!buffer || !bufferService?.scroll || !eraseAttrData) return false

    const first = params[0]
    const requested = typeof first === 'number' && Number.isFinite(first) && first > 0
      ? Math.floor(first)
      : 1
    const regionHeight = buffer.scrollBottom - buffer.scrollTop + 1
    const count = Math.min(requested, regionHeight)
    if (count <= 0) return false

    for (let index = 0; index < count; index += 1) {
      if (buffer.scrollTop >= buffer.scrollBottom) break
      bufferService.scroll(eraseAttrData())
    }
    markRangeDirty?.(0, currentTerm.rows - 1)
    // BufferService.scroll 已发 scroll 事件，但移动端 DOM 渲染器在软键盘/visualViewport
    // 变化期间可能拿到过期几何。这里幂等强制重算滚动区，并对 DOM 渲染器补一次全量重绘。
    const viewport = (currentTerm as TerminalViewportHost)._core?.viewport
    viewport?.syncScrollArea?.(true)
    if (!webglAddon) currentTerm.refresh(0, currentTerm.rows - 1)
    return true
  })
}

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
    allowProposedApi: true,
    fontFamily: FONT_FAMILY,
    fontSize: computeFontSize(),
    cursorBlink: true,
    // ⚠️ 不开 smoothScrollDuration：它的动画每次 scrollLines 都从当前显示位置重置进度重跑
    // （origin = viewportElement.scrollTop），触摸连发调用下位置逐步落后手指、停手才补跳
    // ——快滑呈「一小块一小块」。行步进的平滑交给 setupTouchScroll 自己的惯性 glide。
    scrollback: 10000, // 回滚行数，与 VSCode 集成终端默认一致（xterm 默认仅 1000）
    theme: { background: '#000000' },
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  search = new SearchAddon({ highlightLimit: 1000 })
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    searchResultIndex.value = resultIndex
    searchResultCount.value = resultCount
  })
  term.loadAddon(search)
  term.loadAddon(new WebLinksAddon())
  term.open(el.value)
  registerScrollRegionHandler()
  // OSC 0/2（窗口标题）：shell 钩子（scripts/zshrc / 宿主 ~/.zshrc 的 preexec/precmd）
  // 与 TUI 应用（CC/opencode）发的标题，经 tmux set-titles on（session 级选项）转发到
  // 这里——ContainerList 拿去更新 tab 标签/popout 窗口标题。plain shell 降级（无 tmux）
  // 时序列直达，同样走这里，链路两种模式天然覆盖。
  term.onTitleChange((t) => emit('title', t.trim()))
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
    emit('cwd', p)
    return true
  })
  // 环境，xclip/wl-copy 全失败，唯一的复制通道就是「请终端代写剪贴板」的 OSC 52。
  // xterm.js 核心不实现它——不接的话应用提示「已复制」但剪贴板纹丝不动（VSCode 终端
  // 实现了 OSC 52，所以同样的 opencode 在 VSCode 里能复制）。
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
      if (text) void copyText(text)
    } catch {
      /* 非法 base64：静默 */
    }
    return true
  })
  // 路径链接 provider（Ctrl+点击打开）。必须在上面 WebLinksAddon 之后注册：xterm 按注册
  // 顺序取第一个命中位置的链接，URL 撞位时归 web-links，别调换顺序。
  // 宽字符映射是核心：translateToString 的字符串索引 ≠ cell 列（CJK 占 2 cell，其后还有
  // 1 个 width=0 的续格），必须 cell walk 建「字符串索引 -> cell 列」映射（xterm 内部
  // web-links 的 _mapStrIdx 同款手法）。
  linkProv = term.registerLinkProvider({    provideLinks(bufferLineNumber, callback) {
      const t = term
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
            emit('link-open', tk.path, tk.line, tk.col)
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
  // 键盘复制/粘贴拦截。返回 false=吞掉（不发 onData）、true=透传给终端。
  //   - Ctrl+Shift+C：复制选中（无选区也不发 ^C，纯复制键不应中断当前命令）。
  //   - Ctrl+V / Ctrl+Shift+V：粘贴（与桌面终端习惯一致；吞掉 ^V，牺牲 shell 的
  //     quoted-insert/literal-next，web 终端场景粘贴远比它常用）。
  //   - Ctrl+C：有选区时复制并清选区、吞掉；无选区时透传发 ^C=SIGINT（必须 return true）。
  //   其余按键一律透传，不影响 vim/less 等正常输入。
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && e.code === 'KeyF' && e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      openSearch()
      return false
    }
    if (e.type === 'keydown' && e.key === 'Escape' && searchVisible.value) {
      e.preventDefault()
      closeSearch()
      return false
    }
    // 粘滞修饰（工具条 Ctrl/Alt 点亮态）+ 软键盘敲的单字符：在这里接管发送——Ctrl 字母
    // → 控制字符、Alt → ESC 前缀（sendToolSeq 消费粘滞），return false 不让 xterm 再
    // 处理一遍（否则字母会原样落屏）。带物理修饰的组合不拦，照常透传。
    // ⚠️ 这只拦得到真实 keydown——Android 软键盘（GBoard 等）敲字母走 composition/IME
    // 通道，keydown 只有 Unidentified，字符经 xterm 处理后从 onData 出来；那条路在
    // term.onData 里兜底消费粘滞（见下），keydown 拦走的不会进 onData，两边不双发。
    if (
      e.type === 'keydown' && (ctrlSticky.value || altSticky.value) &&
      e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey
    ) {
      e.preventDefault()
      sendToolSeq(e.key)
      return false
    }
    if (!(e.ctrlKey && !e.altKey && !e.metaKey)) return true
    if (e.shiftKey && e.code === 'KeyC') {
      if (e.type === 'keydown' && term!.hasSelection()) void copyText(term!.getSelection())
      return false
    }
    // 粘贴：Ctrl+V 和 Ctrl+Shift+V 都匹配（e.code 不区分 shift）。
    // attachCustomKeyEventHandler 对 keydown 和 keyup 各回调一次：不区分 e.type 的话 pasteText
    // 会被调两次（按下 + 抬起）。
    // secure context（https/localhost）：keydown 时手动粘贴并 preventDefault 掉原生 paste，
    // 否则手动 readText + 原生 paste（xterm 内置粘贴）+ keyup 三路叠加 = 粘贴内容 ×3。
    // 非 secure context（http://IP 访问）：navigator.clipboard 不存在，手动路径必落兜底弹框；
    // 而 paste 事件自带 clipboardData、无需任何权限，是浏览器唯一放行的免权限粘贴通道 ——
    // 此时不 preventDefault，让原生 paste 走 xterm 内置粘贴，全程无弹框。
    if (e.code === 'KeyV') {
      if (e.type === 'keydown') {
        if (navigator.clipboard) {
          e.preventDefault()
          void pasteClipboard()
        }
        // 无 clipboard API：不 preventDefault —— 原生 paste 派发给 xterm 内置粘贴完成发送。
      }
      return false // 两种环境都不发 ^V（quoted-insert）；return false 不 preventDefault，见上
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
  const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches ?? false
  const fractionalDpr = window.devicePixelRatio % 1 !== 0
  if (!coarsePointer && !fractionalDpr) {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webglAddon = null
        webgl.dispose()
        term?.refresh(0, term.rows - 1)
        refit()
      })
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
  // ⚠️ 仅在可见时 fit：恢复多个 tab 时非激活组是 display:none 挂载，这里量到的是 NaN/0 尺寸，
  // 别把垃圾值喂给 resize/URL——等激活 refit 或 ResizeObserver 兜底。
  try {
    if (el.value.clientWidth > 0) fit?.fit()
  } catch {
    /* noop */
  }

  // 构建 WS（见下方模块级 connectWs）。懒挂载：非激活 tab（会话恢复时 display:none
  // 挂载）不连，等切到该 tab 时由 active watcher 重连——那时才同步 fit + 拿真实尺寸。
  if (props.active) connectWs()

  term.onData((data) => {
    // 回车即提交命令：上抛给文件面板做即时的 cwd 跟随检查（cd 提交后壳立即改目录，
    // 250ms 后查基本必中）。粘贴多行也含 \r，多抛几次无妨（跟随端去重）。
    // 粘滞修饰兜底（composition 路径见 attachCustomKeyEventHandler 注释）：keydown 拦截
    // return false 后 xterm 不再处理、不会走到这里，所以粘滞态还亮着就说明这次输入绕过
    // 了 keydown——在此消费并改写（Ctrl 逐字符 ctrlify，编码不了的保持原样；Alt 恒 ESC 前缀）。
    // ESC 开头的序列（1004 焦点上报 \x1b[I、鼠标上报、括号粘贴）不是「待修饰的按键」，
    // 不许碰——否则 ctrlify 会把 \x1b[I 改成 \x1b[\t 且白白消费掉粘滞态（vim/claude 开
    // 焦点上报时点 Ctrl 再落焦就是这条雷）。
    let out = data
    if ((ctrlSticky.value || altSticky.value) && !out.startsWith('\x1b')) {
      const withCtrl = ctrlSticky.value
      const withAlt = altSticky.value
      ctrlSticky.value = false
      altSticky.value = false
      if (withCtrl) out = Array.from(out, (ch) => tb.ctrlify(ch) ?? ch).join('')
      if (withAlt) out = '\x1b' + out
    }
    if (data.includes('\r')) emit('enter')
    sendStdin(out)
  })
  term.onResize(({ cols, rows }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    }
  })
  resizeObs = new ResizeObserver(refit)
  resizeObs.observe(el.value)
  // 选区同步：工具条「复制」按钮的禁用态跟随选区（仅手机工具条用，桌面无成本——一行回调）。
  term.onSelectionChange(syncSel)
  // 焦点落位上抛（文件面板跟随最后聚焦的 pane）。xterm 5 公开 API 无 onFocus 事件，
  // 借容器上的 focusin（xterm 隐藏 textarea 的 focus 冒泡上来，DOM focusin 在
  // focus() 调用内同步派发——suppressFocusEmit 开关拦得住）。此处的 mount focus 是
  // 「分屏新 pane / 新组首 pane 拿焦点」——真实落焦，不抑制；refit 的恢复性聚焦已抑制。
  // ⚠️ 首次分屏会把源 pane 的 Terminal 一并重建（根叶子升级 / 换向包裹，模板分支切换），
  // 重建实例的 mount focus 会多出一次老 pane 落焦上抛——ContainerList 的去重窗口按
  // 「分屏新 pane（cwdSourceOf 命中）优先」消解，见 onPaneFocus。
  el.value.addEventListener('focusin', onFocusIn)
  el.value.addEventListener('focusout', onFocusOut)
  // 图片粘贴入口（capture，原因见 onTermPaste 注释）。
  el.value.addEventListener('paste', onTermPaste, { capture: true })
  // 触摸设备不 mount 聚焦（弹系统键盘）：同 refit，键盘只由用户点终端触发。
  if (props.active && !isCoarse.value) term.focus()

  // 软键盘自适应（usePhoneToolbar）：isPhone watch immediate + flush post 自管挂/拆，
  // 设备形态翻转（桌面缩窄）也会补挂，不再依赖挂载时刻的一次性判定。

  // 触屏滚动接管：所有 touch 设备（含平板/触屏本）都挂，鼠标环境零成本（listener 不会被触发）。
  if (navigator.maxTouchPoints > 0 || 'ontouchstart' in window) setupTouchScroll()
  document.addEventListener('visibilitychange', recoverOnReturn)
  window.addEventListener('focus', recoverOnReturn)
  window.addEventListener('online', recoverOnReturn)
  // 交互兜底重连：capture + passive，正常态进来第一个 if 就返回，零成本。
  // pointerdown 覆盖触摸与鼠标（触屏浏览器均派发），keydown 覆盖外接键盘。
  for (const t of ['pointerdown', 'keydown'] as const)
    document.addEventListener(t, recoverOnReturn, { capture: true, passive: true })
})

// 路径链接 tooltip：挂在 term.element 内的动态 DOM（带 xterm-hover class——xterm 的
// mousemove 会沿 composedPath 找到它，视为「仍在链接上」不误触发 leave）。
// pointer-events:none 让它永不抢鼠标事件。leave() 里必须移除：xterm 在行重绘/resize/
// mouseleave/跨 cell 时都会清当前链接。样式在下方非 scoped <style>（动态 DOM 带不上
// Vue scoped 的 data 属性）。
let linkTip: HTMLDivElement | null = null
function showLinkTip(ev: MouseEvent, path: string) {
  const root = term?.element
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

onBeforeUnmount(() => {
  if (rafId) cancelAnimationFrame(rafId)
  if (hbTimer) clearInterval(hbTimer)
  if (inputFlushTimer) clearTimeout(inputFlushTimer)
  if (closeBannerTimer) clearTimeout(closeBannerTimer)
  document.removeEventListener('visibilitychange', recoverOnReturn)
  window.removeEventListener('focus', recoverOnReturn)
  window.removeEventListener('online', recoverOnReturn)
  for (const t of ['pointerdown', 'keydown'] as const)
    document.removeEventListener(t, recoverOnReturn, { capture: true })
  touchCleanup?.()
  resizeObs?.disconnect()
  el.value?.removeEventListener('focusin', onFocusIn)
  el.value?.removeEventListener('focusout', onFocusOut)
  el.value?.removeEventListener('paste', onTermPaste, { capture: true })
  try {
    ws?.close()
  } catch {
    /* noop */
  }
  // 链接 provider 与 tooltip 先于 WebGL addon 拆（同款防御性顺序：term.dispose 会连带
  // 清理，但显式 dispose 保证卸载路径上 tooltip 不残留 DOM）。
  try {
    linkProv?.dispose()
  } catch {
    /* noop */
  }
  hideLinkTip()
  // dispose 顺序：先 addon（WebGL renderer 挂在 term 上，得在 term 还活着时拆），
  // 再 term。反序会触发 term.dispose 内部访问已释放的 renderer -> TypeError。
  try {
    webglAddon?.dispose()
  } catch {
    /* context loss 后再 dispose 偶发报错，忽略 */
  }
  webglAddon = null
  try {
    search?.clearDecorations()
  } catch {
    /* 搜索插件已随终端清理则忽略 */
  }
  try {
    term?.dispose()
  } catch {
    /* noop */
  }
  term = null
  fit = null
  search = null
})
</script>

<template>
  <!-- bg-black + 内边距放外层：el 自身不带 padding，FitAddon 量到的 clientWidth/clientHeight 才是
       真实内容区，否则会多算 ~1 行、末行光标被底部边缘切掉一半。
       overscroll-none：iOS 聚焦终端时防页面整体上滚（终端是 body 内唯一内容，链上加锁即可）。
       手机软键盘弹起时不改 xterm 盒子尺寸（kbShift 只对内层 shift 做整盒上移，见 setupViewportWatch），
       xterm/PTY 的 cols/rows 保持稳定，回滚位置也不会被 resize/reflow 重置。 -->
  <!-- ⚠️ 根容器必须 flex-1 min-h-0 而不是 h-full：叶子是 flex-col（pane 头部 + 本体），
       h-full = 100% 叶子高，加头部后恒溢出一个头高——终端底部会盖住下方文件 tab 栏
       （旧换显布局溢的是黑底看不出来，编辑器+终端分栏后这 22px 正好压住 tab 栏右侧
       按钮）。flex-1 min-h-0 让本体只占头部之外的剩余空间。 -->
  <div ref="rootEl" class="relative min-h-0 flex-1 overflow-hidden bg-black px-2 py-1.5 overscroll-none">
    <!-- touch-none（touch-action: none）：触屏滚终端的唯一正解。xterm 的 touchmove 处理是 JS 驱动
         viewport.scrollTop，但只在回滚区边界才 preventDefault——滚动途中浏览器的原生平移同时在跑，
         而触点不在 .xterm-viewport 滚动层内，原生滚动链直接落到 document：上翻历史（手指下划）时
         document 顶部 overscroll 触发下拉刷新、手势被浏览器抢走。touch-action: none 让终端区域的手势
         完全交给 JS（xterm 自滚），浏览器不再启动原生平移/下拉刷新/双指缩放。中间层挂 overscroll-none
         挡不住这个——touch 侧的原生滚动链跳过 overflow:hidden 的祖先直达 document。 -->
    <div
      class="absolute inset-x-2 top-1.5 bottom-1.5 will-change-transform"
      :style="kbShift > 0 ? { transform: `translate3d(0, -${kbShift}px, 0)` } : undefined"
      @pointerdown.capture="saveFocusAnchor"
    >
      <div ref="el" class="absolute inset-0 touch-none overflow-hidden" @contextmenu.prevent="onContextMenu" />
    </div>
    <!-- 终端搜索：Ctrl+F 打开，Enter/Shift+Enter 跳转，Esc 返回终端。
         浮层用绝对定位，不参与 FitAddon 测量，避免改变终端网格尺寸。 -->
    <div class="search-shell" v-if="searchVisible">
      <div class="search-field">
        <Search class="size-3 shrink-0 text-zinc-500" />
        <input
          ref="searchInput"
          v-model="searchQuery"
          class="search-input"
          :style="{ width: searchInputWidth }"
          placeholder="搜索终端…"
          spellcheck="false"
          @input="runSearch('next')"
          @keydown.enter.prevent="runSearch($event.shiftKey ? 'previous' : 'next')"
          @keydown.esc.stop.prevent="closeSearch"
        />
      </div>
      <div class="search-filters">
        <button type="button" class="search-toggle" :class="{ 'search-on': searchCaseSensitive }" title="区分大小写" :aria-pressed="searchCaseSensitive" @click="searchCaseSensitive = !searchCaseSensitive; runSearch('next')">
          <CaseSensitive class="size-3" />
        </button>
        <button type="button" class="search-toggle" :class="{ 'search-on': searchWholeWord }" title="全字匹配" :aria-pressed="searchWholeWord" @click="searchWholeWord = !searchWholeWord; runSearch('next')">
          <WholeWord class="size-3" />
        </button>
        <button type="button" class="search-toggle" :class="{ 'search-on': searchRegex }" title="正则匹配" :aria-pressed="searchRegex" @click="searchRegex = !searchRegex; runSearch('next')">
          <Regex class="size-3" />
        </button>
      </div>
      <div class="search-meta">
        <span
          class="search-count shrink-0"
          :class="searchResultCount || searchQuery === '' ? 'text-zinc-500' : 'text-amber-400'"
        >
          {{ searchResultCount ? `${searchResultIndex + 1}/${searchResultCount}` : '无匹配' }}
        </span>
        <button type="button" class="search-btn" title="上一个匹配（Shift+Enter）" @click="runSearch('previous')">
          <ChevronUp class="size-3" />
        </button>
        <button type="button" class="search-btn" title="下一个匹配（Enter）" @click="runSearch('next')">
          <ChevronDown class="size-3" />
        </button>
        <button type="button" class="search-btn" title="关闭（Esc）" @click="closeSearch">
          <X class="size-3" />
        </button>
      </div>
    </div>
    <!-- 触屏工具条（手机 only，agent 遥控布局）。
         按钮全部 @pointerdown.prevent：点按钮不抢终端 textarea 焦点（否则软键盘收起→refit 的
         term.focus() 又抢回 = 键盘闪一下，且正在输入的 composition 被中断吞字——粘滞 Ctrl 后
         敲字母不响应就是它）。prevent 不影响 click 派发，各按钮 @click 照常工作。
         按钮全可配置（⋯ 设置弹窗编排，存 lib/termToolbar.ts 模块级状态 + localStorage），7 列 grid 自然换行（对齐 Termux 一行 7 键）——
         「哪个键高频」由使用者编排，代码不硬编码。预置布局 = Termux 默认 extra-keys 两行
         （ESC / - HOME ↑ END 上页 / Tab Ctrl Alt ← ↓ → 下页）+ ⏎ ⇥。Ctrl/Alt 是粘滞修饰
         （点亮→下一个键带修饰发出→用掉即灭，可叠加 C-M-x；软键盘单字符在
         attachCustomKeyEventHandler 接管）。Esc 中断（红色加重）/ ↑↓ 菜单与输入历史（长按连发）/
         快捷短语（一键文本+回车）/「指令」快捷指令面板（命名命令列表，点条目 = 整条命令+回车，
         管理态增删改，数据 lib/termQuickCmds.ts）。滑屏滚动的是本地回滚缓冲，↑↓ 是发给程序的输入
         （agent 菜单/全屏 TUI 唯一导航方式）——两者语义不同。工具条固定 2 行 × 7 列为
         一页，键多时整个卡片横向轻扫翻页（页点指示器标位），⋯ 设置入口是列表末项
         参与分页。桌面不渲染。工具条是「键盘态 + 本实例持焦」双闸覆盖层——始终渲染以便
         测量高度，但平时不可见，且不参与终端盒子布局。焦点闸必须：终端组件按组/分屏
         多实例常驻，kbOpen（window.visualViewport）是全局信号、所有实例同时为真，
         而工具条 Teleport 到 body 不受源组件 v-show 约束——不按焦点收敛的话多实例
         工具条会全部显形精确叠放，tap 落到 DOM 末尾实例（不一定是眼前终端），其 WS
         已 detach，输入进 pendingInput 无声黑洞（表现：软键盘字母正常、快捷键全灭）。
         显隐/键盘态/粘滞/分页逻辑全部归属 composables/usePhoneToolbar.ts（通用规则见
         docs/architecture/web.md「Teleport 覆盖层归属」）。
         -->
    <Teleport to="body">
      <div
        v-if="isPhone"
        ref="toolbarEl"
        class="fixed inset-x-2 z-[80] select-none overflow-hidden border-t border-zinc-800 bg-black pt-1 transition-opacity md:hidden"
        :class="kbOpen && termFocused ? 'opacity-100' : 'pointer-events-none invisible opacity-0'"
        :style="kbOpen && termFocused ? { top: `${kbToolbarTop}px` } : undefined"
        @touchstart="tbTouchStart"
        @touchend="tbTouchEnd"
      >
      <!-- 分页轨道：每页固定 2 行 × 7 列，横向轻扫翻页（手势见脚本 tbTouchStart/End） -->
      <div
        class="flex transition-transform duration-200 ease-out"
        :style="{ width: `${toolPages.length * 100}%`, transform: `translateX(-${(tbPage * 100) / toolPages.length}%)` }"
      >
        <div v-for="(pg, pi) in toolPages" :key="pi" class="grid shrink-0 grid-cols-7 gap-1" :style="{ width: `${100 / toolPages.length}%` }">
          <template v-for="(b, bi) in pg" :key="b.t === 'key' ? `k:${b.id}` : b.t === 'custom' ? `c:${b.label}` : b.t === 'settings' ? 'settings' : b.t === 'cmds' ? 'cmds' : `s:${b.text}:${pi}:${bi}`">
            <button
              v-if="b.t === 'key'"
              type="button" class="tb" :class="{ 'tb-esc': b.id === 'esc', 'tb-on': (b.id === 'ctrl' && ctrlSticky) || (b.id === 'alt' && altSticky) }"
              :disabled="b.id === 'copy' && !termHasSel"
              :title="KEY_POOL[b.id]?.title"
              @pointerdown.prevent="tbDown(b)" @pointerup="stopRepeat" @pointercancel="stopRepeat" @pointerleave="stopRepeat" @contextmenu.prevent
              @click="runKeyBtn(b.id)"
            >{{ KEY_POOL[b.id]?.label }}</button>
            <button
              v-else-if="b.t === 'custom'"
              type="button" class="tb overflow-hidden text-ellipsis whitespace-nowrap" :title="`发送自定义按键「${b.label}」`"
              @pointerdown.prevent @click="sendToolSeq(b.seq)"
            >{{ b.label }}</button>
            <button
              v-else-if="b.t === 'cmds'"
              type="button" class="tb" title="快捷指令：点开列表，一键发送整条命令并回车" @pointerdown.prevent @click="cmdsOpen = true"
            >指令</button>
            <button
              v-else-if="b.t === 'settings'"
              type="button" class="tb" :class="{ 'tb-on': settingsOpen }" title="工具条按钮设置：增删 / 调序 / 快捷短语" @pointerdown.prevent @click="settingsOpen = true"
            >⋯</button>
            <button
              v-else
              type="button" class="tb overflow-hidden text-ellipsis whitespace-nowrap" :title="`发送「${b.text}」并回车`"
              @pointerdown.prevent @click="sendSnippet(b.text)"
            >{{ b.text }}</button>
          </template>
        </div>
      </div>
      <!-- 页点指示器（仅多页时出现） -->
      <div v-if="toolPages.length > 1" class="mt-1 flex justify-center gap-1.5 pb-0.5">
        <span v-for="i in toolPages.length" :key="i" class="size-1.5 rounded-full transition-colors" :class="i - 1 === tbPage ? 'bg-zinc-400' : 'bg-zinc-700'" />
      </div>
      </div>
    </Teleport>
    <ToolbarSettingsDialog v-if="settingsOpen" @close="settingsOpen = false" />
    <!-- 快捷指令面板：浏览态点条目 = sendSnippet（命令 + 回车 + cwd 跟随）并收起；管理态增删改。
         数据 localStorage（lib/termQuickCmds.ts），多终端实例共享同一份。 -->
    <QuickCmdsSheet v-model:open="cmdsOpen" @run="runQuickCmd" />
    <!-- 粘贴兜底输入：浏览器剪贴板 API 不可用/被拒时自动弹（桌面 http://IP 访问、Firefox
         readText 拒绝、iOS Safari 均落这里）。textarea 里系统级粘贴（Ctrl+V / 长按）不走
         clipboard API，永远可用；@paste/@input 捕获到粘贴动作即自动发送，按钮仅作兜底。 -->
    <div v-if="pasteFallback" class="absolute inset-x-0 bottom-0 z-20 flex flex-col gap-2 rounded-t-lg border-t border-zinc-700 bg-zinc-900 p-3 pb-safe">
      <p class="text-xs text-zinc-500">桌面浏览器可直接在终端里 Ctrl+V 粘贴，无需此框。</p>
      <textarea
        ref="fallbackTa"
        v-model="pasteText"
        class="h-24 w-full resize-none rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-sm text-zinc-100"
        placeholder="在此粘贴内容（Ctrl+V / 长按）…"
        @paste="onFallbackPaste"
        @input="onFallbackInput"
      />
      <div class="flex justify-end gap-2">
        <button type="button" class="tb" @click="pasteFallback = false; pasteText = ''">取消</button>
        <button type="button" class="tb tb-on" @click="toolPasteConfirm">发送到终端</button>
      </div>
    </div>
    <!-- 断线覆盖条：非正常断开时显示，点击重连（termId 不变 -> 回到同一 tmux 会话） -->
    <button
      v-if="connState === 'lost'"
      class="absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-2 bg-amber-500/90 px-3 py-1 text-xs font-medium text-black"
      @click="reconnect(true)"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-black" />
      连接已断开 · 点击重连
    </button>
  </div>
</template>

<style>
/* 触屏工具条按钮：紧凑但命中区 ≥40px（高度 h-9），等宽字排布稳定。
   user-select/callout：长按连发期间不能弹出系统选择/放大镜；touch-action:manipulation
   消双击缩放延迟（主行固定不滚，无横滚冲突）。 */
.tb {
  height: 2.25rem;
  min-width: 2.5rem;
  padding: 0 0.5rem;
  flex-shrink: 0;
  border-radius: 0.375rem;
  border: 1px solid #3f3f46;
  background: #18181b;
  color: #d4d4d8;
  font-size: 12px;
  font-family: var(--font-mono), ui-monospace, monospace;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  touch-action: manipulation;
}
/* Esc = agent 中断键，视觉加重（红色系），主行 flex-1 拉出大命中面。 */
.tb-esc {
  border-color: #7f1d1d;
  background: #2a1215;
  color: #fca5a5;
  font-weight: 600;
}
.tb-esc:active {
  background: #451a1d;
}
.tb:active {
  background: #27272a;
}
.tb:disabled {
  opacity: 0.35;
}
.tb-on {
  border-color: #f59e0b;
  color: #fbbf24;
}
/* 终端搜索：单行控件。渐变和内高光让浮层在纯黑终端上有清晰的边界层次。 */
.search-shell {
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
  z-index: 30;
  width: fit-content;
  max-width: min(19rem, calc(100% - 1rem));
  min-width: min(12rem, calc(100% - 1rem));
  display: grid;
  grid-template-columns: auto auto auto auto;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem;
  border: 1px solid rgba(63, 63, 70, 0.65);
  border-radius: 0;
  background: linear-gradient(180deg, rgba(24, 24, 27, 0.96), rgba(9, 9, 11, 0.96));
  box-shadow: 0 16px 36px -18px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.04);
  backdrop-filter: blur(18px) saturate(1.1);
}
.search-field {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.25rem;
  height: 1.5rem;
  padding: 0 0.25rem 0 0.375rem;
  border-radius: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.38);
  background: transparent;
  transition: border-color 140ms ease;
}
.search-field:focus-within {
  border-bottom-color: #ffffff;
}
.search-input {
  min-width: 0;
  max-width: 100%;
  height: 100%;
  border: 0;
  outline: none;
  background: transparent;
  color: #f4f4f5;
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: 11px;
}
.search-input::placeholder {
  color: #52525b;
}
.search-meta {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  height: 1.5rem;
}
.search-count {
  min-width: 2rem;
  text-align: center;
  font-size: 9px;
  font-weight: 500;
}
.search-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 0.1875rem;
  color: #a1a1aa;
  transition: background-color 120ms ease, color 120ms ease;
}
.search-btn:hover {
  background-color: #27272a;
  color: #e4e4e7;
}
.search-filters {
  display: inline-flex;
  flex-shrink: 0;
  gap: 0.125rem;
  padding: 0.125rem;
  border-radius: 0;
  background: rgba(9, 9, 11, 0.72);
}
.search-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 0.1875rem;
  color: #71717a;
  transition: background-color 120ms ease, color 120ms ease;
}
.search-toggle:hover {
  background-color: #27272a;
  color: #e4e4e7;
}
.search-on {
  background-color: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}
.search-on:hover {
  background-color: rgba(245, 158, 11, 0.2);
  color: #fcd34d;
}
/* 路径链接 tooltip：动态创建挂在 term.element 内，Vue scoped 样式够不着，用全局类名。 */
.ms-term-link-tip {
  position: fixed;
  z-index: 50;
  pointer-events: none; /* 不抢鼠标事件：hover 不会被自己打断，也无需担心挡住点击 */
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid #3f3f46;
  border-radius: 4px;
  background: #18181b;
  color: #d4d4d8;
  padding: 2px 6px;
  font-size: 11px;
  font-family: var(--font-mono), ui-monospace, monospace;
}
</style>
