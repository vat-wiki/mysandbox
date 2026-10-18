import { defineComponent } from 'vue'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// 当前 Workspace Shell 还没有迁移成独立 RouterView，这些路由只作为导航层级存在；
// Vue Router 的 record 类型要求 component，空渲染组件让类型显式成立。
const RouteAnchor = defineComponent({ name: 'RouteAnchor', render: () => null })

// 移动端全屏页的第一批路由只描述导航层级，不拥有业务数据：Workspace（终端 + 侧栏）
// 常驻挂载，路由只决定当前展开的全屏层级。这样系统后退/前进由 Vue Router 接管，
// 而 xterm、tmux attach、分屏树和轮询状态不会被页面切换销毁。
// 后续服务详情、文件编辑等全屏页继续追加到 pageRoutes，并逐步把桌面抽屉的共享内容抽成组件。
const pageRoutes: RouteRecordRaw[] = [
  {
    path: '/environments',
    name: 'environments',
    component: RouteAnchor,
    meta: { layer: 'page', mobileOnly: true },
  },
]

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'workspace',
    component: RouteAnchor,
    meta: { layer: 'workspace' },
  },
  ...pageRoutes,
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
