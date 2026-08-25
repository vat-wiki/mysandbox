// SSE 小工具：把长任务（镜像 build/pull/push、LXC 模板 build/export/import）的进度
// 逐条推给前端。image.ts 与 template.ts 共用，前端 api.ts 只有一份解析逻辑（streamOp）。
//
// reply.hijack() 接管响应手动写 text/event-stream；鉴权仍在 hijack 前由全局 onRequest 完成。
import type { FastifyReply } from 'fastify';

// 进度事件（脚本 stdout / 自产步骤状态复用同一形状）。
export interface ProgressEvent {
  stream?: string; // 带换行的原始输出（脚本 stdout）
  status?: string; // 单行状态（自产步骤名）
  id?: string;
  progress?: string;
  error?: string;
  aux?: unknown;
}

// finalize 接 thunk：参数解析 / 执行过程中任一抛错都转成 SSE error 帧，
// 保持「要么流式进度、要么流式错误」的契约（HTTP 状态码此时已经发出去了）。
export function beginSse(reply: FastifyReply): {
  sink: (e: ProgressEvent) => void;
  finalize: (thunk: () => Promise<unknown>) => Promise<void>;
} {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // 防 nginx 等反向代理缓冲
  });
  const write = (obj: Record<string, unknown>): void => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  return {
    sink: (e) =>
      write({ type: 'progress', stream: e.stream, status: e.status, id: e.id, progress: e.progress }),
    finalize: async (thunk) => {
      try {
        const result = await thunk();
        write({ type: 'done', result });
      } catch (err) {
        write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        if (!reply.raw.writableEnded) reply.raw.end();
      }
    },
  };
}
