// Skills 分发：技能库（registry）为唯一技能真相源，安装规则把库技能装进受管容器
// （宿主直读直写 rootfs——D1 uid 直通：容器内 dev(1000) = 宿主当前用户，写出的文件
// 属主天然正确；容器不必在跑）。
//
// 模型（两个一等概念）：
// ① 技能库（STATE_DIR/skills/registry/<名>/）：**静态快照中心**——入库（目录/git）
//    一律拷贝快照，与来源解耦；来源的改动**不**订阅、不自动进库，更新走显式动作
//    （registryUpdate：面板行「更新」/ mysandbox skills update / POST .../update）
//    ——先比对内容指纹（meta.hash，git 源外加 meta.gitCommit 快路径）再动手：
//    来源没变幂等空转，变了才重拉替换 + 全量分发。检查更新（只读比对）见
//    registryCheckUpdate(s)。源没了更新报错，库副本冻结保留。库内同名唯一 → 无冲突概念。
// ② 安装规则（sidecar state.skillsHub.rules）：{库内技能集合, 去向, 范围}。去向
//    唯一（同 to 不允许两条规则）；全局去向铺本机 + 全部受管容器，项目去向只装已有
//    该项目的目标（落点逐级向上探测，项目克隆到哪 skill 跟到哪；宿主与容器共享同一条
//    项目规则），容器 start 事件补发闭环停机期间克隆的项目。规则删除/改去向 → 孤儿
//    清理按清单把分发过的条目从目标收回。**订阅单向：只订阅库，不订阅来源**——库
//    内容一变（显式更新/手改库目录），安装位置自动跟走。
//
// 同步两步（每条规则同构）：
//   库 → 聚合副本（skills/hub-<hash(to)>/，规则技能集的有效子集；集合里已无的条目删）
//   聚合副本 → 容器去向：顶层条目逐一克隆；「上次分发过而已消失」的删除（按清单
//   <id>.json 记账，用户自装的其他 skills 不动）。
// 文件级 size+内容比对、变才写（与 seedContainerCli 的自更新语义一致）。
//
// 旧版迁移（ensureLegacyMigrated，一次性）：config.skills.sync 静态规则与 targets
// 模型下挂的目录源，逐技能入库（快照）后并进对应规则；'registry' 源展开为库成员
// 名单。迁移后 config 键被忽略（state.staticMigratedAt 记账），双真相源不复存在。
//
// 触发点（全自动）：服务启动 sweep（cli.ts）+ create() 建容器后补发 + 容器 start
// 事件补发（lifecycle.ts / startSkillSyncEvents）。显式：入库/出库/git 导入由路由层
// 触发全量分发，更新（registryUpdate）自带分发，手动 mysandbox skills sync /
// POST /api/skills/sync / 面板「立即同步」。来源不 watch（静态快照），库目录也
// 不 watch——一切流向由动作驱动，手改库目录需手动同步。同步全程互斥（模块级
// promise 链）。
import { existsSync, lstatSync, realpathSync, type Dirent, type Stats } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { STATE_DIR, expandTilde } from './config.js';
import { getEngine, subscribeEvents } from './engine/index.js';
import { getAllMeta, HOST_TARGET } from './state.js';
import { AI_DIR, getSkillHub, setSkillHub, getSkillRegistry, setSkillRegistry, type SkillHubState, type SkillRule, type SkillRegistryMeta } from './aiState.js';
import { log } from './logger.js';

const SKILLS_DIR = join(AI_DIR, 'skills');
// 全局落点的唯一真身：~/.agents/skills（跨工具标准）。~/.claude/skills 是指向它的
// 相对软链（compat shim，claude 等工具读软链）——规则/盘点/范围判定都只认真身，
// 避免同目录双份记账。软链由 seedHome（新容器）与一次性迁移（存量环境）落地。
const GLOBAL_RELS = ['.agents/skills'];
export interface SkillSyncContainerResult {
  name: string;
  ok: boolean;
  changed: number; // 写入/更新的文件数
  removed: number; // 删除的陈旧条目数（顶层计 1，内部文件不计）
  error?: string;
}

// 一条安装规则的同步结果。skills = 有效集（库里存在、实际参与聚合的）；missing =
// 规则勾了但库里没有（exists=false 元数据残留或目录被外部删）——展示层标红。
export interface SkillRuleResult {
  id: string;
  to: string;
  all: boolean;
  skills: { name: string; ok: boolean; error?: string }[];
  missing: string[];
  changed: number;
  removed: number;
  containers: SkillSyncContainerResult[];
  error?: string;
}

export interface SkillSyncResult {
  ok: boolean;
  rules: SkillRuleResult[];
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

// 宿主路径 → home 内相对：'~/x' / '~' / 宿主绝对路径（相对 $HOME）。文件面板宿主
// 面板的 path 本身就是宿主路径，与容器的契约前缀分形（aiconfig.hostRel 同形）。
function hostHomeRel(p: string): string {
  if (p === '~') return '';
  if (p.startsWith('~/')) return p.slice(2);
  const home = homedir().replace(/\/+$/, '');
  if (p === home) return '';
  if (p.startsWith(home + '/')) return p.slice(home.length + 1);
  throw new Error(`宿主路径必须在 home 内（${home}）："${p}"`);
}

// from → 宿主路径。'registry' = 技能库（用户策展的权威副本）；'<容器名>:<路径>'
// 前缀匹配 LXC 名字符集即按容器解析（容器名不会含 :，宿主路径必须 / 或 ~ 开头，
// 两者天然无歧义）。
export function resolveSyncSource(cfg: Config, from: string): { hostPath: string; container?: string } {
  if (from === REGISTRY_FROM) return { hostPath: REGISTRY_DIR };
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
// 返回 [写入, 删除] 文件计数。dst 本体是符号链接 → 整棵子树跳过（不写不删，防穿透）：
// 容器内用户会把全局落点条目软链到项目内技能（~/.agents/skills/x → 项目/.claude/skills/x
// 的容器内绝对路径），宿主视角 stat 悬空，mkdir recursive 直接 ENOENT；不悬空时写
// 透软链会污染项目真身目录。
async function syncTree(src: string, dst: string): Promise<[number, number]> {
  let dstSt: Stats | undefined;
  try {
    dstSt = lstatSync(dst);
  } catch {
    /* 不存在 = 正常路径 */
  }
  if (dstSt?.isSymbolicLink()) {
    log.warn({ dst }, 'skills sync: destination is symlink, subtree skipped');
    return [0, 0];
  }
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
      if (e.isSymbolicLink()) continue; // 用户自放的软链不动（rm 只会摘链，但一律不碰）
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
    const target = join(home, rel);
    // 落点本体是符号链接 → 整台跳过（写/删都会穿透到软链指向的真身目录）。
    // 实测踩坑：改规则的 to 后旧清单成孤儿，孤儿清理按旧路径（.claude/skills 软链）
    // rm 把真身 ~/.agents/skills 里的内容清空了。
    let lst: Stats | undefined;
    try {
      lst = lstatSync(target);
    } catch {
      /* 不存在 = 交给后面的 mkdir/syncTree */
    }
    if (lst?.isSymbolicLink()) {
      c.ok = false;
      c.error = `落点是符号链接（${target} → ${realpathSync(target)}），跳过分发防穿透`;
      log.warn({ container: name, manifestId, err: c.error }, 'skills distribute skipped');
      continue;
    }
    try {
      for (const n of names) {
        const [w] = await syncTree(join(dir, n), join(target, n));
        c.changed += w;
      }
      for (const n of prev?.distributed ?? []) {
        if (names.includes(n)) continue;
        let sl: Stats | undefined;
        try {
          sl = lstatSync(join(target, n));
        } catch {
          /* 不存在 = rm force 兜底 */
        }
        if (sl?.isSymbolicLink()) continue; // 用户把分发过的条目换成了自放软链 → 不动不记账
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

// 分发目标：本机（宿主 leon 的 home——与容器契约 home 同形，D1 直通）+ 容器内绝对
// 宿主路径（sidecar 已知、home 可见的容器 = 与 sweepContainerCli 同口径）。宿主排最前。
async function distributeTargets(cfg: Config): Promise<{ name: string; home: string }[]> {
  const engine = getEngine(cfg);
  const out: { name: string; home: string }[] = [{ name: HOST_TARGET, home: homedir() }];
  const names = Object.keys(await getAllMeta());
  for (const name of names) {
    const home = engine.hostHomePath(cfg, name);
    if (home && existsSync(home)) out.push({ name, home });
  }
  return out;
}

// 分发结果里的人话目标名（CLI / 面板展示用）。
export function targetDisplayName(name: string): string {
  return name === HOST_TARGET ? 'host（本机）' : name;
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

// 旧命名空间副本清理（幂等）：hub 副本/清单（hub-*）与库（registry）之外的条目全是
// 静态规则时代或更早的遗留（<ruleId>/、<ruleId>.json、旧版单中心 hub/hub.json）——
// 静态规则通路已死，一律删。hub 孤儿（规则删除/改 to）在 syncRules 里连容器一起清。
async function pruneStale(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return; // 目录还没有 = 无可清
  }
  for (const e of entries) {
    const id = e.endsWith('.json') ? e.slice(0, -'.json'.length) : e;
    if (id === 'registry' || id.startsWith('hub-')) continue;
    await rm(join(SKILLS_DIR, e), { recursive: true, force: true });
  }
}

// —— 旧版迁移（一次性）——

// 旧目录源 → 库条目（快照）→ 并进 to 对应规则的技能名单。from 目录本身含
// SKILL.md = 单技能；否则按 skills 目录处理（扫顶层含 SKILL.md 的子目录）。
// 库内同名的条目不重导入（库内容是权威），但名字照样并进规则。
async function legacySourceIntoLibrary(
  cfg: Config,
  from: string,
  rule: SkillRule,
): Promise<void> {
  let hostPath = '';
  try {
    hostPath = resolveSyncSource(cfg, from).hostPath;
  } catch (e) {
    log.warn({ from, err: String(e) }, 'skills legacy migrate: source resolve failed');
    return;
  }
  if (!existsSync(hostPath)) {
    log.warn({ from, hostPath }, 'skills legacy migrate: source missing');
    return;
  }
  const add = async (dir: string): Promise<void> => {
    const name = basename(dir.replace(/\/+$/, ''));
    if (!existsSync(join(dir, 'SKILL.md'))) return;
    try {
      await registryAdd(cfg, fromForDir(from, dir), false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('已有同名')) {
        log.warn({ skill: name, err: msg }, 'skills legacy migrate: import failed');
        return;
      }
    }
    if (!rule.skills.includes(name)) rule.skills.push(name);
  };
  if (existsSync(join(hostPath, 'SKILL.md'))) {
    await add(hostPath);
    return;
  }
  for (const e of await readdir(hostPath, { withFileTypes: true })) {
    if (e.isDirectory()) await add(join(hostPath, e.name));
  }
}

// 旧源的 from 记账形态：源目录整体时 from 原样；顶层子技能时 <源>/<名>。
// registryAdd 的 resolveSyncSource 认 <容器名>:<路径> 与宿主路径，直接拼即可。
function fromForDir(from: string, dir: string): string {
  return dir === from ? from : `${from.replace(/\/+$/, '')}/${basename(dir)}`;
}

// 一次性迁移：① config.skills.sync 静态规则（staticMigratedAt 记账）；② targets
// 模型 rule.legacy 遗留源（state.ts 形状迁移时挂上）。'registry'
// 源展开为库成员名单；目录源逐技能入库。迁移后双真相源不复存在，config 键被忽略。
function isGitFrom(from: string): boolean {
  return /^(https?:\/\/|git@|ssh:\/\/)/.test(from);
}

async function ensureLegacyMigrated(cfg: Config): Promise<void> {
  const hub = await getSkillHub();
  let dirty = false;
  if (!hub.staticMigratedAt && (cfg.skills?.sync ?? []).length) {
    for (const r of cfg.skills?.sync ?? []) {
      let target = hub.rules.find((x) => x.to === r.to);
      if (!target) {
        target = { id: randomBytes(4).toString('hex'), to: r.to, all: true, skills: [] };
        hub.rules.push(target);
      }
      await legacySourceIntoLibrary(cfg, r.from, target);
    }
    hub.staticMigratedAt = new Date().toISOString();
    log.info({ rules: (cfg.skills?.sync ?? []).length }, 'skills: legacy config rules migrated');
    dirty = true;
  }
  for (const rule of hub.rules) {
    if (!rule.legacy?.length) continue;
    for (const l of rule.legacy) {
      if (!l.enabled) continue; // 旧「停用」语义：跳过即弃（迁移不复活）
      if (l.from === REGISTRY_FROM) {
        const reg = await getSkillRegistry();
        for (const name of Object.keys(reg.skills)) {
          if (!rule.skills.includes(name)) rule.skills.push(name);
        }
      } else {
        await legacySourceIntoLibrary(cfg, l.from, rule);
      }
    }
    delete rule.legacy;
    dirty = true;
  }
  if (dirty) await setSkillHub(hub);
}

// —— 安装规则通路 ——

// 目标的聚合副本目录/清单锚点：sha1(to) 前 8 位。锚在 to 而非 target id——目标删
// 除/改 to 时旧目录自然变孤儿，由孤儿清理按清单把分发过的条目从容器收回来。
// 同 to 不允许两个目标（addTarget 查重），目录不会撞。
function hubDirId(to: string): string {
  return `hub-${createHash('sha1').update(to).digest('hex').slice(0, 8)}`;
}

// 规则聚合：把规则技能集的有效子集（库目录仍存在的）从库镜像进聚合副本，副本里
// 已不在集合的条目删除。返回聚合视图（不分发）——syncRule/syncContainerSkills 共用。
async function aggregateRule(rule: SkillRule): Promise<{ dir: string; effective: string[]; changed: number; removed: number }> {
  const dir = join(SKILLS_DIR, hubDirId(rule.to));
  await mkdir(dir, { recursive: true });
  const effective = rule.skills.filter((n) => existsSync(join(REGISTRY_DIR, n)));
  let changed = 0;
  let removed = 0;
  for (const n of effective) {
    const [w] = await syncTree(join(REGISTRY_DIR, n), join(dir, n));
    changed += w;
  }
  // 集合里已无的条目 → 删（取消勾选/出库后自动退出聚合副本，进而从容器收回）。
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!effective.includes(e.name)) {
      await rm(join(dir, e.name), { recursive: true, force: true });
      removed++;
    }
  }
  return { dir, effective, changed, removed };
}

// 单规则：库 → 聚合副本 → 逐容器分发。失败收敛进结果，不中断其他规则/容器。
async function syncRule(cfg: Config, rule: SkillRule): Promise<SkillRuleResult> {
  const out: SkillRuleResult = {
    id: rule.id, to: rule.to, all: rule.all, skills: [], missing: [], changed: 0, removed: 0, containers: [],
  };
  try {
    const agg = await aggregateRule(rule);
    // skills = 全量声明集（含库里缺失的，ok=false）——面板勾选面板/编辑需要完整名单。
    out.skills = rule.skills.map((name) => ({ name, ok: agg.effective.includes(name) }));
    out.missing = out.skills.filter((s) => !s.ok).map((s) => s.name);
    out.changed = agg.changed;
    out.removed = agg.removed;
    out.containers = await distributeDir(cfg, agg.dir, rule.to, hubDirId(rule.to), {
      onlyIfParentExists: !rule.all,
    });
    log.info(
      { to: rule.to, all: rule.all, skills: agg.effective.length, containers: out.containers.length },
      'skills rule synced',
    );
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    log.warn({ to: rule.to, err: out.error }, 'skills rule sync failed');
  }
  return out;
}

// 规则同步：逐规则聚合 → 分发（all = 全部容器；否则按落点探测收窄）；孤儿副本
// （规则已删/改 to）按清单把分发过的条目从容器里清掉再删副本。从未配置过（全部
// 规则零技能且无任何副本）则整体跳过，不碰任何目录。
async function syncRules(cfg: Config): Promise<{ ok: boolean; rules: SkillRuleResult[] }> {
  const hub = await getSkillHub();
  const used = hub.rules.some((r) => r.skills.length > 0) || existsSync(SKILLS_DIR);
  if (!used) return { ok: true, rules: [] };
  const out: SkillRuleResult[] = [];
  let ok = true;

  for (const rule of hub.rules) {
    const res = await syncRule(cfg, rule);
    if (res.error) ok = false;
    out.push(res);
  }

  // 孤儿副本清理：规则已删/改 to 的副本 → 按清单把分发过的条目从容器收回来，再删
  // 副本与清单。范围口径重算：清单 to 还在存活规则里 = 沿用其口径；不在 = 曾是
  // 项目目标（收窄——孤儿多半是规则删除/改 to，原容器集合里落点判据依然成立）。
  let entries: string[] = [];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    /* 无目录 = 无孤儿 */
  }
  const aliveIds = new Set(hub.rules.map((r) => hubDirId(r.to)));
  const aliveAll = new Set(hub.rules.filter((r) => r.all).map((r) => r.to));
  for (const e of entries) {
    if (!e.startsWith('hub-') || !e.endsWith('.json')) continue;
    const id = e.slice(0, -'.json'.length);
    if (aliveIds.has(id)) continue;
    const manifest = await readManifest(id);
    if (manifest) {
      try {
        await distributeDir(cfg, join(SKILLS_DIR, id, '__gone__'), manifest.to, id, {
          onlyIfParentExists: !aliveAll.has(manifest.to),
        });
      } catch (err) {
        log.warn({ id, err: String(err) }, 'skills orphan cleanup failed');
      }
    }
    await rm(join(SKILLS_DIR, id), { recursive: true, force: true });
    await rm(join(SKILLS_DIR, `${id}.json`), { force: true }); // 清单本体一并删——漏了它孤儿每次同步都复活（distributeDir 还会把清单重写回去）
  }

  if (out.length) {
    log.info(
      { rules: out.map((r) => ({ to: r.to, all: r.all, skills: r.skills.length, missing: r.missing.length })) },
      'skills rules synced',
    );
  }
  return { ok, rules: out };
}

// —— 总入口 ——

// 内部全量同步（不加锁；syncSkillsAll/hubView 各自 exclusive 包一层——嵌套 exclusive
// 会死锁，runSync 绝不自己加锁）：迁移 → 库跟随刷新 → 规则同步（含孤儿清理）→ 旧
// 命名空间副本清理。
async function runSync(cfg: Config): Promise<SkillSyncResult> {
  const started = Date.now();
  await ensureLegacyMigrated(cfg);
  const { rules, ok } = await syncRules(cfg);
  await pruneStale();
  return { ok, rules, durationMs: Date.now() - started };
}

// 全量同步。手动/API/启动 sweep/watch 共用。
export async function syncSkillsAll(cfg: Config): Promise<SkillSyncResult> {
  return exclusive(() => runSync(cfg));
}

// 单目标补发（create()/容器 start 事件/宿主就地安装后调用；本机传 HOST_TARGET）：
// 聚合照跑（副本保鲜），只分发到这一个目标（项目目标按范围口径判这台要不要）。
// 尽力而为不抛。
export async function syncContainerSkills(cfg: Config, name: string): Promise<void> {
  await exclusive(async () => {
    try {
      await ensureLegacyMigrated(cfg);
      const home = name === HOST_TARGET ? homedir() : getEngine(cfg).hostHomePath(cfg, name);
      if (!home || !existsSync(home)) return;
      const hub = await getSkillHub();
      if (!hub.rules.some((r) => r.skills.length) && !existsSync(SKILLS_DIR)) return;
      for (const rule of hub.rules) {
        const agg = await aggregateRule(rule);
        await distributeDir(cfg, agg.dir, rule.to, hubDirId(rule.to), {
          only: [{ name, home }],
          onlyIfParentExists: !rule.all,
        });
      }
      log.info({ container: name }, 'skills distributed to container');
    } catch (e) {
      log.warn({ container: name, err: String(e) }, 'skills distribute to container failed');
    }
  });
}

// 就地安装（文件面板「安装技能」的主入口——pull 语义：人到哪个项目就装到哪；本机
// 同样可装，container 传 HOST_TARGET）：把库技能装进某目标当前浏览位置下的
// .claude/skills。语义 = 确保 <spot> 的安装规则存在（home 根下的全局落点 all=true；
// 项目落点 all=false，跟项目走——宿主与容器的同一项目共享同一条规则）+ 勾上这些技能
// + 立即为该目标分发一次。规则此后由同步系统接管（库更新跟走、出库自动清理）——
// 安装按钮只是规则系统的糖，不产生第二套记账。to 按 ~/rel 规范化（hubDirId 锚在 to，
// 同一落点两种写法必须是同一条规则）。
export async function installSkillsToSpot(
  cfg: Config,
  container: string,
  spot: string,
  skills: string[],
): Promise<{ to: string; all: boolean; created: boolean; ruleId: string }> {
  const isHost = container === HOST_TARGET;
  const home = isHost ? homedir() : getEngine(cfg).hostHomePath(cfg, container);
  if (!home || !existsSync(home)) {
    throw new Error(isHost ? '本机 home 不可见' : `容器 ${container} 的 home 不可见`);
  }
  // rel：宿主 spot 是真实宿主路径（相对 $HOME）；容器 spot 走契约前缀（/home/dev）。
  let rel = isHost ? hostHomeRel(spot) : containerRel(spot);
  if (!rel) throw new Error('安装位置不能是 home 根');
  // 归一到全局真身：home 直下的 ~/.claude/skills 是 ~/.agents/skills 的软链，
  // 规则统一落真身路径，防止同目录两条规则互相打架。
  if (rel === '.claude/skills') rel = '.agents/skills';
  const to = `~/${rel}`;
  const reg = await getSkillRegistry();
  const missing = skills.filter((n) => !reg.skills[n] || !existsSync(join(REGISTRY_DIR, n)));
  if (missing.length) throw new Error(`库中没有这些技能：${missing.join('、')}`);
  // 范围：规范的全局落点（~/.claude/skills、~/.agents/skills）铺全部容器；其余落点
  // 一律项目范围。
  const all = GLOBAL_RELS.includes(rel);
  const hub = await getSkillHub();
  let rule = hub.rules.find((r) => r.to === to);
  let created = false;
  if (!rule) {
    rule = { id: randomBytes(4).toString('hex'), to, all, skills: [], createdAt: new Date().toISOString() };
    hub.rules.push(rule);
    created = true;
  }
  for (const n of skills) if (!rule.skills.includes(n)) rule.skills.push(n);
  await setSkillHub(hub);
  await syncContainerSkills(cfg, container);
  log.info({ container, to, skills, created }, 'skills installed at spot');
  return { to, all, created, ruleId: rule.id };
}

// —— 面板视图与规则管理（routes 调用）——

// 面板视图：跑一次全量同步再返回规则列表（聚合顺带把副本刷新鲜并分发——readdir/
// 小拷贝级开销可忽略；面板即真相）。
export async function hubView(cfg: Config): Promise<SkillSyncResult> {
  return exclusive(() => runSync(cfg));
}

function findRule(hub: SkillHubState, id: string): SkillRule {
  const r = hub.rules.find((x) => x.id === id);
  if (!r) throw new Error(`规则不存在：${id}`);
  return r;
}

// 添加规则。to 全局唯一（聚合副本/清单按 to 锚定，撞了会互踩）。skills 允许空
// （先建去向再勾技能）；名字合法性不做库存在性校验——库里缺失在视图 missing 里可见。
export async function addSkillRule(_cfg: Config, to: string, all: boolean, skills: string[]): Promise<void> {
  containerRel(to);
  const hub = await getSkillHub();
  if (hub.rules.some((r) => r.to === to)) throw new Error(`去向已存在：${to}`);
  hub.rules.push({
    id: randomBytes(4).toString('hex'),
    to,
    all,
    skills: [...new Set(skills)],
    createdAt: new Date().toISOString(),
  });
  await setSkillHub(hub);
}

// 规则 patch：to 改址（旧位置由孤儿清理收回）/ all 切范围 / skills 全量替换
// （取消勾选的技能下次同步按清单从容器收回）。
export async function updateSkillRule(
  _cfg: Config,
  id: string,
  patch: { to?: string; all?: boolean; skills?: string[] },
): Promise<void> {
  const hub = await getSkillHub();
  const r = findRule(hub, id);
  if (patch.to !== undefined) {
    containerRel(patch.to);
    if (hub.rules.some((x) => x.id !== id && x.to === patch.to)) {
      throw new Error(`去向已存在：${patch.to}`);
    }
    r.to = patch.to;
  }
  if (patch.all !== undefined) r.all = patch.all;
  if (patch.skills !== undefined) r.skills = [...new Set(patch.skills)];
  await setSkillHub(hub);
}

// 删规则：副本变孤儿，下一次同步的孤儿清理按清单把分发过的条目从容器收回。
export async function deleteSkillRule(_cfg: Config, id: string): Promise<void> {
  const hub = await getSkillHub();
  findRule(hub, id);
  hub.rules = hub.rules.filter((x) => x.id !== id);
  await setSkillHub(hub);
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
  const r = await syncSkillsAll(cfg);
  const reg = await getSkillRegistry();
  if (!r.rules.length && !Object.keys(reg.skills).length) {
    process.stdout.write('>> 库是空的、也没有安装规则——面板「AI 工具 → 技能中心」入库技能并建规则\n');
    return;
  }
  for (const rule of r.rules) {
    process.stdout.write(
      `>> ${rule.to}${rule.all ? '' : '（仅已有该项目的容器）'}（${rule.skills.length} 个技能${
        rule.missing.length ? `，${rule.missing.length} 个库中缺失` : ''
      }）  ${rule.error ? `失败 — ${rule.error}` : ''}\n`,
    );
    for (const s of rule.missing) process.stdout.write(`>>   [缺失] ${s}\n`);
    for (const c of rule.containers) {
      process.stdout.write(
        `>>   ${targetDisplayName(c.name)}: ${c.ok ? `+${c.changed} 文件${c.removed ? ` -${c.removed} 陈旧` : ''}` : `失败 — ${c.error}`}\n`,
      );
    }
  }
  process.stdout.write(`>> skills 同步完成（${r.durationMs}ms）\n`);
  if (!r.ok) process.exit(1);
}

// CLI：mysandbox skills update [名…]——显式更新库条目（快照语义下库不会自己变；
// 不带名字 = 全部）。更新完统一同步分发一次。
export async function runSkillsUpdateCommand(cfg: Config, args: string[]): Promise<void> {
  const reg = await getSkillRegistry();
  const names = args.length ? args : Object.keys(reg.skills);
  if (!names.length) {
    process.stdout.write('>> 库是空的——面板「AI 工具 → 技能中心」入库技能后才能更新\n');
    return;
  }
  let failed = false;
  for (const name of names) {
    try {
      const r = await registryUpdate(cfg, name, { sync: false });
      process.stdout.write(r.changed
        ? `>> 已更新：${name}（来源 ${reg.skills[name]?.from ?? '?'})\n`
        : `>> 无变化：${name}（来源内容没变，已是最新）\n`);
    } catch (e) {
      failed = true;
      process.stdout.write(`>> 更新失败：${name} — ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  await runSkillsCommand(cfg);
  if (failed) process.exit(1);
}

// —— 技能库（registry）：唯一技能真相源。入库 / 出库 / 列表 / git 导入 ——

// 库目录：库内每技能一份独立副本，分发以库为源。
export const REGISTRY_DIR = join(SKILLS_DIR, 'registry');
// 分发 from 的特殊值：指向技能库目录（resolveSyncSource 识别）——legacy 迁移判定用。
export const REGISTRY_FROM = 'registry';

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const execFileP = promisify(execFile);

async function readRegistryMeta(): Promise<Record<string, SkillRegistryMeta>> {
  return (await getSkillRegistry()).skills;
}

// 把 srcDir 快照进库（校验 SKILL.md）。name 显式传入——更新路径保持条目名稳定，
// 不随来源目录改名漂移。
async function snapshotIntoLibrary(name: string, srcDir: string): Promise<void> {
  const st = await stat(srcDir).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`技能目录不存在：${srcDir}`);
  if (!existsSync(join(srcDir, 'SKILL.md'))) throw new Error(`不是技能目录（缺 SKILL.md）：${srcDir}`);
  await mkdir(REGISTRY_DIR, { recursive: true });
  await syncTree(srcDir, join(REGISTRY_DIR, name));
}

// —— 内容指纹（检查更新 / 更新比对的基准，meta.hash / meta.gitCommit）——

// 目录内容的规范 hash：排序相对路径 + \0 + 文件内容 逐段喂 sha256。跳过符号链接
// （与 syncTree 同语义）。同树必同值（跨机器/容器可比），路径或内容任一变化都改 hash。
async function hashTree(dir: string): Promise<string> {
  const h = createHash('sha256');
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(r);
      } else if (e.isFile()) {
        h.update(r);
        h.update('\0');
        h.update(await readFile(join(dir, r)));
        h.update('\0');
      }
    }
  };
  await walk('');
  return h.digest('hex');
}

// git from → { url, subPath }（'#' 分隔；registryUpdate 原内联逻辑提出共用）。
function parseGitFrom(from: string): { url: string; subPath: string } {
  const hash = from.indexOf('#');
  return { url: hash > 0 ? from.slice(0, hash) : from, subPath: hash > 0 ? from.slice(hash + 1) : '.' };
}

// git 来源的远端 HEAD commit（ls-remote 一次网络往返，免 clone——检查更新的快路径）。
async function gitRemoteCommit(url: string): Promise<string> {
  const { stdout } = await execFileP('git', ['ls-remote', url, 'HEAD'], { timeout: 30_000 });
  return stdout.split('\t')[0].trim();
}

// git clone 里记录的 commit（rev-parse HEAD；导入/更新时随指纹一起存 meta.gitCommit）。
async function gitRepoCommit(repo: string): Promise<string> {
  const { stdout } = await execFileP('git', ['-C', repo, 'rev-parse', 'HEAD'], { timeout: 30_000 });
  return stdout.trim();
}

// 弃缓存重 clone（更新/检查慢路径都要最新内容），返回子路径目录。
async function freshGitSubdir(url: string, subPath: string, timeoutMs = 300_000): Promise<string> {
  await rm(gitTmpDir(url), { recursive: true, force: true }); // 缓存 clone 弃掉——要最新
  const repo = await ensureGitClone(url, timeoutMs);
  return subPath === '.' ? repo : join(repo, subPath);
}

// 库条目的内容 hash（meta.hash 缺失时对库副本现算——旧数据自愈，调用方负责落盘）。
async function libraryHash(name: string): Promise<string> {
  return hashTree(join(REGISTRY_DIR, name));
}

// 入库：把一个技能目录（必须含 SKILL.md）拷进库。**一律快照**——来源改动不自动
// 进库（不订阅来源），更新走 registryUpdate。git 来源走 registryImportGit。
// name = 目录末段；库内同名 = 覆盖（force=false 时拒绝，由调用方确认后重试）。
export async function registryAdd(cfg: Config, from: string, force = false): Promise<{ name: string; replaced: boolean }> {
  if (from === REGISTRY_FROM) throw new Error('库不能以自己为来源入库');
  const { hostPath } = resolveSyncSource(cfg, from);
  const name = basename(hostPath.replace(/\/+$/, ''));
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能名不合法："${name}"`);
  const dst = join(REGISTRY_DIR, name);
  const replaced = existsSync(dst);
  if (replaced && !force) throw new Error(`库中已有同名技能：${name}（覆盖请确认）`);
  await snapshotIntoLibrary(name, hostPath);
  const meta = await readRegistryMeta();
  meta[name] = { from, importedAt: new Date().toISOString(), hash: await libraryHash(name) };
  await setSkillRegistry({ skills: meta });
  log.info({ name, from }, 'skill added to registry');
  return { name, replaced };
}

// 出库：删目录 + 删元数据。分发清理由调用方触发（路由层出库后 distributeSkills）——
// 全量同步按「聚合副本里已消失」把分发过的条目从容器收回。
export async function registryRemove(name: string): Promise<void> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能名不合法："${name}"`);
  await rm(join(REGISTRY_DIR, name), { recursive: true, force: true });
  const meta = await readRegistryMeta();
  delete meta[name];
  await setSkillRegistry({ skills: meta });
}

// 显式更新库条目（快照语义下库不会自己变——这是来源 →库的唯一更新通道）。**先比对
// 后动手**：来源内容指纹与库基线（meta.hash）一致 → 幂等空转（不重写库、不空转分发），
// 返回 changed:false；有变化才重拉替换 + 全量分发。git 源两层：meta.gitCommit 与
// ls-remote 一致 = 快路径直接判同（免 clone）；commit 前进了才 clone 下来比内容
// （commit 变 ≠ 子路径变）。目录源 = hashTree(来源目录) 直比（容器源宿主直读 rootfs）。
// 源没了 → 报错（库副本冻结保留）。opts.sync = 更新后全量分发（订阅侧语义：库变 →
// 安装位置跟走）；CLI 批量更新传 false，最后统一同步一次。
export async function registryUpdate(
  cfg: Config,
  name: string,
  opts: { sync?: boolean } = {},
): Promise<{ name: string; changed: boolean; sync: SkillSyncResult | null }> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能名不合法："${name}"`);
  const meta = await readRegistryMeta();
  const m = meta[name];
  if (!m) throw new Error(`库中没有这个技能：${name}`);
  // 基线 = 库副本当前内容（meta.hash 缺失时现算——旧数据自愈，收尾统一落盘）。
  const baseline = m.hash ?? (await libraryHash(name));
  let srcDir: string;
  let commit: string | undefined;
  if (isGitFrom(m.from)) {
    const { url, subPath } = parseGitFrom(m.from);
    if (m.gitCommit) {
      const remote = await gitRemoteCommit(url);
      if (remote === m.gitCommit) return { name, changed: false, sync: null };
    }
    srcDir = await freshGitSubdir(url, subPath);
    commit = await gitRepoCommit(srcDir); // rev-parse 对 repo 内子目录同样有效
  } else {
    srcDir = resolveSyncSource(cfg, m.from).hostPath;
  }
  // 内容没变：什么都不重铺。commit 基准跟上（下次走快路径），importedAt 不动（快照没换）。
  if ((await hashTree(srcDir)) === baseline) {
    if (commit) {
      meta[name] = { from: m.from, importedAt: m.importedAt, hash: baseline, gitCommit: commit };
      await setSkillRegistry({ skills: meta });
    }
    log.info({ name, from: m.from }, 'skill update: source unchanged, skipped');
    return { name, changed: false, sync: null };
  }
  await snapshotIntoLibrary(name, srcDir);
  // 显式重建字段（不 spread）——旧 meta 里可能残留已废弃的 follow 键，顺手洗掉。
  meta[name] = { from: m.from, importedAt: new Date().toISOString(), hash: await libraryHash(name), gitCommit: commit };
  await setSkillRegistry({ skills: meta });
  log.info({ name, from: m.from }, 'skill updated in registry');
  const sync = opts.sync === false ? null : await syncSkillsAll(cfg);
  return { name, changed: true, sync };
}

// —— 检查更新（只读比对，不动库不动分发）——

export interface SkillUpdateCheckResult {
  name: string;
  status: 'changed' | 'same' | 'error';
  message?: string; // error 原因 / same 的判定路径（如「commit 变了但内容没变」）
}

// 单条检查：来源指纹 vs 库基线。除旧数据自愈（补 meta.hash）外不写任何状态。
export async function registryCheckUpdate(_cfg: Config, name: string): Promise<SkillUpdateCheckResult> {
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能名不合法："${name}"`);
  const meta = await readRegistryMeta();
  const m = meta[name];
  if (!m) throw new Error(`库中没有这个技能：${name}`);
  const libDir = join(REGISTRY_DIR, name);
  if (!existsSync(libDir)) return { name, status: 'error', message: '库目录不在（元数据残留）' };
  const baseline = m.hash ?? (await libraryHash(name));
  if (!m.hash) {
    meta[name] = { ...m, hash: baseline };
    await setSkillRegistry({ skills: meta });
  }
  try {
    if (isGitFrom(m.from)) {
      const { url, subPath } = parseGitFrom(m.from);
      let commit: string;
      try {
        commit = await gitRemoteCommit(url);
      } catch (e) {
        return { name, status: 'error', message: `ls-remote 失败：${e instanceof Error ? e.message : String(e)}` };
      }
      // 快路径：commit 没变 = 内容没变（subPath 属于该 commit）。
      if (m.gitCommit && commit === m.gitCommit) return { name, status: 'same' };
      // 慢路径：commit 前进了（或无基准）——clone 下来比内容（60s 超时：检查是
      // 轻量动作，网络不通快速报错，别把批量检查拖几分钟）。
      const srcDir = await freshGitSubdir(url, subPath, 60_000);
      const changed = (await hashTree(srcDir)) !== baseline;
      return { name, status: changed ? 'changed' : 'same', message: changed ? undefined : 'commit 变了但内容没变' };
    }
    const srcDir = resolveSyncSource(_cfg, m.from).hostPath;
    if (!existsSync(srcDir)) return { name, status: 'error', message: `来源不在：${m.from}` };
    const changed = (await hashTree(srcDir)) !== baseline;
    return { name, status: changed ? 'changed' : 'same' };
  } catch (e) {
    return { name, status: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}

// 批量检查（面板头部「检查更新」）：p-limit 并发（git 源有网络往返），单条失败
// 不拖垮整批——每条独立 status，前端按卡片标徽标。
export async function registryCheckUpdates(cfg: Config): Promise<SkillUpdateCheckResult[]> {
  const meta = await readRegistryMeta();
  const limit = pLimit(4);
  return Promise.all(Object.keys(meta).map((n) => limit(() => registryCheckUpdate(cfg, n).catch(
    (e): SkillUpdateCheckResult => ({ name: n, status: 'error', message: e instanceof Error ? e.message : String(e) }),
  ))));
}

export interface SkillRegistryItem {
  name: string;
  description: string;
  from: string; // 导入来源（元数据；缺失 = 空串）
  importedAt: string;
  exists: boolean; // 目录还在（false = 元数据残留，展示为缺失）
}

// 库列表：readdir registry + 每技能读 SKILL.md frontmatter，合并 sidecar 元数据。
export async function registryList(): Promise<SkillRegistryItem[]> {
  const meta = await readRegistryMeta();
  let names: string[] = [];
  try {
    names = (await readdir(REGISTRY_DIR, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    /* 库还没建 = 空 */
  }
  const out: SkillRegistryItem[] = [];
  for (const name of names) {
    let description = '';
    try {
      const raw = await readFile(join(REGISTRY_DIR, name, 'SKILL.md'), 'utf8');
      description = fmValue(/^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? '', 'description');
    } catch {
      /* 无 SKILL.md：description 空 */
    }
    out.push({
      name,
      description,
      from: meta[name]?.from ?? '',
      importedAt: meta[name]?.importedAt ?? '',
      exists: true,
    });
  }
  // 元数据残留（目录被外部删了）：列出但 exists=false，用户可顺手清掉。
  for (const name of Object.keys(meta)) {
    if (!names.includes(name)) {
      out.push({
        name,
        description: '',
        from: meta[name].from,
        importedAt: meta[name].importedAt,
        exists: false,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// —— git URL 导入（外部技能）：depth-1 clone 到临时目录，探测候选，按需入库 ——

function gitTmpDir(url: string): string {
  return join(tmpdir(), `mysandbox-skill-${createHash('sha1').update(url).digest('hex').slice(0, 12)}`);
}

// depth-1 clone（已存在则复用）。filter=blob:none 跳过非必要 blob——monorepo
// （如 shadcn-vue）不带它 120s 都拉不完，带上后秒级。git 超时兜底 300s（检查更新
// 的慢路径传更短的——网络不通时不该把批量检查拖住几分钟）。
async function ensureGitClone(url: string, timeoutMs = 300_000): Promise<string> {
  if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(url)) throw new Error(`git 地址不识别："${url}"`);
  const dst = gitTmpDir(url);
  if (existsSync(join(dst, '.git'))) return dst;
  await mkdir(dirname(dst), { recursive: true });
  await rm(dst, { recursive: true, force: true });
  await execFileP('git', ['clone', '--depth', '1', '--filter=blob:none', url, dst], { timeout: timeoutMs });
  return dst;
}

export interface SkillGitCandidate {
  path: string; // repo 内子路径（'.' = repo 根即是技能）
  name: string; // 技能名（目录名）
}

// 探测 repo 里的技能候选：根 SKILL.md 优先；否则一层/两层深扫 SKILL.md
// （skills-lock 约定 skills/<名>/ 与常见 <名>/SKILL.md 两种形状）。
export async function registryProbeGit(url: string): Promise<SkillGitCandidate[]> {
  const repo = await ensureGitClone(url);
  const out: SkillGitCandidate[] = [];
  if (existsSync(join(repo, 'SKILL.md'))) return [{ path: '.', name: basename(repo) }];
  for (const depth of [['skills'], ['.']]) {
    const base = join(repo, ...depth);
    let entries: Dirent[] = [];
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (existsSync(join(base, e.name, 'SKILL.md'))) {
        const rel = depth[0] === '.' ? e.name : `${depth[0]}/${e.name}`;
        out.push({ path: rel, name: e.name });
      }
    }
    if (out.length) break; // skills/ 层命中就用它，不再扫根层
  }
  return out;
}

// 按探测结果导入：subPath = registryProbeGit 返回的 path（'.' = repo 根）。
// git来源 = 快照——版本化在仓库侧，更新走 registryUpdate（弃缓存 clone 重拉）。
export async function registryImportGit(
  cfg: Config,
  url: string,
  subPath: string,
  force = false,
): Promise<{ name: string; replaced: boolean }> {
  const repo = await ensureGitClone(url);
  const src = subPath === '.' ? repo : join(repo, subPath);
  const name = basename(src.replace(/\/+$/, ''));
  if (!SKILL_NAME_RE.test(name)) throw new Error(`技能名不合法："${name}"`);
  const dst = join(REGISTRY_DIR, name);
  const replaced = existsSync(dst);
  if (replaced && !force) throw new Error(`库中已有同名技能：${name}（覆盖请确认）`);
  await snapshotIntoLibrary(name, src);
  const meta = await readRegistryMeta();
  meta[name] = {
    from: `${url}#${subPath}`,
    importedAt: new Date().toISOString(),
    hash: await libraryHash(name),
    gitCommit: await gitRepoCommit(repo),
  };
  await setSkillRegistry({ skills: meta });
  log.info({ name, url, subPath }, 'skill imported to registry from git');
  return { name, replaced };
}

// —— 已安装清单（inventory）：宿主 + 受管容器的标准 skills 落点只读扫描 ——

// 落点（相对 home）。加新工具支持 = 加一行；不存在/不可读的落点静默跳过。
// 宿主与容器同一份清单（契约 home=/home/dev，宿主 $HOME 同形）。
const INVENTORY_SPOTS = ['.agents/skills'];

// 项目级落点动态发现：home 顶层非隐藏目录下的 .claude/skills（存在才列）。
// 项目的 skills 也是「能用的 skills」（agent 在项目内加载），不扫就答不全；
// 这也是 hub 挂源最常见的位置（mytest:~/proj/.claude/skills）。
async function projectSpots(home: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const spot = `${e.name}/.claude/skills`;
    try {
      if ((await stat(join(home, spot))).isDirectory()) out.push(spot);
    } catch {
      /* 无此落点 */
    }
  }
  return out;
}

export interface SkillInventoryEntry {
  dir: string; // 目录名（安装名）
  name: string; // SKILL.md frontmatter name（缺省 = 目录名）
  description: string; // frontmatter description（可空）
  spot: string; // 所在落点（相对 home）
  managed: boolean; // 被 hub 目标 / config 静态规则分发管理（manifest 命中——摘源/删目标会自动清理）
}

export interface SkillInventoryLocation {
  name: string; // 'host'（本机）或容器名
  kind: 'host' | 'container';
  home: string;
  ok: boolean;
  error?: string;
  skills: SkillInventoryEntry[];
}

export interface SkillInventoryView {
  locations: SkillInventoryLocation[];
  durationMs: number;
}

// frontmatter 单行值；块标量（> / |）取紧跟的缩进行首行。skills 的 frontmatter
// 就两个字段有用（name/description），不值得为此引 YAML 解析器。
function fmValue(fm: string, key: string): string {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(fm);
  if (!m) return '';
  let v = m[1].trim();
  if (/^[>|][+-]?\d*$/.test(v)) {
    const rest = fm.slice((m.index ?? 0) + m[0].length);
    v = rest.split('\n').find((l) => l.trim())?.trim() ?? '';
  }
  return v.replace(/^['"]|['"]$/g, '');
}

async function readSkillEntry(dir: string, spot: string, managedDirs: Set<string>): Promise<SkillInventoryEntry | null> {
  let raw: string;
  try {
    raw = await readFile(join(dir, 'SKILL.md'), 'utf8');
  } catch {
    return null; // 无 SKILL.md 的顶层条目不是 skill
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? '';
  const base = basename(dir);
  return {
    dir: base,
    name: fmValue(fm, 'name') || base,
    description: fmValue(fm, 'description'),
    spot,
    managed: managedDirs.has(base),
  };
}

// manifest 全读（安装规则的 hub-*.json 清单；旧静态规则清单已被 pruneStale 清掉，
// 读不到自然跳过）：to（相对 home）
// → 该位置被分发管理的顶层条目集。只做展示对照，不影响任何分发语义。
async function managedIndex(): Promise<Map<string, Set<string>>> {
  const idx = new Map<string, Set<string>>();
  let entries: string[] = [];
  try {
    entries = (await readdir(SKILLS_DIR)).filter((e) => e.endsWith('.json'));
  } catch {
    return idx; // 从未同步过 = 无 manifest
  }
  for (const e of entries) {
    const manifest = await readManifest(e.slice(0, -'.json'.length));
    if (!manifest) continue;
    try {
      const rel = containerRel(manifest.to);
      const set = idx.get(rel) ?? new Set<string>();
      for (const n of manifest.distributed) set.add(n);
      idx.set(rel, set);
    } catch {
      /* to 形态不合法的旧清单，跳过 */
    }
  }
  return idx;
}

async function scanInventoryLocation(
  name: string,
  kind: 'host' | 'container',
  home: string,
  managed: Map<string, Set<string>>,
): Promise<SkillInventoryLocation> {
  const loc: SkillInventoryLocation = { name, kind, home, ok: true, skills: [] };
  try {
    const spots = [...INVENTORY_SPOTS, ...(await projectSpots(home))];
    for (const spot of spots) {
      let entries: Dirent[];
      try {
        entries = await readdir(join(home, spot), { withFileTypes: true });
      } catch {
        continue; // 落点不存在/不可读 = 该处无 skill
      }
      const dirs = managed.get(spot) ?? new Set<string>();
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const ent = await readSkillEntry(join(home, spot, e.name), spot, dirs);
        if (ent) loc.skills.push(ent);
      }
    }
  } catch (err) {
    loc.ok = false;
    loc.error = err instanceof Error ? err.message : String(err);
  }
  return loc;
}

// 分发目标（distributeTargets：本机 + 受管容器，home 可见口径同 sweepContainerCli）
// 逐一扫描。纯 readdir + SKILL.md 小文件读（D1 直读 rootfs，容器不必在跑），几十毫秒级，GET 即扫。
export async function skillInventory(cfg: Config): Promise<SkillInventoryView> {
  const started = Date.now();
  const [managed, targets] = await Promise.all([managedIndex(), distributeTargets(cfg)]);
  const locations = await Promise.all(
    targets.map((t) => scanInventoryLocation(t.name, t.name === HOST_TARGET ? 'host' : 'container', t.home, managed)),
  );
  return { locations, durationMs: Date.now() - started };
}

// CLI：mysandbox skills ls
export async function runSkillsListCommand(cfg: Config): Promise<void> {
  const view = await skillInventory(cfg);
  for (const loc of view.locations) {
    const label = loc.kind === 'host' ? 'host（本机）' : loc.name;
    if (!loc.ok) {
      process.stdout.write(`>> ${label}：扫描失败 — ${loc.error}\n`);
      continue;
    }
    process.stdout.write(`>> ${label}：${loc.skills.length} 个 skill\n`);
    for (const s of loc.skills) {
      const tags = [s.spot, s.managed ? 'hub' : ''].filter(Boolean).join(', ');
      process.stdout.write(`>>   ${s.name}  [${tags}]${s.description ? `  ${s.description}` : ''}\n`);
    }
  }
  process.stdout.write(`>> 扫描完成（${view.durationMs}ms）\n`);
}
