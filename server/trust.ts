// 内网互信判定：mysandbox 面向开发网络，不做通用公网服务。
// 只在显式 proxy.trustLan=true 时，允许私网来源免 token 访问控制台/WS/代理。
import type { FastifyRequest } from 'fastify';
import type { Config } from './config.js';

// HTTPS facade 在本机终结 TLS 后回源；只有回源连接来自 loopback 时，
// 才允许用它覆写过的 X-Forwarded-For 还原真实客户端 IP。
function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/i, '').toLowerCase();
}

function isLoopback(ip: string): boolean {
  return ip === '::1' || /^127\./.test(ip);
}

function isPrivateIPv4(ip: string): boolean {
  return (
    /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^169\.254\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    // Tailscale CGNAT：100.64.0.0/10
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)
  );
}

function isPrivateIPv6(ip: string): boolean {
  return ip === '::1' || /^(fc|fd)/.test(ip) || /^fe80/.test(ip);
}

export function requestClientIp(req: FastifyRequest): string {
  const remote = normalizeIp(req.socket.remoteAddress ?? '');
  if (isLoopback(remote)) {
    const forwarded = req.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
      ?.split(',')[0]?.trim();
    if (first) return normalizeIp(first);
  }
  return remote;
}

export function trustedNetworkRequest(req: FastifyRequest, cfg: Config): boolean {
  if (!cfg.proxy.trustLan) return false;
  const ip = requestClientIp(req);
  return isLoopback(ip) || isPrivateIPv4(ip) || isPrivateIPv6(ip);
}
