#!/usr/bin/env node
// CLI 入口：加载 config（首启生成 token）-> 校验 LXC 运行环境 -> 起服务 -> 打印 URL/token。
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { loadConfig, CONFIG_FILE } from './config.js';
import { buildServer } from './index.js';
import { getEngine } from './engine/index.js';
import { runBaseCommand } from './base.js';
import { runOpenCommand } from './open.js';
import { runStatusCommand } from './status.js';
import { runFirewallCommand } from './firewall.js';
import { sweepContainerCli } from './container-cli.js';
import { sweepHosts, startHostsEventSync } from './hosts-sync.js';
import { startServicesEventSync } from './services.js';
import { getVersion } from './version.js';

interface Args {
  port?: number;
  host?: string;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--version' || a === '-V') out.version = true;
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
  }
  return out;
}

// --host auto：取默认路由所在接口的 IPv4（Linux 读 /proc/net/route）；
// 拿不到默认路由时退化为第一个非 internal 的 IPv4。
async function resolveAutoHost(): Promise<string> {
  const ifaces = networkInterfaces();
  const pick = (name?: string) => {
    if (!name) return;
    for (const a of ifaces[name] ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  };
  let ifname: string | undefined;
  try {
    for (const line of (await readFile('/proc/net/route', 'utf8')).split('\n').slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c[1] === '00000000') {
        ifname = c[0];
        break;
      }
    }
  } catch {
    // 非 Linux 或读取失败：走退化路径。
  }
  const ip = pick(ifname);
  if (ip) return ip;
  for (const name of Object.keys(ifaces)) {
    const f = pick(name);
    if (f) return f;
  }
  throw new Error('--host auto: 找不到可用的非 internal IPv4 地址');
}

const HELP = `mysandbox ${getVersion()} — dev container control panel

Usage: mysandbox [--port 7321] [--host 127.0.0.1]
  Starts the web UI (default http://127.0.0.1:7321).

  mysandbox base <status|clone|export|import>
      Manage the template container that new containers are cloned from.
      (\`mysandbox image\` is a legacy alias.)

  mysandbox open <path> [--container <name>]
      Open a container file (editor) or directory (file panel) in the browser
      (one-shot; requires the server to be running).

  mysandbox status
      Scan and list every mysandbox-managed object on this host (containers,
      template, docker services/volumes, host-terminal sessions, transient
      systemd units, sidecar files). Read-only; does not need the server.

  mysandbox firewall print
      Print the desired ufw rules for host<->LXC<->docker interconnect
      (computed from config; applied by mysandbox-firewall.service).
      Read-only; does not need the server or root.

Options:
  --port <n>     listen port (default 7321)
  --host <addr|auto>
                 listen host (default 127.0.0.1; auto = 默认路由接口的 IPv4；
                 WARNING: binding non-localhost exposes host-root-equivalent access
                 to anyone with the token)
  -V, --version  print version and exit
  -h, --help     show this help

Config: ${CONFIG_FILE}
Token:  stored in config (mode 0600), printed on first run.
`;

async function main(): Promise<void> {
  // 一次性子命令：mysandbox open <path>（走 HTTP 调运行中的服务，不启动 server）。
  if (process.argv[2] === 'open') {
    const { config } = await loadConfig();
    await runOpenCommand(process.argv.slice(3), config);
    return;
  }

  // 一次性子命令：mysandbox status（不启动 server；只读扫宿主，各段独立降级）。
  if (process.argv[2] === 'status') {
    const { config } = await loadConfig();
    await runStatusCommand(config);
    return;
  }

  // 一次性子命令：mysandbox firewall print（不启动 server、不需要 root；输出期望规则，
  // 由 scripts/mysandbox-firewall.sh——root 单元 mysandbox-firewall.service——消费）。
  if (process.argv[2] === 'firewall') {
    const { config } = await loadConfig();
    await runFirewallCommand(process.argv.slice(3), config);
    return;
  }

  // 一次性子命令：mysandbox base|image <action>（不启动 server）。
  // image 是 base 的历史别名（docker 时代的名字）。
  if (process.argv[2] === 'base' || process.argv[2] === 'image') {
    const { config } = await loadConfig();
    const engine = getEngine(config);
    const d = await engine.status(config);
    if (!d.reachable) {
      process.stderr.write(`>> cannot reach ${engine.name}: ${d.error}\n`);
      process.exit(1);
    }
    await runBaseCommand(process.argv.slice(3), config);
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.version) {
    process.stdout.write(`${getVersion()}\n`);
    process.exit(0);
  }

  const { config, firstRun, tokenGenerated } = await loadConfig();
  if (args.port) config.listen.port = args.port;
  if (args.host) config.listen.host = args.host;
  // --host auto 或 config 里 listen.host: auto → 解析为默认路由接口 IPv4。
  if (config.listen.host === 'auto') config.listen.host = await resolveAutoHost();

  // LXC 运行环境校验（CLI 在 + systemd user manager 环境对——后者是最常见的
  // 部署错误，engine.status 会给人话提示）。
  const engine = getEngine(config);
  const d = await engine.status(config);
  if (!d.reachable) {
    process.stderr.write(`>> cannot reach ${engine.name}: ${d.error}\n`);
    process.exit(1);
  }

  const app = await buildServer(config);
  // 存量容器补种子容器内 mysandbox 命令（幂等；sidecar 已知且 dataRoot 可见的才写）。
  await sweepContainerCli(config);
  // 全局 hosts 启动补刷（幂等，hash 跳过；不阻塞 listen）+ events 自动重刷（容器重启追平）。
  void sweepHosts(config);
  startHostsEventSync(config);
  // docker 服务事件 → hosts 服务行追平（debounce + 断线重连，见 services.ts）。
  startServicesEventSync(config);
  await app.listen({ host: config.listen.host, port: config.listen.port });

  process.stdout.write(
    `>> mysandbox ${getVersion()}  ${engine.name} ${d.version ?? '?'}${d.apiVersion ? ` (api ${d.apiVersion})` : ''}\n`,
  );
  process.stdout.write(`>> web UI:  http://${config.listen.host}:${config.listen.port}\n`);
  if (firstRun || tokenGenerated) {
    process.stdout.write(`>> first run — config written: ${CONFIG_FILE}\n`);
    process.stdout.write(`>> token:   ${config.token}\n`);
    process.stdout.write('>> (token also stored in config file, mode 0600)\n');
  } else {
    process.stdout.write(`>> config:  ${CONFIG_FILE}\n`);
  }
  if (config.listen.host !== '127.0.0.1') {
    process.stderr.write(
      `>> WARNING: listening on ${config.listen.host}, not localhost. ` +
        'Anyone with the token has full access to your host user account.\n',
    );
  }
}

main().catch((e) => {
  process.stderr.write(`>> fatal: ${e}\n`);
  process.exit(1);
});
