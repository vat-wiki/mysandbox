# web/ 前端约定（Vue 3 + Vite + Tailwind v4）

- UI 组件库走 **shadcn-vue**（reka-ui 底座），源码拷贝在 `src/components/ui/`。优先 `npx shadcn-vue@latest search` 找现成组件、用语义色（`bg-primary`）不用裸色值。（曾有的 `.claude/skills/shadcn-vue` 技能已删除——2026-09 工作区清空，该目录下别再引用。）
- 业务组件在 `src/components/`（ContainerList、Terminal、BatchDialog 等），API 封装在 `src/lib/api.ts`。api() 的每次请求向 `lib/linkQuality.ts` 回报耗时/成败，**弱网自适应轮询**：各定时器经 `gatePoll(fn, baseMs, {hidden})` 包装（timer 结构不变，实际请求频率 = 基础间隔 × 链路档位 1/3/5；`hidden: true` 的 poller 页面隐藏也拉长 4×）。⚠️ 终端活动轮询（`lib/terminalActivity.ts`、ContainerList 的 refreshActivity）**不得 gate hidden**——agent 等输入的浏览器通知依赖隐藏窗口下的轮询。
- 终端：xterm + fit/web-links/webgl 插件，WebSocket 到 `/ws/terminal`（容器）或 `/ws/host-terminal`（宿主，`Terminal.vue` 的 `host` prop 切换）；桌面是 `DesktopDialog.vue`（noVNC canvas，行菜单「桌面」，见 [desktop.md](desktop.md)）。
- **Monaco 是离线精简接法**（见 `vite.config.ts` 注释与 `src/lib/monaco.ts`）：只引 `editor.api`（通过 vite alias 深路径绕过 exports map），自定义词法高亮，worker 用相对路径 `?worker`，不引 `editor.main`。给 web 加 Monaco 相关功能时沿用此方案，不要引全量。
- **产品版本号**：唯一真相源 = 根 `package.json` 的 `version`（**手动 semver bump**）。build 时 vite `define` 注入 `__APP_VERSION__`（`env.d.ts` 声明），侧栏品牌块展示 `v<版本>`，rail 收起态挂在展开键 tooltip——零请求，与 `/api/health` 的 `getVersion()` 同源。**提交前 bump 规则见根目录 `AGENTS.md`「Git 工作流」**——界面不会自己变，靠 package.json。
- **旧页面新版本提示**（`lib/versionCheck.ts`）：SPA 页面 bundle 是加载时刻的快照，部署新版后旧页面无感知——旧 bundle 缺新协议帧分支会静默失能（实例：v0.9.16 msmux resume 补发 `{type:'modes'}`，旧页面收不懂 → 手机回前台触摸滚动失效）。App.vue 挂 `startVersionWatch()`：启动 3s、回前台、网络恢复 + 2min 轮询兜底，对 `/api/health`（免鉴权）的 version 与 `__APP_VERSION__`，不一致弹常驻 toast（60s 节流、只报一次）带「刷新」按钮。
- dev 模式 vite 代理 `/api` `/ws` 到 7321；build 后 `web/dist` 由后端 `@fastify/static` 同源服务，无 CORS——部署形态决定了前后端接口无需处理跨域。
- Web 代理的 URL 拼装在 `lib/proxy.ts` 单例，见 [web-proxy.md](web-proxy.md)。
- 终端体系相关前端约定（tab 分组、msmux 后端切换、OSC 深链、活动提醒）见 [terminals.md](terminals.md)。
