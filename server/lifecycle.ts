// 容器生命周期编排：create（含 IP 分配 + data 目录预建 + 固定 IP）+ delete。
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type Docker from 'dockerode';
import type { Config } from './config.js';
import { getDocker, MANAGED_LABEL } from './docker.js';
import { setMeta, deleteMeta } from './state.js';
import { allocate, isFree } from './network.js';
import { badRequest, conflict, notFound } from './errors.js';
import { imageExists } from './image.js';
import { getCustomHostsContent, parseExtraHosts } from './hosts.js';
import { seedContainerCli } from './container-cli.js';
import { log } from './logger.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export interface CreateInput {
  name: string;
  ip?: string;
  gitName?: string;
  gitEmail?: string;
  role?: string;
  description?: string;
  // docker PortBindings 形如 { '6200/tcp': [{ HostPort: '6500' }] }
  portMappings?: Record<string, Array<{ HostPort: string; HostIp?: string }>>;
}

export interface CreateResult {
  id: string;
  name: string;
  ip: string;
}

export async function createContainer(cfg: Config, input: CreateInput): Promise<CreateResult> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw badRequest('invalid name (^[a-z0-9][a-z0-9-]{1,30}$)');
  }

  const docker = getDocker(cfg);

  // 基础镜像就绪检查：缺失时给清晰提示，而不是让 docker create 抛看不懂的 NotFound。
  if (!(await imageExists(cfg, cfg.image))) {
    throw notFound(
      `base image "${cfg.image}" not found locally. Build it: \`mysandbox image build\`, or pull: \`mysandbox image pull\`.`,
    );
  }

  // 查重
  const all = await docker.listContainers({ all: true });
  if (all.some((c) => c.Names.some((n) => n.replace(/^\//, '') === name))) {
    throw conflict(`container name "${name}" already exists`);
  }

  // IP 分配
  let ip: string | undefined = input.ip?.trim();
  if (ip) {
    if (!(await isFree(cfg, ip))) throw conflict(`IP ${ip} already in use`);
  } else {
    const allocated = await allocate(cfg);
    if (!allocated) throw conflict('IP pool exhausted');
    ip = allocated;
  }

  // data 目录预建（leon uid 1000 = 容器 dev），必须在 createContainer 之前。
  // 否则 docker 以 root 自建，容器 dev 写不进，entrypoint 报 home 不可写。
  const home = join(cfg.dataRoot, name);
  if (!existsSync(home)) {
    await mkdir(home, { recursive: true, mode: 0o755 });
  }
  // 种子容器内 mysandbox 命令（~/.local/bin/mysandbox，幂等）：web 终端里敲它即可联动浏览器。
  seedContainerCli(home);

  const binds = [
    `${cfg.dataRoot}/${name}:/home/dev:rw`,
    `${cfg.sshSource}:/mnt/host/.ssh:ro`,
  ];
  if (cfg.claudeSettingsTemplate) {
    binds.push(`${cfg.claudeSettingsTemplate}:/mnt/claude-settings.template:ro`);
  }

  const gName = input.gitName ?? cfg.git.name;
  const gEmail = input.gitEmail ?? cfg.git.email;

  // 全局自定义 hosts -> Docker ExtraHosts（--add-host，唯一重启安全的 /etc/hosts 注入）。
  // 仅对新建容器生效且只表达 host:ip 对（注释/多别名在解析时丢失，见 parseExtraHosts）。
  const savedHosts = await getCustomHostsContent();
  const hostsParsed = savedHosts != null ? parseExtraHosts(savedHosts) : { extraHosts: [], skipped: [] };
  if (hostsParsed.skipped.length) {
    log.warn({ skipped: hostsParsed.skipped }, 'hosts ExtraHosts: some lines skipped');
  }
  const extraHosts = hostsParsed.extraHosts;

  const opts: Docker.ContainerCreateOptions = {
    name,
    Image: cfg.image,
    Hostname: name,
    User: '1000:1000',
    WorkingDir: '/home/dev',
    Env: [
      'TZ=Asia/Singapore',
      'HOME=/home/dev',
      `GIT_AUTHOR_NAME=${gName}`,
      `GIT_AUTHOR_EMAIL=${gEmail}`,
      `GIT_COMMITTER_NAME=${gName}`,
      `GIT_COMMITTER_EMAIL=${gEmail}`,
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
      'mysandbox.role': input.role || 'generic',
    },
    HostConfig: {
      Binds: binds,
      NetworkMode: cfg.network,
      Init: true,
      RestartPolicy: { Name: cfg.restartPolicy },
      ...(input.portMappings ? { PortBindings: input.portMappings } : {}),
      ...(extraHosts.length ? { ExtraHosts: extraHosts } : {}),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [cfg.network]: { IPAMConfig: { IPv4Address: ip } },
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

  await setMeta(name, {
    managed: true,
    adopted: false,
    source: 'mysandbox',
    description: input.description,
    ipHint: ip,
    createdAt: new Date().toISOString(),
  });

  log.info({ name, ip, image: cfg.image, network: cfg.network }, 'container created');
  return { id: container.id, name, ip };
}

export async function deleteManaged(
  cfg: Config,
  id: string,
  opts: { deleteData?: boolean; confirmName?: string },
): Promise<{ ok: true; dataRemoved: boolean; name: string }> {
  const docker = getDocker(cfg);
  const container = docker.getContainer(id);
  let info: Docker.ContainerInspectInfo;
  try {
    info = await container.inspect();
  } catch {
    throw notFound(`container ${id} not found`);
  }
  const name = (info.Name || '').replace(/^\//, '');
  const managed = info.Config?.Labels?.[MANAGED_LABEL] === 'mysandbox';
  if (!managed) {
    throw conflict('only mysandbox-created containers can be deleted here');
  }
  if (opts.deleteData && opts.confirmName !== name) {
    throw badRequest('confirmName does not match container name');
  }

  try {
    await container.stop({ t: 5 });
  } catch {
    /* 可能已停 */
  }
  await container.remove({ force: true });
  await deleteMeta(name);

  let dataRemoved = false;
  if (opts.deleteData) {
    try {
      await rm(join(cfg.dataRoot, name), { recursive: true, force: true });
      dataRemoved = true;
    } catch {
      /* noop */
    }
  }
  log.warn({ name, dataRemoved }, 'container deleted');
  return { ok: true, dataRemoved, name };
}
