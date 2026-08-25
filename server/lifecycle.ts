// 容器生命周期编排：create（含 IP 分配 + home 种子 + hosts）+ delete。
// 引擎特定的建容器动作（克隆模板 + 改写 config）在 engine/lxc.ts 的 create() 里，
// 这里只做编排。
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
import { conflict, notFound } from './errors.js';
import { getCustomHostsContent, parseExtraHosts, composeHostsContent, serviceBlockLines } from './hosts.js';
import { listServiceEndpoints } from './docker.js';
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
}

export interface CreateResult {
  id: string;
  name: string;
  ip: string;
}

export async function createContainer(cfg: Config, input: CreateInput): Promise<CreateResult> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw conflict('invalid name (^[a-z0-9][a-z0-9-]{1,30}$)');
  }

  const engine = getEngine(cfg);

  // 查重（含已停止的容器：lxc-ls 列的是「已定义」的容器，正是名字唯一性范围）
  if (await engine.nameExists(cfg, name)) {
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

  // 全局自定义 hosts。LXC 由启动后 exec 写入（真 systemd 容器的 /etc/hosts
  // 不会被引擎重置，写一次即持久）。内容与 applyHostsToContainers 同源同组合：
  // 用户内容 + docker 服务块（注释行 parseExtraHosts 本就跳过，extraHosts 也带上服务名）。
  const savedHosts = await getCustomHostsContent();
  const svcLines = cfg.services.enabled ? serviceBlockLines(await listServiceEndpoints(cfg)) : [];
  const hostsContent = composeHostsContent(savedHosts ?? '', svcLines);
  const hostsParsed = hostsContent ? parseExtraHosts(hostsContent) : { extraHosts: [], skipped: [] };
  if (hostsParsed.skipped.length) {
    log.warn({ skipped: hostsParsed.skipped }, 'hosts: some lines skipped');
  }

  const { id } = await engine.create(cfg, {
    name,
    ip,
    gitName: input.gitName ?? cfg.git.name,
    gitEmail: input.gitEmail ?? cfg.git.email,
    role: input.role || 'generic',
    extraHosts: hostsParsed.extraHosts,
  });

  // home 在 rootfs 内，克隆完才存在 —— 种子必须 在 create 之后。
  const home = engine.hostHomePath(cfg, name);
  if (home && existsSync(home)) seedContainerCli(home);

  if (hostsContent) {
    await applyInitialHosts(cfg, id, name, hostsContent);
  }

  await setMeta(name, {
    managed: true,
    adopted: false,
    source: `lxc:${cfg.lxc.template}`,
    description: input.description,
    ipHint: ip,
    createdAt: new Date().toISOString(),
  });

  log.info({ name, ip, engine: engine.name, network: cfg.network }, 'container created');
  return { id, name, ip };
}

// 新建容器的 /etc/hosts 初始注入。与 hosts-sync 的 apply 同款做法：
// base64 经 argv 传入、root 覆写。
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
  let info: Awaited<ReturnType<typeof inspectContainer>>;
  try {
    info = await inspectContainer(cfg, id);
  } catch {
    throw notFound(`container ${id} not found`);
  }
  const name = info.name;
  if (!info.managed) {
    throw conflict('only mysandbox-created containers can be deleted here');
  }

  // home 在 rootfs 内，lxc-destroy 必然连数据一起删——「保留数据」不可实现，
  // 所以要求输入容器名确认，不能静默毁数据。
  if (opts.confirmName !== name) {
    throw conflict(
      `deleting the container also deletes its data (home lives inside the container) — confirmName must match the container name`,
    );
  }

  try {
    await stopContainer(cfg, id, 5);
  } catch {
    /* 可能已停 */
  }
  await removeContainer(cfg, id, { force: true });
  await deleteMeta(name);

  log.warn({ name, dataRemoved: true }, 'container deleted');
  return { ok: true, dataRemoved: true, name };
}
