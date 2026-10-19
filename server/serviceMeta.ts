// compose/<名>/meta.json —— 每项目一份的策展文件（state.json 的 services 键退役后的落点）。
//
// 设计：配置真相永远在 compose.yaml（自有项目）或原编排方的文件（外部栈），本文件只放
// 「compose 文件里放不下的东西」——显示名/描述/入口与升格标记（用户策展，无处派生）/
// 外部栈的成员记账（容器名 + 我们在服务网络上给的 IP，停机占用记账用）。目录在即受管，
// 「metaMissing」这类悬空状态从此不存在。
//
// 两种形状：
// - 自有项目（compose.yaml 同目录）：{ displayName?, description?, entry?, listed? }
//   ——成员从 compose 文件现读，这里只记策展 flag（entry = 服务 key，listed = key 数组）。
// - 外部栈（只读收编，目录里只有本文件）：{ external: {file, workdir?}, preset?, image?,
//   description?, createdAt?, members: [...] } ——成员容器名/IP 必须记账（compose down
//   后容器没了，project label 派生不出缺席成员；IP 是我们 connect --ip 给的，停机后
//   network inspect 看不见）。
//
// 历史包袱（state.json services 键的 env/command/image/volume/ports）不迁——compose 底账
// v2 起「文件是唯一配置真相」，那些字段自迁移日起就是死数据（见 migrateLegacyServiceMeta）。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { log } from './logger.js';
import { composeDir, listProjectDirs, readComposeProject } from './serviceCompose.js';
import { listComposeProjectContainers, listServiceContainers, rowLabels, type DockerContainerRow } from './docker.js';

export interface ProjectMemberRef {
  name: string; // compose service key（显示用）
  container: string; // 实际容器名（docker 操作锚点）
  ip?: string; // 我们在服务网络上的静态 IP（停机占用记账）
  entry?: boolean; // 入口容器：栈卡片的锚
  listed?: boolean; // 用户「加入列表」——升格为独立卡片
}

export interface ProjectMeta {
  displayName?: string;
  description?: string;
  createdAt?: string;
  // 外部栈（只读收编）：底账在原编排方，本目录只有 meta.json。file = 原 compose 文件。
  external?: { file: string | null; workdir?: string | null };
  preset?: string; // 外部栈展示用（'adopted'）
  image?: string; // 外部栈展示用（入口镜像）
  // 自有项目：策展 flag（成员清单以 compose 文件为准，这里只记 key）
  entry?: string; // 入口服务的 service key
  listed?: string[]; // 「加入列表」的服务 key 集
  // 外部栈：成员记账（container/ip/entry/listed——与 docker 里派不出来的部分）
  members?: ProjectMemberRef[];
  // 升格成员卡片的显示名（key = 容器名——两种项目形态的卡片名都是容器名，统一键）
  memberNames?: Record<string, string>;
}

const metaFileOf = (name: string): string => `${composeDir(name)}/meta.json`;

export async function readProjectMeta(name: string): Promise<ProjectMeta | null> {
  try {
    const raw = JSON.parse(await readFile(metaFileOf(name), 'utf8')) as ProjectMeta;
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

// 整读改写（读-合并-写）：调用方拿返回值改完传回，或直接传 patch 合并。
export async function writeProjectMeta(name: string, patch: Partial<ProjectMeta>): Promise<ProjectMeta> {
  const dir = composeDir(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const next = { ...(await readProjectMeta(name)), ...patch };
  await writeFile(metaFileOf(name), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

// 外部栈入口：成员里 flag 的优先，否则第一个（services.ts 与 findServiceTarget 共用，
// 单源在这是为了两处入口选择口径一致）。
export function pickExternalEntry(members: ProjectMemberRef[]): ProjectMemberRef {
  return members.find((s) => s.entry) ?? members[0];
}

// 外部栈判定：目录带 external 标记（目录里没有 compose.yaml——有就不是外部栈）。
export async function isExternalProject(name: string): Promise<boolean> {
  return (await readProjectMeta(name))?.external != null;
}

// 按容器名反查所属外部栈（栈成员的启停自愈/取消收编路由用）。
export async function externalProjectOfContainer(container: string): Promise<{ key: string; meta: ProjectMeta } | null> {
  for (const dir of await listProjectDirs()) {
    const m = await readProjectMeta(dir);
    if (m?.external && m.members?.some((s) => s.container === container)) return { key: dir, meta: m };
  }
  return null;
}

// —— 一次性迁移：state.json 的 services 键 → 每目录 meta.json（load() 时触发） ——
// 迁移规则：adopted 外部栈 → stub 目录 meta.json（external + members 全保留）；有 compose
// 目录的 → 策展字段（displayName/description/createdAt）；只读收编单容器（无底账）→
// 已退役形态，没有等价落点——留条 warn，容器退回外部容器（收编 Inbox 可重新接管收编）。
// env/command/image 等旧字段刻意不迁：compose 底账 v2 起文件是唯一真相，那些自迁移起
// 就是死数据。返回须从 state 里删掉的键集（迁走的 + 无法迁移的都删）。
export async function migrateLegacyServiceMeta(services: Record<string, Record<string, unknown>>): Promise<Set<string>> {
  const done = new Set<string>();
  for (const [name, m] of Object.entries(services)) {
    try {
      const adopted = m.adopted === true;
      const stack = m.stack as { file?: string | null; workdir?: string | null; services?: ProjectMemberRef[] } | undefined;
      if (adopted && stack) {
        await writeProjectMeta(name, {
          external: { file: stack.file ?? null, workdir: stack.workdir ?? null },
          preset: 'adopted',
          image: typeof m.image === 'string' ? m.image : undefined,
          displayName: typeof m.displayName === 'string' ? m.displayName : undefined,
          description: typeof m.description === 'string' ? m.description : undefined,
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : undefined,
          members: stack.services ?? [],
        });
      } else if (m.displayName || m.description || m.createdAt) {
        await writeProjectMeta(name, {
          displayName: typeof m.displayName === 'string' ? m.displayName : undefined,
          description: typeof m.description === 'string' ? m.description : undefined,
          createdAt: typeof m.createdAt === 'string' ? m.createdAt : undefined,
        });
      } else if (adopted) {
        log.warn({ name }, 'state.services 迁移：只读收编单容器已退役（无 compose 底账），条目丢弃——容器退回外部，可重新接管收编');
      }
    } catch (e) {
      // 单条失败不阻塞其余迁移与启动
      log.warn({ err: String(e), name }, 'state.services → meta.json 迁移失败，条目丢弃');
    }
    done.add(name);
  }
  return done;
}

// —— 受管服务目标判定（原「label 集 ∪ 收编名集」双源的坍缩）——
// :name 的合法目标 = 目录项目（compose.yaml）∪ 外部栈 stub（项目名或成员容器名）∪
// 受管行（我们的 label 集 ∪ compose project label ∈ 目录集）。未收编的外部容器
// （dener-* 等）结构性查不到——同名也 404。服务文件面板 / peer exec / 复制跨面板等
// 单点判定共用这一个函数。
export interface ServiceTargetHit {
  kind: 'project' | 'stub' | 'row';
  project: string; // 所属项目名（row 形态可能是旧版残留行，取容器名）
  container: string; // docker 操作锚（容器名；目录项目解析到入口/唯一容器）
  running: boolean | null; // null = 无容器行（未创建 / stub 成员缺席）
}

const rowNameOf = (names: string): string => names.split(',')[0].replace(/^\//, '');

export async function findServiceTarget(name: string): Promise<ServiceTargetHit | null> {
  const dirs = await listProjectDirs();
  if (dirs.includes(name)) {
    const pm = await readProjectMeta(name);
    if (pm?.external) {
      const members = pm.members ?? [];
      if (!members.length) return null;
      const entry = pickExternalEntry(members);
      const row = await containerRow(entry.container, dirs);
      return { kind: 'stub', project: name, container: entry.container, running: row ? row.State === 'running' : null };
    }
    const proj = await readComposeProject(name);
    const rows = await listComposeProjectContainers([name]);
    const byKey = new Map(rows.map((r) => [rowLabels(r)['com.docker.compose.service'] ?? rowNameOf(r.Names), r]));
    const pick = proj
      ? (proj.services.find((s) => s.key === pm?.entry) ?? proj.services.find((s) => s.ports.length) ?? proj.services[0])
      : undefined;
    const row = pick ? byKey.get(pick.key) : undefined;
    return {
      kind: 'project',
      project: name,
      container: row ? rowNameOf(row.Names) : (pick?.containerName ?? name),
      running: row ? row.State === 'running' : null,
    };
  }
  const owner = await externalProjectOfContainer(name);
  if (owner) {
    const row = await containerRow(name, dirs);
    return { kind: 'stub', project: owner.key, container: name, running: row ? row.State === 'running' : null };
  }
  const row = await containerRow(name, dirs);
  if (row) {
    return {
      kind: 'row',
      project: rowLabels(row)['com.docker.compose.project'] ?? name,
      container: name,
      running: row.State === 'running',
    };
  }
  return null;
}

// 行查找：我们的 label 集 ∪ compose project label ∈ 目录集。listServiceContainers
// 挂了（daemon 瞬时故障）降级空——目录命中路径不受影响，行命中宁可 404（同旧双源口径）。
async function containerRow(name: string, dirs: string[]): Promise<DockerContainerRow | null> {
  const all = [...(await listServiceContainers()), ...(await listComposeProjectContainers(dirs))];
  return all.find((r) => rowNameOf(r.Names) === name) ?? null;
}
