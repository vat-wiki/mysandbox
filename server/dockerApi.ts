// 宿主 docker API 桥（cfg.dockerApi.enabled）：LXC 容器内免装 docker，直用宿主 dockerd。
//
// 形态：本进程内一个 TCP 服务器，绑网关 IP（<ipPool 前缀>.1，宿主在 mysandbox0 桥上的
// 副 IP）的 2375 端口，每个连接双向透传到 cfg.dockerApi.socket 的 unix socket。用裸
// net pipe（字节透明）而不是 HTTP 反代：docker 的 exec attach / build 走 HTTP hijack
// 升级后的裸 TCP 流，pipe 天然支持；dockerd 停机/重启期间连接级失败，桥本身不倒。
//
// 容器侧配套（缺一不可，都随 dockerApi.enabled 开关）：
//   - hosts：hosts-sync 把 host.docker.internal → 网关 IP 写进容器 /etc/hosts 的 services
//     尾块。域名固定不随 ipPool 变——改池子只动 hosts 那一行，容器内配置零重配。
//   - DOCKER_HOST：engine attachArgs 每次 exec 注入（非交互命令/tmux 新起的 shell 都吃到）；
//     scripts/zshrc 条件导出兜底（tmux server 早于功能存在时，env 传不进 server 起的 shell）。
//   - docker CLI：模板 step docker-cli（官方静态包只取客户端二进制，不带 daemon）。
//   - ufw：firewall.ts 推导 LXC 网段 → 2375 的 INPUT 放行（mysandbox-firewall.service 应用）。
//
// 安全立场：docker API = 宿主 root（docker 可挂宿主 /）。暴露面刻意收窄——绑死网桥 IP
// （LAN 无路由可达）+ ufw 只放 LXC 网段（services 网段的应用容器不给）+ 桥随 mysandbox
// 进程存活（服务停即关，不留常驻暴露面）。对容器（dev uid = 宿主 leon，token = 宿主完整
// 权限）这只是把既有信任边界再推一格，换来容器内 docker 零安装。
import { createServer, connect } from 'node:net';
import type { Config } from './config.js';
import { gatewayOf } from './network.js';
import { log } from './logger.js';

// 端口钉死 2375（docker 的约定端口）：scripts/zshrc 的 DOCKER_HOST 是模板里烧死的静态
// 文本，做成可配置就会出现「配置改了、存量容器 zshrc 不跟」的陈旧分叉。
export const DOCKER_API_PORT = 2375;
// 容器内指向宿主 dockerd 的固定域名（hosts 行由 hosts-sync 维护）。借 Docker Desktop
// 的惯用名，看到就懂「这是宿主」。
export const DOCKER_API_HOSTNAME = 'host.docker.internal';

// 每次尝试新建一个 server：listen 失败（EADDRNOTAVAIL 等）后复用同一实例再 listen 的
// 状态机容易留脏状态，重建最省心（失败的 listen 不占端口，旧实例无 fd 泄漏）。
function bind(cfg: Config, bindIp: string): void {
  let attempt = 0;
  const listen = () => {
    const server = createServer((down) => {
      const up = connect(cfg.dockerApi.socket);
      // 对端关闭/出错 → 双向摧毁（docker 的 hijack 连接没有半关闭语义，断就是断）。
      const killUp = () => up.destroy();
      const killDown = () => down.destroy();
      down.on('close', killUp);
      down.on('error', killUp);
      up.on('close', killDown);
      up.on('error', () => {
        // dockerd 停了 / 进程不在 docker 组（EACCES）：连接级失败，debug 级别别刷屏。
        log.debug({ socket: cfg.dockerApi.socket }, 'docker api bridge: upstream connect failed');
        killDown();
      });
      // Nagle 关掉：docker exec attach 的交互式 stdin 都是小包，默认 200ms 合并很卡手。
      down.setNoDelay(true);
      up.setNoDelay(true);
      down.pipe(up);
      up.pipe(down);
    });
    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRNOTAVAIL' && attempt < 15) {
        // 网关 IP 还没挂上（boot 时序：system 的 mysandbox-net 晚于 user service）。
        // 退避重试而不是认命缺席——桥缺席的表象是「容器里 docker 时好时坏」。
        attempt += 1;
        const waitMs = Math.min(1000 * attempt, 5_000);
        log.warn({ bindIp, port: DOCKER_API_PORT, attempt, retryMs: waitMs }, 'docker api bridge: gateway IP not up yet, retrying');
        setTimeout(listen, waitMs).unref();
        return;
      }
      // EADDRINUSE（起了两个 mysandbox）/ EACCES 等一律放弃：非致命，桥缺席只影响
      // 容器内 docker，别把整个服务拖下水。
      log.warn({ bindIp, port: DOCKER_API_PORT, err: e.message }, 'docker api bridge: not listening (containers lose host docker access)');
    });
    server.on('listening', () => {
      log.info({ bindIp, port: DOCKER_API_PORT, socket: cfg.dockerApi.socket }, 'docker api bridge: listening');
    });
    server.listen(DOCKER_API_PORT, bindIp);
  };
  listen();
}

// cli.ts 启动装配点（与 startHostsEventSync 等后台任务同排）。永不抛、不阻塞 listen。
export function startDockerApiBridge(cfg: Config): void {
  if (!cfg.dockerApi.enabled) return;
  bind(cfg, gatewayOf(cfg));
}
