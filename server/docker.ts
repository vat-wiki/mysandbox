// dockerode 单例 + 连通性检查 + 容器列表与生命周期。exec 封装在 M4/M6 追加。
import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { Config } from './config.js';
import { getAllMeta, type ContainerMeta } from './state.js';

export const MANAGED_LABEL = 'mysandbox.managed-by';

export interface ContainerPort {
  ip?: string;
  privatePort?: number;
  publicPort?: number;
  type: string;
}

export interface ContainerView {
  id: string;
  name: string;
  displayName?: string;
  status: string;
  state: string;
  image: string;
  ip: string | null;
  networks: string[];
  managed: boolean; // 由 mysandbox 创建（label）
  adopted: boolean; // sidecar 登记为纳入管理
  description?: string;
  tags?: string[];
  source?: string;
  labels: Record<string, string>;
  ports: ContainerPort[];
  created: number;
  command: string;
}

let _docker: Docker | null = null;
export function getDocker(cfg: Config): Docker {
  if (!_docker) {
    _docker = new Docker({ socketPath: cfg.docker.socketPath });
  }
  return _docker;
}

export interface DockerStatus {
  reachable: boolean;
  version?: string;
  apiVersion?: string;
  error?: string;
}

export async function checkDocker(cfg: Config): Promise<DockerStatus> {
  try {
    const v = await getDocker(cfg).version();
    return { reachable: true, version: v.Version, apiVersion: v.ApiVersion };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// 列出受管理容器：在配置网络上 或 带 mysandbox label。合并 sidecar 元数据。
export async function listManaged(cfg: Config): Promise<ContainerView[]> {
  const docker = getDocker(cfg);
  const all = await docker.listContainers({ all: true });
  const meta = await getAllMeta();
  const views: ContainerView[] = [];
  for (const c of all) {
    const networks = Object.keys(c.NetworkSettings?.Networks || {});
    const onNet = networks.includes(cfg.network);
    const hasLabel = c.Labels?.[MANAGED_LABEL] === 'mysandbox';
    if (!onNet && !hasLabel) continue;
    const name = (c.Names[0] || '').replace(/^\//, '');
    const m: ContainerMeta | undefined = meta[name];
    const netEntry = c.NetworkSettings?.Networks?.[cfg.network];
    views.push({
      id: c.Id,
      name,
      displayName: m?.displayName,
      status: c.Status,
      state: c.State,
      image: c.Image,
      ip: netEntry?.IPAddress || null,
      networks,
      managed: hasLabel,
      adopted: !!m?.managed,
      description: m?.description,
      tags: m?.tags,
      source: m?.source,
      labels: c.Labels || {},
      ports: (c.Ports || []).map((p) => ({
        ip: p.IP ?? undefined,
        privatePort: p.PrivatePort ?? undefined,
        publicPort: p.PublicPort ?? undefined,
        type: p.Type,
      })),
      created: c.Created * 1000,
      command: c.Command,
    });
  }
  views.sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (a.state !== 'running' && b.state === 'running') return 1;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });
  return views;
}

// —— 生命周期（薄封装 dockerode）——
export async function startContainer(cfg: Config, id: string): Promise<void> {
  await getDocker(cfg).getContainer(id).start();
}
export async function stopContainer(cfg: Config, id: string, t = 5): Promise<void> {
  await getDocker(cfg).getContainer(id).stop({ t });
}
export async function restartContainer(cfg: Config, id: string, t = 5): Promise<void> {
  await getDocker(cfg).getContainer(id).restart({ t });
}
export async function renameContainer(cfg: Config, id: string, name: string): Promise<void> {
  await getDocker(cfg).getContainer(id).rename({ name });
}
export async function removeContainer(
  cfg: Config,
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  await getDocker(cfg).getContainer(id).remove({ force: opts.force ?? true });
}
export async function inspectContainer(cfg: Config, id: string): Promise<Docker.ContainerInspectInfo> {
  return getDocker(cfg).getContainer(id).inspect();
}

// 在容器内执行命令。Tty:false -> demux stdout/stderr（批量配置用）。
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface ExecOpts {
  Cmd: string[];
  Env?: string[];
  Tty?: boolean;
  User?: string;
  WorkingDir?: string;
  timeoutMs?: number;
}
export async function execRun(cfg: Config, id: string, opts: ExecOpts): Promise<ExecResult> {
  const docker = getDocker(cfg);
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: opts.Cmd,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: false,
    Tty: opts.Tty ?? false,
    User: opts.User || '1000:1000',
    WorkingDir: opts.WorkingDir || '/home/dev',
    Env: opts.Env,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  // 超时分支会 stream.destroy(new Error('mysandbox timeout'))，在流上 emit 'error'；
  // 不挂 handler 就会冒成 unhandled error 把整个进程崩掉（殃及 batch claude/exec 的超时）。
  // 这里吞掉：流随后仍触发 end/close 兜底 resolve，再走 inspect 取 exitCode。
  stream.on('error', () => {
    /* noop: 防止超时/异常 destroy 崩进程 */
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          stream.destroy(new Error('mysandbox timeout'));
        } catch {
          /* noop */
        }
      }, opts.timeoutMs)
    : null;
  if (opts.Tty) {
    stream.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
  } else {
    const out = new PassThrough();
    const errp = new PassThrough();
    docker.modem.demuxStream(stream, out, errp);
    out.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    errp.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
  }
  await new Promise<void>((resolve) => {
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });
  if (timer) clearTimeout(timer);
  let exitCode: number;
  try {
    const info = await exec.inspect();
    exitCode = info.ExitCode ?? -1;
  } catch {
    exitCode = -1;
  }
  if (timedOut) {
    stderr += stderr ? '\n[mysandbox: timeout]' : '[mysandbox: timeout]';
    if (exitCode === 0 || exitCode === -1) exitCode = -1;
  }
  return { exitCode, stdout, stderr };
}

// execRun 的 stdin 版：把 input 喂给命令的 stdin 后半关闭（对 cat > file 即 EOF）。
// 用途：写大文件——base64 进 argv 受 Linux 单参数 128KB 上限约束（hosts apply 那招的局限），
// stdin 走 hijack 流无此限制且二进制安全。固定 Tty:false 才能像 execRun 一样 demux。
export async function execFeed(
  cfg: Config,
  id: string,
  opts: ExecOpts,
  input: Buffer,
): Promise<ExecResult> {
  const docker = getDocker(cfg);
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: opts.Cmd,
    AttachStdout: true,
    AttachStderr: true,
    AttachStdin: true,
    Tty: false,
    User: opts.User || '1000:1000',
    WorkingDir: opts.WorkingDir || '/home/dev',
    Env: opts.Env,
  });
  const stream = await exec.start({ hijack: true, stdin: true });
  // 同 execRun：超时 destroy 会在流上 emit 'error'，吞掉防崩进程。
  stream.on('error', () => {
    /* noop */
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = opts.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        try {
          stream.destroy(new Error('mysandbox timeout'));
        } catch {
          /* noop */
        }
      }, opts.timeoutMs)
    : null;
  const out = new PassThrough();
  const errp = new PassThrough();
  docker.modem.demuxStream(stream, out, errp);
  out.on('data', (d: Buffer) => {
    stdout += d.toString('utf8');
  });
  errp.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
  });
  // 一次写入并 end（半关闭 stdin）= 命令收到 EOF 后收尾退出。
  stream.end(input);
  await new Promise<void>((resolve) => {
    stream.on('end', () => resolve());
    stream.on('close', () => resolve());
  });
  if (timer) clearTimeout(timer);
  let exitCode: number;
  try {
    const info = await exec.inspect();
    exitCode = info.ExitCode ?? -1;
  } catch {
    exitCode = -1;
  }
  if (timedOut) {
    stderr += stderr ? '\n[mysandbox: timeout]' : '[mysandbox: timeout]';
    if (exitCode === 0 || exitCode === -1) exitCode = -1;
  }
  return { exitCode, stdout, stderr };
}
