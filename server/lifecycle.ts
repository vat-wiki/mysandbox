// 容器生命周期编排：create（含 IP 分配 + home 种子 + hosts）+ delete。
// 引擎特定的建容器动作（克隆模板 + 改写 config）在 engine/lxc.ts 的 create() 里，
// 这里只做编排。
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from './config.js';
import { expandTilde } from './config.js';
import {
  getEngine,
  inspectContainer,
  stopContainer,
  removeContainer,
  type CreateSource,
  type BaseProgress,
} from './engine/index.js';
import { setMeta, deleteMeta, deleteAiGatewayOverride } from './state.js';
import { allocate, isFree } from './network.js';
import { conflict, notFound } from './errors.js';
import { readHostHosts } from './hosts.js';
import { applyServicesBlock, overwriteHosts } from './hosts-sync.js';
import { seedContainerCli } from './container-cli.js';
import { peerSeedInfo } from './peer.js';
import { syncContainerSkills } from './skillSync.js';
import { applyGatewayToContainer } from './aiconfig.js';
import { log } from './logger.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

export interface CreateInput {
  name: string;
  ip?: string;
  gitName?: string;
  gitEmail?: string;
  role?: string;
  description?: string;
  // /etc/hosts 来源：template = 继承所选来源 rootfs 的 hosts（lxc-copy 原样复制 / 解包原样落地，
  // 缺省）；host = 用宿主 /etc/hosts 整体覆写。
  hosts?: 'template' | 'host';
  // 建容器的来源：缺省 = 模板（cfg.lxc.template）；container = 克隆现有容器（在跑会先停）；
  // archive = 从 tar.zst 包解包落地。
  source?: CreateSource;
}

export interface CreateResult {
  id: string;
  name: string;
  ip: string;
}

export async function createContainer(
  cfg: Config,
  input: CreateInput,
  onProgress?: (e: BaseProgress) => void,
): Promise<CreateResult> {
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

  // hosts 来源。template（缺省）零动作——lxc-copy 原样复制模板 rootfs 的 /etc/hosts，
  // 只需追平一次服务块（同时剥掉克隆可能从模板带来的旧块残留；无服务则全 skip）。
  // host = 宿主 /etc/hosts 整体覆写（服务块照常组合）。
  const { id } = await engine.create(
    cfg,
    {
      name,
      ip,
      gitName: input.gitName ?? cfg.git.name,
      gitEmail: input.gitEmail ?? cfg.git.email,
      role: input.role || 'generic',
      source: input.source,
    },
    onProgress,
  );

  // home 在 rootfs 内，克隆完才存在 —— 种子必须 在 create 之后。
  const home = engine.hostHomePath(cfg, name);
  if (home && existsSync(home)) seedContainerCli(home, peerSeedInfo(cfg));

  if (input.hosts === 'host') {
    const base = await readHostHosts();
    if (base) {
      const r = await overwriteHosts(cfg, [id], base, 'create');
      if (r.failed > 0) log.warn({ name, failed: r.failed }, 'initial hosts overwrite (host source) partially failed');
    } else {
      // 宿主读不到（异常环境）：容器已建好，退回模板继承态即可，不回滚。
      log.warn({ name }, 'host /etc/hosts unreadable; container keeps template-inherited hosts');
    }
  } else {
    await applyServicesBlock(cfg, { ids: [id], reason: 'create' });
  }

  // 来源按实际出处记（详情面板展示「从哪儿来」）：模板/容器克隆 = lxc:<名字>，
  // 包导入 = archive:<绝对路径>（expandTilde 归一，与 config 的路径口径一致）。
  const source = !input.source
    ? `lxc:${cfg.lxc.template}`
    : input.source.kind === 'container'
      ? `lxc:${input.source.name}`
      : `archive:${resolve(expandTilde(input.source.path))}`;

  await setMeta(name, {
    managed: true,
    adopted: false,
    source,
    description: input.description,
    ipHint: ip,
    createdAt: new Date().toISOString(),
  });

  log.info({ name, ip, engine: engine.name, network: cfg.network }, 'container created');
  // skills 分发 + AI 网关凭据：新容器补发当前期望状态（宿主直写 rootfs，容器在不在
  // 跑都行；尽力而为不阻塞返回）。声明式配置从此对新容器自动就位。
  void syncContainerSkills(cfg, name);
  void applyGatewayToContainer(cfg, name);
  return { id, name, ip };
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
  await deleteAiGatewayOverride(name); // 网关覆盖随容器走（残留会对不上任何容器）

  log.warn({ name, dataRemoved: true }, 'container deleted');
  return { ok: true, dataRemoved: true, name };
}
