// 宿主 ADB 桥（cfg.android.enabled）：LXC 容器内用 ADB 客户端访问宿主 USB 安卓设备。
//
// 形态照抄 server/dockerApi.ts：本进程内跑 TCP 透传，绑网关 IP（<ipPool 前缀>.1），
// 每个连接转发到宿主 ADB server。ADB 的命令/attach 流对 HTTP 语义不敏感，裸字节管道
// 最稳。USB 只属于宿主 adb server；容器侧不启动自己的 ADB server，凭据/授权集中一处。
//
// 容器侧配套（都随 android.enabled 开关）：
//   - hosts：hosts-sync 把 host.android.internal → 网关 IP 写进 services 尾块。
//   - ADB_SERVER_HOST/PORT：engine attachArgs 注入 + scripts/zshrc 兜底（tmux 老 shell）。
//   - adb 客户端：模板 apt 契约预装；存量容器可自行 sudo apt install adb。
//   - ufw：自管网段全端口 blanket（firewall.ts 信任模型）覆盖 ADB 端口。
//
// 安全立场：ADB server 可 shell/安装/读写设备。绑死网桥 IP + 桥随 mysandbox 进程存活
// （服务停即关）。默认关；自管网段全端口互信下开启即视为容器可信。
import { createServer, connect } from 'node:net';
import type { Config } from './config.js';
import { gatewayOf } from './network.js';
import { log } from './logger.js';

// ADB server 的约定端口；配置里的 port 同时是网桥监听端口与容器内的目标端口。
export const ANDROID_ADB_PORT = 5037;
// 容器内指向宿主 ADB server 的固定域名（hosts 行由 hosts-sync 维护）。
export const ANDROID_ADB_HOSTNAME = 'host.android.internal';

function bind(cfg: Config, bindIp: string): void {
  let attempt = 0;
  const listen = () => {
    const server = createServer((down) => {
      const up = connect({ host: cfg.android.host, port: cfg.android.port });
      const killUp = () => up.destroy();
      const killDown = () => down.destroy();
      down.on('close', killUp);
      down.on('error', killUp);
      up.on('close', killDown);
      up.on('error', () => {
        // adb server 没起/被重启：连接级失败，桥本身不倒。
        log.debug({ host: cfg.android.host, port: cfg.android.port }, 'android adb bridge: upstream connect failed');
        killDown();
      });
      down.setNoDelay(true);
      up.setNoDelay(true);
      down.pipe(up);
      up.pipe(down);
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRNOTAVAIL' && attempt < 15) {
        attempt += 1;
        const waitMs = Math.min(1000 * attempt, 5_000);
        log.warn({ bindIp, port: ANDROID_ADB_PORT, attempt, retryMs: waitMs }, 'android adb bridge: gateway IP not up yet, retrying');
        setTimeout(listen, waitMs).unref();
        return;
      }
      log.warn({ bindIp, port: ANDROID_ADB_PORT, err: e.message }, 'android adb bridge: not listening');
    });
    server.on('listening', () => {
      log.info({ bindIp, port: ANDROID_ADB_PORT, host: cfg.android.host, upstreamPort: cfg.android.port }, 'android adb bridge: listening');
    });
    server.listen(ANDROID_ADB_PORT, bindIp);
  };
  listen();
}

export function startAndroidAdbBridge(cfg: Config): void {
  if (!cfg.android.enabled) return;
  bind(cfg, gatewayOf(cfg));
}
