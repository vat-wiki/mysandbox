// Web 代理 URL 单例（服务端见 server/proxy.ts）。App 挂载/登录成功后 loadProxyConfig()
// 按**当前控制台的访问口径**决定端口点击的目标，两种口径平级、服务端不做互转：
// - 直连口径：控制台经 IP/localhost 打开 → 端口点击直连容器/服务 IP:端口（不经代理、
//   无 cookie 依赖）——代理上线前的原始形式，宿主本机 / tailscale 子网路由下可达。
// - 代理口径：控制台经基域名打开 → 对候选基域名逐个探测择优，serviceUrl() 拼 vhost
//   URL；全部候选不可达时降级 subpath（同源 /proxy/... 永远可用）。
//
// 为什么要探测：auto 模式的首选 mysandbox.test 需要宿主侧 DNS 应答（mihomo hosts /
// dnsmasq），并非每台机器都配了——解析失败/端口不通的候选直接跳过，别让端口点击落到
// 打不开的域名上。探测请求本身免鉴权（health），no-cors 下任何 HTTP 应答都算走通。
import { ref } from 'vue'
import type { ProxyConfigInfo } from './api'
import { getProxyConfig } from './api'

const info = ref<ProxyConfigInfo>({ mode: 'subpath', bases: [], primary: null })
let loaded = false

// 控制台是否经 IP/localhost 口径访问（直连口径判定）。[::1] 与 IPv6 字面量同待之：
// 服务端 vhost 不玩 IPv6（见 makeRewriteUrl），直连口径收下。
export function originIpish(): boolean {
  const h = location.hostname.toLowerCase()
  return h === 'localhost' || h.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)
}

// 装载代理配置并按口径定型。返回最终生效的门面（vhost = 探测命中某候选；subpath =
// 直连口径不需要/代理关/全败）。App 用它驱动登录后的装载时序。
export async function loadProxyConfig(): Promise<'vhost' | 'subpath'> {
  if (loaded) return info.value.mode
  loaded = true
  if (originIpish()) {
    // 直连口径：端口点击不走代理，基域名信息用不上——跳过探测。
    info.value = { mode: 'subpath', bases: [], primary: null }
    return 'subpath'
  }
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
// no-cors 拿不到响应体也不需要——opaque 应答即证明链路通；DNS 失败/拒连/证书不受信
// （CA 未导入时 https 自签名的正常现象）都会 reject，逐个候选试到能用的为止。
// 首标签 msbprobe 无连字符数字，不会误入代理路由（直落控制台的 /api/health）。
async function probeBase(base: string): Promise<boolean> {
  const portPart = location.port ? `:${location.port}` : ''
  try {
    await fetch(`${location.protocol}//msbprobe.${base}${portPart}/api/health`, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    })
    return true
  } catch {
    return false
  }
}

// 探测命中的基域名（直连口径/subpath 模式为 null）——proxyBack 回跳校验用。
export function proxyPrimary(): string | null {
  return info.value.mode === 'vhost' ? info.value.primary : null
}

// 容器（kind 'c'）或 docker 服务（kind 's'）的端口打开 URL。ip = 目标内网 IP（直连
// 口径用；未知时退代理形式——至少同源子路径可达）。直连恒 http://（容器/服务内是明文
// HTTP，TLS 只在控制台侧终结）；代理口径 scheme/端口跟当前访问口径走（location.port
// 为空 = 80/443 默认口）。
export function serviceUrl(kind: 'c' | 's', name: string, port: number, ip?: string | null): string {
  if (originIpish() && ip) return `http://${ip}:${port}/`
  if (info.value.mode === 'vhost' && info.value.primary) {
    const portPart = location.port ? `:${location.port}` : ''
    return `${location.protocol}//${name}-${port}.${info.value.primary}${portPart}/`
  }
  return `${location.origin}/proxy/${kind}/${name}/${port}/`
}
