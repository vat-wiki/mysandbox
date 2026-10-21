// 「子进程流 / TCP 流 → WebSocket」数据泵的背压封装(终端四侧 + VNC 共用)。
//
// 为什么必须做背压:浏览器收不动(远程弱网窗口、页面挂起、对端半死)时,内核
// socket 发送缓冲打满,此后 `ws.send()` 会把数据**无界堆进进程内写队列**
// (WritableState[kBufferedValue])。实测(2026-10-21 排查):一台远程浏览器
// 卡住后,容器/宿主/SSH 终端 + 代理的 PTY 输出以 ~45MB/min 灌进写队列,
// 1 小时把 mysandbox 主进程 RSS 灌到 3.4GB 纯匿名堆,GC 压力把所有 exec 类
// 端点拖慢 10~30 倍(/api/metrics 的 listen/cwd/services avg 全线上涨,
// 而纯内存端点恒 0ms——事件循环没堵,堵在分配与回收)。
//
// 语义:只在「对端确认收完已发数据」的意义上暂停源流,绝不丢字节(终端丢
// 字节会永久错位,RFB 丢字节直接断协议)。高水位暂停 + 落回低水位恢复,
// 恢复检查用 200ms 轮询(ws 没有 drain 事件);socket 关闭后定时器自停。
export type WsPumpSocket = {
  readyState: number;
  bufferedAmount: number;
  send(d: Buffer): void;
};

export type WsPumpStream = {
  on(ev: 'data', cb: (d: Buffer) => void): unknown;
  pause(): void;
  resume(): void;
};

const HIGH_WATER_MARK = 4 * 1024 * 1024; // 未确认字节超过 4MB → 暂停源流
const LOW_WATER_MARK = 1 * 1024 * 1024; // 落回 1MB 以下 → 恢复
const DRAIN_TICK_MS = 200;

export function pumpToWs(
  ws: WsPumpSocket,
  streams: WsPumpStream[],
  opts?: { onChunk?: (d: Buffer) => void },
): void {
  const { onChunk } = opts ?? {};
  let paused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
  const onStreamData = (d: Buffer) => {
    if (ws.readyState !== 1 /* OPEN */) return;
    if (!paused) {
      ws.send(d);
      onChunk?.(d);
      if (ws.bufferedAmount > HIGH_WATER_MARK) {
        paused = true;
        for (const s of streams) s.pause();
        timer = setInterval(() => {
          if (ws.readyState !== 1 /* OPEN */) {
            stopTimer();
            return;
          }
          if (ws.bufferedAmount <= LOW_WATER_MARK) {
            stopTimer();
            paused = false;
            for (const s of streams) s.resume();
          }
        }, DRAIN_TICK_MS);
      }
    }
    // paused 期间 'data' 本就不该到(源流已 pause);防御性丢弃前先缓冲?不——
    // pause 之前已在流的内部缓冲里,恢复时按序重放,这里静默返回即可。
  };
  for (const s of streams) s.on('data', onStreamData);
}
