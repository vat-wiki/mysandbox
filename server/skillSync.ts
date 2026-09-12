// Skills 同步：两条通路把 skills 分发进全部受管容器（宿主直读直写 rootfs——D1 uid
// 直通：容器内 dev(1000) = 宿主当前用户，写出的文件属主天然正确；容器不必在跑）。
//
// ① 静态规则（config.skills.sync = [{from,to}]）：精确映射，适合项目级/非标准目标。
//    from：'<容器名>:<容器内路径>'（home 契约 /home/dev，~/ 与绝对路径都认）或宿主
//    路径（~/ 展开）；to：容器内目标。走 UI 管不到的 config.yaml，改动需重启服务。
// ② 技能中心（hub，sidecar state.json 的 skillsHub）：多源聚合池。每个源自带可选
//    目标 to（缺省 = hub.to 全局 ~/.claude/skills），**同目标自动聚合成组**——组内
//    重名按源顺序先到先得（冲突在面板可见），每组一个聚合副本（skills/hub-<hash>/）
//    独立分发。范围语义：全局目标 → 全部受管容器；项目目标（用户显式指定的 to）→
//    **只同步到已有该项目的容器**（目标父目录存在即视为项目在，项目克隆到哪 skill
//    跟到哪），并配容器 start 事件补发（晚克隆的项目重启后自动补齐）。
//    源在 UI 增删/启停/排序（数组顺序 = 组内优先级）；源移除/禁用后其条目退出中心，
//    组内最后一个源没了 → 清单记账把该组分发过的条目从容器里清干净。
//
// 每条通路两步（同构）：
//   源 → 宿主权威副本（规则 = skills/<ruleId>/，中心 = skills/hub-<hash>/；源删了副本仍在）
//   权威副本 → 容器目标：顶层条目逐一克隆；「上次分发过而已消失」的顶层条目删除
//   （按清单 <id>.json 记账，用户自装的其他 skills 不动）。
// 文件级 size+内容比对、变才写（与 seedContainerCli 的自更新语义一致）。
//
// 触发点（全自动）：服务启动 sweep（cli.ts）+ 源目录 fs.watch（宿主 inotify——源在
// 容器 rootfs 里照样是宿主文件，跑着的容器立即生效；watch 按源动态注册，中心源在
// UI 增删时同步挂/摘）+ create() 建容器后补发 + 容器 start 事件补发（lifecycle.ts /
// startSkillSyncEvents）。手动：mysandbox skills sync / POST /api/skills/sync / 面板
// 「立即同步」。同步全程互斥（模块级 promise 链）。
import { existsSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import { STATE_DIR, expandTilde } from './config.js';
import { getEngine, subscribeEvents } from './engine/index.js';
import { getAllMeta, getSkillHub, setSkillHub, type SkillHubSource } from './state.js';
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

export interface SkillHubSourceView {
  id: string;
  from: string;
  to?: string; // 缺省 = 全局目标
  enabled: boolean;
  ok: boolean;
  skills: string[]; // 该源当前顶层条目（disabled 的也列出，仅信息展示）
  error?: string;
}

// 一个目标组的聚合 + 分发结果。
export interface SkillHubGroupResult {
  to: string;
  ok: boolean;
  changed: number;
  removed: number;
  skills: { name: string; sourceId: string; conflicts: string[] }[];
  containers: SkillSyncContainerResult[];
  error?: string;
}

export interface SkillHubResult {
  ok: boolean;
  to: string; // 全局目标（缺省 to）
  sources: SkillHubSourceView[];
  groups: SkillHubGroupResult[];
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

interface DistributeOpts {
  // 限单容器（create()/start 事件补发用）。
  only?: { name: string; home: string }[];
  // 项目范围：只同步到「已有该项目」的容器——目标路径到首段逐级向上探测，任一
  // 前缀已存在即视为落点在（项目克隆到哪 skill 跟到哪），没有项目的容器不制造
  // 目录。全局目标不开（fresh 容器也要铺 ~/.claude/skills）。
  onlyIfParentExists?: boolean;
}

// 目标落点探测：rel 的任一前缀（含 rel 本身）在容器 home 里已存在。
function landingExists(home: string, rel: string): boolean {
  const parts = rel.split('/');
  for (let i = parts.length; i >= 1; i--) {
    if (existsSync(join(home, parts.slice(0, i).join('/')))) return true;
  }
  return false;
}

// 把 dir（规则的权威副本 / 中心的聚合副本）分发到容器的 to：顶层条目逐一克隆；
// 上次分发过而 dir 里已消失的顶层条目删除（按清单 manifestId 记账——用户自装的
// 其他 skills 不在清单里，永不动）。
async function distributeDir(
  cfg: Config,
  dir: string,
  to: string,
  manifestId: string,
  opts: DistributeOpts = {},
): Promise<SkillSyncContainerResult[]> {
  const rel = containerRel(to);
  if (!rel) throw new Error('to 不能指向 home 根');
  let names: string[] = [];
  if (existsSync(dir)) names = await topLevelNames(dir);
  const prev = await readManifest(manifestId);
  let targets = opts.only ?? (await distributeTargets(cfg));
  if (opts.onlyIfParentExists) {
    targets = targets.filter(({ home }) => landingExists(home, rel));
  }
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
  await writeFile(join(SKILLS_DIR, `${manifestId}.json`), JSON.stringify({ to, distributed: names }, null, 2));
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
  to: string; // 该清单对应的目标（孤儿清理时要知道往哪收）
  distributed: string[]; // 上次分发到容器的顶层条目名
}

async function readManifest(id: string): Promise<RuleManifest | null> {
  try {
    return JSON.parse(await readFile(join(SKILLS_DIR, `${id}.json`), 'utf8')) as RuleManifest;
  } catch {
    return null; // 首跑/坏文件：当没分发过，绝不在目标里乱删
  }
}

// 配置/分组里已消失的副本目录与清单清掉（幂等）。分类按文件名：
// 'hub'/'hub.json' = 旧版单中心遗留（直接删）；'hub-*' = 目标组（存活集外删）；
// 其余 = 静态规则副本（存活集外删）。
async function pruneStale(aliveRuleIds: Set<string>, aliveHubIds: Set<string>): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return; // 目录还没有 = 无可清
  }
  for (const e of entries) {
    const isFile = e.endsWith('.json');
    const id = isFile ? e.slice(0, -'.json'.length) : e;
    if (id === 'hub') {
      await rm(join(SKILLS_DIR, e), { recursive: true, force: true }); // 旧版单中心遗留
      continue;
    }
    if (id.startsWith('hub-')) {
      if (!aliveHubIds.has(id)) await rm(join(SKILLS_DIR, e), { recursive: true, force: true });
      continue;
    }
    if (!aliveRuleIds.has(id)) await rm(join(SKILLS_DIR, e), { recursive: true, force: true });
  }
}

// —— 静态规则通路 ——

// 规则 id：from+to 的 sha1 前 12 位——配置里无关字段的改动不影响副本目录；
// from/to 变了自然换新 id（旧副本由 pruneStale 清掉）。
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

// 目标组：同 to 的源聚成一组成员，组内重名按源顺序（hub.sources 全局顺序）裁决。
interface HubGroup {
  id: string; // sha1(to) 前 8 位（副本目录/清单锚点）
  to: string;
  sources: SkillHubSource[]; // 组内成员（保持全局顺序）
  onlyIfParentExists: boolean; // 项目目标 = 只同步到已有该项目的容器
}

function groupHub(hub: { to: string; sources: SkillHubSource[] }): HubGroup[] {
  const groups = new Map<string, HubGroup>();
  for (const src of hub.sources) {
    const to = src.to || hub.to;
    let g = groups.get(to);
    if (!g) {
      g = {
        id: `hub-${createHash('sha1').update(to).digest('hex').slice(0, 8)}`,
        to,
        sources: [],
        onlyIfParentExists: to !== hub.to, // 显式目标才收窄范围；全局目标铺满全部容器
      };
      groups.set(to, g);
    }
    g.sources.push(src);
  }
  return [...groups.values()];
}

// 组聚合：按源顺序把各源顶层条目镜像进组副本目录（重名先到先得），组里已无提供者
// 的条目从副本删除。返回该组的聚合视图（不分发）。
async function aggregateGroup(cfg: Config, g: HubGroup): Promise<SkillHubGroupResult> {
  const out: SkillHubGroupResult = { to: g.to, ok: false, changed: 0, removed: 0, skills: [], containers: [] };
  try {
    const dir = join(SKILLS_DIR, g.id);
    await mkdir(dir, { recursive: true });

    const enabledNames = new Map<string, string[]>(); // sourceId → 条目名
    const resolved = new Map<string, string>(); // sourceId → 宿主源路径
    for (const src of g.sources) {
      if (!src.enabled) continue;
      try {
        const { hostPath } = resolveSyncSource(cfg, src.from);
        if (!existsSync(hostPath)) throw new Error(`源不存在：${hostPath}`);
        resolved.set(src.id, hostPath);
        enabledNames.set(src.id, await topLevelNames(hostPath));
      } catch (e) {
        log.warn({ source: src.from, err: String(e) }, 'skills hub source failed');
      }
    }

    // 赢家（组内先到先得）与冲突表 → 逐条目镜像进组副本。
    const winners = new Map<string, string>();
    const conflicts = new Map<string, string[]>();
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
        const [w] = await syncTree(join(srcDir, n), join(dir, n));
        out.changed += w;
      }
    }
    // 组里已无提供者的条目 → 删（源移除/禁用后自动退出中心）。
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!winners.has(e.name)) {
        await rm(join(dir, e.name), { recursive: true, force: true });
        out.removed++;
      }
    }
    out.skills = [...winners.entries()].map(([name, sourceId]) => ({ name, sourceId, conflicts: conflicts.get(name) ?? [] }));
    out.ok = true;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    log.warn({ to: g.to, err: out.error }, 'skills hub aggregate failed');
  }
  return out;
}

// 中心同步：逐组聚合 → 分发；孤儿副本（组已不存在，如某目标最后一个源被删）按
// 清单把分发过的条目从容器里清掉再删副本——「中心管理」语义闭环。从未配置过
// （无源且无任何组副本）则整体跳过，不碰任何目标目录。
async function syncHub(cfg: Config): Promise<SkillHubResult | undefined> {
  const hub = await getSkillHub();
  const everUsed = hub.sources.length > 0 || existsSync(SKILLS_DIR);
  if (!everUsed) return undefined;
  const out: SkillHubResult = { ok: true, to: hub.to, sources: [], groups: [] };

  // 源视图（扁平，保持全局顺序；disabled 的也展示）。
  for (const src of hub.sources) {
    const v: SkillHubSourceView = { id: src.id, from: src.from, to: src.to, enabled: src.enabled, ok: true, skills: [] };
    out.sources.push(v);
    if (!src.enabled) continue;
    try {
      const { hostPath } = resolveSyncSource(cfg, src.from);
      if (!existsSync(hostPath)) throw new Error(`源不存在：${hostPath}`);
      v.skills = await topLevelNames(hostPath);
    } catch (e) {
      v.ok = false;
      v.error = e instanceof Error ? e.message : String(e);
    }
  }

  // 组聚合 + 分发。
  const groups = groupHub(hub);
  for (const g of groups) {
    const res = await aggregateGroup(cfg, g);
    if (res.ok) {
      try {
        res.containers = await distributeDir(cfg, join(SKILLS_DIR, g.id), g.to, g.id, {
          onlyIfParentExists: g.onlyIfParentExists,
        });
      } catch (e) {
        res.error = e instanceof Error ? e.message : String(e);
        log.warn({ to: g.to, err: res.error }, 'skills hub distribute failed');
      }
    }
    if (!res.ok) out.ok = false;
    out.groups.push(res);
  }

  // 孤儿副本清理：组已不存在（该目标最后一个源被删/目标改走）→ 按清单把分发过的
  // 条目从容器收回来，再删副本与清单。范围口径按「to 是否为当前全局目标」重算。
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    /* 无目录 = 无孤儿 */
  }
  const alive = new Set(groups.map((g) => g.id));
  for (const e of entries) {
    if (!e.startsWith('hub-') || !e.endsWith('.json')) continue;
    const id = e.slice(0, -'.json'.length);
    if (alive.has(id)) continue;
    const manifest = await readManifest(id);
    if (manifest) {
      const onlyIfParentExists = manifest.to !== hub.to;
      try {
        await distributeDir(cfg, join(SKILLS_DIR, id, '__gone__'), manifest.to, id, { onlyIfParentExists });
      } catch (err) {
        log.warn({ id, err: String(err) }, 'skills hub orphan cleanup failed');
      }
    }
    await rm(join(SKILLS_DIR, id), { recursive: true, force: true });
  }

  if (groups.length) {
    log.info(
      { groups: groups.map((g) => ({ to: g.to, sources: g.sources.length, skills: out.groups.find((r) => r.to === g.to)?.skills.length ?? 0 })) },
      'skills hub synced',
    );
  }
  return out;
}

// —— 总入口 ——

// 全量同步：全部静态规则 + 中心。手动/API/启动 sweep/watch 共用。
export async function syncSkillsAll(cfg: Config): Promise<SkillSyncResult> {
  const started = Date.now();
  const { rules, hub } = await exclusive(async () => {
    const rules = cfg.skills?.sync ?? [];
    const out: SkillSyncRuleResult[] = [];
    for (const rule of rules) out.push(await syncRule(cfg, rule));
    const hub = await syncHub(cfg);
    // 清失效副本：规则副本按 config 存活集；组副本已在 syncHub 里连容器一起清过。
    await pruneStale(new Set(rules.map(ruleId)), new Set((hub ? groupHub(await getSkillHub()) : []).map((g) => g.id)));
    return { rules: out, hub };
  });
  return {
    ok: rules.every((r) => r.ok) && (hub?.ok ?? true),
    rules,
    hub,
    durationMs: Date.now() - started,
  };
}

// 单容器补发（create()/容器 start 事件后调用）：镜像/聚合照跑（副本保鲜），只分发
// 到这一个容器（项目目标按范围口径判这台要不要）。尽力而为不抛。
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
          await distributeDir(cfg, mirror, rule.to, ruleId(rule), { only: [{ name, home }] });
          log.info({ container: name, from: rule.from }, 'skills distributed to container');
        } catch (e) {
          log.warn({ container: name, from: rule.from, err: String(e) }, 'skills distribute to container failed');
        }
      }
      // 中心：逐组聚合 + 单容器分发（无源且从未用过则跳过，同 syncHub）。
      const hub = await getSkillHub();
      if (!hub.sources.length && !existsSync(SKILLS_DIR)) return;
      for (const g of groupHub(hub)) {
        const agg = await aggregateGroup(cfg, g);
        if (!agg.ok) continue;
        await distributeDir(cfg, join(SKILLS_DIR, g.id), g.to, g.id, {
          only: [{ name, home }],
          onlyIfParentExists: g.onlyIfParentExists,
        });
      }
      log.info({ container: name }, 'skills distributed to container (hub)');
    } catch (e) {
      log.warn({ container: name, err: String(e) }, 'skills distribute to container failed');
    }
  });
}

// —— 面板视图与源管理（routes 调用）——

// 中心面板视图：源列表（含各源当前条目）+ 按目标分组的聚合归属/冲突 + config 静态
// 规则展示。聚合顺带把组副本刷新鲜（readdir/小拷贝级，开销可忽略）。
export async function hubView(cfg: Config): Promise<SkillHubResult & { configRules: SkillSyncRule[] }> {
  const hub = await getSkillHub();
  const view = await exclusive(() => syncHub(cfg));
  return {
    ok: view?.ok ?? true,
    to: hub.to,
    sources: view?.sources ?? [],
    groups: view?.groups ?? [],
    configRules: cfg.skills?.sync ?? [],
  };
}

export async function addSkillHubSource(cfg: Config, from: string, to?: string): Promise<void> {
  resolveSyncSource(cfg, from); // 形态不识别直接抛（routes 转 400）
  if (to !== undefined) containerRel(to); // 目标形态校验（空串 = 用全局，别显式传）
  const hub = await getSkillHub();
  if (hub.sources.some((s) => s.from === from && (s.to || hub.to) === (to || hub.to))) {
    throw new Error(`源已存在：${from} → ${to || hub.to}`);
  }
  const src: SkillHubSource = {
    id: randomBytes(4).toString('hex'),
    from,
    ...(to ? { to } : {}),
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  hub.sources.push(src);
  await setSkillHub(hub);
  watchSkillSource(cfg, `hub:${src.id}`, src.from);
}

// patch：enabled 开关 / move 排序（-1 上移 +1 下移，越界即贴边）/ to 换目标
// （null = 回到全局目标）。from 不支持改——改源 = 删了重加（id/顺序语义才稳定）。
export async function updateSkillHubSource(
  cfg: Config,
  id: string,
  patch: { enabled?: boolean; move?: number; to?: string | null },
): Promise<void> {
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
  if (patch.to !== undefined) {
    if (patch.to === null || patch.to === '') delete hub.sources[i].to;
    else {
      containerRel(patch.to);
      hub.sources[i].to = patch.to;
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

// 容器 start/restart 事件补发（startSkillSyncEvents，cli.ts 装配）：项目目标的
// 「只同步到已有该项目的容器」语义靠它闭环——容器停机期间克隆了项目，下次启动
// 自动补齐，不用手动同步。断线指数退避重连（hosts-sync 同款骨架）。
const startTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function startSkillSyncEvents(cfg: Config): void {
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeEvents(cfg, (ev) => {
          if (ev.action !== 'start' && ev.action !== 'restart') return;
          const id = ev.containerId;
          const t = startTimers.get(id);
          if (t) clearTimeout(t);
          startTimers.set(
            id,
            setTimeout(() => {
              startTimers.delete(id);
              void syncContainerSkills(cfg, id).catch((e) => log.warn({ container: id, err: String(e) }, 'skills event sync failed'));
            }, 2_000),
          );
        });
        delay = 1_000;
        log.info({ engine: 'lxc' }, 'skills event sync: subscribed');
        await sub.closed;
      } catch (e) {
        log.warn({ err: String(e), retryMs: delay }, 'skills event sync: subscribe failed, retrying');
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}

// —— CLI：mysandbox skills sync ——

export async function runSkillsCommand(cfg: Config): Promise<void> {
  const rules = cfg.skills?.sync ?? [];
  const hub = await getSkillHub();
  if (!rules.length && !hub.sources.length) {
    process.stdout.write('>> 没有配置任何 skills 源（面板「AI 工具 → 技能中心」或 config skills.sync）\n');
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
    for (const g of r.hub.groups) {
      process.stdout.write(
        `>> 中心（${g.skills.length} 个技能）→ ${g.to}${g.to === r.hub.to ? '' : '（仅已有该项目的容器）'}  ${g.ok ? '' : `失败 — ${g.error}`}\n`,
      );
      for (const c of g.containers) {
        process.stdout.write(
          `>>   ${c.name}: ${c.ok ? `+${c.changed} 文件${c.removed ? ` -${c.removed} 陈旧` : ''}` : `失败 — ${c.error}`}\n`,
        );
      }
    }
  }
  process.stdout.write(`>> skills 同步完成（${r.durationMs}ms）\n`);
  if (!r.ok) process.exit(1);
}
