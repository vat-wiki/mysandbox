// Git daemon：原生 git:// 协议（默认 9418），服务 ~/.mysandbox/repos 下的 bare 仓库。
// 与 /git/* 的 Smart HTTP 互补：内网按 IP clone 时 git:// 少一跳，也更贴近「纯 git 库」。
// 匿名 push 由 gitDaemon.receivePack 决定（默认开，与「无权限内网库」语义一致）。
// 生命周期随 mysandbox 主进程：spawn 出来的 git daemon 挂在 exit 上收割（同 hostTerminal）。
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { Config } from './config.js';
import { REPOS_DIR } from './config.js';
import { log } from './logger.js';

let child: ChildProcess | null = null;
let started = false;

export function isGitDaemonRunning(): boolean {
  return started && child !== null && child.exitCode === null;
}

export function startGitDaemon(cfg: Config): void {
  if (!cfg.gitDaemon.enabled) {
    log.info('git daemon disabled');
    return;
  }
  try {
    mkdirSync(REPOS_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {
    log.warn({ err: e, root: REPOS_DIR }, 'git daemon: 无法创建仓库根目录，跳过');
    return;
  }
  const args = [
    'daemon',
    '--reuseaddr',
    '--export-all',
    `--base-path=${REPOS_DIR}`,
    `--listen=${cfg.gitDaemon.host}`,
    `--port=${cfg.gitDaemon.port}`,
    '--verbose',
    ...(cfg.gitDaemon.receivePack ? ['--enable=receive-pack'] : ['--disable=receive-pack']),
  ];
  try {
    child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log.warn({ err: e }, 'git daemon: 启动失败（git 未装？），跳过');
    child = null;
    return;
  }
  child.once('spawn', () => {
    started = true;
    log.info({ host: cfg.gitDaemon.host, port: cfg.gitDaemon.port, receivePack: cfg.gitDaemon.receivePack }, 'git daemon listening');
  });
  child.stdout?.on('data', (c: Buffer) => {
    const text = c.toString('utf8').trim();
    if (text) log.debug({ detail: text }, 'git daemon');
  });
  child.stderr?.on('data', (c: Buffer) => {
    const text = c.toString('utf8').trim();
    if (text) log.warn({ detail: text }, 'git daemon');
  });
  child.once('error', (e) => {
    started = false;
    log.warn({ err: e }, 'git daemon: 进程错误');
  });
  child.once('exit', (code, signal) => {
    started = false;
    child = null;
    if (code && code !== 0) log.warn({ code, signal }, 'git daemon: 异常退出（端口占用？）');
    else log.info('git daemon: 已停止');
  });
  // exit 覆盖正常退出；SIGINT/SIGTERM 由 hostTerminal.ts 的全局处理器先 kill 子进程再
  // process.exit()，那里会触发 exit ——这里只挂 exit 就够，不重复注册信号处理器。
  process.on('exit', () => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* noop */
    }
  });
}
