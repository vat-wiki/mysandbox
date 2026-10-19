// 批量配置：对一组容器并发执行 git/ssh/claude/通用 exec，逐容器收敛 ok/error/exitCode/stdout。
// 全部走 execRun（lxc-attach，Tty:false），p-limit 限并发，统一返回每容器结果。
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { execRun, inspectContainer, type ExecOpts } from './engine/index.js';
import { log } from './logger.js';

const DEFAULT_CONCURRENCY = 4;

export interface BatchItemResult {
  id: string;
  name: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string; // 容器未运行 / 不存在 / 超时等前置错误
}
export interface BatchResult {
  total: number;
  ok: number;
  failed: number;
  items: BatchItemResult[];
}

// sh 单引号转义：把任意串安全包进 '...'
function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// 单容器执行：解析名 → 检查 running → exec。任何异常收敛成一条 result，绝不抛出。
async function runOne(
  cfg: Config,
  id: string,
  build: () => ExecOpts,
): Promise<BatchItemResult> {
  let name = id;
  try {
    let info;
    try {
      info = await inspectContainer(cfg, id);
    } catch (e) {
      const err = e as { statusCode?: number };
      if (err?.statusCode === 404) {
        return { id, name, ok: false, exitCode: -1, stdout: '', stderr: '', error: 'container not found' };
      }
      throw e;
    }
    name = info.name;
    if (!info.running) {
      return { id, name, ok: false, exitCode: -1, stdout: '', stderr: '', error: `container not running (${info.stateStatus})` };
    }
    const r = await execRun(cfg, id, build());
    return {
      id,
      name,
      ok: r.exitCode === 0,
      exitCode: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
    };
  } catch (e) {
    return {
      id,
      name,
      ok: false,
      exitCode: -1,
      stdout: '',
      stderr: '',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// 并发扇出。build() 每容器调用一次，便于按需注入参数。
// 导出供 hosts apply 复用（同走「运行态检查 + 并发 + 逐容器错误收敛」）。
export async function runBatch(
  cfg: Config,
  ids: string[],
  build: () => ExecOpts,
  op: string,
  concurrency = DEFAULT_CONCURRENCY,
): Promise<BatchResult> {
  const limit = pLimit(concurrency);
  log.info({ op, count: ids.length }, 'batch start');
  const items = await Promise.all(ids.map((id) => limit(() => runOne(cfg, id, build))));
  const result: BatchResult = {
    total: items.length,
    ok: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length,
    items,
  };
  log.info({ op, ok: result.ok, failed: result.failed }, 'batch done');
  for (const it of items) {
    if (!it.ok) log.warn({ op, name: it.name, exitCode: it.exitCode, error: it.error }, 'batch item failed');
  }
  return result;
}

// —— git 身份：git config --global 覆盖（即便首启已 seed .gitconfig 也生效）——
export function batchGit(
  cfg: Config,
  ids: string[],
  input: { name: string; email: string },
): Promise<BatchResult> {
  const script = `git config --global user.name ${shq(input.name)} && git config --global user.email ${shq(input.email)} && git config --global user.name && git config --global user.email`;
  return runBatch(cfg, ids, () => ({ Cmd: ['sh', '-c', script] }), 'git');
}

// —— ssh：reseed=从挂载的 /mnt/host/.ssh 重拷一份；append-key=追加公钥到 authorized_keys ——
export type SshInput =
  | { mode: 'reseed' }
  | { mode: 'append-key'; key: string };
export function batchSsh(cfg: Config, ids: string[], input: SshInput): Promise<BatchResult> {
  const script =
    input.mode === 'reseed'
      ? 'set -e; rm -rf "$HOME/.ssh"; cp -a /mnt/host/.ssh "$HOME/.ssh"; chmod 700 "$HOME/.ssh"; chmod 600 "$HOME/.ssh"/id_* 2>/dev/null || true; ls -1 "$HOME/.ssh"'
      : `mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && printf '%s\\n' ${shq(input.key)} >> "$HOME/.ssh/authorized_keys" && wc -l < "$HOME/.ssh/authorized_keys"`;
  return runBatch(cfg, ids, () => ({ Cmd: ['sh', '-c', script] }), `ssh:${input.mode}`);
}

// —— claude -p：非交互跑 prompt 收敛输出。默认 120s 超时（claude 可能卡）。——
export function batchClaudeRun(
  cfg: Config,
  ids: string[],
  input: { prompt: string; timeoutMs?: number },
): Promise<BatchResult> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  return runBatch(cfg, ids, () => ({
    Cmd: ['claude', '-p', input.prompt],
    Tty: false,
    timeoutMs,
  }), 'claude');
}

// —— 通用 exec：sh -c <command>。可选超时。——
export function batchExec(
  cfg: Config,
  ids: string[],
  input: { command: string; timeoutMs?: number },
): Promise<BatchResult> {
  return runBatch(cfg, ids, () => ({
    Cmd: ['sh', '-c', input.command],
    Tty: false,
    timeoutMs: input.timeoutMs,
  }), 'exec');
}

// —— Agent CLI 一键更新（AI 工具页签）：npm 全局包拉 @latest ——
// npm 是唯一可靠通道：官方原生安装器/自更新的下载源在本部署网络区域封锁/超时
//（实测 2026-09，见 scripts/lxc-template.sh claude 段注释），npm registry 可达。
// 容器内按「command -v 落点」分层更新：同一工具可能同时存在 /usr/local（模板 root
// 装）与 /home/dev/.local（dev 自装的影子副本，PATH 优先）两层——只更一层会出现
//「npm 报更新成功但 which 还是旧版」的错象（dev 实测）。prefix 一律显式传：npm 的
// 默认全局 prefix 会跟着 PATH 上第一个 node 的安装根走（dev 的 node26 把整批包装进
// 过它自己的 lib/node_modules），不显式传落点不可预期。root 代写 /home/dev/.local
// 后必须 chown 归还属主，残留 root 属主会让 dev 侧 npm 自更新写不进 prefix。
// --ignore-scripts 防 pi 的 postinstall 挂住；opencode/claude 的 postinstall 手动补跑
// （claude-code 新版是原生二进制分发：postinstall install.cjs 把平台 optional dep 里的
// ELF 拷到 bin/claude.exe，跳过它就留「native binary not installed」报错 stub；optional
// dep 下载失败时它只打印提示、留 stub——好在收尾的 claude --version 会非零退出显式暴露）。
const AGENT_UPDATE_SCRIPT = `\
export HOME=/tmp
PAIRS='claude:@anthropic-ai/claude-code codex:@openai/codex opencode:opencode-ai pi:@earendil-works/pi-coding-agent openclaw:openclaw'
local_pkgs=''; root_pkgs=''
for pair in $PAIRS; do
  tool=\${pair%%:*}; pkg=\${pair#*:}
  bin=\$(command -v "\$tool" 2>/dev/null) || continue
  case "\$bin" in
    /home/dev/.local/*) local_pkgs="\$local_pkgs \${pkg}@latest" ;;
    *) root_pkgs="\$root_pkgs \${pkg}@latest" ;;
  esac
done
if [ -n "\$root_pkgs" ]; then
  npm install -g --prefix /usr/local --ignore-scripts \$root_pkgs || exit 1
  if [ -f /usr/local/lib/node_modules/opencode-ai/postinstall.mjs ]; then
    (cd /usr/local/lib/node_modules/opencode-ai && node postinstall.mjs)
  fi
  if [ -f /usr/local/lib/node_modules/@anthropic-ai/claude-code/install.cjs ]; then
    (cd /usr/local/lib/node_modules/@anthropic-ai/claude-code && node install.cjs)
  fi
fi
if [ -n "\$local_pkgs" ]; then
  npm install -g --prefix /home/dev/.local --ignore-scripts \$local_pkgs || exit 1
  if [ -f /home/dev/.local/lib/node_modules/opencode-ai/postinstall.mjs ]; then
    (cd /home/dev/.local/lib/node_modules/opencode-ai && node postinstall.mjs)
  fi
  if [ -f /home/dev/.local/lib/node_modules/@anthropic-ai/claude-code/install.cjs ]; then
    (cd /home/dev/.local/lib/node_modules/@anthropic-ai/claude-code && node install.cjs)
  fi
  for p in \$local_pkgs; do chown -R 1000:1000 "/home/dev/.local/lib/node_modules/\${p%@*}"; done
  chown -R 1000:1000 /home/dev/.local/bin
fi
echo '--- versions ---'
command -v claude    >/dev/null 2>&1 && claude --version
command -v codex     >/dev/null 2>&1 && codex --version
command -v opencode  >/dev/null 2>&1 && opencode --version
command -v pi        >/dev/null 2>&1 && pi --version
command -v openclaw  >/dev/null 2>&1 && openclaw --version
`;

// 单个 npm 操作的硬顶：正常几十秒，冷缓存 + 慢镜像放宽到 10min（超时 SIGKILL，幂等重跑）。
const AGENT_UPDATE_TIMEOUT_MS = 600_000;

export function batchAgentUpdate(cfg: Config, ids: string[]): Promise<BatchResult> {
  return runBatch(cfg, ids, () => ({
    Cmd: ['sh', '-c', AGENT_UPDATE_SCRIPT],
    User: 'root',
    Tty: false,
    timeoutMs: AGENT_UPDATE_TIMEOUT_MS,
  }), 'agent-update');
}

// —— 宿主侧更新（同上，不走 lxc）：宿主的 agent CLI 多半由 fnm 管的 npm 装的（本机
// 实测 claude/codex/pi/openclaw 都在 fnm 的全局 prefix），另有 opencode 是 ~/.opencode
// 原生安装——npm 通道管不到，走它自带的 upgrade 兜底（失败只警告，不拖垮整体）。
// 按包探测「已装才更新」，宿主没装的不凭空安装。
const HOST_NPM_PACKAGES = [
  '@anthropic-ai/claude-code',
  '@openai/codex',
  '@earendil-works/pi-coding-agent',
  'openclaw',
  'opencode-ai',
];

// execFile 收敛版：非零退出也算一次观测（code + 合并输出），不抛出。
// killSignal 必须 SIGKILL：execFile 的 timeout 只发默认 SIGTERM 且等 close——
// opencode upgrade 实测无视 SIGTERM，硬顶变摆设、整个请求挂死（与 engine execRun
// 超时悬挂同款教训：超时收场绝不等进程自觉）。
async function runCapture(
  file: string,
  args: string[],
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(file, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return { code: 0, output: [stdout, stderr].filter(Boolean).join('\n') };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string; message: string };
    const output = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    return { code: typeof err.code === 'number' ? err.code : 1, output };
  }
}

// 宿主 npm 定位：mysandbox 跑在 systemd user service 里，PATH 不含 fnm 的动态 shims。
// 服务自身的 node 就是 fnm 管的（process.execPath），npm 就在同目录——首选它；退而求
// 其次扫 fnm 已装版本挑最新；都没有才赌 PATH 上的 npm。
function resolveHostNpm(): { npm: string; binDir: string } {
  const binDir = dirname(process.execPath);
  const beside = join(binDir, 'npm');
  if (existsSync(beside)) return { npm: beside, binDir };
  try {
    const root = join(homedir(), '.local/share/fnm/node-versions');
    const best = readdirSync(root)
      .map((d) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(d))
      .filter((m): m is RegExpExecArray => !!m)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || Number(b[2]) - Number(a[2]) || Number(b[3]) - Number(a[3]))[0];
    if (best) {
      const dir = join(root, best[0], 'installation/bin');
      return { npm: join(dir, 'npm'), binDir: dir };
    }
  } catch {
    /* fnm 不在，走 PATH 兜底 */
  }
  return { npm: 'npm', binDir: '' };
}

export async function hostAgentUpdate(): Promise<BatchItemResult> {
  const id = '__host__';
  const name = '本机';
  try {
    const { npm, binDir } = resolveHostNpm();
    // npm 是 env node 的 shebang——service PATH 里未必有 node，把 npm 同目录的 bin 前置
    const env = binDir ? { PATH: `${binDir}:${process.env.PATH ?? ''}` } : undefined;
    const want = new Set(HOST_NPM_PACKAGES);
    const ls = await runCapture(npm, ['ls', '-g', '--depth=0', '--json'], 30_000, env);
    if (ls.code !== 0) throw new Error(`npm ls -g 失败：${ls.output.slice(0, 300)}`);
    let deps: Record<string, unknown> = {};
    try {
      deps = ((JSON.parse(ls.output) as { dependencies?: Record<string, unknown> }).dependencies ?? {});
    } catch {
      /* 解析不出按没装算 */
    }
    const present = HOST_NPM_PACKAGES.filter((p) => deps[p]);
    const parts: string[] = [];
    const failedPkgs: string[] = [];
    // 逐包更新：一包失败不拖累其余（实测 openclaw 新版对 node 版本有硬门槛，整批
    // 一起装会把它前面的包也赔进去）。
    for (const pkg of present) {
      const r = await runCapture(npm, ['install', '-g', `${pkg}@latest`], AGENT_UPDATE_TIMEOUT_MS, env);
      parts.push(`$ npm install -g ${pkg}@latest\n${r.output.trim()}`);
      if (r.code !== 0) failedPkgs.push(pkg);
    }
    // opencode 原生安装（~/.opencode）：不在 npm 全局里才走这条；upgrade 通道失败不拖垮
    // 整体。硬顶单独压到 3min——它在本网络区域常态拉不动，10min 全额等它不值得（best-effort）。
    const ocNative = join(homedir(), '.opencode/bin/opencode');
    if (!present.includes('opencode-ai') && existsSync(ocNative)) {
      const r = await runCapture(ocNative, ['upgrade'], 180_000);
      parts.push(`$ opencode upgrade\n${r.output.trim()}${r.code !== 0 ? '\n（升级失败，已跳过——不影响其余工具）' : ''}`);
    }
    const ver = await runCapture(npm, ['ls', '-g', '--depth=0'], 30_000, env);
    const verLines = ver.output.split('\n').filter((l) => [...want].some((p) => l.includes(p)));
    parts.push(['--- versions ---', ...verLines].join('\n'));
    if (failedPkgs.length) {
      return {
        id, name, ok: false, exitCode: 1, stdout: parts.join('\n\n'), stderr: '',
        error: `更新失败：${failedPkgs.join('、')}（其余成功，输出见下）`,
      };
    }
    return { id, name, ok: true, exitCode: 0, stdout: parts.join('\n\n'), stderr: '' };
  } catch (e) {
    return { id, name, ok: false, exitCode: -1, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
  }
}
