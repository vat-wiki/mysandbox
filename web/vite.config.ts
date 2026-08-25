import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// dev: vite 5173，/api 与 /ws 代理到后端 127.0.0.1:7321。
// build: 产物到 web/dist（root 后端 @fastify/static 同源服务，无 CORS）。
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Monaco 核心深路径 editor.api 被 monaco-editor 的 exports map 挡住，直接别名到磁盘路径。
      // 只引核心 API（worker 用相对路径 ?worker），不引 editor.main（那会把全部语言模式塞进首屏 ~4MB）。
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
      '/api': 'http://127.0.0.1:7321',
      '/ws': { target: 'ws://127.0.0.1:7321', ws: true },
    },
  },
  // es2022：@novnc/novnc 1.7 的 rfb.js 用了 top-level await（浏览器动态导入指纹），
  // 默认 target（es2020/chrome87）不认。我们只跑自托管现代浏览器，直接放宽。
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
})
