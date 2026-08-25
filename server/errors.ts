// HTTP 错误类型 + 全局错误处理映射。
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const notFound = (m: string) => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
export const badRequest = (m: string) => new HttpError(400, m, 'bad_request');

// 引擎错误 -> HttpError 归一（404 形状映射 not_found）。
// LXC 侧多数路径直接抛 HttpError，这里兜住其余 Error 形状。
export function wrapEngineError(
  e: unknown,
  idHint = '',
  kind: 'container' | 'template' = 'container',
): Error {
  const err = e as { statusCode?: number; message?: string };
  if (err && err.statusCode === 404) {
    return notFound(`${kind} ${idHint} not found`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
