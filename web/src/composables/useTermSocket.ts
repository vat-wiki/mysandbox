// 终端 WS 生命周期（从 Terminal.vue 抽出，2026-10-26）：建连/重连/detach/心跳、stdin
// 闸门与暂存、断线横幅、历史回填锚点、后端选路（tmux/msmux）。组件只保留 xterm 实例与
// 渲染相关的接线，这里不 import 任何 UI 组件。
//
// 协议形状（两侧共用）：二进制帧 = 终端流；文本帧 = 控制帧（history / history-delta /
// modes / title / cwd / foreground / exit / error）。
import { ref } from 'vue'
import type { Terminal as XTerm } from '@xterm/xterm'
import { authToken } from '@/lib/api'
import { muxAgentAvailable } from '@/lib/mux'
import { applyHistoryDelta } from '@/lib/termScreen'
import { noteTermOutput } from '@/lib/terminalActivity'

export interface TermSocketProps {
  id?: string
  name: string
  termId: string
  shell?: string
  active?: boolean
  host?: boolean
  service?: string
  ssh?: string
  fromTermId?: string
  backend?: 'tmux' | 'msmux'
}

/** 连接生命周期里需要上抛的事件（组件转成 defineEmits）。 */
export interface TermSocketEvents {
  backend(backend: 'tmux' | 'msmux'): void
  title(title: string): void
  cwd(path: string): void
  foreground(command: string): void
  ready(): void
}

export interface TermSocketDeps {
  props: TermSocketProps
  events: TermSocketEvents
  term: () => XTerm | null
  /** 恢复会话的叶子 termId（注入的 RESTORED_TERM_IDS）：恢复出来的重连不写「连接」横幅 */
  restoredTermIds: Set<string>
}

export function useTermSocket(deps: TermSocketDeps) {
  const { props, events } = deps
  const term = () => deps.term()

  // 断线状态（终端上方覆盖条用）：'ok' | 'lost' | 'connecting'。TCP 半开（后端挂死/NAT
  // 超时）时 onclose 不会触发，靠心跳探测置 lost。会话在后端无限期保留（真 tmux 语义），
  // 重连即恢复。'connecting' = 重连在建（含服务端 attach/自动部署窗口）：隧道接入时这段
  // 要 1.5~2s 且画面全程冻结，没有这条反馈用户只能看到「卡死」（2026-10-29）。
  const connState = ref<'ok' | 'lost' | 'connecting'>('ok')

  let connectSeq = 0
  let ws: WebSocket | null = null
  // 当前连接是否程序性静默（tab 切换的 detach/attach 路径）：onopen/onclose 不写 banner。
  // 共享可变量而非闭包捕获：detach 要让「已存在连接」的 onclose 也静默，只能事后改标记。
  let wsQuiet = false
  let hbTimer: ReturnType<typeof setInterval> | null = null
  // tmux 历史回填只做一次（组件首连）：reconnect 时 term 实例还在、scrollback 已有内容，
  // 再回填会重复整段历史。断线期间产生的输出留在 tmux 历史里滚不到（可接受的缺口）。
  let backfilled = false
  let closeBannerTimer: ReturnType<typeof setTimeout> | null = null
  let closeBannerShown = false
  let readySent = false
  // 本组件是否已成功建过连（onopen 置位）：重连/刷新/懒挂载补连才显示「重连中」覆盖条，
  // 首连（页面加载/新开终端）画面本来就在加载中，不需要额外状态条。
  let hadConnection = false
  let currentBackend: 'tmux' | 'msmux' = 'tmux'
  // msmux 最新前台进程名；断线/重连后由 attach 元数据恢复。
  let foregroundCommand = ''

  // attach 完成前的 stdin 暂存：服务端 /ws/* 在 attach 未完成时会丢弃二进制帧（mux 侧
  // sid==null 直接 return），建连窗口内用户敲的键就无声消失。入队等首帧（history/输出）
  // 到达即 flush——顺序保真，窗口通常 <300ms；再加 2s 兜底定时器，防「会话永远无输出」
  // 时输入滞留。
  let pendingInput: string[] = []
  let inputReady = false
  let inputFlushTimer: ReturnType<typeof setTimeout> | null = null
  // shell 退出（mux {type:'exit'} 帧）：置位后 onclose 不再写「已断开 (1000)」——
  // 会话结束是正常路径，不是断线，提示语也不同。
  let sessionEnded = false
  const PENDING_INPUT_MAX = 512

  function queueStdin(s: string) {
    pendingInput.push(s)
    if (pendingInput.length > PENDING_INPUT_MAX) pendingInput.splice(0, pendingInput.length - PENDING_INPUT_MAX)
  }
  // 发 stdin 的唯一出口：attach 未完成先入队。onData / sendRaw / 粘贴全走这里。
  // 连接不在 OPEN（重连空窗：旧 socket CLOSING、新 socket 未建 / CONNECTING / 首帧未到）
  // 一律入队而不是丢弃——手机回前台、agent 断连重连的窗口里敲的键曾经被这里无声吃掉
  //（表现就是「重连后快捷键/输入无效」）。上限兜底：连接死透（服务端不可达）时不无限积压。
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

  // 建 WS 连接（含事件挂接与心跳）。断线重连（reconnect）、tab 激活懒挂载与首连共用。
  // termId 不变 -> 后端 attach 回同一会话（无限期保留，直到显式 ✕ 或 shell 退出）。
  // quiet：程序性连接/断开（tab 切换的 detach/attach）不打 banner——每次切 tab 都写
  // 「>> 连接/>> 已断开」两行会把 scrollback 刷成切换日志；意外断线路径照常提示。
  async function connectWs(quiet = false) {
    const seq = ++connectSeq
    wsQuiet = quiet
    // 重连在建即置 connecting（清掉 lost 覆盖条、亮出「重连中」）：服务端 attach/自动
    // 部署窗口可能长达数秒，覆盖条留着直到首帧到达。首连不置（hadConnection 为假）。
    if (hadConnection) connState.value = 'connecting'
    const token = authToken()
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    // SSH 远端 shell 由远端自己决定（不传 shell）；其余目标沿用 defaultShell。
    const shell = props.ssh ? '' : props.shell || 'zsh'
    const target = muxTargetOf()
    const useMux = await muxAgentAvailable(target, props.backend)
    currentBackend = useMux ? 'msmux' : 'tmux'
    // 等在线探测期间组件可能已被切走/重建：过期连接直接作废。
    if (seq !== connectSeq || !props.active) return
    const t = term()
    const cols = t ? t.cols : 80
    const rows = t ? t.rows : 24
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
    const sock = ws
    ws.binaryType = 'arraybuffer'
    // 每条连接重置 stdin 闸门与会话结束标记：pendingInput 跨连接保留（建连窗口的击键
    // 不因重连丢失），inputReady 等新连接首帧再打开。
    inputReady = false
    sessionEnded = false
    if (inputFlushTimer) clearTimeout(inputFlushTimer)
    inputFlushTimer = setTimeout(markInputReady, 2_000)

    ws.onopen = () => {
      // 不在这里置 'ok'：mux 路径 onopen（升级完成）后服务端还要 attach/可能自动部署
      // 才有首帧，connecting 覆盖条要留到 onmessage 首帧才收。
      hadConnection = true
      // 重连成功：取消未落笔的断线横幅；若横幅已写出（慢重连），补一行「已重连」闭环，
      // 别让回滚末尾那行「已断开 (1006)」成了最后状态。
      if (closeBannerTimer) {
        clearTimeout(closeBannerTimer)
        closeBannerTimer = null
      }
      if (closeBannerShown) {
        closeBannerShown = false
        term()?.writeln('\x1b[2m>> 已重连\x1b[0m')
      }
      const label = useMux ? 'msmux' : shell
      // 横幅只在「新建终端的首连」写一次：恢复布局出来的重连（wsQuiet 或 termId 属
      // RESTORED_TERM_IDS）一律静默，避免刷新/回前台时 scrollback 被连接日志刷花。
      if (!wsQuiet && !deps.restoredTermIds.has(props.termId)) {
        term()?.writeln(`\x1b[2m>> 连接 ${props.name}${label ? ` (${label})` : ''}\x1b[0m`)
      }
      events.backend(useMux ? 'msmux' : 'tmux')
    }
    ws.onmessage = (ev) => {
      // 刷新/重建连接时旧 socket 可能还有排队消息先到：丢弃，别写进刚 reset 的 buffer。
      if (ws !== sock) return
      // 文本帧 = 服务端控制帧（二进制才是终端流）。目前只有 history：tmux pane 历史回填
      //（后端 attach 前 capture-pane 发来），写入 scrollback 后 tmux 整屏重绘落在空视口上。
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
              const cur = term()
              if (m.text) cur?.write(m.text.split('\n').join('\r\n') + '\r\n'.repeat(cur.rows))
            }
          } else if (m.type === 'history-delta' && m.text) {
            // 重连增量：补断线窗口期内错过的输出（锚点去重，见 applyHistoryDelta）。
            applyHistoryDelta(term(), m.text)
          } else if (m.type === 'modes' && m.text) {
            // msmux resume 补发终端输入模式（?1000/?1003/?1006 鼠标上报、?2004 括号粘贴）：
            // 断线窗口内 app 改过模式就靠这帧重同步。触屏滚动的 SGR 滚轮转换
            //（setupTouchScroll altWheel）依赖 xterm 的 mouseTrackingMode，缺了它 claude
            // 在手机上没法滚。首次 attach 的模式随首屏 Data 帧来，不经此分支。
            term()?.write(m.text)
          } else if (m.type === 'title' && typeof m.text === 'string') {
            // 重连/刷新后的标题恢复：pane title 留在 tmux 里不会随 attach 重发（历史回填
            // 只有可见文本），服务端 attach 前读 #T 补发此帧（terminal.ts / hostTerminal.ts）。
            events.title(m.text)
          } else if (m.type === 'cwd' && typeof m.text === 'string' && m.text) {
            events.cwd(m.text)
          } else if (m.type === 'foreground' && typeof m.text === 'string') {
            foregroundCommand = m.text
            events.foreground(m.text)
          } else if (m.type === 'error' && typeof m.text === 'string' && m.text) {
            // 服务端 attach 失败（agent 未连接/会话名非法/create 失败）：随后就是 1011，
            // close code 本身不带原因——不消费这帧，用户只能看到无来由的「已断开 (1011)」。
            term()?.writeln(`\x1b[31m>> ${m.text}\x1b[0m`)
          } else if (m.type === 'exit') {
            // shell 退出（mux）：会话本体终结，是正常路径不是断线。写明示语并拦下 onclose
            // 的「已断开 (1000)」；quiet（程序性重连）也要写——否则终端静默变死、输入无声丢弃。
            sessionEnded = true
            term()?.writeln('\x1b[2m>> 会话已结束（shell 退出）；点击重连会开新会话\x1b[0m')
          }
          // 控制帧是 attach 完成后的随附物（history/title/cwd/foreground 都在 attach 成功
          // 后补发）：到此即可放行 stdin。error 帧的下一步是 1011，不开闸——连接状态留给
          // onclose 置 lost（error 之后必是 1011/1008，不会停在 connecting）。
          if (m.type !== 'error') {
            connState.value = 'ok'
            markInputReady()
          }
        } catch {
          /* 非法控制帧忽略 */
        }
        return
      }
      // 终端数据帧 = 有输出：登记最后输出时刻（「无输出提醒」用，见 lib/terminalActivity）。
      // 非激活 tab 已 detach（懒挂载）不再收流，登记只对当前激活 tab 生效；历史回填（文本帧）
      // 不算。prime 窗口内的帧只点亮光晕、不进提醒资格（attach 重绘/初始 prompt 是打开自带画面）。
      connState.value = 'ok'
      noteTermOutput(props.termId)
      const bytes = new Uint8Array(ev.data as ArrayBuffer)
      term()?.write(bytes)
      if (!readySent) {
        readySent = true
        events.ready()
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
          term()?.writeln(`\x1b[2m>> 已断开 (${code})\x1b[0m`)
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
        const cur = term()
        ws.send(cur ? JSON.stringify({ type: 'resize', cols: cur.cols, rows: cur.rows }) : '')
      } catch {
        connState.value = 'lost'
      }
    }, 15_000)
  }

  // 断线重连：卸掉旧 WS 重建。termId 不变 -> 后端 attach 回同一会话（无时限保留），
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
    void connectWs(quiet)
  }

  // 程序性 detach（tab 切走）：只关连接，不杀会话，也不写横幅。
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

  // 真刷新（组件已清掉本地 buffer）：关连接 + 丢掉回填锚点 + 按 resume=0 重连，
  // 由服务端重发全量历史与当前屏重绘。
  function refresh() {
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
    backfilled = false
    // buffer 清空后旧横幅已不存在，别再补「已重连」、也别让延迟横幅写进新现场。
    if (closeBannerTimer) {
      clearTimeout(closeBannerTimer)
      closeBannerTimer = null
    }
    closeBannerShown = false
    void connectWs(true) // 程序性重连：不要往刚清空的 buffer 写「连接/断开」横幅
  }

  // 关闭 tab 时断 socket（真杀会话由父组件走 HTTP）：socket 存在时顺手补一发 kill
  //（服务端当墓碑，覆盖 attach 飞行中 HTTP kill 先到的竞态），然后断开。
  function killSocket() {
    const sock = ws
    if (sock) {
      const send = () => {
        try {
          sock.send(JSON.stringify({ type: 'kill' }))
        } catch {
          /* socket 已关：HTTP 端点那条路负责真杀 */
        }
        try {
          sock.close(1000)
        } catch {
          /* noop */
        }
      }
      if (sock.readyState === WebSocket.OPEN) send()
      // 建连窗口（含自动部署）：open 后立刻补发；连接失败则随 socket 一起丢弃，
      // 会话由父组件的 HTTP kill 兜底。
      else if (sock.readyState === WebSocket.CONNECTING) sock.addEventListener('open', send, { once: true })
    }
    ws = null
    if (hbTimer) {
      clearInterval(hbTimer)
      hbTimer = null
    }
  }

  function sendResize(cols: number, rows: number) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols, rows }))
  }

  /** 切回本 tab 时用：没有 socket 或已 CLOSING/CLOSED 就补一次静默连接（CONNECTING 不重入）。 */
  function ensureConnected() {
    if (ws && ws.readyState <= WebSocket.OPEN) return
    void connectWs(true)
  }

  /** 组件卸载：清计时器 + 断 socket，并作废在途 connectWs（seq 自增）。 */
  function dispose() {
    connectSeq += 1
    if (hbTimer) {
      clearInterval(hbTimer)
      hbTimer = null
    }
    if (inputFlushTimer) {
      clearTimeout(inputFlushTimer)
      inputFlushTimer = null
    }
    if (closeBannerTimer) {
      clearTimeout(closeBannerTimer)
      closeBannerTimer = null
    }
    try {
      ws?.close()
    } catch {
      /* noop */
    }
    ws = null
  }

  return {
    connState,
    connect: connectWs,
    reconnect,
    ensureConnected,
    detachWs,
    recoverOnReturn,
    refresh,
    killSocket,
    dispose,
    sendStdin,
    sendResize,
    isOpen: () => !!ws && ws.readyState === WebSocket.OPEN,
    backend: () => currentBackend,
    foreground: () => foregroundCommand,
  }
}
