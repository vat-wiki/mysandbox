# 移动端软键盘验收清单

改 `useVirtualKeyboard.ts` / `usePhoneToolbar.ts` / `Terminal.vue` 的尺寸或焦点路径之后，按本页在真机上过一遍。
设计原理见 [terminals.md](../architecture/terminals.md)「手机软键盘 = 真实让位」条目；本页只讲**怎么验、看到什么算过**。

## 为什么要两种浏览器都测

软键盘让位有两条互斥的浏览器策略，代码里都有分支，**只看一种会漏一半**：

| 模式 | 行为 | 典型载体 | 代码判据 |
| --- | --- | --- | --- |
| **视觉视口** | 布局不动，`innerHeight` 不变、`visualViewport.height` 变矮 | iOS Safari、Chrome Android 默认（尊重 `interactive-widget=resizes-visual`） | `innerHeight − vv.height − vv.offsetTop` |
| **布局视口** | 布局自己被缩，`innerHeight` 与 `vv.height` 同步变矮，差值恒 0 | 华为/荣耀壳（实测 HuaweiBrowser 17.9.2 / Chromium 132，**忽略** `interactive-widget`） | 「无键盘基线 − 当前 `innerHeight`」（`iw ≤ 768` 才认） |

判定当下走哪条：键盘弹起时读一次

```js
// Chrome DevTools 远程调试（adb forward tcp:9222 localabstract:chrome_devtools_remote）
JSON.stringify({ ih: innerHeight, vh: Math.round(visualViewport.height) })
```

- `ih` 不变、`vh` 变矮 → 视觉视口模式（不该钉高）
- `ih` 与 `vh` 一起变矮 → 布局视口模式（`layoutMode`，应钉高）

## 环境准备

```bash
adb reverse tcp:7321 tcp:7321                  # 手机直连宿主服务，免证书/免 LAN
adb forward tcp:9222 localabstract:chrome_devtools_remote   # 华为壳换成 huawei_webview_devtools_remote_<pid>
adb shell am start -a android.intent.action.VIEW -d "http://localhost:7321/"
```

- 用 `http://localhost:7321` 而不是 `https://<ip>.sslip.io`：本地 CA 手机不信任，且 `localhost` 是 secure context（剪贴板 API 才可用）。
- Chrome < 94 打不开本站（build target 是 es2022）。老设备只能用系统壳浏览器。
- 想数「到底发了几次 exec.resize」，在页面里钩住 WS 发送即可（见文末「计数方法」）。

## 用例

前提：打开一个终端（跑 `claude`/`codex` 这类备用屏 TUI 更能看出重绘），光标停在提示符。

| # | 操作 | 预期 | 备注 |
| --- | --- | --- | --- |
| 1 | 点终端 → 键盘弹起 | 终端缩到工具条上方；工具条两行贴着键盘上沿；底部导航滑出；**只发 1 次 resize** | 终端底部与工具条之间约 6px 呼吸位，不该被工具条压住 |
| 2 | 直接收起键盘 | 先保持缩小约 0.9s，再撑回全高；过程有约 0.26s 变黑再淡出；**只发 1 次 resize（回到全高行数）** | 「变黑」是遮罩，正常 |
| 3 | 收起键盘 → 0.5s 内再点终端 | **0 次 resize**，内容原样、无闪烁；工具条重新出现 | 这条是整套设计的核心指标 |
| 4 | 中文输入法切出候选栏/预测栏 | **不该有任何 resize**；终端不跳 | `KB_STEP=48px` 量化兜住；只能人工测 |
| 5 | 语音/手写输入唤醒 | 工具条仍贴键盘上沿，终端不被遮挡 | 人工确认 |
| 6 | 键盘态下点终端黑区（工具条上方、终端文字下方） | 焦点交回终端（键盘保持/重新弹出），不该没反应 | `Terminal.vue` 的 `onRootPointerDown` |
| 7 | 分屏两个 pane，键盘在下半屏弹起 | 只有被压住的 pane 让位；上方 pane 尺寸不动 | 上方 pane 量出 0 |
| 8 | 键盘态切到别的终端 pane | 原 pane 立刻交还让位权（不等 0.9s），新 pane 让位 | `onFocusedOut` 里的 `.xterm` 判定 |
| 9 | 键盘态切到「文件」/「AI」 | 底栏立刻滑回；不残留半屏黑 | 视图切换会 blur |
| 10 | 小屏（≈667pt 高） | 终端至少留 7~9 行（`KB_MIN_TERM=120px` 兜底），工具条不压内容 | |
| 11 | 滚动地址栏伸缩（无键盘） | 不该出现遮罩闪烁或 resize | 基线只在键盘确认关闭时抬高 |
| 12 | 转屏 | 键盘态清空、重新开合仍正常 | 宽度变化即重置基线 |
| 13 | 收键盘的最后一拍事件丢了（用例 2 后停在半屏：终端卡在上半、工具条浮在屏幕中间、底栏不出来） | ≤0.3s 内被兜底轮询发现，随后按用例 2 正常收尾（工具条消失、底栏回来、0.9s 后撑满） | `WATCHDOG_MS`；真机难主动触发，判定只看 `kbRaw`/`kbOpen` 最终是否落回 false（临时挂 `window` 观察即可） |

## 计数方法（页面内钩 WS 发送）

```js
window.__rz = []
const o = WebSocket.prototype.send
WebSocket.prototype.send = function (d) {
  try {
    if (typeof d === 'string' && d.includes('resize')) {
      const j = JSON.parse(d)
      __rz.push([Date.now() % 1e6, j.cols, j.rows, new Error().stack.split('\n')[2]])
    }
  } catch {}
  return o.call(this, d)
}
```

判读要点：

- **每次开合只该有 1 条两帧栈的记录**（`onResize` → 去抖 → `sendResize`）。
- **单帧栈的是心跳**：`useTermSocket` 每 15s 发一帧 resize 做尺寸对账，后端尺寸不变即跳过，不产生 `SIGWINCH`——不要误判成「多余的 resize」。
- **别重复装钩子**：装两次会让每次发送记两条（同一时间戳、同样的值），看起来像重复发送。
- 若出现「同尺寸连续两条」，先看时间差：≈15s 是心跳，≈0 是钩子重复，其余才需要查。

## 失败时先看这几个常量

`web/src/composables/useVirtualKeyboard.ts`：

| 常量 | 默认 | 作用 / 调大会怎样 |
| --- | --- | --- |
| `KB_MIN` | 120 | 键盘识别阈值；调大更抗地址栏抖动，但小键盘设备可能漏判 |
| `KB_STEP` | 48 | 高度量化（≈2 行）；调大更能吞候选栏变化，代价是让位更迟钝 |
| `KB_SETTLE` | 80 | 开键盘等动画停住；调大更稳但更慢 |
| `KB_CLOSE_DELAY` | 900 | 收起后延迟恢复；**用例 3 全靠它**，调小会让「看一眼再点回来」重新变成两次 resize |
| `WATCHDOG_MS` | 300 | 会话期间兜底轮询（用例 13）：收键盘最后一拍事件丢失时靠它自愈；调大恢复更慢，调小只是多几次属性读取 |

`web/src/composables/usePhoneToolbar.ts`：`KB_GAP=6`（终端底与工具条间距）、`KB_MIN_TERM=120`（让位后最少保留高度）、`KB_MASK_MS=260`（遮罩窗口）。
`web/src/components/Terminal.vue`：`onResize` 140ms 去抖 + 与上次已发尺寸去重。
