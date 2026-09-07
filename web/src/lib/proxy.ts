// Web 代理 URL 单例（服务端见 server/proxy.ts）。App 挂载/登录成功后 loadProxyConfig()
// 拉一次 /api/proxy/config 并对候选基域名**逐个探测择优**，各处 serviceUrl() 只读。
// 全部候选不可达时降级 subpath（同源 /proxy/... 永远可用）。
//
// 为什么要探测：auto 模式的首选 mysandbox.local 需要宿主侧 DNS 应答（mihomo hosts /
// dnsmasq），并非每台机器都配了——解析失败/端口不通的候选直接跳过，别让端口点击落到
// 打不开的域名上。探测请求本身免鉴权（health），no-cors 下任何 HTTP 应答都算走通。
import { ref } from 'vue'
import type { ProxyConfigInfo } from './api'
import { getProxyConfig } from './api'

const info = ref<ProxyConfigInfo>({ mode: 'subpath', bases: [], primary: null })
let loaded = false

// 返回最终生效的门面（vhost = 探测命中某候选；subpath = 代理关/全败）。App 用它给提示。
export async function loadProxyConfig(): Promise<'vhost' | 'subpath'> {
  if (loaded) return info.value.mode
  loaded = true
  let cfg: ProxyConfigInfo
  try {
    cfg = await getProxyConfig()
  } catch {
    return 'subpath' // 服务不可用：维持 subpath 兜底
  }
  if (cfg.mode === 'vhost') {
    for (const b of cfg.bases) {
      if (await probeBase(b.base)) {
        info.value = { mode: 'vhost', bases: cfg.bases, primary: b.base }
        return 'vhost'
      }
    }
  }
  info.value = { mode: 'subpath', bases: cfg.bases, primary: null }
  return 'subpath'
}

// 探测基域名在当前浏览器能否走通：DNS 可解析 + 控制台端口可达。
// no-cors 拿不到响应体也不需要——opaque 应答即证明链路通；DNS 失败/拒连都会 reject。
// 首标签 msbprobe 无连字符数字，不会误入代理路由（直落控制台的 /api/health）。
async function probeBase(base: string): Promise<boolean> {
  const portPart = location.port ? `:${location.port}` : ''
  try {
    await fetch(`http://msbprobe.${base}${portPart}/api/health`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    })
    return true
  } catch {
    return false
  }
}

// 探测命中的基域名（subpath 模式为 null）——App 的提示条用。
export function proxyPrimary(): string | null {
  return info.value.mode === 'vhost' ? info.value.primary : null
}

// 容器（kind 'c'）或 docker 服务（kind 's'）的代理 URL。
export function serviceUrl(kind: 'c' | 's', name: string, port: number): string {
  if (info.value.mode === 'vhost' && info.value.primary) {
    // 控制台端口跟当前访问口径走（location.port 为空 = 80/443 默认口）。
    const portPart = location.port ? `:${location.port}` : ''
    return `http://${name}-${port}.${info.value.primary}${portPart}/`
  }
  return `${location.origin}/proxy/${kind}/${name}/${port}/`
}
