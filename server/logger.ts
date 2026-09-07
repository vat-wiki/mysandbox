// 共享日志配置。
// - loggerOptions：交给 fastify（opts.stream = multistream；fastify 会注入默认 req/res
//   serializers 再 pino(opts, opts.stream)，请求日志与 domain log 走同一组流）。
// - log：领域事件用（batch/lifecycle）。
// 流有两路：stdout（TTY=pino-pretty 进程内流，服务形态=JSON 行进 journald）+
// 按天轮转文件 STATE_DIR/logs/mysandbox-<date>.log（JSON 行，留 KEEP_DAYS 天）。
// 文件名自带日期、轮换 = 换文件名而非 rename，service 与一次性 CLI 同时追加也安全；
// 跨零点后的首条写入触发换档与过期清理。
import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import pino, { multistream, type DestinationStream, type LoggerOptions } from 'pino';
import pinoPretty from 'pino-pretty';
import { STATE_DIR } from './config.js';

const level = process.env.MYSANDBOX_LOG_LEVEL || 'info';
export const LOG_DIR = join(STATE_DIR, 'logs');
const KEEP_DAYS = 14;

const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// 过期文件清理：只认 mysandbox-<date>.log 形状，别的文件不碰。失败静默（下次轮换再试）。
function sweepOldLogs(): void {
  try {
    const cutoff = localDate(new Date(Date.now() - KEEP_DAYS * 86400_000));
    for (const f of readdirSync(LOG_DIR)) {
      const m = /^mysandbox-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (m && m[1] < cutoff) unlinkSync(join(LOG_DIR, f));
    }
  } catch {
    /* 目录还没建等：忽略 */
  }
}

// 按天轮转的文件流。pino.destination = 进程内 SonicBoom（无 worker 线程，CLI 一次性
// 命令也能干净退出）；首写才落 fd，不含日志的 CLI 子命令零开销。
function rotatingFileStream(): DestinationStream {
  let date = '';
  let dest: { write(msg: string): void; end(): void } | null = null;
  return {
    write(chunk: string): void {
      const today = localDate();
      if (!dest || today !== date) {
        const first = !dest;
        dest?.end();
        dest = pino.destination({ dest: join(LOG_DIR, `mysandbox-${today}.log`), mkdir: true, append: true, sync: false });
        date = today;
        if (first) sweepOldLogs(); // 启动清一次，之后每次跨天清一次
      }
      dest.write(chunk);
    },
  } as DestinationStream;
}

const streams = multistream([
  {
    stream: (process.stdout.isTTY
      ? pinoPretty({ colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' })
      : process.stdout) as DestinationStream,
  },
  { stream: rotatingFileStream() },
]);

// stream 键 runtime 受支持（fastify 走 pino(opts, opts.stream)；本模块 pino 侧走第二参），
// 但 pino 的 LoggerOptions 类型没声明它，这里断言收敛。
export const loggerOptions = { level, stream: streams } as LoggerOptions;

export const log = pino({ level }, streams);
