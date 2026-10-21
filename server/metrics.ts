// 进程内请求指标（无依赖、不持久化）：fastify onResponse hook 聚合 per-route
// 计数 / 耗时分桶 / 错误数，暴露 GET /api/metrics（鉴权走全局 hook）。
// 用途：远程访问「变卡/掉线」这类问题的量化定位——哪些轮询端点在打、单次耗时
// 分布如何、有无长尾。另设两路输出进日志：慢请求 warn（每路由限频 1/min）与
// 10 分钟一行摘要（top 5 端点），journalctl 里能直接看到服务负载画像。
// 刻意不持久化、不上报外部——重启即清零，诊断窗口内够用。
import type { FastifyInstance } from 'fastify';
import { log } from './logger.js';

// 耗时分桶边界（ms）：轮询端点健康时 p50 在几十 ms，>500ms 说明 exec 在拖，
// >5s 说明下游（docker/lxc/ssh）卡了——分桶按这个诊断梯度设。
const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, Infinity];
const SLOW_MS = 2_000;
const SLOW_WARN_INTERVAL_MS = 60_000;
const SUMMARY_INTERVAL_MS = 600_000;

interface RouteStat {
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  buckets: number[]; // 与 BUCKETS 对齐
  lastSlowWarn: number;
}

const stats = new Map<string, RouteStat>();
const startedAt = Date.now();

function statOf(route: string): RouteStat {
  let s = stats.get(route);
  if (!s) {
    s = { count: 0, errors: 0, totalMs: 0, maxMs: 0, buckets: BUCKETS.map(() => 0), lastSlowWarn: 0 };
    stats.set(route, s);
  }
  return s;
}

// 路由模板：优先 fastify 已解析的 routeOptions.url（/:id 形状，天然免归一），
// 404（无路由）落回裸 url 截短。WS 升级连接 onResponse 不保证触发，计数以
// onRequest 为准、耗时只记 HTTP。
function routeOf(url: string | undefined, raw: string): string {
  if (url) return url;
  const path = raw.split('?')[0];
  return path.length > 60 ? `${path.slice(0, 57)}…` : path;
}

export function registerMetrics(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    const route = routeOf(req.routeOptions?.url, req.raw.url ?? '');
    const s = statOf(route);
    s.count += 1;
    (req as unknown as { msbMetricsAt: bigint }).msbMetricsAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (req, reply) => {
    const started = (req as unknown as { msbMetricsAt?: bigint }).msbMetricsAt;
    if (started === undefined) return;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const route = routeOf(req.routeOptions?.url, req.raw.url ?? '');
    const s = statOf(route);
    const code = reply.statusCode;
    if (code >= 400) s.errors += 1;
    s.totalMs += ms;
    if (ms > s.maxMs) s.maxMs = ms;
    for (let i = 0; i < BUCKETS.length; i++) {
      if (ms <= BUCKETS[i]) {
        s.buckets[i] += 1;
        break;
      }
    }
    // 慢请求限频告警：每路由至多 1 条/分钟，防慢 docker 把日志刷爆
    if (ms > SLOW_MS && Date.now() - s.lastSlowWarn > SLOW_WARN_INTERVAL_MS) {
      s.lastSlowWarn = Date.now();
      log.warn({ route, ms: Math.round(ms), status: code }, 'metrics: slow request');
    }
  });

  app.get('/api/metrics', async () => {
    const routes = [...stats.entries()]
      .map(([route, s]) => ({
        route,
        count: s.count,
        errors: s.errors,
        avgMs: s.count ? Math.round(s.totalMs / s.count) : 0,
        maxMs: Math.round(s.maxMs),
        buckets: Object.fromEntries(
          s.buckets.map((n, i) => [i === BUCKETS.length - 1 ? `>${BUCKETS[i - 1]}` : `<=${BUCKETS[i]}`, n]),
        ),
      }))
      .sort((a, b) => b.count - a.count);
    return {
      startedAt: new Date(startedAt).toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      total: routes.reduce((n, r) => n + r.count, 0),
      routes,
    };
  });

  // 摘要日志：10 分钟一行 top 5，journalctl --user -u mysandbox 里直接看负载走向
  const timer = setInterval(() => {
    const top = [...stats.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([route, s]) => `${route} x${s.count} avg${s.count ? Math.round(s.totalMs / s.count) : 0}ms`);
    if (top.length) log.info({ top }, 'metrics: 10min summary');
  }, SUMMARY_INTERVAL_MS);
  timer.unref();
}
