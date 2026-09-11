// 服务块维护 + 显式覆写：mysandbox 对容器 /etc/hosts 的全部写路径。
// 模型（全局 hosts 已删）：base 是用户资产（模板继承/宿主源/批量覆写的结果），只有
// 尾部的服务发现块（docker 服务行）归 mysandbox 管——
//   - applyServicesBlock：读-改-写（读容器 hosts → 剥旧块 → 追新块），base 永不动。
//     服务集变化（docker events）、容器重启（块内容可能过期）、启动补刷都走它。
//   - overwriteHosts：显式整体覆写（批量配置 tab / 新建容器选宿主源），覆写内容
//     同样组合服务块——显式动作不丢服务发现。
import type { Config } from './config.js';
import { listManaged, rootfsPath, execRun, inspectContainer, subscribeEvents, type ExecOpts } from './engine/index.js';
import type { BatchResult } from './batch.js';
import { readFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { composeHostsContent, stripServicesBlock, serviceBlockLines } from './hosts.js';
import { listServiceEndpoints } from './docker.js';
import { listComposeDirServices } from './serviceCompose.js';
import { adoptedContainerNames, getAllServiceMeta } from './state.js';
import { DOCKER_API_HOSTNAME } from './dockerApi.js';
import { gatewayOf } from './network.js';
import { log } from './logger.js';

export type ApplyHostsResult = BatchResult & { skipped: number };

const EMPTY_RESULT: ApplyHostsResult = { total: 0, ok: 0, failed: 0, skipped: 0, items: [] };

// 当前服务行（services 关闭时为空数组 = 剥掉所有服务块的语义）。
async function currentSvcLines(cfg: Config): Promise<string[]> {
  const endpoints: { name: string; ip: string }[] = [];
  // docker API 桥（dockerApi.enabled）：host.docker.internal → 网关 IP（server/dockerApi.ts）。
  // 与 docker 服务行同走一个 services 尾块——同一套读-改-写/事件追平/启动补刷，块被剥
  // 一起剥。域名固定不随 ipPool 变：改池子只动这一行，容器内 DOCKER_HOST 永不重配。
  if (cfg.dockerApi.enabled) endpoints.push({ name: DOCKER_API_HOSTNAME, ip: gatewayOf(cfg) });
  if (cfg.services.enabled) {
    // 服务事实源三源并集：label 集 ∪ adopted meta（收编无 label；栈按成员容器名展开）
    // ∪ compose 目录注册表（agent 自放文件的服务容器同样无我们的 label，靠 project 命中）。
    const adopted = adoptedContainerNames(await getAllServiceMeta());
    const dirs = await listComposeDirServices();
    endpoints.push(...(await listServiceEndpoints(cfg, adopted, dirs)));
  }
  return serviceBlockLines(endpoints);
}

// base64 token 仅 [A-Za-z0-9+/=]，单引号包裹绝对安全；printf %s 不解释反斜杠。
// root:root —— 容器以 dev(1000) 跑、/etc/hosts 归 root。
function writeCmd(content: string): ExecOpts {
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  return {
    Cmd: ['sh', '-c', `printf %s '${b64}' | base64 -d > /etc/hosts`],
    User: 'root:root',
    Tty: false,
    timeoutMs: 15_000,
  };
}

// 模板永远不是目标：它的 /etc/hosts 是新容器的源头资产，被追平等于污染模板。
// 事件路径曾在这里漏过（模板 running 时被覆写，state.json 里的旧 hostsHash 是铁证）。
function dropTemplate(cfg: Config, ids: string[]): string[] {
  return ids.filter((id) => id !== cfg.lxc.template);
}

// 容器 rootfs 里当前 hosts 内容；读不到（容器不存在/刚删）返回 null，调用方记失败。
// base.ts 的来源预览也用它（/api/base/hosts?container=）。
export async function readContainerHosts(cfg: Config, id: string): Promise<string | null> {
  const rootfs = rootfsPath(cfg, id);
  if (!rootfs) return null;
  try {
    return await readFile(`${rootfs}/etc/hosts`, 'utf8');
  } catch {
    return null;
  }
}

// —— 服务块读-改-写 ——
// 目标：显式 ids（过滤模板）或全部运行中受管理容器。每台「读现文件 → 剥旧块 →
// 追新块」，与现内容相同记 skipped（读-比较-写天然幂等，无需 hash 记账）。
export async function applyServicesBlock(
  cfg: Config,
  opts: { ids?: string[]; reason?: string } = {},
): Promise<ApplyHostsResult> {
  const svcLines = await currentSvcLines(cfg);
  let targets: string[];
  if (opts.ids && opts.ids.length) {
    targets = dropTemplate(cfg, opts.ids);
  } else {
    const views = await listManaged(cfg);
    targets = dropTemplate(cfg, views.filter((v) => v.state === 'running').map((v) => v.id));
  }
  if (targets.length === 0) return { ...EMPTY_RESULT };

  // 读-比-写：内容一致的目标不 exec（服务集没变时近零成本；容器数少，并发读文件很快）。
  const jobs: { id: string; next: string }[] = [];
  let skipped = 0;
  const reads = await Promise.all(
    targets.map(async (id) => ({ id, current: await readContainerHosts(cfg, id) })),
  );
  for (const { id, current } of reads) {
    if (current == null) continue; // 读不到（已删/异常）：多半容器已不在，不刷不报错
    const next = composeHostsContent(stripServicesBlock(current), svcLines);
    if (next === current) skipped++;
    else jobs.push({ id, next });
  }
  if (jobs.length === 0) {
    log.debug({ skipped, reason: opts.reason }, 'hosts services block: all up to date');
    return { ...EMPTY_RESULT, total: targets.length, skipped };
  }

  // 内容每容器不同，且 runBatch 的无参 build() 调用到达序与提交序不保证一致
  // （runOne 的 inspect await 之后才调 build，实测会乱序），所以自己扇出：
  // p-limit 同款并发限制 + 逐容器错误收敛（结果形状与 runBatch 一致）。
  const limit = pLimit(4);
  const items = await Promise.all(
    jobs.map((j) =>
      limit(async () => {
        try {
          const r = await execRun(cfg, j.id, writeCmd(j.next));
          return { id: j.id, name: j.id, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        } catch (e) {
          return { id: j.id, name: j.id, ok: false, exitCode: -1, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
        }
      }),
    ),
  );
  const r: BatchResult = {
    total: items.length,
    ok: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length,
    items,
  };
  for (const it of items) {
    if (!it.ok) log.warn({ op: 'hosts-services', id: it.id, exitCode: it.exitCode, error: it.error }, 'hosts services write failed');
  }
  return { ...r, skipped };
}

// —— 显式整体覆写 ——
// 批量配置 hosts tab / 新建容器选宿主源。base 是调用方给的完整内容（非空——
// 清空 /etc/hosts 从不是合法意图，空内容在此 400 前就挡掉），服务块照常组合。
export async function overwriteHosts(cfg: Config, ids: string[], base: string, reason: string): Promise<ApplyHostsResult> {
  const targets = dropTemplate(cfg, ids);
  if (targets.length === 0) return { ...EMPTY_RESULT };
  const svcLines = await currentSvcLines(cfg);
  const content = composeHostsContent(base, svcLines);
  if (!content) return { ...EMPTY_RESULT };
  const limit = pLimit(4);
  const items = await Promise.all(
    targets.map((id) =>
      limit(async () => {
        try {
          const r = await execRun(cfg, id, writeCmd(content));
          return { id, name: id, ok: r.exitCode === 0, exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
        } catch (e) {
          return { id, name: id, ok: false, exitCode: -1, stdout: '', stderr: '', error: e instanceof Error ? e.message : String(e) };
        }
      }),
    ),
  );
  return {
    total: items.length,
    ok: items.filter((i) => i.ok).length,
    failed: items.filter((i) => !i.ok).length,
    items,
    skipped: 0,
  };
}

// —— 容器事件 → 服务块追平 ——

// 模块级串行队列：事件稀疏但 restart 风暴时防并发 exec；失败吞掉不连锁。
let chain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  chain = chain.then(fn).catch((e) => {
    log.warn({ err: String(e) }, 'hosts event sync: task failed');
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 订阅引擎事件（容器 RUNNING），断线指数退避重连。永不抛、永不崩进程：引擎侧
// 已吞掉流 error（lxc-monitor 进程退出），断流即返回，这里退避重连即自愈。
export function startHostsEventSync(cfg: Config): void {
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeEvents(cfg, (ev) => {
          enqueue(() => handleEvent(cfg, ev.containerId));
        });
        delay = 1_000; // 连上即复位
        log.info({ engine: 'lxc' }, 'hosts event sync: subscribed');
        // 重连后追平一次，补断线窗口内错过的事件（读-比-写，近零成本）
        enqueue(async () => void (await applyServicesBlock(cfg, { reason: 'reconnect' })));
        await sub.closed; // resolve = 底层断流（引擎侧判定）-> 退避重连
      } catch (e) {
        log.warn({ err: String(e), retryMs: delay }, 'hosts event sync: subscribe failed, retrying');
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}

async function handleEvent(cfg: Config, id: string): Promise<void> {
  // 模板 start 不追平：模板的 /etc/hosts 是新容器的源头资产（dropTemplate 是写侧
  // 的同款防线，这里前置省一次 inspect）。受管理判定异常一律当不受管理——
  // 容器删除瞬间的 start 竞态等不该炸事件循环。
  if (id === cfg.lxc.template) return;
  try {
    const info = await inspectContainer(cfg, id);
    if (!info.managed && !info.networks.includes(cfg.network)) return;
  } catch {
    return;
  }
  // 容器 start 后追平一次服务块：hosts 是 rootfs 真文件、重启不还原，但块内容
  // 可能在停机期间过期（服务集变了）。读-改-写，base 不动。
  await applyServicesBlock(cfg, { ids: [id], reason: 'event' });
}

// 启动补刷：服务重启期间容器可能被外部 restart（错过事件窗口）。门控：存在
// 运行中服务才刷——服务存在时容器 /etc/hosts 尾部就该有服务行。读-比-写，
// 无变化近零成本。用户资产（base）永远不是这条路径的写入对象。
export async function sweepHosts(cfg: Config): Promise<void> {
  try {
    const svcLines = await currentSvcLines(cfg);
    if (svcLines.length === 0) return;
    const r = await applyServicesBlock(cfg, { reason: 'startup' });
    log.info({ ok: r.ok, skipped: r.skipped, failed: r.failed }, 'hosts startup sweep done');
  } catch (e) {
    log.warn({ err: String(e) }, 'hosts startup sweep failed');
  }
}
