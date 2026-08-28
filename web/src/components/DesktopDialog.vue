<script setup lang="ts">
// 容器桌面查看器：Xvfb+XFCE+x11vnc 容器栈经 /ws/desktop-vnc（RFB 透传）接 noVNC 渲染。
// 两段式连接：先连 /ws/desktop（控制流，文本帧 JSON）等 ensure 完成——期间展示安装/启动
// 进度（首次可能要装几分钟包）；收到 {type:'ready'} 再 new RFB() 连 RFB 流（纯二进制）。
//
// 窗口形态：Dialog 内容可拖边缘/四角改大小（8 向手柄），右上角按钮/双击标题栏切换铺满。
// 尺寸（w/h）持久化在 localStorage，重开记住；位置不持久——默认居中，第一次拖动后按
// 「固定左上角」跟随（见 startResize）。分辨率固定于连接时（Xvfb 不动态改屏），窗口尺寸
// 变化时画布经 scaleViewport 等比缩放适配，不裁切不滚动。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import RFB from '@novnc/novnc/core/rfb.js'
import { Maximize2, Minimize2 } from 'lucide-vue-next'
import { getToken } from '@/lib/api'
import { isPhone } from '@/composables/useDevice'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
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

function toggleMax(): void {
  maximized.value = !maximized.value
  if (!maximized.value) pos.value = null // 还原后回居中（记住的尺寸保留）
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
         关窗只走右上角 X 与 Escape。 -->
    <DialogContent
      class="flex h-[88vh] w-[94vw] max-w-none flex-col max-md:h-[100dvh] max-md:max-h-none max-md:w-full max-md:rounded-none max-md:border-0 max-md:p-0"
      :class="anchored ? '!translate-x-0 !translate-y-0' : ''"
      :style="contentStyle"
      @pointer-down-outside.prevent
    >
      <DialogHeader class="shrink-0" @dblclick="toggleMax">
        <div class="flex items-center gap-2 pr-20">
          <DialogTitle>桌面 · {{ containerName }}</DialogTitle>
          <button
            type="button"
            class="ring-offset-background text-muted-foreground hover:text-foreground inline-flex size-7 items-center justify-center rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden"
            :title="maximized ? '还原窗口' : '铺满整个窗口'"
            @click="toggleMax"
          >
            <Minimize2 v-if="maximized" class="size-4" />
            <Maximize2 v-else class="size-4" />
          </button>
        </div>
        <DialogDescription>
          容器内 XFCE 桌面（Xvfb + x11vnc，经 mysandbox 代理）。键盘鼠标直接操作，焦点需先点一下画面。
        </DialogDescription>
      </DialogHeader>

      <div
        ref="canvasWrap"
        class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-md border bg-black"
        :class="phase === 'ready' ? '' : 'opacity-0'"
      ></div>

      <!-- 状态层：canvas 之上叠进度/错误（ready 时隐藏，露出画面） -->
      <div
        v-if="phase !== 'ready'"
        class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 pt-16"
      >
        <div
          v-if="phase === 'connecting' || phase === 'preparing'"
          class="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
        ></div>
        <p class="text-sm text-muted-foreground">
          <template v-if="phase === 'connecting'">{{ progressMsg }}</template>
          <template v-else-if="phase === 'preparing'">{{ progressMsg }}</template>
        </p>
        <p v-if="errMsg" class="max-w-xl whitespace-pre-wrap break-all text-center text-sm text-destructive">
          {{ errMsg }}
        </p>
        <Button v-if="phase === 'disconnected'" variant="outline" size="sm" class="pointer-events-auto" @click="reconnect">
          重连
        </Button>
      </div>

      <div class="flex shrink-0 items-center justify-between pt-1 text-xs text-muted-foreground">
        <span>{{
          phase === 'ready' ? '已连接（断开 Dialog 不关桌面，重开秒连）' : phase === 'disconnected' ? '未连接' : '准备中'
        }}</span>
        <span>拖边缘/四角调整窗口 · 双击标题栏或右上角铺满 · 分辨率固定于连接时</span>
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
