import { createApp } from 'vue'
import '@fontsource-variable/cascadia-code' // 内置终端字体（woff2 打包），保证跨端渲染一致
import './index.css'
import App from './App.vue'

createApp(App).mount('#app')
