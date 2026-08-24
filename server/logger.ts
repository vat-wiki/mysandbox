// 共享日志配置。
// - loggerOptions：交给 fastify（fastify 自建实例，保留默认 Logger 类型，签名兼容）。
// - log：领域事件用（batch/lifecycle）。TTY 走 pino-pretty，否则 JSON。
import pino, { type LoggerOptions } from 'pino';

const level = process.env.MYSANDBOX_LOG_LEVEL || 'info';

export const loggerOptions: LoggerOptions = process.stdout.isTTY
  ? {
      level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
    }
  : { level };

export const log = pino(loggerOptions);
