// 弱网自适应轮询：api 层每次请求回报耗时/成败，这里维护 EWMA 与连败计数，判定
// 链路档位（正常/慢/差）。轮询器经 gatePoll 包装：实际执行频率 = 基础间隔 × 档位
// 系数——局域网零变化（系数 1），远程弱网把 5s 轮询自动拉长到 15~25s。
//
// 背景（2026-10-21 诊断）：前端每日 13~40 万请求全是轮询，局域网无感，远程弱网下
// HTTP/1.1 单源 6 连接被轮询占满 → UI 卡、终端 WS 抢不到链路 → 掉线。
//
// 刻意不发自建探针（额外流量），完全搭 api() 的便车；阈值取轮询端点健康 p50
// （~64ms）的整数倍：>600ms 明显异常（正常一两拍 exec 就这个数），>1.5s 链路已差。
// 连败 ≥2 直接判差（连续超时多半断网，探不动不如歇着）。

let ewmaMs = 0;
let consecFails = 0;

export function noteRequest(ms: number, ok: boolean): void {
  if (!ok) {
    consecFails += 1;
    return;
  }
  consecFails = 0;
  ewmaMs = ewmaMs === 0 ? ms : ewmaMs * 0.8 + ms * 0.2;
}

// 档位系数：1（正常）/ 3（慢）/ 5（差）。判断依据见上。
export function linkFactor(): number {
  if (consecFails >= 2 || ewmaMs >= 1500) return 5;
  if (ewmaMs >= 600) return 3;
  return 1;
}

export interface GateOpts {
  // 页面隐藏时也拉长间隔（多开窗口/切 tab 时砍后台流量）。**终端活动轮询等
  // 「隐藏也要跑」的 poller 不得开**——agent 等输入的浏览器通知依赖它。
  hidden?: boolean;
}

// 把 setInterval 的 tick 函数包一层闸：未到「基础间隔 × 当前档位系数」就直接跳过。
// 间隔本身不变（timer 结构零改动），变的是真实请求频率；链路恢复后 ≤ 一个基础周期
// 内回到正常节奏。
export function gatePoll(fn: () => unknown, baseMs: number, opts?: GateOpts): () => void {
  let lastRun = 0;
  return () => {
    let factor = linkFactor();
    if (opts?.hidden && document.hidden) factor = Math.max(factor, 4);
    if (Date.now() - lastRun < baseMs * factor) return;
    lastRun = Date.now();
    void fn();
  };
}
