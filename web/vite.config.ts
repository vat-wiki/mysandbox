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
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7321',
      '/ws': { target: 'ws://127.0.0.1:7321', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
