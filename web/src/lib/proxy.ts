// Web 代理 URL 单例（服务端见 server/proxy.ts）。App 挂载/登录成功后 loadProxyConfig()
// 按**当前控制台的访问口径**决定端口点击的目标，两种口径平级、服务端不做互转：
// - 直连口径：控制台经 IP/localhost 打开 → 端口点击直连容器/服务 IP:端口（不经代理、
//   无 cookie 依赖）——代理上线前的原始形式，宿主本机 / tailscale 子网路由下可达。
// - 代理口径：控制台经域名打开 → 直接用当前域名作基域拼 vhost URL。能打开控制台
//   就说明该域名可达，不再额外探测泛解析——sslip 自带通配、自有域按用户配置保证
//   通配；服务端 rewriteUrl 只解析目标名，不限制必须来自 config 里的候选基域。
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

// 装载代理配置并按口径定型。返回最终生效的门面（vhost = 当前域名；subpath =
// 直连口径或代理关闭）。App 用它驱动登录后的装载时序。
export async function loadProxyConfig(): Promise<'vhost' | 'subpath'> {
  if (loaded) return info.value.mode
  loaded = true
  if (originIpish()) {
    // 直连口径：端口点击不走代理，基域名信息用不上。
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
    const base = location.hostname.toLowerCase()
    info.value = { mode: 'vhost', bases: [{ base, kind: 'custom' }], primary: base }
    return 'vhost'
  }
  info.value = { mode: 'subpath', bases: cfg.bases, primary: null }
  return 'subpath'
}

// 当前生效基域（直连口径/subpath 模式为 null）——proxyBack 回跳校验用。
export function proxyPrimary(): string | null {
  return info.value.mode === 'vhost' ? info.value.primary : null
}

// 直连 URL：容器/服务内网 IP:端口（明文 HTTP，TLS 只在控制台侧终结）。代理上线前的
// 原始打开形式——宿主本机、tailscale 子网路由下可达；无路由的 LAN/公网设备打不开。
export function directUrl(ip: string, port: number): string {
  return `http://${ip}:${port}/`
}

// 容器（kind 'c'）或 docker 服务（kind 's'）的端口打开 URL。ip = 目标内网 IP（直连
// 口径用；未知时退代理形式——至少同源子路径可达）。代理口径 scheme/端口跟当前访问
// 口径走（location.port 为空 = 80/443 默认口）。
export function serviceUrl(kind: 'c' | 's', name: string, port: number, ip?: string | null): string {
  if (originIpish() && ip) return directUrl(ip, port)
  if (info.value.mode === 'vhost' && info.value.primary) {
    const portPart = location.port ? `:${location.port}` : ''
    return `${location.protocol}//${name}-${port}.${info.value.primary}${portPart}/`
  }
  return `${location.origin}/proxy/${kind}/${name}/${port}/`
}
