// msmux agent 回连桥：容器/服务在自管网段里，服务本体却通常只监听 127.0.0.1。
//
// 这里在网关 IP（<ipPool 前缀>.1，宿主在 mysandbox0 桥上的副 IP）开一个裸 TCP
// 透传口，把字节原样转给本机控制台端口。WebSocket 握手之后的 raw frame 也走同一条
// TCP 流，所以不需要解析 HTTP/WS。主服务、鉴权与路由完全不变：桥只增加一条「从
// 自管网段能打到 localhost」的入口，/ws/mux-agent 仍由 muxAgent.ts 校验派生 token。
//
// 形态照抄 dockerApi.ts：绑死网桥 IP（LAN 无路由可达）、EADDRNOTAVAIL 退避、随
// mysandbox 进程存活、失败非致命。SSH 目标不在这个网段，部署时要显式传可达 url。
import { connect, createServer } from 'node:net';
import type { Config } from './config.js';
import { gatewayOf } from './network.js';
import { log } from './logger.js';

export function muxAgentBridgeIp(cfg: Config): string {
  return gatewayOf(cfg);
}

export function startMuxAgentBridge(cfg: Config): void {
  if (!cfg.muxToken) return;
  const bindIp = muxAgentBridgeIp(cfg);
  const upstreamPort = cfg.listen.port;
  let attempt = 0;

  const listen = () => {
    const server = createServer((down) => {
      const up = connect(upstreamPort, '127.0.0.1');
      const killUp = () => up.destroy();
      const killDown = () => down.destroy();
      down.on('close', killUp);
      down.on('error', killUp);
      up.on('close', killDown);
      up.on('error', () => {
        log.debug({ port: cfg.mux.agentPort }, 'msmux bridge: upstream connect failed');
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
        log.warn(
          { bindIp, port: cfg.mux.agentPort, attempt, retryMs: waitMs },
          'msmux bridge: gateway IP not up yet, retrying',
        );
        setTimeout(listen, waitMs).unref();
        return;
      }
      log.warn(
        { bindIp, port: cfg.mux.agentPort, err: e.message },
        'msmux bridge: not listening (containers cannot reach the mux agent endpoint)',
      );
    });
    server.on('listening', () => {
      log.info({ bindIp, port: cfg.mux.agentPort }, 'msmux bridge: listening');
    });
    server.listen(cfg.mux.agentPort, bindIp);
  };

  listen();
}
