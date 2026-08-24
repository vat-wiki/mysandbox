// 全局 hosts 的「应用」共享逻辑 + docker events 自动重刷。
// routes 的 apply 路由、保存即生效、事件监听三方共用 applyHostsToContainers；
// 事件路径让全局 hosts 变「真全局」——容器重启后 mysandbox 自动追平被 Docker
// 还原的 /etc/hosts（Docker 管创建、我们管维持，只写声明的内容）。
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { getDocker, listManaged, inspectContainer, MANAGED_LABEL, type ExecOpts } from './docker.js';
import { runBatch, type BatchResult } from './batch.js';
import { getCustomHostsContent, readHostHosts } from './hosts.js';
import { getAllMeta, setMeta } from './state.js';
import { log } from './logger.js';

export interface ResolveHostsResult {
  content: string;
  // hosts.txt 存在即用户表达过意图（保存但空串也是意图，不落回宿主内容）
  isCustom: boolean;
}

// 解析要应用的内容：显式 > 已保存自定义（hosts.txt）> 宿主 /etc/hosts。
export async function resolveHostsContent(explicit?: string): Promise<ResolveHostsResult> {
  if (typeof explicit === 'string') {
    return { content: explicit, isCustom: (await getCustomHostsContent()) != null };
  }
  const custom = await getCustomHostsContent();
  if (custom != null) return { content: custom, isCustom: true };
  return { content: await readHostHosts(), isCustom: false };
}

export interface ApplyHostsOpts {
  content?: string; // 缺省走 resolveHostsContent()
  ids?: string[]; // 缺省 = 全部运行中受管理容器
  // 容器级 hostsHash 命中即跳过（事件/启动补刷路径用；手动路径强制刷）
  skipUnchanged?: boolean;
  reason?: string; // 日志 op 后缀：'manual' | 'save' | 'event' | 'startup'
}
export type ApplyHostsResult = BatchResult & { skipped: number };

const EMPTY_RESULT: ApplyHostsResult = { total: 0, ok: 0, failed: 0, skipped: 0, items: [] };

// 批量把内容覆写进容器 /etc/hosts（root exec）。空内容防御式返回——绝不把容器 hosts 清空。
export async function applyHostsToContainers(
  cfg: Config,
  opts: ApplyHostsOpts = {},
): Promise<ApplyHostsResult> {
  const { content } = await resolveHostsContent(opts.content);
  if (!content) return { ...EMPTY_RESULT };

  // 目标容器：显式 ids 原样用；缺省枚举全部运行中受管理容器。
  // 跳过判定需要 name（hash 按容器名存 meta）：枚举路径 listManaged 自带 name；
  // 显式 ids 路径逐个解析（单容器事件场景只有 1 个 id，listManaged 一次拿全量对照）。
  let ids = opts.ids;
  const hash = opts.skipUnchanged ? hostsHash(content) : null;
  let targets: { id: string; name: string }[] = [];
  let skipped = 0;
  if (hash) {
    const views = await listManaged(cfg);
    const byId = new Map(views.map((v) => [v.id, v]));
    const meta = await getAllMeta();
    const pool = ids && ids.length ? ids.map((id) => byId.get(id)).filter(Boolean) as typeof views : views.filter((v) => v.state === 'running');
    targets = pool.filter((v) => meta[v.name]?.hostsHash !== hash).map((v) => ({ id: v.id, name: v.name }));
    skipped = pool.length - targets.length;
    if (targets.length === 0) {
      log.debug({ skipped, reason: opts.reason }, 'hosts apply: all targets up to date');
      return { ...EMPTY_RESULT, total: pool.length, skipped };
    }
  } else {
    if (!ids || ids.length === 0) {
      const views = await listManaged(cfg);
      ids = views.filter((v) => v.state === 'running').map((v) => v.id);
      if (ids.length === 0) return { ...EMPTY_RESULT };
    }
    targets = ids.map((id) => ({ id, name: '' })); // name 由 runOne 在结果里解析
  }
  return { ...(await execAndRecordHash(cfg, targets, content, opts.reason ?? 'manual')), skipped };
}

// base64 token 仅 [A-Za-z0-9+/=]，单引号包裹绝对安全；printf %s 不解释反斜杠。
// root:root —— 容器以 dev(1000) 跑、/etc/hosts 归 root。
// hash 在 exec 成功后才回写：写早了 exec 失败但 hash 已记会导致永不重试；
// 写晚了崩溃窗口内丢 hash，下次触发重刷一次，覆写幂等，自愈。
async function execAndRecordHash(
  cfg: Config,
  targets: { id: string; name: string }[],
  content: string,
  reason: string,
): Promise<ApplyHostsResult> {
  const hash = hostsHash(content);
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  const build = (): ExecOpts => ({
    Cmd: ['sh', '-c', `printf %s '${b64}' | base64 -d > /etc/hosts`],
    User: 'root:root',
    Tty: false,
    timeoutMs: 15_000,
  });
  const result = await runBatch(cfg, targets.map((t) => t.id), build, `hosts-apply:${reason}`);
  for (const it of result.items) {
    if (it.ok && it.name) await setMeta(it.name, { hostsHash: hash });
  }
  return { ...result, skipped: 0 };
}

function hostsHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// —— docker events 自动重刷 ——

// 模块级串行队列：事件稀疏但 restart 风暴时防并发 exec；失败吞掉不连锁。
let chain: Promise<void> = Promise.resolve();
function enqueue(fn: () => Promise<void>): void {
  chain = chain.then(fn).catch((e) => {
    log.warn({ err: String(e) }, 'hosts event sync: task failed');
  });
}

interface DockerEvent {
  Type?: string;
  Action?: string;
  // 容器 id 在 Actor.ID（顶层无 id 字段，实测 docker 29 事件结构）
  Actor?: { ID?: string; Attributes?: Record<string, string> };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 订阅 docker events（container start/restart），断线指数退避重连。
// 永不抛、永不崩进程：流 error 吞掉（terminal.ts/docker.ts 同款先例），重连即自愈。
export function startHostsEventSync(cfg: Config): void {
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const stream = await getDocker(cfg).getEvents({
          filters: { type: ['container'], event: ['start', 'restart'] },
        });
        delay = 1_000; // 连上即复位
        log.info('hosts event sync: subscribed');
        // 重连后全量补刷一次，补断线窗口内错过的事件（hash 跳过，近零成本）
        enqueue(() => sweepHosts(cfg));
        await consumeStream(cfg, stream); // 正常返回 = 流断 -> 退避重连
      } catch (e) {
        log.warn({ err: String(e), retryMs: delay }, 'hosts event sync: subscribe failed, retrying');
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}

// 消费事件流：\n 分帧（剥 \r），坏行丢弃保留 remainder；error 吞掉（end/close/error 都 resolve）。
function consumeStream(cfg: Config, stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise<void>((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    stream.on('error', (e) => {
      log.warn({ err: String(e) }, 'hosts event sync: stream error');
      finish();
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('data', (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev: DockerEvent;
        try {
          ev = JSON.parse(line) as DockerEvent;
        } catch {
          continue; // 坏行丢弃
        }
        const id = ev.Actor?.ID;
        if (ev.Type === 'container' && (ev.Action === 'start' || ev.Action === 'restart') && id) {
          enqueue(() => handleEvent(cfg, ev, id));
        }
      }
    });
  });
}

async function handleEvent(cfg: Config, ev: DockerEvent, id: string): Promise<void> {
  // 受管理判定：label 命中零调用（events 的 Actor.Attributes 内联全部容器 labels）；
  // 未命中 inspect 一次查网络（Attributes 不含 network 信息）。异常一律当不受管理，
  // 容器删除瞬间的 start 竞态等不该炸事件循环。
  if (ev.Actor?.Attributes?.[MANAGED_LABEL] !== 'mysandbox') {
    try {
      const info = await inspectContainer(cfg, id);
      const networks = Object.keys(info.NetworkSettings?.Networks || {});
      if (!networks.includes(cfg.network)) return;
    } catch {
      return;
    }
  }
  // start/restart 后 Docker 已把 /etc/hosts 还原成镜像+ExtraHosts 的初始态——即使
  // 内容与 meta hash 相同也必须重写。事件路径不跳过（skipUnchanged 只用于启动补刷
  // 的断线窗口去重）。
  await applyHostsToContainers(cfg, { ids: [id], reason: 'event' });
}

// 启动补刷（类比 sweepContainerCli）：服务重启期间容器可能被外部 restart（错过事件窗口）。
// 门控：仅 hosts.txt 存在（isCustom）才自动刷——用户从未保存过时回退内容是宿主
// /etc/hosts，自动应用等于「容器一启动就被静默改写」，超出用户表达过的意图。
// 手动「应用」按钮不受此门控（显式动作）。
export async function sweepHosts(cfg: Config): Promise<void> {
  try {
    const { content, isCustom } = await resolveHostsContent();
    if (!isCustom || !content) return;
    const r = await applyHostsToContainers(cfg, { content, skipUnchanged: true, reason: 'startup' });
    log.info({ ok: r.ok, skipped: r.skipped, failed: r.failed }, 'hosts startup sweep done');
  } catch (e) {
    log.warn({ err: String(e) }, 'hosts startup sweep failed');
  }
}
