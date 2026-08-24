// docker 引擎实现：原 server/docker.ts 全量迁入，挂到 Engine 接口后（P3 重构，行为零变化）。
// dockerode 单例与容器操作、exec 封装（demux/hijack）、events 订阅都在这里。
// P5 起还包含建容器（create）——原 lifecycle.ts 里那段 ContainerCreateOptions 组装，
// 因为它与 LXC 的「克隆模板 + 改写 config」毫无共同点，属引擎特定路径。
import Docker from 'dockerode';
import { PassThrough, type Duplex } from 'node:stream';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { getAllMeta, type ContainerMeta } from '../state.js';
import type {
  Engine,
  EngineEvent,
  EngineCaps,
  EventSubscription,
  ContainerInfo,
  ContainerView,
  ContainerPort,
  CreateSpec,
  ExecOpts,
  ExecResult,
  ExecStream,
  BaseAction,
  BaseActionOpts,
  BaseProgress,
  BaseStatus,
} from './types.js';

export const MANAGED_LABEL = 'mysandbox.managed-by';

// docker 形态的能力：home 是 bind mount 的宿主目录（删容器不动数据）、支持 live rename、
// 有 NAT 端口映射；基座是镜像，动作 = build/pull/push（有 registry 这个分发形态）。
const CAPS: EngineCaps = {
  dataInsideContainer: false,
  liveRename: true,
  portMappings: true,
  baseKind: 'image',
  baseActions: ['build', 'pull', 'push'],
};

let _docker: Docker | null = null;
export function getDocker(cfg: Config): Docker {
  if (!_docker) {
    _docker = new Docker({ socketPath: cfg.docker.socketPath });
  }
  return _docker;
}

// —— Engine.status：连通性检查 ——
async function status(cfg: Config) {
  try {
    const v = await getDocker(cfg).version();
    return { reachable: true, version: v.Version, apiVersion: v.ApiVersion };
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// 列出受管理容器：在配置网络上 或 带 mysandbox label。合并 sidecar 元数据。
async function listManaged(cfg: Config): Promise<ContainerView[]> {
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

// —— inspect 归一：把 docker 原始 inspect 裁剪成 ContainerInfo ——
async function inspect(cfg: Config, id: string): Promise<ContainerInfo> {
  const info = await getDocker(cfg).getContainer(id).inspect();
  return {
    id: info.Id,
    name: (info.Name || '').replace(/^\//, ''),
    running: info.State?.Running === true,
    stateStatus: info.State?.Status || 'unknown',
    managed: info.Config?.Labels?.[MANAGED_LABEL] === 'mysandbox',
    networks: Object.keys(info.NetworkSettings?.Networks || {}),
    ports: (info.NetworkSettings?.Ports
      ? Object.entries(info.NetworkSettings.Ports).flatMap(([key, bindings]) => {
          const privatePort = Number(key.split('/')[0]);
          const type = key.split('/')[1] || 'tcp';
          return (bindings || []).map((b) => ({
            ip: b.HostIp,
            privatePort,
            publicPort: b.HostPort ? Number(b.HostPort) : undefined,
            type,
          }));
        })
      : []) as ContainerPort[],
  };
}

// 在容器内执行命令。Tty:false -> demux stdout/stderr（批量配置用）。
async function execRun(cfg: Config, id: string, opts: ExecOpts): Promise<ExecResult> {
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
async function execFeed(
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

// terminal.ts 的 PTY 流：docker exec hijack + Tty 单流 + resize。
async function execStream(cfg: Config, id: string, opts: ExecOpts): Promise<ExecStream> {
  const container = getDocker(cfg).getContainer(id);
  const exec = await container.exec({
    Cmd: opts.Cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: opts.User || '1000:1000',
    WorkingDir: opts.WorkingDir || '/home/dev',
    Env: opts.Env,
  });
  const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
  // 同 execRun：destroy 会在流上 emit 'error'，不挂 handler 会崩整个 mysandbox。
  stream.on('error', () => {
    /* noop */
  });
  return {
    stream,
    resize: async (cols, rows) => {
      await exec.resize({ w: cols, h: rows });
    },
  };
}

// —— 网络与事件（network.ts / hosts-sync.ts 的底座）——
async function assignedIps(cfg: Config): Promise<Set<string>> {
  const info = await getDocker(cfg).getNetwork(cfg.network).inspect();
  const set = new Set<string>();
  for (const c of Object.values(info.Containers || {})) {
    if (c.IPv4Address) set.add(c.IPv4Address.split('/')[0]);
  }
  return set;
}

async function subscribeEvents(
  cfg: Config,
  onEvent: (ev: EngineEvent) => void,
): Promise<EventSubscription> {
  const stream = await getDocker(cfg).getEvents({
    filters: { type: ['container'], event: ['start', 'restart'] },
  });
  // closed：流 end/close/error 任一即视为断开（error 吞掉不外抛，由调用方退避重连）。
  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const readable = stream as import('node:stream').Readable;
  readable.on('end', () => resolveClosed());
  readable.on('close', () => resolveClosed());
  readable.on('error', () => resolveClosed());
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line) as {
          Type?: string;
          Action?: string;
          Actor?: { ID?: string };
        };
        if (ev.Type === 'container' && (ev.Action === 'start' || ev.Action === 'restart') && ev.Actor?.ID) {
          onEvent({ containerId: ev.Actor.ID, action: ev.Action });
        }
      } catch {
        continue; // 坏行丢弃
      }
    }
  });
  return {
    close() {
      try {
        readable.destroy();
      } catch {
        /* noop */
      }
    },
    closed,
  };
}

// —— 建容器（原 lifecycle.ts 的 docker 路径，行为逐字保留）——
// 前置（IP 分配、data 目录预建、种子、hosts 解析）在 lifecycle.ts；这里只组装 docker 对象并起。
async function create(cfg: Config, spec: CreateSpec): Promise<{ id: string }> {
  const docker = getDocker(cfg);
  const binds = [
    `${cfg.dataRoot}/${spec.name}:/home/dev:rw`,
    `${cfg.sshSource}:/mnt/host/.ssh:ro`,
  ];
  if (cfg.claudeSettingsTemplate) {
    binds.push(`${cfg.claudeSettingsTemplate}:/mnt/claude-settings.template:ro`);
  }

  const opts: Docker.ContainerCreateOptions = {
    name: spec.name,
    Image: cfg.image,
    Hostname: spec.name,
    User: '1000:1000',
    WorkingDir: '/home/dev',
    Env: [
      'TZ=Asia/Singapore',
      'HOME=/home/dev',
      `GIT_AUTHOR_NAME=${spec.gitName}`,
      `GIT_AUTHOR_EMAIL=${spec.gitEmail}`,
      `GIT_COMMITTER_NAME=${spec.gitName}`,
      `GIT_COMMITTER_EMAIL=${spec.gitEmail}`,
      'PATH=/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      'DEBIAN_FRONTEND=noninteractive',
      'LANG=C.UTF-8',
      'PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright',
    ],
    Cmd: ['sleep', 'infinity'],
    Entrypoint: ['/usr/local/bin/entrypoint.sh'],
    Tty: true,
    OpenStdin: true,
    StdinOnce: false,
    Labels: {
      [MANAGED_LABEL]: 'mysandbox',
      'mysandbox.created-at': new Date().toISOString(),
      'mysandbox.role': spec.role,
    },
    HostConfig: {
      Binds: binds,
      NetworkMode: cfg.network,
      Init: true,
      RestartPolicy: { Name: cfg.restartPolicy },
      ...(spec.portMappings ? { PortBindings: spec.portMappings } : {}),
      ...(spec.extraHosts.length ? { ExtraHosts: spec.extraHosts } : {}),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [cfg.network]: { IPAMConfig: { IPv4Address: spec.ip } },
      },
    },
  };

  const container = await docker.createContainer(opts);
  try {
    await container.start();
  } catch (e) {
    // start 失败：删除容器，保留 data 目录（破坏性操作留用户）
    try {
      await container.remove({ force: true });
    } catch {
      /* noop */
    }
    throw e;
  }
  return { id: container.id };
}

// 建容器前置查重（含已停止的容器：docker 名字唯一性跨状态）。
async function nameExists(cfg: Config, name: string): Promise<boolean> {
  const all = await getDocker(cfg).listContainers({ all: true });
  return all.some((c) => c.Names.some((n) => n.replace(/^\//, '') === name));
}

// 容器 home 的宿主路径 = bind mount 源。adopted 的外部容器没有这个挂载，
// 宿主直写方案对它不成立（container-cli 的种子扫描据此跳过）——但路径本身照算，
// 由调用方用 existsSync 判定可见性（与 P5 前 sweepContainerCli 的行为一致）。
function hostHomePath(cfg: Config, name: string): string {
  return join(cfg.dataRoot, name);
}

// —— 基座（镜像）：实现在 ../image.ts（build/pull/push + status）——
// 动态 import 而非顶部静态：image.ts 依赖本模块的 getDocker，静态互引会成环。
// 基座动作都是用户触发的低频操作，那一次 import 的开销无所谓。
async function baseStatus(cfg: Config): Promise<BaseStatus> {
  const { imageBaseStatus } = await import('../image.js');
  return imageBaseStatus(cfg);
}

async function runBaseAction(
  cfg: Config,
  action: BaseAction,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const { buildImage, pullImage, pushImage, resolveImageRef } = await import('../image.js');
  if (action === 'build') {
    return buildImage(cfg, { tag: opts.tag || cfg.image, noCache: !!opts.noCache }, onProgress);
  }
  if (action === 'pull') return pullImage(cfg, resolveImageRef(cfg, opts.ref), onProgress);
  if (action === 'push') return pushImage(cfg, resolveImageRef(cfg, opts.ref), onProgress);
  const { badRequest } = await import('../errors.js');
  throw badRequest(`engine docker does not support base action "${action}"`);
}

// —— 导出 Engine——
export const dockerEngine: Engine = {
  name: 'docker',
  caps: CAPS,
  status: async (cfg) => {
    return status(cfg);
  },
  listManaged,
  inspect,
  create,
  start: async (cfg, id) => {
    await getDocker(cfg).getContainer(id).start();
  },
  stop: async (cfg, id, t = 5) => {
    await getDocker(cfg).getContainer(id).stop({ t });
  },
  restart: async (cfg, id, t = 5) => {
    await getDocker(cfg).getContainer(id).restart({ t });
  },
  rename: async (cfg, id, name) => {
    await getDocker(cfg).getContainer(id).rename({ name });
  },
  remove: async (cfg, id, opts = {}) => {
    await getDocker(cfg).getContainer(id).remove({ force: opts.force ?? true });
  },
  execRun,
  execFeed,
  execStream,
  assignedIps,
  subscribeEvents,
  baseStatus,
  runBaseAction,
  nameExists,
  hostHomePath,
};
