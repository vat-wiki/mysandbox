// Skills 同步：把「源目录」（容器内项目的 skills 或宿主路径）镜像进全部受管容器的
// 目标目录。与 aiconfig.ts 同一惯用法——宿主直读直写 rootfs（D1 uid 直通：容器内
// dev(1000) = 宿主当前用户，写出的文件属主天然正确），容器不必在跑，下次启动即生效。
//
// 配置形状（config.skills.sync）：[{ from, to }]
// - from：'<容器名>:<容器内路径>'（home 契约 /home/dev，~/ 与绝对路径都认）或宿主路径
//   （~/ 展开）。容器名与路径以第一个 : 分隔（前缀匹配 LXC 名字符集即按容器解析）。
// - to：容器内目标（相对 dev home，~/ 前缀可选，不能为空——目标是 home 根没有意义）。
//
// 每条规则两步：
//   源 → STATE_DIR/skills/<ruleId>/（宿主权威副本，精确镜像含删除；源容器删了/不在了
//   副本仍在，分发比对基准稳定）
//   权威副本 → 每个 sidecar 已知容器的 to：顶层条目逐一克隆；「上次分发过而源里已
//   消失」的顶层条目删除（按清单 <ruleId>.json 记账，用户自装的其他 skills 不动）。
// 文件级 size+内容比对、变才写（与 seedContainerCli 的自更新语义一致，不去无谓惊动
// 容器里正被会话读着的文件）。
//
// 触发点（全自动）：服务启动 sweep（cli.ts）+ 源目录 fs.watch（宿主 inotify——源在
// 容器 rootfs 里照样是宿主文件，跑着的容器立即生效）+ create() 建容器后补发
// （lifecycle.ts）。手动：mysandbox skills sync / POST /api/skills/sync。
// 同步全程互斥（模块级 promise 链），watch 抖动经 debounce 收敛。
import { existsSync, watch as fsWatch } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { STATE_DIR, expandTilde } from './config.js';
import { getEngine } from './engine/index.js';
import { getAllMeta } from './state.js';
import { log } from './logger.js';

const SKILLS_DIR = join(STATE_DIR, 'skills');
// 源变化 → 实际同步的 debounce（编辑器保存往往连发多个事件）。
const WATCH_DEBOUNCE_MS = 500;

export interface SkillSyncRule {
  from: string;
  to: string;
}

export interface SkillSyncContainerResult {
  name: string;
  ok: boolean;
  changed: number; // 写入/更新的文件数
  removed: number; // 删除的陈旧条目数（顶层计 1，内部文件并入 changed 口径不计）
  error?: string;
}

export interface SkillSyncRuleResult {
  from: string;
  to: string;
  source: string; // 解析出的宿主路径（人话/排障用）
  ok: boolean;
  changed: number; // 权威副本这步的变更文件数
  removed: number;
  error?: string;
  containers: SkillSyncContainerResult[];
}

export interface SkillSyncResult {
  ok: boolean;
  rules: SkillSyncRuleResult[];
  durationMs: number;
}

// 互斥链：sweep / watch / 手动触发可能并发，串行执行免得镜像-分发交错。
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

// —— 源/目标路径解析 ——

// 容器内路径 → home 内相对：'~/x' / '~' / '/home/dev/x'（home 契约固定 /home/dev）。
function containerRel(p: string): string {
  if (p === '~') return '';
  if (p.startsWith('~/')) return p.slice(2);
  if (p === '/home/dev') return '';
  if (p.startsWith('/home/dev/')) return p.slice('/home/dev/'.length);
  throw new Error(`容器内路径只认 ~/ 与 /home/dev 前缀（契约 home=/home/dev）："${p}"`);
}

// from → 宿主路径。'<容器名>:<路径>' 前缀匹配 LXC 名字符集即按容器解析
// （容器名不会含 :，宿主路径必须 / 或 ~ 开头，两者天然无歧义）。
export function resolveSyncSource(cfg: Config, from: string): { hostPath: string; container?: string } {
  const idx = from.indexOf(':');
  if (idx > 0) {
    const name = from.slice(0, idx);
    if (/^[a-z0-9][a-z0-9_.-]*$/.test(name)) {
      const home = getEngine(cfg).hostHomePath(cfg, name);
      if (!home) throw new Error(`容器 ${name} 的 home 不可定位`);
      return { hostPath: join(home, containerRel(from.slice(idx + 1))), container: name };
    }
  }
  if (!/^[~/]/.test(from)) {
    throw new Error(`from "${from}" 不识别：应为 <容器名>:<容器内路径> 或宿主路径（/ 或 ~/ 开头）`);
  }
  return { hostPath: expandTilde(from) };
}

// —— 文件树同步（镜像语义：多删少补、变才写） ——

async function sameFile(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)]);
  if (sa.size !== sb.size) return false;
  const [ca, cb] = await Promise.all([readFile(a), readFile(b)]);
  return ca.equals(cb);
}

// 让 dst 与 src 完全一致。符号链接跳过（skills 目录里罕见，跟随复制有循环风险）。
// 返回 [写入, 删除] 文件计数。
async function syncTree(src: string, dst: string): Promise<[number, number]> {
  let written = 0;
  let removed = 0;
  const entries = await readdir(src, { withFileTypes: true });
  await mkdir(dst, { recursive: true });
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.isSymbolicLink()) {
      log.warn({ src: join(src, e.name) }, 'skills sync: symlink skipped');
      continue;
    }
    seen.add(e.name);
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) {
      const [w, r] = await syncTree(s, d);
      written += w;
      removed += r;
    } else if (e.isFile()) {
      let same = false;
      try {
        same = await sameFile(s, d);
      } catch {
        /* dst 读不了 = 不一样 */
      }
      if (!same) {
        await copyFile(s, d);
        written++;
      }
    }
  }
  for (const e of await readdir(dst, { withFileTypes: true })) {
    if (!seen.has(e.name)) {
      await rm(join(dst, e.name), { recursive: true, force: true });
      removed++;
    }
  }
  return [written, removed];
}

// —— 规则与权威副本 ——

// 规则 id：from+to 的 sha1 前 12 位——配置里无关字段的改动不影响副本目录；
// from/to 变了自然换新 id（旧副本由 pruneStaleMirrors 清掉）。
function ruleId(rule: SkillSyncRule): string {
  return createHash('sha1').update(`${rule.from}=>${rule.to}`).digest('hex').slice(0, 12);
}

interface RuleManifest {
  from: string;
  to: string;
  distributed: string[]; // 上次分发到容器的顶层条目名（陈旧删除的记账依据）
}

async function readManifest(id: string): Promise<RuleManifest | null> {
  try {
    return JSON.parse(await readFile(join(SKILLS_DIR, `${id}.json`), 'utf8')) as RuleManifest;
  } catch {
    return null; // 首跑/坏文件：当没分发过，绝不在目标里乱删
  }
}

// 配置里已消失的规则的副本目录/清单清掉（幂等）。
async function pruneStaleMirrors(aliveIds: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return; // 目录还没有 = 无可清
  }
  for (const e of entries) {
    const id = e.endsWith('.json') ? e.slice(0, -'.json'.length) : e;
    if (aliveIds.has(id)) continue;
    await rm(join(SKILLS_DIR, e), { recursive: true, force: true });
  }
}

// —— 分发 ——

// 分发目标：容器内绝对宿主路径（sidecar 已知、home 可见的容器 = 与 sweepContainerCli 同口径）。
async function distributeTargets(cfg: Config): Promise<{ name: string; home: string }[]> {
  const engine = getEngine(cfg);
  const names = Object.keys(await getAllMeta());
  const out: { name: string; home: string }[] = [];
  for (const name of names) {
    const home = engine.hostHomePath(cfg, name);
    if (home && existsSync(home)) out.push({ name, home });
  }
  return out;
}

// 单规则：镜像源 → 逐容器分发 → 清单记账。任何一步失败收敛进结果，不中断其他容器。
async function syncRule(cfg: Config, rule: SkillSyncRule): Promise<SkillSyncRuleResult> {
  const id = ruleId(rule);
  const base: SkillSyncRuleResult = { from: rule.from, to: rule.to, source: '', ok: false, changed: 0, removed: 0, containers: [] };
  try {
    const rel = containerRel(rule.to);
    if (!rel) throw new Error('to 不能指向 home 根');
    const { hostPath } = resolveSyncSource(cfg, rule.from);
    base.source = hostPath;
    if (!existsSync(hostPath)) throw new Error(`源不存在：${hostPath}`);

    const mirror = join(SKILLS_DIR, id);
    const [changed, removed] = await syncTree(hostPath, mirror);
    base.changed = changed;
    base.removed = removed;

    const names = (await readdir(mirror, { withFileTypes: true })).map((e) => e.name);
    const manifest = (await readManifest(id)) ?? { from: rule.from, to: rule.to, distributed: [] };

    for (const { name, home } of await distributeTargets(cfg)) {
      const c: SkillSyncContainerResult = { name, ok: true, changed: 0, removed: 0 };
      base.containers.push(c);
      try {
        const target = join(home, rel);
        for (const n of names) {
          const [w] = await syncTree(join(mirror, n), join(target, n));
          c.changed += w;
        }
        // 上次分发过、这次源里没有的顶层条目 → 删（镜像语义；用户自装的不在清单里，不动）。
        for (const n of manifest.distributed) {
          if (names.includes(n)) continue;
          await rm(join(target, n), { recursive: true, force: true });
          c.removed++;
        }
      } catch (e) {
        c.ok = false;
        c.error = e instanceof Error ? e.message : String(e);
        log.warn({ container: name, rule: rule.from, err: c.error }, 'skills distribute failed');
      }
    }

    manifest.distributed = names;
    await mkdir(SKILLS_DIR, { recursive: true });
    await writeFile(join(SKILLS_DIR, `${id}.json`), JSON.stringify(manifest, null, 2));

    base.ok = true;
    log.info(
      { from: rule.from, to: rule.to, changed, removed, containers: base.containers.length },
      'skills rule synced',
    );
  } catch (e) {
    base.error = e instanceof Error ? e.message : String(e);
    log.warn({ from: rule.from, to: rule.to, err: base.error }, 'skills rule sync failed');
  }
  return base;
}

// 全量同步：全部规则镜像 + 分发 + 清理失效副本。手动/API/启动 sweep 共用。
export async function syncSkillsAll(cfg: Config): Promise<SkillSyncResult> {
  const started = Date.now();
  const rules = cfg.skills?.sync ?? [];
  const result = await exclusive(async () => {
    const out: SkillSyncRuleResult[] = [];
    for (const rule of rules) out.push(await syncRule(cfg, rule));
    await pruneStaleMirrors(new Set(rules.map(ruleId)));
    return out;
  });
  return { ok: result.every((r) => r.ok), rules: result, durationMs: Date.now() - started };
}

// 单容器补发（create() 后调用）：镜像照跑（副本保鲜），只分发到这一个容器。尽力而为不抛。
export async function syncContainerSkills(cfg: Config, name: string): Promise<void> {
  const rules = cfg.skills?.sync ?? [];
  if (!rules.length) return;
  await exclusive(async () => {
    for (const rule of rules) {
      try {
        const rel = containerRel(rule.to);
        if (!rel) continue;
        const { hostPath } = resolveSyncSource(cfg, rule.from);
        if (!existsSync(hostPath)) continue;
        const id = ruleId(rule);
        const mirror = join(SKILLS_DIR, id);
        await syncTree(hostPath, mirror);
        const home = getEngine(cfg).hostHomePath(cfg, name);
        if (!home || !existsSync(home)) continue;
        const names = (await readdir(mirror, { withFileTypes: true })).map((e) => e.name);
        const target = join(home, rel);
        for (const n of names) await syncTree(join(mirror, n), join(target, n));
        const manifest = (await readManifest(id)) ?? { from: rule.from, to: rule.to, distributed: [] };
        for (const n of manifest.distributed) {
          if (names.includes(n)) continue;
          await rm(join(target, n), { recursive: true, force: true });
        }
        log.info({ container: name, from: rule.from }, 'skills distributed to new container');
      } catch (e) {
        log.warn({ container: name, from: rule.from, err: String(e) }, 'skills distribute to container failed');
      }
    }
  });
}

// —— watch（实时分发的自动触发器） ——

// 对每条规则的源目录挂 fs.watch（递归；源在容器 rootfs 里就是宿主文件，容器不必在跑）。
// 返回 disposer（进程内常驻，暂无卸载场景，留对称）。
export function startSkillSyncWatch(cfg: Config): () => void {
  const disposers: (() => void)[] = [];
  for (const rule of cfg.skills?.sync ?? []) {
    let source: string;
    try {
      source = resolveSyncSource(cfg, rule.from).hostPath;
    } catch (e) {
      log.warn({ from: rule.from, err: String(e) }, 'skills watch: source resolve failed');
      continue;
    }
    if (!existsSync(source)) {
      log.warn({ from: rule.from, source }, 'skills watch: source missing, watch not set');
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const w = fsWatch(source, { recursive: true }, () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          void syncSkillsAll(cfg).catch((e) => log.warn({ err: String(e) }, 'skills watch sync failed'));
        }, WATCH_DEBOUNCE_MS);
      });
      w.on('error', (e) => log.warn({ from: rule.from, err: String(e) }, 'skills watch error'));
      disposers.push(() => w.close());
    } catch (e) {
      log.warn({ from: rule.from, err: String(e) }, 'skills watch setup failed');
    }
  }
  if (disposers.length) log.info({ watchers: disposers.length }, 'skills sync watchers active');
  return () => disposers.forEach((d) => d());
}

// —— CLI：mysandbox skills sync ——

export async function runSkillsCommand(cfg: Config): Promise<void> {
  const rules = cfg.skills?.sync ?? [];
  if (!rules.length) {
    process.stdout.write('>> config 里没有 skills.sync 规则（~/.config/mysandbox/config.yaml）\n');
    process.stdout.write('>> 示例:\n>>   skills:\n>>     sync:\n>>       - from: mytest:~/testlens/.claude/skills\n>>         to: ~/.claude/skills\n');
    return;
  }
  const r = await syncSkillsAll(cfg);
  for (const rule of r.rules) {
    process.stdout.write(`>> ${rule.from} → ${rule.to}  ${rule.ok ? '' : `失败 — ${rule.error}`}\n`);
    for (const c of rule.containers) {
      process.stdout.write(
        `>>   ${c.name}: ${c.ok ? `+${c.changed} 文件${c.removed ? ` -${c.removed} 陈旧` : ''}` : `失败 — ${c.error}`}\n`,
      );
    }
  }
  process.stdout.write(`>> skills 同步完成（${r.durationMs}ms）\n`);
  if (!r.ok) process.exit(1);
}
