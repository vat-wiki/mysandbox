#!/usr/bin/env node
// Node HTTPS 门面：systemd socket activation 把 443 交给本进程，TLS 在这里终结，
// 再回源到本机 mysandbox 的 HTTP 端口（7321）。这样 7321 可以同时保持本机 HTTP。
//
// HTTP/2（2026-10-21 起）：远程弱网访问的轮询场景收益最大——前端 3~5 个 poller
// 本来各占一条 HTTP/1.1 连接（浏览器单源 6 条上限），h2 下全部多路复用进一条
// TLS 连接，弱网/高丢包链路上省掉排队与重复握手。
//
// 刻意不做 WS over h2（RFC 8441），原因实测过（2026-10-21，node 24）：h1 回退依赖
// compat 'request' 监听器，而 compat 一激活就把 extended CONNECT 自动回 405
// （'stream' 事件收到时响应已发出，ERR_HTTP2_HEADERS_SENT）；纯低层能实现隧道但
// h1 回退整个死掉（Safari/curl/CLI 全挂），无两全。不开 enableConnectProtocol 时
// 浏览器发现服务端不支持，自动改走独立 h1 连接做 WS——与旧版行为一致，零回归。
// 事件分发（实测）：h2 与 h1 回退的常规请求都走 compat 'request'，WS 走 'upgrade'。
import http from 'node:http';
import http2 from 'node:http2';
import { loadConfig } from './config.js';
import { ensureTlsMaterial } from './tls.js';
import { log } from './logger.js';

interface Args {
  host?: string;
  port?: number;
  listen?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') out.host = argv[++i];
    if (argv[i] === '--port') out.port = Number(argv[++i]);
    // 测试钩子：绕过 socket activation 直接监听指定端口（单测 h2/h1/隧道用，不进生产装配）
    if (argv[i] === '--listen') out.listen = Number(argv[++i]);
  }
  return out;
}

function socketActivatedFd(): number | null {
  if (process.env.LISTEN_FDS !== '1') return null;
  if (process.env.LISTEN_PID !== String(process.pid)) return null;
  return 3;
}

// 结构化最小类型：h2 compat 的 req/res 与 http1 的形状差一层继承，够用即可
interface FwdReq {
  headers: http.IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}

function forwardedHeaders(req: FwdReq): http.OutgoingHttpHeaders {
  // h2 compat 的 req.headers 带伪头（:method/:scheme/:authority/:path，实测），
  // http.request 不收非法 token——剥掉，:authority 补成 host（h2 请求没有 host 头）
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (name.startsWith(':') || value === undefined) continue;
    out[name] = value;
  }
  const authority = (req.headers as Record<string, string | undefined>)[':authority'];
  if (authority) out.host = authority;
  return {
    ...out,
    // 回源连接来自 loopback；后端只在 loopback 直连时信任这个头。
    // 必须覆盖客户端伪造的 XFF，否则内网互信会被伪装来源绕过。
    'x-forwarded-for': req.socket.remoteAddress ?? '',
    'x-forwarded-proto': 'https',
  };
}

interface SimpleRes {
  headersSent: boolean;
  destroy(): void;
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: unknown): unknown;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'];

function writeSimpleResponse(res: SimpleRes, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(message);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { config } = await loadConfig();
  if (!config.listen.tls) throw new Error('HTTPS facade requires listen.tls=true');

  const tls = await ensureTlsMaterial(config);
  const targetHost = args.host ?? (config.listen.host === 'auto' ? '127.0.0.1' : config.listen.host);
  const targetPort = args.port ?? config.listen.port;
  const agent = new http.Agent({ keepAlive: true });

  const server = http2.createSecureServer({
    key: tls.key,
    cert: tls.cert,
    allowHTTP1: true,
    settings: { /* 刻意不开 enableConnectProtocol：见文件头「WS over h2」说明 */ },
  });

  // —— 常规请求（h2 compat + h1 回退同走这里）——
  server.on('request', (req, res) => {
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req),
      agent,
    }, (upstreamRes) => {
      // 上游是 h1 响应：connection/keep-alive/transfer-encoding 等 hop-by-hop 头
      // 在 h2 里非法（ERR_HTTP2_INVALID_CONNECTION_HEADERS），写回前剥掉；
      // 分块语义由 h2 自身接管
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP.includes(name)) continue;
        headers[name] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res);
    });
    upstream.on('error', () => writeSimpleResponse(res, 502, 'mysandbox upstream unavailable'));
    req.pipe(upstream);
  });

  // —— WS over h1.1（ALPN 回退，Safari 等不带 RFC 8441 的客户端）——
  server.on('upgrade', (req, socket, head) => {
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      path: req.url,
      headers: forwardedHeaders(req),
      agent,
    });
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${upstreamRes.statusCode ?? 101}`];
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (value === undefined) continue;
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
      const close = () => {
        upstreamSocket.destroy();
        socket.destroy();
      };
      upstreamSocket.on('error', close);
      socket.on('error', close);
      upstreamSocket.on('close', close);
      socket.on('close', close);
    });
    upstream.on('response', (upstreamRes) => {
      const body = `HTTP/1.1 ${upstreamRes.statusCode ?? 502} Bad Gateway\r\nconnection: close\r\n\r\n`;
      socket.end(body);
    });
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'));
    upstream.end();
  });

  // 畸形 h2/h1 流量不进错误处理器就崩进程，全部静默销毁
  server.on('sessionError', () => {});
  server.on('streamError', () => {});
  server.on('clientError', (_err, socket) => socket.destroy());

  const fd = socketActivatedFd();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (args.listen !== undefined) server.listen(args.listen, '127.0.0.1', resolve);
    else if (fd === null) server.listen(443, '0.0.0.0', resolve);
    else server.listen({ fd }, resolve);
  });
  log.info({ target: `${targetHost}:${targetPort}`, socketActivated: fd !== null }, 'https facade ready (h2+h1)');

  const shutdown = () => {
    // http2 server 没有 closeAllConnections（实测 undefined）：3s 后强退，不等长连接
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  process.stderr.write(`>> https facade fatal: ${e}\n`);
  process.exit(1);
});
