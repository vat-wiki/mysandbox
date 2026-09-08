// 端口探测/监听扫描的公共件：routes.ts（LXC 容器）与 services.ts（docker 服务）共用。
//
// 两类容器拿「里面在监听什么端口」的路径不同——LXC 走 lxc-attach awk 读容器内
// /proc/net/tcp，docker 服务走宿主直读 /proc/<容器主进程 pid>/net/tcp（网络命名空间
// 即容器那张表）——但解析出的端口列表之后要做的事一样：probeHtmlPort 实测哪些是
// 真网页（可点开），哪些只是 ssh/db 类监听。probeHtmlPort 原在 routes.ts，随 docker
// 服务复用一起迁到这里。
import { connect as netConnect, type Socket } from 'node:net';

// —— 端口 HTML 探测（区分「真 web 页面」与其他监听端口）——
// 宿主直连容器/服务 IP 发最小 HTTP 请求：状态行是 HTTP 且（Content-Type text/html 或
// body 以 '<' 开头）才算 web。ssh/redis/postgres 这类要么先发 banner（非 HTTP 状态行）、
// 要么等输入超时、要么回 JSON/二进制——都判 false。HTTP/1.0 + Connection: close 让
// 服务端回完即断，不留半开连接。
const PROBE_IDLE_MS = 800; // 连接后/发出请求后等待对端说话的上限（内网足够宽裕）
const PROBE_TOTAL_MS = 2_000; // 单端口总兜底

export function probeHtmlPort(ip: string, port: number): Promise<boolean> {
  return new Promise((settled) => {
    const socket: Socket = netConnect({ host: ip, port });
    let buf = '';
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(totalTimer);
      socket.destroy();
      settled(v);
    };
    const totalTimer = setTimeout(() => finish(false), PROBE_TOTAL_MS);
    socket.setTimeout(PROBE_IDLE_MS, () => finish(false)); // 对端不说话（等输入的协议）→ 非 HTTP
    socket.on('connect', () => {
      socket.write(
        `GET / HTTP/1.0\r\nHost: ${ip}:${port}\r\nUser-Agent: mysandbox-probe\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (d: Buffer) => {
      buf += d.toString('latin1');
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1 && buf.length < 16 * 1024) return; // 头部没完，继续收
      const head = idx === -1 ? buf : buf.slice(0, idx);
      if (!/^HTTP\/[\d.]+ \d{3}/.test(head)) return finish(false); // ssh banner 等：连了但不是 HTTP
      const ct = /content-type:[^\r\n]*/i.exec(head)?.[0] ?? '';
      const bodyStart = idx === -1 ? '' : buf.slice(idx + 4, idx + 64);
      // text/html 或 body 直接以 <!doctype / <html 开头（个别 dev server 不带正确 content-type）
      finish(/text\/html/i.test(ct) || /^\s*<(?:!doctype|html)/i.test(bodyStart));
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false)); // 头部没收全就断：不算（正常情况 data 里已 finish）
  });
}

// /proc/net/tcp{,6} 文本 → LISTEN 端口（十进制、去重、升序）。
// 行形状：`  0: 00000000:1538 00000000:0000 0A ...`——sl 本地地址 状态 …；
// 本地地址是十六进制：v4 为 8 位小端 hex（首字节在末两位），v6 为 32 位 hex。
// 回环监听剔除（127.0.0.0/8 与 ::1）：外部本来就不可达，且 docker 内嵌 DNS
// （127.0.0.11）会在每个服务容器的网络命名空间里挂一个随机端口的监听，纯噪音。
export function parseProcNetListeners(text: string): number[] {
  const out = new Set<number>();
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^\d+:$/.test(cols[0] ?? '')) continue;
    if (cols[3] !== '0A') continue; // 0A = LISTEN
    const [addr, portHex] = (cols[1] ?? '').split(':');
    if (!addr || !portHex) continue;
    // v4：末两位 = 首字节（小端），127 = 0x7F；v6：::1 的固定形状（全零 + 末字 01000000）
    const loopback = addr.length === 8 ? addr.endsWith('7F') : addr === '00000000000000000000000001000000';
    if (loopback) continue;
    const port = parseInt(portHex, 16);
    if (Number.isInteger(port) && port > 0) out.add(port);
  }
  return [...out].sort((a, b) => a - b);
}
