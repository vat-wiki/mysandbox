// Skills 同步：两条通路把 skills 分发进全部受管容器（宿主直读直写 rootfs——D1 uid
// 直通：容器内 dev(1000) = 宿主当前用户，写出的文件属主天然正确；容器不必在跑）。
//
// ① 静态规则（config.skills.sync = [{from,to}]）：精确映射，适合项目级/非标准目标。
//    from：'<容器名>:<容器内路径>'（home 契约 /home/dev，~/ 与绝对路径都认）或宿主
//    路径（~/ 展开）；to：容器内目标。走 UI 管不到的 config.yaml，改动需重启服务。
// ② 技能中心（hub，sidecar state.json 的 skillsHub）：多源聚合池 + 单一分发目标。
//    源在 UI 里增删/启停/排序（数组顺序 = 重名时的优先级，先到先得，冲突在面板可见）；
//    聚合 = 各源顶层条目按名进 STATE_DIR/skills/hub/，源移除/禁用后其条目自动退出
//    中心；分发 = 中心 → 各容器 to（默认 ~/.claude/skills）。
//
// 每条通路两步（同构）：
//   源 → 宿主权威副本（规则 = skills/<ruleId>/，中心 = skills/hub/；源删了副本仍在）
//   权威副本 → 每个 sidecar 已知容器的目标：顶层条目逐一克隆；「上次分发过而已消失」
//   的顶层条目删除（按清单 <id>.json 记账，用户自装的其他 skills 不动）。
// 文件级 size+内容比对、变才写（与 seedContainerCli 的自更新语义一致）。
//
// 触发点（全自动）：服务启动 sweep（cli.ts）+ 源目录 fs.watch（宿主 inotify——源在
// 容器 rootfs 里照样是宿主文件，跑着的容器立即生效；watch 按源动态注册，中心源在
// UI 增删时同步挂/摘）+ create() 建容器后补发（lifecycle.ts）。手动：mysandbox
// skills sync / POST /api/skills/sync / 面板按钮。同步全程互斥（模块级 promise 链）。
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { STATE_DIR, expandTilde } from './config.js';
import { getEngine } from './engine/index.js';
import { getAllMeta, getSkillHub, setSkillHub, type SkillHubSource } from './state.js';
import { log } from './logger.js';

const SKILLS_DIR = join(STATE_DIR, 'skills');
const HUB_DIR = join(SKILLS_DIR, 'hub');
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
  removed: number; // 删除的陈旧条目数（顶层计 1，内部文件不计）
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

// 技能中心（hub）的同步结果：sources 各自的取数情况 + 聚合后的条目归属。
export interface SkillHubSourceView {
  id: string;
  from: string;
  enabled: boolean;
  ok: boolean;
  skills: string[]; // 该源当前顶层条目（disabled 的也列出，仅信息展示）
  error?: string;
}
export interface SkillHubResult {
  ok: boolean;
  to: string;
  sources: SkillHubSourceView[];
  skills: { name: string; sourceId: string; conflicts: string[] }[];
  changed: number;
  removed: number;
  containers: SkillSyncContainerResult[];
  error?: string;
}

export interface SkillSyncResult {
  ok: boolean;
  rules: SkillSyncRuleResult[];
  hub?: SkillHubResult;
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

async function topLevelNames(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true })).map((e) => e.name);
}

// —— 分发 ——

// 把 dir（规则的权威副本 / 中心的聚合副本）分发到容器的 to：顶层条目逐一克隆；
// 上次分发过而 dir 里已消失的顶层条目删除（按清单 manifestId 记账——用户自装的
// 其他 skills 不在清单里，永不动）。only 限单容器（create() 补发用）。
async function distributeDir(
  cfg: Config,
  dir: string,
  to: string,
  manifestId: string,
  only?: { name: string; home: string }[],
): Promise<SkillSyncContainerResult[]> {
  const rel = containerRel(to);
  if (!rel) throw new Error('to 不能指向 home 根');
  const names = await topLevelNames(dir);
  const prev = await readManifest(manifestId);
  const targets = only ?? (await distributeTargets(cfg));
  const results: SkillSyncContainerResult[] = [];
  for (const { name, home } of targets) {
    const c: SkillSyncContainerResult = { name, ok: true, changed: 0, removed: 0 };
    results.push(c);
    try {
      const target = join(home, rel);
      for (const n of names) {
        const [w] = await syncTree(join(dir, n), join(target, n));
        c.changed += w;
      }
      for (const n of prev?.distributed ?? []) {
        if (names.includes(n)) continue;
        await rm(join(target, n), { recursive: true, force: true });
        c.removed++;
      }
    } catch (e) {
      c.ok = false;
      c.error = e instanceof Error ? e.message : String(e);
      log.warn({ container: name, manifestId, err: c.error }, 'skills distribute failed');
    }
  }
  await mkdir(SKILLS_DIR, { recursive: true });
  await writeFile(join(SKILLS_DIR, `${manifestId}.json`), JSON.stringify({ distributed: names }, null, 2));
  return results;
}

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

// —— 清单（陈旧删除的记账） ——

interface RuleManifest {
  distributed: string[]; // 上次分发到容器的顶层条目名
}

async function readManifest(id: string): Promise<RuleManifest | null> {
  try {
    return JSON.parse(await readFile(join(SKILLS_DIR, `${id}.json`), 'utf8')) as RuleManifest;
  } catch {
    return null; // 首跑/坏文件：当没分发过，绝不在目标里乱删
  }
}

// 配置里已消失的规则的副本目录/清单清掉（幂等；hub 目录 hub/hub.json 不在此列）。
async function pruneStaleMirrors(aliveIds: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return; // 目录还没有 = 无可清
  }
  for (const e of entries) {
    if (e === 'hub' || e === 'hub.json') continue;
    const id = e.endsWith('.json') ? e.slice(0, -'.json'.length) : e;
    if (aliveIds.has(id)) continue;
    await rm(join(SKILLS_DIR, e), { recursive: true, force: true });
  }
}

// —— 静态规则通路 ——

// 规则 id：from+to 的 sha1 前 12 位——配置里无关字段的改动不影响副本目录；
// from/to 变了自然换新 id（旧副本由 pruneStaleMirrors 清掉）。
function ruleId(rule: SkillSyncRule): string {
  return createHash('sha1').update(`${rule.from}=>${rule.to}`).digest('hex').slice(0, 12);
}

// 单规则：镜像源 → 权威副本 → 逐容器分发。失败收敛进结果，不中断其他容器/规则。
async function syncRule(cfg: Config, rule: SkillSyncRule): Promise<SkillSyncRuleResult> {
  const id = ruleId(rule);
  const base: SkillSyncRuleResult = { from: rule.from, to: rule.to, source: '', ok: false, changed: 0, removed: 0, containers: [] };
  try {
    const { hostPath } = resolveSyncSource(cfg, rule.from);
    base.source = hostPath;
    if (!existsSync(hostPath)) throw new Error(`源不存在：${hostPath}`);

    const mirror = join(SKILLS_DIR, id);
    const [changed, removed] = await syncTree(hostPath, mirror);
    base.changed = changed;
    base.removed = removed;
    base.containers = await distributeDir(cfg, mirror, rule.to, id);
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

// —— 技能中心（hub）通路 ——

// 聚合：按源顺序把各源顶层条目镜像进 hub 目录（重名先到先得），源已不提供的条目
// 从 hub 删除。返回聚合结果（含每源视图与条目归属），不分发。
async function aggregateHub(cfg: Config, hub: { to: string; sources: SkillHubSource[] }): Promise<SkillHubResult> {
  const out: SkillHubResult = { ok: false, to: hub.to, sources: [], skills: [], changed: 0, removed: 0, containers: [] };
  try {
    const rel = containerRel(hub.to);
    if (!rel) throw new Error('中心目标 to 不能指向 home 根');
    await mkdir(HUB_DIR, { recursive: true });

    // pass 1：逐源解析 + 列条目（disabled 的也展示，但不参与聚合/冲突）。
    const enabledNames = new Map<string, string[]>(); // sourceId → 条目名
    const resolved = new Map<string, string>(); // sourceId → 宿主源路径
    for (const src of hub.sources) {
      const v: SkillHubSourceView = { id: src.id, from: src.from, enabled: src.enabled, ok: true, skills: [] };
      out.sources.push(v);
      if (!src.enabled) continue;
      try {
        const { hostPath } = resolveSyncSource(cfg, src.from);
        if (!existsSync(hostPath)) throw new Error(`源不存在：${hostPath}`);
        resolved.set(src.id, hostPath);
        v.skills = await topLevelNames(hostPath);
        enabledNames.set(src.id, v.skills);
      } catch (e) {
        v.ok = false;
        v.error = e instanceof Error ? e.message : String(e);
        log.warn({ source: src.from, err: v.error }, 'skills hub source failed');
      }
    }

    // pass 2：赢家（先到先得）与冲突表 → 逐条目镜像进 hub。
    const winners = new Map<string, string>(); // 条目名 → 赢家 sourceId
    const conflicts = new Map<string, string[]>(); // 条目名 → 其余提供者
    for (const [id, names] of enabledNames) {
      for (const n of names) {
        const w = winners.get(n);
        if (w === undefined) winners.set(n, id);
        else conflicts.set(n, [...(conflicts.get(n) ?? []), id]);
      }
    }
    for (const [id, names] of enabledNames) {
      const srcDir = resolved.get(id);
      if (!srcDir) continue;
      for (const n of names) {
        if (winners.get(n) !== id) continue;
        const [w] = await syncTree(join(srcDir, n), join(HUB_DIR, n));
        out.changed += w;
      }
    }
    // pass 3：hub 里已无提供者的条目 → 删（源移除/禁用后自动退出中心）。
    for (const e of await readdir(HUB_DIR, { withFileTypes: true })) {
      if (!winners.has(e.name)) {
        await rm(join(HUB_DIR, e.name), { recursive: true, force: true });
        out.removed++;
      }
    }
    out.skills = [...winners.entries()].map(([name, sourceId]) => ({ name, sourceId, conflicts: conflicts.get(name) ?? [] }));
    out.ok = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    log.warn({ err: out.error }, 'skills hub aggregate failed');
  }
  return out;
}

// 中心同步：聚合 → 分发。从未配置过（无源且从未分发过）则跳过，不碰目标目录。
async function syncHub(cfg: Config): Promise<SkillHubResult | undefined> {
  const hub = await getSkillHub();
  if (!hub.sources.length && !existsSync(join(SKILLS_DIR, 'hub.json'))) return undefined;
  const result = await aggregateHub(cfg, hub);
  if (!result.ok) return result;
  try {
    result.containers = await distributeDir(cfg, HUB_DIR, hub.to, 'hub');
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    log.warn({ err: result.error }, 'skills hub distribute failed');
  }
  log.info({ sources: hub.sources.length, skills: result.skills.length, to: hub.to }, 'skills hub synced');
  return result;
}

// —— 总入口 ——

// 全量同步：全部静态规则 + 中心。手动/API/启动 sweep/watch 共用。
export async function syncSkillsAll(cfg: Config): Promise<SkillSyncResult> {
  const started = Date.now();
  const { rules, hub } = await exclusive(async () => {
    const rules = cfg.skills?.sync ?? [];
    const out: SkillSyncRuleResult[] = [];
    for (const rule of rules) out.push(await syncRule(cfg, rule));
    await pruneStaleMirrors(new Set(rules.map(ruleId)));
    const hub = await syncHub(cfg);
    return { rules: out, hub };
  });
  return {
    ok: rules.every((r) => r.ok) && (hub?.ok ?? true),
    rules,
    hub,
    durationMs: Date.now() - started,
  };
}

// 单容器补发（create() 后调用）：镜像/聚合照跑（副本保鲜），只分发到这一个容器。
// 尽力而为不抛。
export async function syncContainerSkills(cfg: Config, name: string): Promise<void> {
  await exclusive(async () => {
    try {
      const home = getEngine(cfg).hostHomePath(cfg, name);
      if (!home || !existsSync(home)) return;
      for (const rule of cfg.skills?.sync ?? []) {
        try {
          const { hostPath } = resolveSyncSource(cfg, rule.from);
          if (!existsSync(hostPath)) continue;
          const mirror = join(SKILLS_DIR, ruleId(rule));
          await syncTree(hostPath, mirror);
          await distributeDir(cfg, mirror, rule.to, ruleId(rule), [{ name, home }]);
          log.info({ container: name, from: rule.from }, 'skills distributed to new container');
        } catch (e) {
          log.warn({ container: name, from: rule.from, err: String(e) }, 'skills distribute to container failed');
        }
      }
      // 中心：聚合 + 单容器分发（无源且从未分发过则跳过，同 syncHub）。
      const hub = await getSkillHub();
      if (!hub.sources.length && !existsSync(join(SKILLS_DIR, 'hub.json'))) return;
      const agg = await aggregateHub(cfg, hub);
      if (!agg.ok) return;
      await distributeDir(cfg, HUB_DIR, hub.to, 'hub', [{ name, home }]);
      log.info({ container: name, skills: agg.skills.length }, 'skills hub distributed to new container');
    } catch (e) {
      log.warn({ container: name, err: String(e) }, 'skills distribute to container failed');
    }
  });
}

// —— 面板视图与源管理（routes 调用）——

// 中心面板视图：源列表（含各源当前条目）+ 聚合归属/冲突 + config 静态规则展示。
// 只读描述（readdir 级），不拷贝不分发。
export async function hubView(cfg: Config): Promise<SkillHubResult & { configRules: SkillSyncRule[] }> {
  const hub = await getSkillHub();
  const view = await aggregateHub(cfg, hub);
  return { ...view, configRules: cfg.skills?.sync ?? [] };
}

export async function addSkillHubSource(cfg: Config, from: string): Promise<void> {
  resolveSyncSource(cfg, from); // 形态不识别直接抛（routes 转 400）
  const hub = await getSkillHub();
  if (hub.sources.some((s) => s.from === from)) throw new Error(`源已存在：${from}`);
  const src: SkillHubSource = { id: randomBytes(4).toString('hex'), from, enabled: true, createdAt: new Date().toISOString() };
  hub.sources.push(src);
  await setSkillHub(hub);
  watchSkillSource(cfg, `hub:${src.id}`, src.from);
}

// patch：enabled 开关 / move 排序（-1 上移 +1 下移，越界即贴边）。from 不支持改——
// 改源 = 删了重加（id/顺序语义才稳定）。
export async function updateSkillHubSource(cfg: Config, id: string, patch: { enabled?: boolean; move?: number }): Promise<void> {
  const hub = await getSkillHub();
  const i = hub.sources.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`源不存在：${id}`);
  if (patch.enabled !== undefined) hub.sources[i].enabled = patch.enabled;
  if (patch.move) {
    const j = Math.max(0, Math.min(hub.sources.length - 1, i + patch.move));
    if (j !== i) {
      const [s] = hub.sources.splice(i, 1);
      hub.sources.splice(j, 0, s);
    }
  }
  await setSkillHub(hub);
}

export async function deleteSkillHubSource(_cfg: Config, id: string): Promise<void> {
  const hub = await getSkillHub();
  hub.sources = hub.sources.filter((s) => s.id !== id);
  await setSkillHub(hub);
  unwatchSkillSource(`hub:${id}`);
}

export async function setSkillHubTo(to: string): Promise<void> {
  containerRel(to); // 形态校验
  const hub = await getSkillHub();
  hub.to = to;
  await setSkillHub(hub);
}

// —— watch（实时分发的自动触发器，按源动态注册）——

// watchers 注册表：key = 'cfg:<规则序号>'（config 静态规则，重启才变）/ 'hub:<源id>'
// （中心源，UI 增删时同步挂/摘）。值 = watcher + debounce timer。
const watchers = new Map<string, { w: FSWatcher; timer?: ReturnType<typeof setTimeout> }>();

function scheduleSync(cfg: Config, key: string): void {
  const e = watchers.get(key);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    if (e) e.timer = undefined;
    void syncSkillsAll(cfg).catch((err) => log.warn({ err: String(err) }, 'skills watch sync failed'));
  }, WATCH_DEBOUNCE_MS);
}

function watchSkillSource(cfg: Config, key: string, from: string): void {
  if (watchers.has(key)) return;
  let source: string;
  try {
    source = resolveSyncSource(cfg, from).hostPath;
  } catch (e) {
    log.warn({ from, err: String(e) }, 'skills watch: source resolve failed');
    return;
  }
  if (!existsSync(source)) {
    log.warn({ from, source }, 'skills watch: source missing, watch not set');
    return;
  }
  try {
    const w = fsWatch(source, { recursive: true }, () => scheduleSync(cfg, key));
    w.on('error', (e) => log.warn({ from, err: String(e) }, 'skills watch error'));
    watchers.set(key, { w });
  } catch (e) {
    log.warn({ from, err: String(e) }, 'skills watch setup failed');
  }
}

function unwatchSkillSource(key: string): void {
  const e = watchers.get(key);
  if (!e) return;
  if (e.timer) clearTimeout(e.timer);
  e.w.close();
  watchers.delete(key);
}

// 服务启动：静态规则 + 中心源全部挂 watch。
export function startSkillSyncWatch(cfg: Config): void {
  (cfg.skills?.sync ?? []).forEach((rule, i) => watchSkillSource(cfg, `cfg:${i}`, rule.from));
  void getSkillHub().then((hub) => {
    for (const s of hub.sources) {
      if (s.enabled) watchSkillSource(cfg, `hub:${s.id}`, s.from);
    }
    if (hub.sources.length) log.info({ sources: hub.sources.length }, 'skills hub watch active');
  });
}

// —— CLI：mysandbox skills sync ——

export async function runSkillsCommand(cfg: Config): Promise<void> {
  const rules = cfg.skills?.sync ?? [];
  const hub = await getSkillHub();
  if (!rules.length && !hub.sources.length) {
    process.stdout.write('>> 没有配置任何 skills 源（面板「技能中心」或 config skills.sync）\n');
    process.stdout.write('>> config 示例:\n>>   skills:\n>>     sync:\n>>       - from: mytest:~/testlens/.claude/skills\n>>         to: ~/.claude/skills\n');
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
  if (r.hub) {
    process.stdout.write(`>> 中心（${r.hub.skills.length} 个技能）→ ${r.hub.to}  ${r.hub.ok ? '' : `失败 — ${r.hub.error}`}\n`);
    for (const c of r.hub.containers) {
      process.stdout.write(
        `>>   ${c.name}: ${c.ok ? `+${c.changed} 文件${c.removed ? ` -${c.removed} 陈旧` : ''}` : `失败 — ${c.error}`}\n`,
      );
    }
  }
  process.stdout.write(`>> skills 同步完成（${r.durationMs}ms）\n`);
  if (!r.ok) process.exit(1);
}
