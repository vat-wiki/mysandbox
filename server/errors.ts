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

// dockerode 错误 -> HttpError（404 映射）。kind 区分 container/image，避免镜像 404 被误报成 container。
export function wrapDocker(
  e: unknown,
  idHint = '',
  kind: 'container' | 'image' = 'container',
): Error {
  const err = e as { statusCode?: number; message?: string };
  if (err && err.statusCode === 404) {
    return notFound(`${kind} ${idHint} not found`);
  }
  return e instanceof Error ? e : new Error(String(e));
}
