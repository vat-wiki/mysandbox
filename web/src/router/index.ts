import { defineComponent } from 'vue'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

// 当前 Workspace Shell 还没有迁移成独立 RouterView，这些路由只作为导航层级存在；
// Vue Router 的 record 类型要求 component，空渲染组件让类型显式成立。
const RouteAnchor = defineComponent({ name: 'RouteAnchor', render: () => null })

// 手机工具条设置页（全屏）。路由名给 lib/termToolbarNav.ts 与 App 共用，避免三处手写漂移。
export const TERMINAL_TOOLBAR_ROUTE = 'terminal-toolbar'

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
  {
    path: '/services',
    name: 'services',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'drawer', mobile: 'page' },
  },
  {
    path: '/services/:name',
    name: 'service',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'drawer', mobile: 'page' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/terminal-toolbar',
    name: TERMINAL_TOOLBAR_ROUTE,
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/base',
    name: 'base',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/accounts',
    name: 'accounts',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/files/:target',
    name: 'files',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'panel', mobile: 'page' },
  },
  {
    path: '/ssh',
    name: 'ssh-targets',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/terminals',
    name: 'term-sessions',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    // 手机终端切换页（本窗口的终端组列表）。桌面终端 tab 条常驻，没有这个入口。
    path: '/terminals/switch',
    name: 'term-switch',
    component: RouteAnchor,
    meta: { layer: 'page', mobileOnly: true },
  },
  {
    path: '/containers/new',
    name: 'container-create',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/containers/batch',
    name: 'container-batch',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/containers/:id/export',
    name: 'container-export',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/desktop/:id',
    name: 'container-desktop',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/services/adopt',
    name: 'service-adopt',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'dialog', mobile: 'page' },
  },
  {
    path: '/ai',
    name: 'ai',
    component: RouteAnchor,
    meta: { layer: 'page', desktop: 'workspace', mobile: 'page' },
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

// 页面路由名集合，由路由表派生（单一真相，随 pageRoutes 增删自动跟）。「是页面路由才收」
// 的判定（closePageRoute 等）都消费它——曾在 ContainerList 手工镜像这份名单，/ai 等后来
// 新增的路由漏掉 → 关闭逻辑静默 no-op，主区切走了路由留在原处，刷新「回魂」。
export const pageRouteNames = new Set<string>(
  pageRoutes.map((r) => r.name as string),
)

export const router = createRouter({
  history: createWebHistory(),
  routes,
})
