// 批量配置：对一组容器并发执行 git/ssh/claude/通用 exec，逐容器收敛 ok/error/exitCode/stdout。
// 全部走 docker exec（Tty:false demux），p-limit 限并发，统一返回每容器结果。
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { execRun, inspectContainer, type ExecOpts } from './docker.js';
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
    name = (info.Name || '').replace(/^\//, '');
    if (!info.State?.Running) {
      return { id, name, ok: false, exitCode: -1, stdout: '', stderr: '', error: `container not running (${info.State?.Status || 'unknown'})` };
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
