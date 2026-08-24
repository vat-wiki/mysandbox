<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { getToken, setToken, clearToken, health, verifyToken, getImageStatus, Unauthorized } from '@/lib/api'
import { setEngineInfo, engineName } from '@/lib/caps'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import ContainerList from '@/components/ContainerList.vue'
import type { OpenReq } from '@/components/ContainerList.vue'
import TokenGate from '@/components/TokenGate.vue'
import ImageBadge from '@/components/ImageBadge.vue'
import ImagePanel from '@/components/ImagePanel.vue'
import HostsBadge from '@/components/HostsBadge.vue'
// 异步加载 hosts 面板：Monaco 编辑器较重（~700KB gzip），只在点 hosts 徽标时才下载，不拖累首屏。
const HostsPanel = defineAsyncComponent(() => import('@/components/HostsPanel.vue'))

const token = ref<string | null>(getToken())
const version = ref<string>('')
const dockerOk = ref<boolean | null>(null)
const checking = ref(false)
const checkErr = ref('')

// 基础镜像状态：header 徽标 + ContainerList 新建守卫用。轮询保持新鲜。
const imageExists = ref<boolean | null>(null)
const imageBuilding = ref(false)
const showImagePanel = ref(false)
const showHostsPanel = ref(false)
let imageTimer: ReturnType<typeof setInterval> | null = null

async function refreshImageStatus() {
  if (!token.value) return
  try {
    imageExists.value = (await getImageStatus()).exists
  } catch {
    /* 状态拉取失败不打扰主流程 */
  }
}

async function verify(t: string): Promise<boolean> {
  checking.value = true
  checkErr.value = ''
  try {
    setToken(t)
    // health 不鉴权（错误 token 也 200），只用来看后端/docker 状态；
    // 真伪校验走必鉴权的 verifyToken，401 会在下面 catch 成明确的「token 无效」。
    const h = await health()
    await verifyToken()
    version.value = h.version
    dockerOk.value = h.docker.reachable
    // caps 写进全局单例：删除/改名/端口映射的 UI 分支都读它（见 lib/caps.ts）
    setEngineInfo(h.engine ?? 'docker', h.caps)
    token.value = t
    refreshImageStatus()
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
  dockerOk.value = null
  imageExists.value = null
}

const ready = computed(() => !!token.value)

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

onMounted(() => {
  pendingOpen.value = parseOpenHash()
  refreshImageStatus()
  imageTimer = setInterval(refreshImageStatus, 15000)
})
onUnmounted(() => {
  if (imageTimer) clearInterval(imageTimer)
})
</script>

<template>
  <!-- 全高布局：header + 主区撑满视口（终端为主体，不再页面滚动） -->
  <div class="flex h-screen flex-col overflow-hidden bg-background text-foreground">
    <header class="shrink-0 border-b border-border bg-card/60 backdrop-blur">
      <div class="flex h-12 items-center gap-3 px-4">
        <img src="/logo.svg" alt="" class="h-7 w-7" />
        <span class="text-base font-semibold tracking-tight">MySandbox</span>
        <Badge v-if="version" variant="outline" class="font-normal text-muted-foreground"
          >v{{ version }}</Badge
        >
        <Badge
          v-if="dockerOk === true"
          variant="outline"
          class="border-transparent bg-emerald-500/15 text-emerald-500"
          >{{ engineName }} ok</Badge
        >
        <Badge
          v-else-if="dockerOk === false"
          variant="outline"
          class="border-transparent bg-destructive/15 text-destructive"
          >{{ engineName }} unreachable</Badge
        >
        <ImageBadge
          v-if="ready"
          :exists="imageExists"
          :building="imageBuilding"
          @click="showImagePanel = true"
        />
        <HostsBadge v-if="ready" @click="showHostsPanel = true" />
        <div class="ml-auto" />
        <Button
          v-if="ready"
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          @click="logout"
          >登出</Button
        >
      </div>
    </header>

    <main class="min-h-0 flex-1">
      <TokenGate v-if="!ready" :checking="checking" :err="checkErr" @submit="verify" />
      <ContainerList
        v-else
        class="h-full"
        :image-present="imageExists"
        :open-req="pendingOpen"
        @unauthorized="logout"
        @open-image="showImagePanel = true"
        @open-hosts="showHostsPanel = true"
        @open-handled="onOpenHandled"
      />
      <ImagePanel
        v-if="showImagePanel"
        @close="showImagePanel = false"
        @changed="refreshImageStatus"
        @running="imageBuilding = $event"
      />
      <HostsPanel v-if="showHostsPanel" @close="showHostsPanel = false" />
    </main>
  </div>
</template>
