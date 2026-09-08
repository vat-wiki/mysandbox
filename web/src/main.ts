import { createApp } from 'vue'
import '@fontsource-variable/cascadia-code' // 内置终端字体（woff2 打包），保证跨端渲染一致
import './index.css'
import App from './App.vue'

// 懒加载 chunk 拉取失败自动重载一次：页面壳是开着的旧构建时（mysandbox 重建 dist 期间
// 常态发生），点开懒加载面板按旧 hash 拉 chunk 必 404——旧 hash 文件已被新构建删掉。
// vite:preloadError 是 __vitePreload 在 import 失败前统一派发的事件，在此重载拿到
// 新 index.html + 新 hash 即愈；10s 内只放行一次，防 index.html 本身异常时无限刷新环。
window.addEventListener('vite:preloadError', () => {
  const key = 'msb:preload-reload-at'
  const last = Number(sessionStorage.getItem(key) ?? 0)
  if (Date.now() - last < 10_000) return
  sessionStorage.setItem(key, String(Date.now()))
  window.location.reload()
})

createApp(App).mount('#app')
