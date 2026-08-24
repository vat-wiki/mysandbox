#!/usr/bin/env node
// CLI 入口：加载 config（首启生成 token）-> 连通 docker -> 起服务 -> 打印 URL/token。
import { loadConfig, CONFIG_FILE, expandTilde } from './config.js';
import { buildServer } from './index.js';
import { getEngine } from './engine/index.js';
import { runBaseCommand } from './base.js';
import { runOpenCommand } from './open.js';
import { sweepContainerCli } from './container-cli.js';
import { sweepHosts, startHostsEventSync } from './hosts-sync.js';
import { getVersion } from './version.js';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// imageDir 配置的启动期校验（fail-fast，别等到 build 时才炸）。返回错误消息或 null。
function validateImageDir(config: { imageDir: string }): string | null {
  if (!config.imageDir) return null;
  const p = expandTilde(config.imageDir);
  if (!isAbsolute(p)) return `imageDir must be an absolute path (got "${config.imageDir}")`;
  if (!existsSync(p)) return `imageDir points to a missing directory: ${p}`;
  return null;
}

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

const HELP = `mysandbox ${getVersion()} — dev container control panel

Usage: mysandbox [--port 7321] [--host 127.0.0.1]
  Starts the web UI (default http://127.0.0.1:7321).

  mysandbox base <status|build|pull|push|clone|export|import>
      Manage the container base — the base image (docker) or the template
      container (lxc). Available actions depend on the engine; run
      \`mysandbox base status\` to see them. (\`mysandbox image\` is an alias.)

  mysandbox open <path> [--container <name>]
      Open a container file (editor) or directory (file panel) in the browser
      (one-shot; requires the server to be running).

Options:
  --port <n>     listen port (default 7321)
  --host <addr>  listen host (default 127.0.0.1; WARNING: binding non-localhost
                 exposes host-root-equivalent access to anyone with the token)
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

  // 一次性子命令：mysandbox base|image <action>（不启动 server）。
  // image 是 base 的别名——docker 引擎下语义完全一致，lxc 引擎下 base 才有 clone/export/import。
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

  // imageDir 只在 docker 引擎下有意义（lxc 的基座是模板容器，见 engine/template.ts）。
  const imageDirErr = config.engine === 'docker' ? validateImageDir(config) : null;
  if (imageDirErr) {
    process.stderr.write(`>> fatal: ${imageDirErr}\n`);
    process.exit(1);
  }

  // 引擎连通性。docker=socket 可连；lxc=CLI 在 + systemd user manager 环境对
  // （后者是最常见的部署错误，engine.status 会给人话提示）。
  const engine = getEngine(config);
  const d = await engine.status(config);
  if (!d.reachable) {
    process.stderr.write(`>> cannot reach ${engine.name}: ${d.error}\n`);
    if (engine.name === 'docker') {
      process.stderr.write('>> ensure docker is running and your user is in the docker group.\n');
    }
    process.exit(1);
  }

  const app = await buildServer(config);
  // 存量容器补种子容器内 mysandbox 命令（幂等；sidecar 已知且 dataRoot 可见的才写）。
  await sweepContainerCli(config);
  // 全局 hosts 启动补刷（幂等，hash 跳过；不阻塞 listen）+ events 自动重刷（容器重启追平）。
  void sweepHosts(config);
  startHostsEventSync(config);
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
        'Anyone with the token has host-root-equivalent access.\n',
    );
  }
}

main().catch((e) => {
  process.stderr.write(`>> fatal: ${e}\n`);
  process.exit(1);
});
