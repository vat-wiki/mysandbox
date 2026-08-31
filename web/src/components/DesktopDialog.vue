<script setup lang="ts">
// 容器桌面查看器：Xvfb+XFCE+x11vnc 容器栈经 /ws/desktop-vnc（RFB 透传）接 noVNC 渲染。
// 两段式连接：先连 /ws/desktop（控制流，文本帧 JSON）等 ensure 完成——期间展示安装/启动
// 进度（首次可能要装几分钟包）；收到 {type:'ready'} 再 new RFB() 连 RFB 流（纯二进制）。
//
// 窗口形态：按「远程桌面客户端窗口」设计——零内边距，三段式窗口 chrome：
// 细工具栏（图标徽标 + 名称 + 状态点 + 铺满/关闭）→ 纯黑贴合画布 → 细状态条。
// 可拖边缘/四角改大小（8 向手柄），铺满/双击工具栏切换。尺寸（w/h）持久化在 localStorage，
// 位置不持久——默认居中，第一次拖动后按「固定左上角」跟随（见 startResize）。
// 分辨率固定于连接时（Xvfb 不动态改屏），窗口尺寸变化时画布经 scaleViewport 等比缩放适配。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import RFB from '@novnc/novnc/core/rfb.js'
import { Maximize2, Minimize2, Monitor, MonitorX, X } from 'lucide-vue-next'
import { getToken } from '@/lib/api'
import { isPhone } from '@/composables/useDevice'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'

const props = defineProps<{ containerId: string; containerName: string }>()
const emit = defineEmits<{ (e: 'close'): void }>()

type Phase = 'connecting' | 'preparing' | 'ready' | 'disconnected'
const phase = ref<Phase>('connecting')
const progressMsg = ref('连接容器…')
const errMsg = ref('')

const canvasWrap = ref<HTMLElement | null>(null)
let ctrl: WebSocket | null = null
let rfb: RFB | null = null
let disposed = false

// —— 窗口尺寸/铺满状态 ——
const MIN_W = 480
const MIN_H = 360
const SIZE_KEY = 'mysandbox.desktopDialog.size'
const size = ref<{ w: number; h: number } | null>(null)
const pos = ref<{ x: number; y: number } | null>(null) // null = 居中（走基础类的 translate 居中）
const maximized = ref(false)

const contentStyle = computed<Record<string, string>>(() => {
  const s: Record<string, string> = {}
  if (isPhone.value) {
    // 手机：直接按铺满语义渲染（100dvh 全屏），不进 resize/restore 那套——
    // MIN_W=480 的 clamp 会把 480px 最小宽强加给 375px 视口导致横向溢出。
    s.left = '0px'
    s.top = '0px'
    s.width = '100vw'
    s.height = '100dvh'
    s.borderRadius = '0px'
  } else if (maximized.value) {
    s.left = '0px'
    s.top = '0px'
    s.width = '100vw'
    s.height = '100vh'
    s.borderRadius = '0px'
  } else if (size.value) {
    s.width = `${size.value.w}px`
    s.height = `${size.value.h}px`
    if (pos.value) {
      // 一旦拖过，锚定左上角（居中的 translate 会让拖动双向对称生长，手感不对）
      s.left = `${pos.value.x}px`
      s.top = `${pos.value.y}px`
    }
  }
  return s
})

// 有显式位置（拖过或铺满）时压掉基础类的居中 translate。用 !important 的 class 而非
// inline transform：reka-ui 动画结束会清 inline style，transform:none 会被一起抹掉（实测）。
const anchored = computed(() => isPhone.value || maximized.value || !!pos.value)

// 工具栏/状态条的文案与状态点。状态点放标题旁（视频会议式「在线点」），细节沉到状态条。
const statusMeta = computed(() => {
  switch (phase.value) {
    case 'ready':
      return { dot: 'bg-emerald-500', short: '已连接', long: '已连接 · 关闭窗口不结束桌面，重开秒连' }
    case 'connecting':
      return { dot: 'animate-pulse bg-amber-400', short: '连接中', long: progressMsg.value }
    case 'preparing':
      return { dot: 'animate-pulse bg-amber-400', short: '准备中', long: progressMsg.value }
    case 'disconnected':
      return { dot: 'bg-red-500/80', short: '未连接', long: '未连接' }
  }
})

// 工具栏图标按钮统一样式（铺满 / 关闭共用）
const toolBtn
  = 'grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'

function toggleMax(): void {
  maximized.value = !maximized.value
  if (!maximized.value) pos.value = null // 还原后回居中（记住的尺寸保留）
}

// 双击工具栏空白处铺满/还原；落点在按钮上时不触发（双击铺满按钮 = click×2 + dblclick，会多切一次）
function onToolbarDblclick(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest('button')) return
  toggleMax()
}

// 8 向手柄的位置/光标。手柄贴在 DialogContent 边缘（absolute，z 高于画布）。
function handleClass(d: string): string {
  const map: Record<string, string> = {
    n: '-top-1 left-3 right-3 h-2 cursor-ns-resize',
    s: '-bottom-1 left-3 right-3 h-2 cursor-ns-resize',
    e: '-right-1 top-3 bottom-3 w-2 cursor-ew-resize',
    w: '-left-1 top-3 bottom-3 w-2 cursor-ew-resize',
    ne: '-top-1.5 -right-1.5 size-3 cursor-nesw-resize',
    sw: '-bottom-1.5 -left-1.5 size-3 cursor-nesw-resize',
    nw: '-top-1.5 -left-1.5 size-3 cursor-nwse-resize',
    se: '-bottom-1.5 -right-1.5 size-3 cursor-nwse-resize',
  }
  return map[d]
}
const HANDLES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function startResize(e: PointerEvent, dir: string): void {
  if (maximized.value) return
  e.preventDefault()
  const root = (e.target as HTMLElement).closest('[data-slot=dialog-content]') as HTMLElement | null
  if (!root) return
  const rect = root.getBoundingClientRect()
  const startX = e.clientX
  const startY = e.clientY
  const move = (ev: PointerEvent): void => {
    const dx = ev.clientX - startX
    const dy = ev.clientY - startY
    let w = rect.width
    let h = rect.height
    if (dir.includes('e')) w = rect.width + dx
    if (dir.includes('w')) w = rect.width - dx
    if (dir.includes('s')) h = rect.height + dy
    if (dir.includes('n')) h = rect.height - dy
    // clamp：不小于最小可用，也不溢出视口
    w = Math.round(Math.max(MIN_W, Math.min(w, innerWidth - 16)))
    h = Math.round(Math.max(MIN_H, Math.min(h, innerHeight - 16)))
    let x = rect.left
    let y = rect.top
    if (dir.includes('w')) x = rect.right - w // 左/上向拖动时固定右/下边缘
    if (dir.includes('n')) y = rect.bottom - h
    size.value = { w, h }
    pos.value = { x, y }
    try {
      localStorage.setItem(SIZE_KEY, JSON.stringify({ w, h }))
    } catch {
      /* noop */
    }
  }
  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function wsUrl(path: string, extra: Record<string, string>): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const q = new URLSearchParams({ id: props.containerId, token: getToken() ?? '', ...extra })
  return `${proto}://${location.host}${path}?${q}`
}

// 分辨率：连接时按视口估一个（clamp 到 640x480–2560x1600，后端同样 clamp）。
// 之后的窗口缩放只是画布等比缩放，不重设 Xvfb 屏幕。
function screenSpec(): { w: string; h: string } {
  return { w: String(Math.min(Math.max(Math.floor(innerWidth * 0.8), 640), 2560)), h: String(Math.min(Math.max(Math.floor(innerHeight * 0.75), 480), 1600)) }
}

function connectCtrl(): void {
  phase.value = 'connecting'
  progressMsg.value = '连接容器…'
  errMsg.value = ''
  const { w, h } = screenSpec()
  ctrl = new WebSocket(wsUrl('/ws/desktop', { w, h }))
  ctrl.onmessage = (ev) => {
    let m: { type: string; message?: string }
    try {
      m = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (m.type === 'progress') {
      phase.value = 'preparing'
      progressMsg.value = m.message || '…'
    } else if (m.type === 'ready') {
      connectRfb()
    } else if (m.type === 'error') {
      fail(m.message || '桌面启动失败')
    }
  }
  ctrl.onerror = () => {
    // 控制流异常断（非 error 帧）：ready 前断 = ensure 失败或网络问题
    if (phase.value !== 'ready') fail('控制流断开（后端不可达或 token 失效）')
  }
  ctrl.onclose = () => {
    if (!disposed && phase.value === 'ready') {
      // ready 后控制流意外断开：桌面大概率还在（只是这条 WS 掉了），RFB 流独立存活，不动。
    }
  }
}

function connectRfb(): void {
  if (disposed || !canvasWrap.value) return
  progressMsg.value = '连接画面…'
  const url = wsUrl('/ws/desktop-vnc', {})
  try {
    rfb = new RFB(canvasWrap.value, url, {
      resizeSession: false,
      background: '#000',
    })
    // ⚠️ noVNC 的 constructor 只认 credentials/shared/repeaterID/wsProtocols，options 里的
    // scaleViewport 是**被忽略的**——必须走 setter，否则 canvas 恒 1:1、Dialog 比画面矮就出滚动条。
    rfb.scaleViewport = true
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e))
    return
  }
  rfb.addEventListener('connect', () => {
    phase.value = 'ready'
  })
  rfb.addEventListener('disconnect', (ev: Event) => {
    const detail = (ev as unknown as { detail?: { clean?: boolean } }).detail
    phase.value = 'disconnected'
    errMsg.value = detail?.clean ? '连接已断开' : '连接异常断开'
  })
  rfb.addEventListener('credentialsrequired', () => {
    fail('服务端要求 VNC 密码（不应发生——x11vnc -nopw）')
  })
  rfb.addEventListener('securityfailure', (ev: Event) => {
    const detail = (ev as unknown as { detail?: { reason?: string } }).detail
    fail(`安全握手失败：${detail?.reason ?? '未知原因'}`)
  })
}

function fail(msg: string): void {
  phase.value = 'disconnected'
  errMsg.value = msg
}

function reconnect(): void {
  teardown()
  connectCtrl()
}

function teardown(): void {
  disposed = false
  if (rfb) {
    try {
      rfb.disconnect()
    } catch {
      /* noop */
    }
    rfb = null
  }
  if (ctrl) {
    try {
      ctrl.close()
    } catch {
      /* noop */
    }
    ctrl = null
  }
  // noVNC 往 canvasWrap 里 append 的 screen 节点要清掉，重连才是干净画布
  if (canvasWrap.value) canvasWrap.value.innerHTML = ''
  // noVNC 还会往 document.body 挂一个全屏「鼠标捕获层」（mousedown 抓指针用，z-index 10000），
  // disconnect() 不回收——不清掉它，Dialog 关了它还盖着整页（实测踩到：菜单都点不动）。
  document.getElementById('noVNC_mouse_capture_elem')?.remove()
}

onMounted(() => {
  // 记住的窗口尺寸（clamp 到当前视口，防止换小屏后打不开）；手机全屏形态不恢复尺寸
  if (!isPhone.value) {
    try {
      const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null') as { w?: unknown; h?: unknown } | null
      if (s && typeof s.w === 'number' && typeof s.h === 'number') {
        size.value = {
          w: Math.max(MIN_W, Math.min(s.w, innerWidth - 16)),
          h: Math.max(MIN_H, Math.min(s.h, innerHeight - 16)),
        }
      }
    } catch {
      /* ignore */
    }
  }
  connectCtrl()
})
onBeforeUnmount(() => {
  disposed = true
  if (rfb) {
    try {
      rfb.disconnect()
    } catch {
      /* noop */
    }
    rfb = null
  }
  if (ctrl) {
    try {
      ctrl.close()
    } catch {
      /* noop */
    }
    ctrl = null
  }
  // 同 teardown：清 noVNC 挂在 body 上的鼠标捕获层（组件卸载路径）
  document.getElementById('noVNC_mouse_capture_elem')?.remove()
})
</script>

<template>
  <Dialog :open="true" @update:open="(v: boolean) => v || emit('close')">
    <!-- noVNC 在 canvas mousedown 时会往 body 挂全屏鼠标捕获层（setCapture polyfill，z-index 10000），
         拖拽/后续点击的事件 target 是这个层而非 DialogContent —— reka-ui 判定 outside 就把 Dialog 关了。
         实测：点一下画面（拖窗口/选文本）Dialog 直接消失。桌面是独占交互面，禁掉 outside-dismiss，
         关窗只走工具栏 X 与 Escape。 -->
    <!-- max-h-none：基础类的 max-h-[85dvh] 会把铺满态（100vh）压回 85dvh，铺满必须放行到全视口；
         画布区自身 min-h-0 + overflow-hidden 兜住内容，不依赖基础类的 overflow-y-auto。 -->
    <DialogContent
      class="flex h-[88vh] max-h-none w-[94vw] max-w-none flex-col gap-0 overflow-hidden rounded-xl p-0 shadow-2xl shadow-black/80 max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:rounded-none max-md:border-0 max-md:shadow-none"
      :class="anchored ? '!translate-x-0 !translate-y-0' : ''"
      :style="contentStyle"
      :show-close-button="false"
      @pointer-down-outside.prevent
    >
      <!-- 窗口工具栏：图标徽标 + 名称 + 状态点在左，铺满/关闭在右（不用基础 Dialog 的悬浮 X） -->
      <div
        class="flex h-11 shrink-0 cursor-default select-none items-center gap-2.5 border-b bg-background pr-2 pl-3"
        @dblclick="onToolbarDblclick"
      >
        <div class="grid size-6 shrink-0 place-items-center rounded-md bg-primary/10 text-foreground/70">
          <Monitor class="size-3.5" />
        </div>
        <DialogTitle class="truncate text-sm font-medium">桌面 · {{ containerName }}</DialogTitle>
        <span class="ml-0.5 size-1.5 shrink-0 rounded-full" :class="statusMeta?.dot" :title="statusMeta?.short" />
        <DialogDescription class="sr-only">容器内 XFCE 桌面的远程查看窗口。</DialogDescription>
        <div class="ml-auto flex items-center gap-0.5">
          <button
            v-if="!isPhone"
            type="button"
            :title="maximized ? '还原窗口' : '铺满整个窗口'"
            :class="toolBtn"
            @click="toggleMax"
          >
            <Minimize2 v-if="maximized" class="size-4" />
            <Maximize2 v-else class="size-4" />
          </button>
          <button type="button" title="关闭" :class="toolBtn" @click="emit('close')">
            <X class="size-4" />
          </button>
        </div>
      </div>

      <!-- 画布：贴合窗口纯黑（无内衬边框）；RFB 装进绝对定位层，未 ready 时隐掉 -->
      <div class="relative min-h-0 flex-1 bg-black">
        <div
          ref="canvasWrap"
          class="absolute inset-0"
          :class="phase === 'ready' ? '' : 'opacity-0'"
        ></div>

        <!-- 状态层：盖在黑画布上（ready 时移除露出画面） -->
        <div v-if="phase !== 'ready'" class="pointer-events-none absolute inset-0 grid place-items-center">
          <div class="flex max-w-full flex-col items-center gap-3 px-6">
            <template v-if="phase === 'connecting' || phase === 'preparing'">
              <div class="size-9 animate-spin rounded-full border-2 border-white/15 border-t-white/80"></div>
              <p class="text-sm text-zinc-300">{{ progressMsg }}</p>
              <p v-if="phase === 'preparing'" class="text-xs text-zinc-600">首次连接需安装桌面组件，可能要几分钟</p>
            </template>
            <template v-else>
              <div class="grid size-12 place-items-center rounded-full bg-red-500/10">
                <MonitorX class="size-5 text-red-400" />
              </div>
              <p class="text-sm font-medium text-zinc-200">桌面连接已断开</p>
              <p v-if="errMsg" class="max-w-xl text-center text-xs break-all whitespace-pre-wrap text-zinc-500">
                {{ errMsg }}
              </p>
              <Button size="sm" class="pointer-events-auto mt-1" @click="reconnect">重新连接</Button>
            </template>
          </div>
        </div>
      </div>

      <!-- 状态条：左侧连接状态（preparing 时透出进度消息），右侧短提示（窄屏隐藏） -->
      <div
        class="flex h-8 shrink-0 items-center justify-between gap-3 border-t bg-background px-3 text-xs text-muted-foreground"
      >
        <span class="truncate">{{ statusMeta?.long }}</span>
        <span class="hidden shrink-0 md:block">拖边缘/四角调整大小 · 双击标题栏铺满</span>
      </div>

      <!-- 拖拽手柄：8 向（四边细条 + 四角小方块）。铺满态/手机全屏不需要。 -->
      <template v-if="!maximized && !isPhone">
        <div
          v-for="d in HANDLES"
          :key="d"
          class="absolute z-20"
          :class="handleClass(d)"
          @pointerdown="startResize($event, d)"
        ></div>
      </template>
    </DialogContent>
  </Dialog>
</template>
