// `mysandbox logs [N] [--raw]` — 看服务日志尾部（排查问题的第一入口）。
// 数据源 = logger.ts 落盘的按天文件（STATE_DIR/logs/mysandbox-<date>.log），取最新一份
// 读尾部 N 行（默认 100，最多回看 2MB——行数不够就只给这么多，要看更早用 journald）。
// 默认渲染成人读行（时间 级别 内容，fastify 请求行带状态码/耗时/来源）；--raw 原样输出
// JSON 行（grep/jq 口径）。journald 也有全量：journalctl --user -u mysandbox。
import { closeSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.js';

const LOG_DIR = join(STATE_DIR, 'logs');
const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const LEVEL_NAMES: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

function newestLogFile(): string | null {
  let best: string | null = null;
  for (const f of readdirSync(LOG_DIR)) {
    if (/^mysandbox-\d{4}-\d{2}-\d{2}\.log$/.test(f) && (!best || f > best)) best = f;
  }
  return best ? join(LOG_DIR, best) : null;
}

function tailLines(path: string): string[] {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8').split('\n').filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

// JSON 行 → 单行人读串。fastify 请求行（req/res 结构化字段）渲染成
// `<reqId> GET /path (host) -> 200 12ms < ip`；domain log 输出 msg + 剩余标量字段。
// 非 JSON 行原样保留。
function render(line: string): string {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line);
  } catch {
    return line;
  }
  const req = j.req as Record<string, unknown> | undefined;
  const res = j.res as Record<string, unknown> | undefined;
  const time = new Date(j.time as string);
  const hhmmss = Number.isNaN(time.getTime())
    ? ''
    : `${time.toLocaleTimeString('en-GB', { hour12: false })}.${String(time.getMilliseconds()).padStart(3, '0')}`;

  const parts = [hhmmss, LEVEL_NAMES[j.level as number] ?? String(j.level ?? '?')];
  let msg = typeof j.msg === 'string' ? j.msg : '';
  if (req && typeof req.method === 'string') {
    msg = `${req.method} ${req.url}${req.host ? ` (${req.host})` : ''}`;
  }
  if (j.reqId) msg = `${String(j.reqId)} ${msg}`;
  parts.push(msg);
  let out = parts.filter(Boolean).join(' ');
  if (res) out += ` -> ${String(res.statusCode)}`;
  if (typeof j.responseTime === 'number') out += ` ${Math.round(j.responseTime)}ms`;
  if (req && typeof req.remoteAddress === 'string') out += ` < ${req.remoteAddress}`;
  const known = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'req', 'res', 'responseTime', 'reqId']);
  for (const [k, v] of Object.entries(j)) {
    if (known.has(k) || typeof v === 'object') continue;
    out += ` ${k}=${String(v)}`;
  }
  return out;
}

export async function runLogsCommand(argv: string[]): Promise<void> {
  let n = 100;
  let raw = false;
  for (const a of argv) {
    if (a === '--raw') raw = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('mysandbox logs [N] [--raw] — 服务日志尾部（默认 100 行；--raw 输出 JSON 行）\n');
      return;
    } else if (/^\d+$/.test(a)) {
      n = Math.min(Math.max(parseInt(a, 10), 1), 10_000);
    } else {
      throw new Error(`unknown logs argument "${a}"`);
    }
  }

  let file: string | null;
  try {
    file = newestLogFile();
  } catch {
    file = null;
  }
  if (!file) {
    process.stdout.write(`>> no log files in ${LOG_DIR} (服务跑过才有；journald 口径: journalctl --user -u mysandbox)\n`);
    return;
  }

  let lines = tailLines(file);
  if (lines.length > n) lines = lines.slice(-n);
  const out = process.stdout;
  for (const line of lines) out.write(`${raw ? line : render(line)}\n`);
}
