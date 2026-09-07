// Web 代理 URL 单例（服务端见 server/proxy.ts）。App 挂载/登录成功后 loadProxyConfig()
// 拉一次 /api/proxy/config，各处 serviceUrl() 只读。默认 subpath：配置没回来（或代理
// 关闭）时也拼得出可用的同源 URL。
//
// 两条门面：
// - vhost（主）：http://<name>-<port>.<基域名>:<控制台端口>/ ——Host 首标签承载目标，
//   应用看到自己是根路径，无子路径改写问题；跨子域与控制台 same-site（cookie 走得通）。
// - subpath（兜底）：<同源>/proxy/<c|s>/<name>/<port>/ ——DNS 不可用/dev 模式时用；
//   注意对绝对路径加载资源的 SPA 会破（应用需支持 base path）。
import { ref } from 'vue'
import type { ProxyConfigInfo } from './api'
import { getProxyConfig } from './api'

const info = ref<ProxyConfigInfo>({ mode: 'subpath', bases: [], primary: null })
let loaded = false

export async function loadProxyConfig(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    info.value = await getProxyConfig()
  } catch {
    /* 服务不可用：维持 subpath 兜底 */
  }
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
