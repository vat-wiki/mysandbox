// 全局事件总线：进程内多播 + /api/events SSE 下发。
// 事件源全部复用已在跑的订阅，不新增常驻进程：
//   - lxc-monitor（engine subscribeEvents，hosts-sync 同一条流旁路转发）
//   - docker events（subscribeServiceEvents，services 事件同步同一条流旁路转发）
//   - fs.watch（fileWatch.ts，文件面板/编辑器声明要看的目录）
// 前端收到事件才刷新，固定轮询降级为慢速对账兜底（见 web lib/events.ts 与各组件）。
//
// SSE 形状：`data: {json}\n\n`，15s 注释行心跳防代理空闲掐断。鉴权走全局 token hook
//（/api/* 全覆盖），前端经 fetch 流读取（token 走 header，不落 URL）。
import type { FastifyInstance, FastifyReply } from 'fastify';

export type SandboxEvent =
  | { type: 'container-state'; name: string; action: string }
  | { type: 'service-state'; name: string; action: string }
  // target = 文件端点目标 id（容器名 / __host__ / s:名 / ssh:名，与 filesBase 哨兵同约定），
  // dir = 目标内绝对路径目录。只发 target+dir 不发文件名/内容：消费方自己比对（列目录
  // 有 sig 防抖、编辑器有 mtime 乐观锁），事件只是「该看一眼了」的信号。
  | { type: 'file-changed'; target: string; dir: string }
  | { type: 'hello' };

type Client = { write: (e: SandboxEvent) => void };

const clients = new Set<Client>();

export function publishEvent(e: SandboxEvent): void {
  for (const c of clients) {
    try {
      c.write(e);
    } catch {
      // 单客户端写炸不拖垮广播
    }
  }
}

export function registerEventsRoute(app: FastifyInstance): void {
  app.get('/api/events', async (_req, reply: FastifyReply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const write = (e: SandboxEvent): void => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const ping = setInterval(() => {
      if (!reply.raw.writableEnded) reply.raw.write(': ping\n\n');
    }, 15_000);
    const client: Client = { write };
    clients.add(client);
    write({ type: 'hello' });
    reply.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
    });
  });
}

// 状态事件多播源的接线（cli.ts 装配）：hosts-sync / services 事件同步各自的重连循环里
// 拿到的原始事件顺手转发一枪，零新进程。action 原样透传（容器 = lxc 状态小写、
// 服务 = docker action），前端自取所需。
export function relayContainerState(name: string, action: string): void {
  publishEvent({ type: 'container-state', name, action });
}

export function relayServiceState(name: string, action: string): void {
  publishEvent({ type: 'service-state', name, action });
}
