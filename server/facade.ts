#!/usr/bin/env node
// Node HTTPS 门面：systemd socket activation 把 443 交给本进程，TLS 在这里终结，
// 再回源到本机 mysandbox 的 HTTP 端口（7321）。这样 7321 可以同时保持本机 HTTP。
import http from 'node:http';
import https from 'node:https';
import { loadConfig } from './config.js';
import { ensureTlsMaterial } from './tls.js';
import { log } from './logger.js';

interface Args {
  host?: string;
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') out.host = argv[++i];
    if (argv[i] === '--port') out.port = Number(argv[++i]);
  }
  return out;
}

function socketActivatedFd(): number | null {
  if (process.env.LISTEN_FDS !== '1') return null;
  if (process.env.LISTEN_PID !== String(process.pid)) return null;
  return 3;
}

function writeSimpleResponse(res: http.ServerResponse, status: number, message: string): void {
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

  const server = https.createServer(
    { key: tls.key, cert: tls.cert },
    (req, res) => {
      const upstream = http.request({
        host: targetHost,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
        agent,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => writeSimpleResponse(res, 502, 'mysandbox upstream unavailable'));
      req.pipe(upstream);
    },
  );

  server.on('upgrade', (req, socket, head) => {
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      path: req.url,
      headers: req.headers,
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

  const fd = socketActivatedFd();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (fd === null) server.listen(443, '0.0.0.0', resolve);
    else server.listen({ fd }, resolve);
  });
  log.info({ target: `${targetHost}:${targetPort}`, socketActivated: fd !== null }, 'https facade ready');

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  process.stderr.write(`>> https facade fatal: ${e}\n`);
  process.exit(1);
});
