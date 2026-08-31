<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { getToken, setToken, clearToken, health, verifyToken, getBaseStatus, Unauthorized } from '@/lib/api'
import { setEngineInfo } from '@/lib/caps'
import { isPhone } from '@/composables/useDevice'
import ContainerList from '@/components/ContainerList.vue'
import type { OpenReq } from '@/components/ContainerList.vue'
import TokenGate from '@/components/TokenGate.vue'
import BasePanel from '@/components/BasePanel.vue'
import { Toaster } from '@/components/ui/sonner'
const ServicesPanel = defineAsyncComponent(() => import('@/components/ServicesPanel.vue'))

const token = ref<string | null>(getToken())
const checking = ref(false)
const checkErr = ref('')

// 基座状态（docker=基础镜像 / lxc=模板容器）：ContainerList 新建守卫用。
// 存 ready 而非 exists：LXC 模板存在但在运行时不能克隆，新建守卫要拦的是「不可用」。
// （基座就绪性不再常驻徽标展示——入口收进侧栏容器分区的 ⋯ 菜单与新建守卫，见 ContainerList。）
const baseReady = ref<boolean | null>(null)
const showBasePanel = ref(false)
const showServicesPanel = ref(false)
// 服务摘要条上的 ＋ 带「新建」意图：面板打开时直接弹新建对话框（普通打开则不弹）。
const svcCreateIntent = ref(false)
let baseTimer: ReturnType<typeof setInterval> | null = null

async function refreshBaseStatus() {
  if (!token.value) return
  try {
    baseReady.value = (await getBaseStatus()).ready
  } catch {
    /* 状态拉取失败不打扰主流程 */
  }
}

async function verify(t: string): Promise<boolean> {
  checking.value = true
  checkErr.value = ''
  try {
    setToken(t)
    // health 不鉴权（错误 token 也 200），这里只为拿 caps/engine 名写全局单例；
    // 真伪校验走必鉴权的 verifyToken，401 会在下面 catch 成明确的「token 无效」。
    const h = await health()
    await verifyToken()
    // caps 写进全局单例：删除/改名/端口映射的 UI 分支都读它（见 lib/caps.ts）
    setEngineInfo(h.engine, h.caps)
    token.value = t
    refreshBaseStatus()
    return true
  } catch (e) {
    if (e instanceof Unauthorized) checkErr.value = 'token 无效，请检查后重试'
    else if (e instanceof Error && e.name === 'TimeoutError') checkErr.value = '后端无响应（超时），请确认 mysandbox 在运行'
    else checkErr.value = e instanceof Error ? e.message : String(e)
    clearToken()
    return false
  } finally {
    checking.value = false
  }
}

function logout() {
  clearToken()
  token.value = null
  baseReady.value = null
}

const ready = computed(() => !!token.value)

// —— 面板打开入口（全部来自侧栏，见 ContainerList）——
// 服务摘要条：普通点击开管理面板；＋ 点击带新建意图（面板内直接弹新建对话框）。
function openServices(create = false) {
  svcCreateIntent.value = create
  showServicesPanel.value = true
}
function closeServices() {
  showServicesPanel.value = false
  svcCreateIntent.value = false
}

// —— CLI `mysandbox open` 深链 ——
// 解析 #open?c=<容器id>&p=<路径>&k=<file|dir> 为 pendingOpen；等 ContainerList 消费完
// （open-handled）再清 hash——中间可能隔着一道 TokenGate（未登录先输 token）。
const pendingOpen = ref<OpenReq | null>(null)
function parseOpenHash(): OpenReq | null {
  const h = location.hash
  if (!h.startsWith('#open?')) return null
  const q = new URLSearchParams(h.slice(6))
  const c = q.get('c')
  const p = q.get('p')
  if (!c || !p) return null
  return { containerId: c, path: p, kind: q.get('k') === 'dir' ? 'dir' : 'file', seq: Date.now() }
}
function onOpenHandled() {
  pendingOpen.value = null
  history.replaceState(null, '', location.pathname + location.search)
}

// —— 独立窗口（popout）——
// ?popout=<containerId|__host__>：主界面「在独立窗口打开」经 window.open 发起的新窗。
// 同源共享 localStorage 里的 token，鉴权天然通过；只渲染 ContainerList 的纯终端工作区
// （无 header/侧栏），首屏自动开一个全新终端、可继续左右/上下分屏，布局独立持久化。
const popoutTarget = ref('')

onMounted(() => {
  popoutTarget.value = new URLSearchParams(location.search).get('popout') ?? ''
  pendingOpen.value = parseOpenHash()
  refreshBaseStatus()
  baseTimer = setInterval(refreshBaseStatus, 15000)
})
onUnmounted(() => {
  if (baseTimer) clearInterval(baseTimer)
})
</script>

<template>
  <!-- 全高布局：主区撑满视口（终端为主体，不再页面滚动）。
       header 已整体移除：品牌 + 版本 + 引擎健康收进侧栏顶部品牌块（见 ContainerList），
       配置入口在侧栏容器分区，登出已删（token 轮换时 @unauthorized 自动弹回 TokenGate）。
       popout 独立窗口与主窗口的唯一区别只剩「无侧栏」。
       h-dvh：手机上随地址栏伸缩（桌面端 dvh≡vh 零差异）。 -->
  <div class="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <main class="min-h-0 flex-1">
      <TokenGate v-if="!ready" :checking="checking" :err="checkErr" @submit="verify" />
      <!-- popout：纯终端工作区；未授权同样走 TokenGate（token 失效时） -->
      <ContainerList
        v-else-if="popoutTarget"
        class="h-full"
        popout
        :popout-target="popoutTarget"
        @unauthorized="logout"
      />
      <ContainerList
        v-else
        class="h-full"
        :base-ready="baseReady"
        :open-req="pendingOpen"
        @unauthorized="logout"
        @open-base="showBasePanel = true"
        @open-services="openServices"
        @open-handled="onOpenHandled"
      />
      <BasePanel v-if="showBasePanel" @close="showBasePanel = false" @changed="refreshBaseStatus" />
      <ServicesPanel
        v-if="showServicesPanel"
        :initial-create="svcCreateIntent"
        @close="closeServices"
      />
    </main>
    <!-- 全局通知（服务创建任务完成/失败等）。桌面右下角——终端主体在左上，避开视觉焦点；
         手机改顶部居中——右下角会压住终端底部输入区，且要避开软键盘与底部 home indicator。 -->
    <Toaster :position="isPhone ? 'top-center' : 'bottom-right'" />
  </div>
</template>
