# TestLens 使用问题记录（mysandbox 团队测试轮 · 2026-11-06）

> 本轮用 TestLens（testlens-v2 API-first 协议）对 mysandbox 做了 5-agent 团队自测。
> 本文件只记 **TestLens 本身的使用问题与改进建议**；被测系统（mysandbox）的 bug 走
> TestLens feedback（项目 `mysandbox`，projectId 27）。

## 环境基线

- TestLens 部署：本机 `http://127.0.0.1:10004`（policy 200，新版实例池协议）。
- 流程定义：首建项目 `mysandbox`（id 27）+ `from-markdown` 导入「mysandbox 全景 v1」（版本 31，36 节点 / 28 连线 / 0 warnings）。
- 团队：5 个 agent × 1 实例 × 1 轮次（全局与鉴权 / 容器管理 / 终端 / 文件面板+服务管理 / 技能中心）。

## 本轮测试结果速览

- 覆盖：24/24 个模块目标节点全覆盖（36 节点中其余为模块父节点与别组目标），unknownMarks=0。
- 结论：auth / container **通过**；skill / term / files **有条件通过**。
- mysandbox feedback：#43（`/ai` 深链偶发被顶到 `/files/__host__`）、#44（失效 termId 的 cwd 轮询 404 不退避）、#46（文件面板跟随容器终端错落宿主面板 + 404 死循环，同根）、#48（会话切换历史乱码/丢失）、#49（活跃会话列表点击疑似新建而非接入）、#50（DELETE container 路由对 msmux 会话静默空操作）；TestLens 自身 bug：#45（mmap_rnd_bits）、#47（chromium 段错误修复建议）、#51（503 无原因透出）。
- 优先修复：#46（文件面板跟随错配/轮询死循环）、#50（清理操作假成功）、#48（终端切换失步）。

## 已发现的使用问题

### P0 级摩擦（直接导致测试失真 / 卡死）

1. **被测 URL 必须写「浏览器所在网络」可达的地址，不是 API 调用方可达的地址**
   - 现象：TestLens 的 Chrome 跑在 mytest 容器 netns 里，`POST /api/runs` 传 `http://127.0.0.1:7321` → 容器内 127.0.0.1 指容器自身 → tab 停在 chrome-error 页 + 2 条 `ERR_CONNECTION_REFUSED` 落进本轮 errorCount（永久留在 report 里）。API 调用方（宿主）curl 同地址完全可达，极具迷惑性。
   - 复现：开轮次 `{"url":"http://127.0.0.1:7321"}`；正确写法是网桥宿主地址（`10.88.10.1:7321` 或 testlens 容器所经网桥的宿主端 `10.88.0.1:7321`，均验证可达）。
   - 附加坑：tab 落在 `chrome-error://` 页时 `eval localStorage` 抛 SecurityError（错误页文档禁 localStorage），报错完全没提「网络不通」，误导排查方向。
   - 改进建议：run 创建响应里带「浏览器侧 url 可达性探测」警告字段；或文档用显著位置写明该判据。
2. **`POST /api/runs` 间歇性 / 稳定性 503 `browser did not become ready in 20s`，且失败原因不可诊断**
   - 现象：auth 组同参数连续 4 次失败（每次 20s）后自愈；container 组遇到**全挂**（所有实例起不来），排障必须进容器手动跑二进制（`docker exec testlens chromium --version` 复现段错误；「strace 包住则不崩」是关键判别线索）。
   - **根因一（container/files 组定位，平台级）**：宿主内核 `vm.mmap_rnd_bits=32`（Ubuntu 抬高值）+ 容器内 Debian 12 glibc 2.36 已知不兼容 → chromium 155 启动即 GP fault in ld.so（Segfault exit 139、日志零输出）。**两组并行做了两条临时修复，现同时生效**：① container 组 `sudo sysctl -w vm.mmap_rnd_bits=28`（运行时生效，**宿主 reboot 复发，建议写 /etc/sysctl.d/**，feedback #45）；② files 组 `docker cp` 宿主 google-chrome 151 进容器 `/opt/google/chrome`，把 `/usr/lib/chromium/chromium` 换成转发脚本（原二进制备份为 `chromium.segv-backup`，**容器 recreate 即回退坏状态**，feedback #47 建议：镜像预置旧 V8 chrome-for-testing 或 compose 卷挂可用浏览器 + `CHROME_BIN`——chrome-instance.js 本就支持）。
   - **根因二（skill 组定位）**：宿主孤儿 headless Chrome 占坑（PPID=init 的残留进程，如 `/tmp/cdp-prof` 的 9223、`/tmp/probe-chrome-prof` 的 9411——后者 DevTools 端口根本没监听）。
   - 改进建议：503 响应带回 spawn 失败原因（chrome exit code / stderr 摘要）；server 启动浏览器前检测同 profile SingletonLock / 端口冲突并给指向性报错；实例加存活看门狗；dev 模式日志也要落盘。
   - 日志排查绕：容器部署下 pitfalls「看 server 日志」没说日志在哪——server 容器 stdout 重定向到 `/tmp/tl-server.log` 且文件已删（fd 还开着），真正可用的是 `docker logs testlens`。

### P1 级摩擦（降低效率 / 误导排查）

3. **`/api/runs/:id/mark` 无命中回显**：响应只有 `{ok,t}`，打点是否命中节点要等全量 report 才知道；`/api/sessions/:id/coverage` 不存在（404）。建议加轻量单会话覆盖率端点或 mark 响应带 `matchedNode`。
4. **`agent-browser find text "..." click` 对弹出菜单 menuitem 不可靠**：点击后菜单关闭但项未激活（疑似坐标/目标命中问题）；必须改用 snapshot 的 accessibility ref 精确 click。使用规范应写死：**菜单/弹层内点击一律用 ref**。
5. **`agent-browser type` 裸调用（不带选择器）静默无效**：不报错但什么都没输入，靠后续按钮状态才能发现。应报错或文档标明必须带选择器 + 先 click 聚焦。
6. **打点角标（burn-in 序号徽标）留在 DOM 里进截图**：带序号蓝色圆标编号=mark 序号，reload 才消失，目检时容易误判成被测页面元素（auth、skill 两组独立踩到并核实非 mysandbox UI）。建议提供截图前淡化/隐藏手段。
7. **503 但轮次实际已建成，协议无幂等键**：skill 组某次 POST `/api/runs` 收到 503，服务端却已创建 run+instance，靠 `GET /api/runs` 列表才找回——失败重试会攒脏轮次。建议：请求带幂等键，或文档写明「503 后先查 runs 列表再决定重试」。
8. **`GET /api/runs/:id` 不回 `cdp` 与 `nodes[]`**：建轮响应若丢失/报错，拿不到 cdp，只能绕道 `GET /api/browser/instances/:id`。建议轮次详情也带上这两个字段。
9. **【团队模式硬伤】run 无归属保护，mark/finish 任何调用方都能执行**：files 组的第一个 run `mw4b2vtw` 被并行的 skill 组检到并共用——技能中心 4 个打点落进 files 组的 session、run 被对方 finish、实例被释放导致 files 组 CDP 后续 401。团队并行时覆盖率互相污染且事后无法区分。建议 mark/finish 校验创建者（token/调用方标识），或文档强制「从 runs 列表捡 run 前先核对 url/label 归属」。
10. **`agent-browser find text` 匹配不了拆分文本的元素**：`已装·4`（文字与计数分属不同 span）用 `find text "已装"`、`"已装·4"` 都匹配不到（container 组同样在「模板管理」menu item、`<summary>` 高级折叠上报 No element found——文本挂在带 icon 子元素的 div/summary 上）。且行为随 DOM 变化不稳定（同一按钮时找到时找不到）。只能 eval 打临时属性再按选择器点。文档应写明 find text 的匹配规则（**纯文本叶子**，不跨子元素拼接、不覆盖菜单项/summary 形态），并给 eval 兜底示例。
11. **mark 同名重复提交不去重不告警**：误打两次同一节点名静默双计。建议幂等或响应告警。
12. **`agent-browser mouse` 子命令不支持 `click`**（要 move/down/up 三连）；小目标（tab 的 × 按钮）只能坐标点击，坐标又随抽屉开合漂移。

### P2 级观察（知晓即可）

13. **`/api/browser/instances` 无鉴权且明文暴露每台实例的 CDP token**（token 即凭据）。内网自测工具可接受，但值得知晓。
14. **snapshot 里 password 输入框以打码圆点显示，无法核对输入内容**，只能靠界面间接状态（如按钮解禁）确认——安全上合理，但排障时要心里有数。
15. **机器缺 `jq`**：skill 文档「一切用 curl + jq」默认 jq 在 PATH，本机没有；文档可加一句「无 jq 用 node -e 解析」。
16. **`POST /api/feedback` 的 `kind` 合法枚举文档缺失**：api.md 只写 `kind` 不列枚举值，prompt 模板里的 `kind:"bug"` 被 API 拒绝，实际合法值形如 `target_bug` / `env_issue` 等。建议 api.md 补枚举清单。

### 终端组补充（与上面不重复的部分）

17. **reka 下拉菜单在 agent-browser 两次 CLI 调用之间自动关闭**：CDP 重新 attach 即焦点丢失，菜单/弹层活不过单条命令——设置菜单「终端工具条」入口点不到。兜底：直接 `history.pushState` + `popstate` 事件做 SPA 路由切换（直达 URL 会被路由守卫弹回工作区，不走这条路）。
18. **`set device` 触摸仿真不生效**：set 成功但 `pointer:coarse` 仍 false、`maxTouchPoints=0`，手机工具条（靠 pointer:coarse 判定）拉不出来；与既有「TestLens 手机视口仿真坑」记忆一致，本环境只能走桌面入口替代覆盖。
19. **侧栏平滑滚动期间坐标点击漂移**：eval 读到的 rect 与真实点击时刻错位，`mouse click` 屡屡点到相邻分组头（折叠/展开副作用）。列表/动画中的元素点击优先用 ref 或 `el.click()`。
20. **eval 顶层 `var` 跨调用持久**：同名再声明报 `Identifier already declared`，看起来像页面坏了；eval 一律 IIFE 或唯一变量名。
21. **裸文本输入用 `keyboard type` 不是 `type`**：`type` 的首参是选择器（不带报 Element not found）；对 xterm 这类 canvas/聚焦捕获控件，先 click 聚焦再 `keyboard type` 才进得去。
22. **顶部会话 tab 标签是中间点 `dev·1`**：`find text "dev 1"` 匹配不到；DOM dump 再按文本点击才稳。

### 环境事实（非问题，但必须记住）

- TestLens 部署（127.0.0.1:10004）实为 docker-proxy → mytest 容器内服务；浏览器在容器 netns。**凡是「本机服务」地址一律换成容器侧可达的宿主网桥地址**：`10.88.10.1:7321` 与 `10.88.0.1:7321` 均验证可达（任选其一写进约定）。
- `~/.testlens.json` 的 host 钉着 `10.88.10.1:10004`（另一套部署语义），TestLens API 一律显式传 `http://127.0.0.1:10004`。
- ⚠️ **宿主 sysctl 改动留痕**：本轮排障把 `vm.mmap_rnd_bits` 32→28（sudo sysctl -w，运行时生效、未持久化）。要持久化需写 `/etc/sysctl.d/`（待用户确认后做），否则宿主 reboot 后容器内 chromium 起不来、全部轮次 503。
