// CLI 子命令 mysandbox open <path> [--container <name>]：在浏览器打开容器文件/目录。
// 本仓库首个 CLI -> HTTP 调用（Node 20 全局 fetch，token 来自 loadConfig 与服务共享）。
// listen.tls 开启时走 https，自签名证书用本地 CA（server/tls.ts 生成的 ca.crt）校验。
// CLI 全程只走 HTTP + 读配置，不碰 LXC——服务没起就明确报错。
import { realpath, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, posix } from 'node:path';
import { Agent } from 'undici';
import type { Config } from './config.js';
import { STATE_DIR } from './config.js';
import { getEngine } from './engine/index.js';
import { getAllMeta } from './state.js';
import { proxyBases } from './proxy.js';

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
}

// 与 image.ts 的 parseImageArgs 同款手写解析（仓库无 commander/yargs）。
function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      flags[name] = eq >= 0 ? a.slice(eq + 1) : argv[++i] ?? '';
    } else if (a === '-c') {
      flags.container = argv[++i] ?? '';
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

export const OPEN_HELP = `mysandbox open — 在浏览器中打开容器内的文件或目录

Usage: mysandbox open <path> [--container <name>|-c <name>]

  <path>   容器内绝对路径，或相对路径（基于 /home/dev）。
           若宿主当前目录在某容器的 home 目录下，相对路径会自动映射回容器视角。

容器解析顺序：
  1. --container/-c 指定（容器名或显示名）
  2. 宿主 cwd 位于某容器 home 目录下时自动识别
  3. 恰好只有一个运行中的受管理容器时用它
  4. 否则列出候选并要求 --container

文件在编辑器中打开，目录在文件面板中打开。需 mysandbox 服务在运行。`;

interface ContainerSummary {
  id: string;
  name: string;
  displayName?: string;
  state: string;
  managed: boolean;
  adopted: boolean;
}

// 带 token 的 API 请求。非 2xx 解析 {error:{code,message}} 抛给调用方（错误结构是本服务定义的）。
// tls 开启时带本地 CA dispatcher（自签名链校验；CA 文件由服务端启动时生成）。
let caDispatcher: Agent | undefined;
async function tlsInit(cfg: Config): Promise<RequestInit> {
  if (!cfg.listen.tls) return {};
  if (!caDispatcher) {
    const ca = await readFile(join(STATE_DIR, 'tls', 'ca.crt'), 'utf8').catch(() => '');
    caDispatcher = new Agent(ca ? { connect: { ca } } : {});
  }
  return { dispatcher: caDispatcher } as RequestInit;
}

async function api<T>(cfg: Config, path: string): Promise<T> {
  const base = baseUrl(cfg);
  const res = await fetch(base + path, {
    headers: { 'x-sandbox-token': cfg.token || '' },
    signal: AbortSignal.timeout(8000),
    ...(await tlsInit(cfg)),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message || `HTTP ${res.status} ${path}`);
  }
  return (await res.json()) as T;
}

// 浏览器可用的 base：监听 0.0.0.0 时浏览器访问 127.0.0.1。
function baseUrl(cfg: Config): string {
  const host = cfg.listen.host === '0.0.0.0' || cfg.listen.host === '::' ? '127.0.0.1' : cfg.listen.host;
  return `${cfg.listen.tls ? 'https' : 'http'}://${host}:${cfg.listen.port}`;
}

// 浏览器打开用的控制台 URL：「都走域名」口径——域名 + 证书覆盖的 scheme/端口。
async function consoleUrl(cfg: Config): Promise<string> {
  if (cfg.proxy.vhost === 'off') return baseUrl(cfg);
  const bases = await proxyBases(cfg);
  if (!bases[0]) return baseUrl(cfg);
  const defPort = cfg.listen.tls ? 443 : 80;
  const portPart = cfg.listen.port === defPort ? '' : `:${cfg.listen.port}`;
  return `${cfg.listen.tls ? 'https' : 'http'}://${bases[0].base}${portPart}`;
}

function fail(msg: string): never {
  process.stderr.write(`>> ${msg}\n`);
  process.exit(1);
}

// 按名称/显示名匹配容器，并校验受管理 + 运行中。
function pickByName(items: ContainerSummary[], want: string): ContainerSummary {
  const hit = items.find((c) => c.name === want || c.displayName === want);
  if (!hit) {
    const names = items.map((c) => c.displayName || c.name).join(', ') || '(无)';
    fail(`容器 "${want}" 不存在。现有: ${names}`);
  }
  if (!hit.managed && !hit.adopted) fail(`容器 ${hit.name} 未纳入管理（先在 Web 界面 adopt）`);
  if (hit.state !== 'running') fail(`容器 ${hit.name} 未运行（state=${hit.state}）`);
  return hit;
}

// 宿主 cwd 在某容器的 home 目录下 -> {容器名, cwd 相对该 home 的部分}。
// 容器 home 的宿主侧路径 = <lxcpath>/<name>/rootfs/home/dev，
// 所以按「所有已知容器逐个比对其 hostHomePath」推断，而不是假设某个共同父目录。
async function inferFromCwd(cfg: Config): Promise<{ name: string; rel: string } | null> {
  let cwd: string;
  try {
    cwd = await realpath(process.cwd());
  } catch {
    return null;
  }
  const engine = getEngine(cfg);
  let names: string[];
  try {
    names = Object.keys(await getAllMeta());
  } catch {
    return null; // state.json 读不了：无从推断
  }
  // 最长匹配优先：容器名互为前缀时（dev / dev2）短的会先命中错的容器。
  let best: { name: string; rel: string; len: number } | null = null;
  for (const name of names) {
    const home = engine.hostHomePath(cfg, name);
    if (!home) continue;
    let root: string;
    try {
      root = await realpath(home);
    } catch {
      continue; // home 不存在（容器已删/adopted 无挂载）
    }
    if (cwd !== root && !cwd.startsWith(root + '/')) continue;
    if (!best || root.length > best.len) {
      best = { name, rel: cwd.slice(root.length), len: root.length }; // rel 以 / 开头或空
    }
  }
  return best ? { name: best.name, rel: best.rel } : null;
}

// 相对路径 -> 容器绝对路径。命中容器 home 时：宿主 cwd 对应容器内 /home/dev/<rel>。
function toContainerPath(input: string, cwdInfo: { name: string; rel: string } | null): string {
  if (input.startsWith('/')) return posix.normalize(input);
  if (cwdInfo && cwdInfo.name) {
    // 宿主 cwd = <容器 home><rel>  <=>  容器内 /home/dev<rel>
    return posix.normalize(posix.join('/home/dev', cwdInfo.rel, input));
  }
  return posix.normalize(posix.join('/home/dev', input));
}

export async function runOpenCommand(argv: string[], cfg: Config): Promise<void> {
  const { positionals, flags } = parseArgs(argv);
  const sub = positionals[0];
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(OPEN_HELP);
    return;
  }

  // 1. 服务探测（/api/health 免鉴权）。
  try {
    const res = await fetch(baseUrl(cfg) + '/api/health', {
    signal: AbortSignal.timeout(2000),
    ...(await tlsInit(cfg)),
  });
    if (!res.ok) throw new Error(`health ${res.status}`);
  } catch {
    fail(`mysandbox 服务未运行（${baseUrl(cfg)}）——请先启动 \`mysandbox\``);
  }

  // 2. 容器解析。
  const items = await api<{ items: ContainerSummary[] }>(cfg, '/api/containers').then(
    (r) => r.items,
  );
  const cwdInfo = await inferFromCwd(cfg);
  let container: ContainerSummary;
  if (flags.container) {
    container = pickByName(items, flags.container);
  } else if (cwdInfo?.name) {
    container = pickByName(items, cwdInfo.name);
  } else {
    const running = items.filter((c) => c.state === 'running' && (c.managed || c.adopted));
    if (running.length === 1) {
      container = running[0];
    } else if (running.length === 0) {
      fail('没有运行中的受管理容器——先启动容器，或用 --container 指定');
    } else {
      const names = running.map((c) => c.displayName || c.name).join(', ');
      fail(`多个运行中容器，请用 --container 指定一个: ${names}`);
    }
  }

  // 3. 路径解析 + 判型（复用 files 路由语义：200=目录 / 400 not_a_directory=文件 /
  //    404 不存在也按文件——编辑器对不存在的文件走新建态）。
  const p = toContainerPath(sub, cwdInfo);
  let kind: 'file' | 'dir';
  try {
    const base = baseUrl(cfg);
    const res = await fetch(
      `${base}/api/containers/${container.id}/files?path=${encodeURIComponent(p)}`,
      {
        headers: { 'x-sandbox-token': cfg.token || '' },
        signal: AbortSignal.timeout(8000),
        ...(await tlsInit(cfg)),
      },
    );
    if (res.ok) {
      kind = 'dir';
    } else {
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      const code = body?.error?.code;
      if (res.status === 400 && code === 'not_a_directory') kind = 'file';
      else if (res.status === 404) kind = 'file';
      else fail(body?.error?.message || `探测路径失败 (HTTP ${res.status})`);
    }
  } catch (e) {
    fail(`探测路径失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 4. 打开浏览器（无论成败都打印 URL——SSH 无显示器的回退）。
  const url = `${await consoleUrl(cfg)}/#open?c=${container.id}&p=${encodeURIComponent(p)}&k=${kind}`;
  process.stdout.write(`>> ${container.displayName || container.name}:${p}\n${url}\n`);
  const openers: Record<string, string[]> = {
    darwin: ['open', url],
    win32: ['cmd', '/c', 'start', '', url],
    linux: ['xdg-open', url],
  };
  const opener = openers[process.platform] || openers.linux;
  try {
    const child = spawn(opener[0], opener.slice(1), { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* 打不开浏览器无所谓，URL 已打印 */
    });
    child.unref();
  } catch {
    /* 同上 */
  }
}
