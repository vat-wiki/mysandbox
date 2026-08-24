// token 校验。REST 走 header X-Sandbox-Token 或 query ?token=（WS 复用）。
import type { FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { Config } from './config.js';

export function tokenValid(provided: string | undefined, cfg: Config): boolean {
  const expected = cfg.token;
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractToken(req: FastifyRequest): string | undefined {
  const h = req.headers['x-sandbox-token'];
  if (typeof h === 'string') return h;
  const q = req.query as Record<string, unknown> | undefined;
  if (q && typeof q.token === 'string') return q.token;
  return undefined;
}

export async function requireToken(
  req: FastifyRequest,
  reply: FastifyReply,
  cfg: Config,
): Promise<void> {
  if (!tokenValid(extractToken(req), cfg)) {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'invalid or missing token' },
    });
  }
}
