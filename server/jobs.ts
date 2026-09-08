// docker 服务创建的后台任务注册表（内存态）。
//
// 形态：POST /api/services 快校验通过后 startServiceJob() 立即返回 jobId，
// 拉镜像/建容器在进程内后台跑，进度进环形日志缓冲，前端轮询 GET /api/services/jobs。
// 刻意不持久化：进程重启任务即丢——镜像层在 daemon 缓存里、容器有 label 可见，
// 丢的只是「进度叙事」，重试近乎免费；进程内名称/IP 预占也随之消失，天然不泄漏。
//
// 依赖方向：本模块不 import services.ts（仅 import type）——docker 编排在 services.ts
// 里以 run thunk 传入，避免循环依赖。名称/IP 预占集合在这里，services.ts 的
// servicePoolView 反向取用（单一方向：services.ts -> jobs.ts）。
import { randomUUID } from 'node:crypto';
import { conflict, notFound } from './errors.js';
import { log } from './logger.js';
import type { ServiceView } from './services.js';

export type JobState = 'running' | 'done' | 'error' | 'canceled';
export type JobKind = 'create' | 'update';

// 任务对 run thunk 暴露的全部控制面。log/status 追加进环形缓冲（status 同时更新
// statusText——列表未展开时前端只显示这一行）；setCancellable 标记当前阶段可否取消
// （只有 pull 阶段 true：docker create/start 是 execFile 杀不掉）；signal 在取消时触发，
// pullImageStream 监听它 SIGKILL 子进程。
export interface JobCtx {
  log(line: string): void;
  status(text: string): void;
  setCancellable(v: boolean): void;
  signal: AbortSignal;
}

// run thunk 的输入（services.ts prepareServiceCreate 的产物形状，只搬需要的字段——
// 绝不把 env 放进任务记录/视图，密码从源头就不到这层）。
export interface ServicePlan {
  name: string;
  image: string;
  ip: string;
  kind?: JobKind; // 缺省 'create'
}

// API 视图：logTail 仅列表请求带（tail 参数可控，侧栏轮询用 tail=0 拿极小 payload），
// 全量日志走 GET /jobs/:id 按需拉。
export interface ServiceJobView {
  id: string;
  kind: JobKind; // create = 新建服务；update = 更新（拉新镜像重建容器）——前端横幅/toast 文案据此区分
  name: string;
  image: string;
  ip: string;
  state: JobState;
  statusText: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  cancellable: boolean;
  logTail?: string[];
  result?: ServiceView;
}

interface JobRec {
  view: ServiceJobView;
  lines: string[];
  controller: AbortController;
  cancelRequested: boolean;
}

const LOG_CAP = 400; // 环形日志行数上限（层进度 2s 聚合一行，400 行足够覆盖半小时级拉取）
const KEEP_FINISHED = 20; // 终态任务保留个数（超出的最旧删除）

const jobs = new Map<string, JobRec>();
const reservedNames = new Set<string>();
const reservedIps = new Set<string>();

// —— 名称/IP 预占 ——
// serviceNameExists 只查 docker 里已存在的容器，进行中任务还没建容器、查不到——
// 两个同名任务会双双通过查重、后一个死在 docker create。预占必须覆盖名称与 IP 两条。
// Node 单线程：路由里「同步预占名 → await 校验 → 同步预占 IP」的顺序里，同步段无竞态。

export function reservedServiceIps(): ReadonlySet<string> {
  return reservedIps;
}

export function tryReserveJobName(name: string): boolean {
  if (reservedNames.has(name)) return false;
  reservedNames.add(name);
  return true;
}

export function releaseJobName(name: string): void {
  reservedNames.delete(name);
}

export function reserveJobIp(ip: string): void {
  reservedIps.add(ip);
}

export function releaseJobIp(ip: string): void {
  reservedIps.delete(ip);
}

function appendLine(job: JobRec, line: string): void {
  job.lines.push(line);
  if (job.lines.length > LOG_CAP) job.lines.splice(0, job.lines.length - LOG_CAP);
}

// 建记录并立刻后台执行。run 的异常在这里全收口（写 error / canceled），绝不 unhandled
// rejection；finally 统一释放名称+IP 预占（与路由 catch 里的释放互补——那是「没跑起来」的路径）。
export function startServiceJob(
  plan: ServicePlan,
  run: (ctx: JobCtx) => Promise<ServiceView>,
): { id: string } {
  const rec: JobRec = {
    view: {
      id: randomUUID(),
      kind: plan.kind ?? 'create',
      name: plan.name,
      image: plan.image,
      ip: plan.ip,
      state: 'running',
      statusText: '排队执行',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cancellable: false,
    },
    lines: [],
    controller: new AbortController(),
    cancelRequested: false,
  };
  jobs.set(rec.view.id, rec);
  const ctx: JobCtx = {
    log: (line) => {
      appendLine(rec, line);
      rec.view.updatedAt = Date.now();
    },
    status: (text) => {
      appendLine(rec, `[进行] ${text}`);
      rec.view.statusText = text;
      rec.view.updatedAt = Date.now();
    },
    setCancellable: (v) => {
      rec.view.cancellable = v;
      rec.view.updatedAt = Date.now();
    },
    signal: rec.controller.signal,
  };
  void (async () => {
    try {
      rec.view.result = await run(ctx);
      rec.view.state = 'done';
      rec.view.updatedAt = Date.now();
    } catch (e) {
      // 取消路径的 reject 带 aborted 标记（pullImageStream 的约定），归为 canceled 而非 error。
      const canceled = rec.controller.signal.aborted || (e as { canceled?: boolean })?.canceled === true;
      rec.view.state = canceled ? 'canceled' : 'error';
      rec.view.error = e instanceof Error ? e.message : String(e);
      rec.view.updatedAt = Date.now();
      if (rec.view.state === 'error') {
        log.warn({ name: plan.name, err: rec.view.error }, 'service job failed');
      }
    } finally {
      releaseJobName(plan.name);
      releaseJobIp(plan.ip);
      rec.view.cancellable = false;
      pruneFinished();
    }
  })();
  return { id: rec.view.id };
}

// 超出 KEEP_FINISHED 的终态任务删最旧的（running 永不删）。
function pruneFinished(): void {
  const finished = [...jobs.values()].filter((j) => j.view.state !== 'running');
  if (finished.length <= KEEP_FINISHED) return;
  finished
    .sort((a, b) => a.view.updatedAt - b.view.updatedAt)
    .slice(0, finished.length - KEEP_FINISHED)
    .forEach((j) => jobs.delete(j.view.id));
}

function toView(rec: JobRec, tail: number): ServiceJobView {
  const v = { ...rec.view };
  if (tail > 0) v.logTail = rec.lines.slice(-tail);
  return v;
}

// running 在前（新→旧），终态按 updatedAt 倒序——面板任务区的自然阅读顺序。
export function listServiceJobs(tail: number): ServiceJobView[] {
  const list = [...jobs.values()];
  const running = list.filter((j) => j.view.state === 'running').sort((a, b) => b.view.createdAt - a.view.createdAt);
  const finished = list
    .filter((j) => j.view.state !== 'running')
    .sort((a, b) => b.view.updatedAt - a.view.updatedAt);
  return [...running, ...finished].map((j) => toView(j, tail));
}

export function getServiceJob(id: string): { job: ServiceJobView; log: string[] } | null {
  const rec = jobs.get(id);
  if (!rec) return null;
  return { job: toView(rec, 0), log: [...rec.lines] };
}

// 仅 pull 阶段（cancellable=true）可取消；之后的 docker create/start 是 execFile
// 杀不掉，「点了取消但任务照样建出来」比不能取消更糟——直接 409 说清当前阶段。
export function cancelServiceJob(id: string): void {
  const rec = jobs.get(id);
  if (!rec) throw notFound(`job "${id}" not found`);
  if (rec.view.state !== 'running') throw conflict('任务已结束，无需取消');
  if (!rec.view.cancellable) throw conflict('已过拉取阶段，无法取消（容器创建/启动数秒内完成）');
  rec.cancelRequested = true;
  rec.view.statusText = '正在取消…';
  rec.controller.abort();
}
