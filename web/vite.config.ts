import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { networkInterfaces } from 'node:os'
import { readFile } from 'node:fs/promises'

// dev: vite 5173，/api 与 /ws 代理到后端 7321。
// build: 产物到 web/dist（root 后端 @fastify/static 同源服务，无 CORS）。

// 解析代理 target：读 ~/.config/mysandbox/config.yaml 的 listen.host（vite 不会读 mysandbox
// config，得自己来）。host 为 auto 时镜像 server/cli.ts 的解析逻辑（默认路由接口 IPv4，
// 读 /proc/net/route）——本机 IP 变了这里自动跟，不用手工同步。任何失败退回 127.0.0.1。
async function backendHost(): Promise<string> {
  try {
    const y = await readFile(
      `${process.env.HOME ?? ''}/.config/mysandbox/config.yaml`,
      'utf8',
    )
    // listen 块内的 host 键（简单缩进匹配足够；yaml 库不值得为两条代理配置引入）
    const m = y.match(/^listen:[\s\S]*?^\s+host:\s*(\S+)/m)
    const host = m?.[1] ?? '127.0.0.1'
    if (host !== 'auto') return host
    const ifaces = networkInterfaces()
    let ifname: string | undefined
    try {
      for (const line of (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c[1] === '00000000') {
          ifname = c[0]
          break
        }
      }
    } catch {
      // 非 Linux：走退化路径（第一个非 internal IPv4）
    }
    const pick = (name?: string) =>
      name ? (ifaces[name] ?? []).find((a) => a.family === 'IPv4' && !a.internal)?.address : undefined
    return pick(ifname) ?? Object.keys(ifaces).map(pick).find(Boolean) ?? '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

// 代理后端端口可用 MYSANDBOX_DEV_PORT 覆盖（并行 dev 实例验证用），默认 7321。
const backend = `http://${await backendHost()}:${process.env.MYSANDBOX_DEV_PORT ?? 7321}`

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Monaco 核心深路径 editor.api 被 monaco-editor 的 exports map 挡住，直接别名到磁盘路径。
      // 只引核心 API（worker 用相对路径 ?worker)，不引 editor.main（那会把全部语言模式塞进首屏 ~4MB）。
      'monaco-editor/api': fileURLToPath(
        new URL('node_modules/monaco-editor/esm/vs/editor/editor.api.js', import.meta.url),
      ),
      // @novnc/novnc 的 exports 字段是非法形状（字符串而非映射），vite 解析成 subpath 'undefined'
      // 直接失败。同 Monaco 手法：别名到磁盘上的 rfb.js。
      '@novnc/novnc/core/rfb.js': fileURLToPath(
        new URL('node_modules/@novnc/novnc/core/rfb.js', import.meta.url),
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
      // Web 代理门面（server/proxy.ts）：dev 下走同源子路径门面（vhost 门面依赖
      // Host 改写，vite 代理是按路径的，做不到——build 后同源服务不受影响）。
      '/proxy': { target: backend, ws: true },
    },
  },
  // es2022：@novnc/novnc 1.7 的 rfb.js 用了 top-level await（浏览器动态导入指纹），
  // 默认 target（es2020/chrome87）不认。dev 的 optimizeDeps esbuild 同理（probe rfb.js
  // 时默认 esnext 之外的 target 也会炸），一并放宽。我们只跑自托管现代浏览器。
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
})
