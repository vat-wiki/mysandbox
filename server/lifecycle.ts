// 容器生命周期编排：create（含 IP 分配 + home 预建 + 种子 + hosts）+ delete。
// 引擎无关：docker 的 ContainerCreateOptions 组装与 lxc 的「克隆模板 + 改写 config」
// 各自在 engine/{docker,lxc}.ts 的 create() 里，这里只做两者共通的编排。
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Config } from './config.js';
import {
  getEngine,
  inspectContainer,
  stopContainer,
  removeContainer,
  execRun,
} from './engine/index.js';
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
  // docker PortBindings 形如 { '6200/tcp': [{ HostPort: '6500' }] }（仅 docker 引擎支持）
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

  const engine = getEngine(cfg);

  // 基础镜像就绪检查：缺失时给清晰提示，而不是让 docker create 抛看不懂的 NotFound。
  // LXC 无镜像概念（模板容器的存在性由 engine.create 检查，错误信息指向 template）。
  if (engine.name === 'docker' && !(await imageExists(cfg, cfg.image))) {
    throw notFound(
      `base image "${cfg.image}" not found locally. Build it: \`mysandbox image build\`, or pull: \`mysandbox image pull\`.`,
    );
  }

  // 查重（含已停止的容器：两个引擎的名字唯一性都跨状态）
  if (await engine.nameExists(cfg, name)) {
    throw conflict(`container name "${name}" already exists`);
  }

  // 端口映射：LXC 固定 IP 直连、不做 NAT。静默忽略会让用户以为映射生效了，故显式拒绝。
  if (input.portMappings && !engine.caps.portMappings) {
    throw badRequest(
      `engine "${engine.name}" does not support port mappings — containers are reachable directly at their fixed IP`,
    );
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

  // 全局自定义 hosts。docker 走 ExtraHosts（create 时注入，唯一重启安全的方式）；
  // LXC 由下面启动后 exec 写入（真 systemd 容器的 /etc/hosts 不会被引擎重置，写一次即持久）。
  const savedHosts = await getCustomHostsContent();
  const hostsParsed = savedHosts != null ? parseExtraHosts(savedHosts) : { extraHosts: [], skipped: [] };
  if (hostsParsed.skipped.length) {
    log.warn({ skipped: hostsParsed.skipped }, 'hosts ExtraHosts: some lines skipped');
  }

  // home 预建（仅 docker：bind mount 的宿主目录必须先存在且属 uid 1000，
  // 否则 docker 以 root 自建、容器 dev 写不进，entrypoint 报 home 不可写）。
  // LXC 的 home 在 rootfs 内、由模板带出来，无需预建（预建反而会撞克隆）。
  if (!engine.caps.dataInsideContainer) {
    const home = engine.hostHomePath(cfg, name);
    if (home && !existsSync(home)) {
      await mkdir(home, { recursive: true, mode: 0o755 });
    }
    // 种子容器内 mysandbox 命令（~/.local/bin/mysandbox，幂等）：web 终端里敲它即可联动浏览器。
    if (home) seedContainerCli(home);
  }

  const { id } = await engine.create(cfg, {
    name,
    ip,
    gitName: input.gitName ?? cfg.git.name,
    gitEmail: input.gitEmail ?? cfg.git.email,
    role: input.role || 'generic',
    extraHosts: hostsParsed.extraHosts,
    portMappings: input.portMappings,
  });

  // LXC：home 在 rootfs 内，克隆完才存在 —— 种子必须在 create 之后。
  if (engine.caps.dataInsideContainer) {
    const home = engine.hostHomePath(cfg, name);
    if (home && existsSync(home)) seedContainerCli(home);
  }

  // LXC 的 hosts 注入：无 ExtraHosts 等价物，启动后 root exec 写一次。
  // 失败只记日志——容器已经建好了，不该因为 hosts 写不进而回滚（用户可在 hosts 面板重试）。
  if (engine.caps.dataInsideContainer && savedHosts) {
    await applyInitialHosts(cfg, id, name, savedHosts);
  }

  await setMeta(name, {
    managed: true,
    adopted: false,
    source: engine.name === 'lxc' ? `lxc:${cfg.lxc.template}` : 'mysandbox',
    description: input.description,
    ipHint: ip,
    createdAt: new Date().toISOString(),
  });

  log.info({ name, ip, engine: engine.name, network: cfg.network }, 'container created');
  return { id, name, ip };
}

// 新建 LXC 容器的 /etc/hosts 初始注入（docker 侧由 ExtraHosts 在 create 时完成）。
// 与 hosts-sync 的 apply 同款做法：base64 经 stdin 无关的 argv 传入、root 覆写。
async function applyInitialHosts(
  cfg: Config,
  id: string,
  name: string,
  content: string,
): Promise<void> {
  try {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const r = await execRun(cfg, id, {
      Cmd: ['sh', '-c', `printf %s '${b64}' | base64 -d > /etc/hosts`],
      User: 'root:root',
      Tty: false,
      timeoutMs: 15_000,
    });
    if (r.exitCode !== 0) {
      log.warn({ name, exitCode: r.exitCode, stderr: r.stderr.slice(0, 200) }, 'initial hosts write failed');
    }
  } catch (e) {
    log.warn({ name, err: String(e) }, 'initial hosts write failed');
  }
}

export async function deleteManaged(
  cfg: Config,
  id: string,
  opts: { deleteData?: boolean; confirmName?: string },
): Promise<{ ok: true; dataRemoved: boolean; name: string }> {
  const engine = getEngine(cfg);
  let info: Awaited<ReturnType<typeof inspectContainer>>;
  try {
    info = await inspectContainer(cfg, id);
  } catch {
    throw notFound(`container ${id} not found`);
  }
  const name = info.name;
  const managed = info.managed;
  if (!managed) {
    throw conflict('only mysandbox-created containers can be deleted here');
  }

  // 数据与容器的关系是引擎语义差异，不是选项：
  //   - docker：home 是 bind mount 的宿主目录，删容器默认保留数据，deleteData 才删。
  //   - lxc：home 在 rootfs 内（D4），lxc-destroy 必然连数据一起删。此时「保留数据」
  //     不可实现，所以要求与 deleteData 同级的确认（输入容器名），不能静默毁数据。
  const dataAlwaysGone = engine.caps.dataInsideContainer;
  if ((opts.deleteData || dataAlwaysGone) && opts.confirmName !== name) {
    throw badRequest(
      dataAlwaysGone
        ? `deleting an ${engine.name} container also deletes its data (home lives inside the container) — confirmName must match the container name`
        : 'confirmName does not match container name',
    );
  }

  try {
    await stopContainer(cfg, id, 5);
  } catch {
    /* 可能已停 */
  }
  await removeContainer(cfg, id, { force: true });
  await deleteMeta(name);

  let dataRemoved = dataAlwaysGone; // lxc：rootfs 随 destroy 一起没了
  if (opts.deleteData && !dataAlwaysGone) {
    const home = engine.hostHomePath(cfg, name);
    if (home) {
      try {
        await rm(home, { recursive: true, force: true });
        dataRemoved = true;
      } catch {
        /* noop */
      }
    }
  }
  log.warn({ name, engine: engine.name, dataRemoved }, 'container deleted');
  return { ok: true, dataRemoved, name };
}
