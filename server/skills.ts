// 技能中心路由（/api/skills/*）：技能库（registry）× 分发规则 × 已装清单的路由面
// （server/skillSync.ts）。从 routes.ts 拆出对齐 base/services/ai 的模块惯例。鉴权走
// index.ts 全局 hook，本模块不自行处理。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { getSkillHub, getSkillRegistry } from './aiState.js';
import { HttpError } from './errors.js';
import { log } from './logger.js';
import {
  syncSkillsAll,
  hubView,
  addSkillRule,
  updateSkillRule,
  deleteSkillRule,
  installSkillsToSpot,
  skillInventory,
  registryList,
  registryAdd,
  registryRemove,
  registryUpdate,
  registryCheckUpdate,
  registryCheckUpdates,
  registryProbeGit,
  registryImportGit,
} from './skillSync.js';

export async function registerSkillRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // —— skills 同步（server/skillSync.ts）：手动触发一次全量同步（watch/启动 sweep 之外）——
  // 不收任何路径参数：规则只来自 sidecar（面板/API 管理），API 无法被用来指路。
  app.post('/api/skills/sync', async () => {
    const hub = await getSkillHub();
    const reg = await getSkillRegistry();
    if (!hub.rules.some((r) => r.skills.length) && !Object.keys(reg.skills).length) {
      throw new HttpError(400, '技能库是空的、也没有安装规则（面板「AI 工具 → 技能中心」配置）', 'bad_request');
    }
    return syncSkillsAll(cfg);
  });

  // 库内容动作（入库/出库/git 导入）后的显式分发——库目录不再挂 fs.watch（同步语义
  // 全显式化），这三个动作是原先靠 watch 兜底分发的唯一入口。不等待：同步耗时随
  // 容器数线性涨，别拖住 HTTP 响应；互斥链保证与手动同步串行。
  function distributeSkills(cfg: Config): void {
    void syncSkillsAll(cfg).catch((err) => log.warn({ err: String(err) }, 'skills distribute after registry change failed'));
  }

  // —— 技能分发规则 CRUD。规则 = {库内技能集合, 去向, 范围}，库（registry）是唯一
  // 技能真相源。表单校验在此处转 4xx，重复去向转 409；视图（GET /hub）是一次全量
  // 同步的返回（聚合副本刷新 + 分发结果）。——
  app.get('/api/skills/hub', async () => hubView(cfg));

  app.post('/api/skills/rules', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const to = String(body.to ?? '').trim();
    if (!to) throw new HttpError(400, 'to 必填（容器内目标路径，如 ~/.claude/skills）', 'bad_request');
    const skills = Array.isArray(body.skills) ? body.skills.map(String) : [];
    try {
      await addSkillRule(cfg, to, body.all === true, skills);
    } catch (e) {
      throw new HttpError(409, e instanceof Error ? e.message : String(e), 'conflict');
    }
    return hubView(cfg);
  });

  app.patch('/api/skills/rules/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: { to?: string; all?: boolean; skills?: string[] } = {};
    if (typeof body.to === 'string' && body.to.trim()) patch.to = body.to.trim();
    if (typeof body.all === 'boolean') patch.all = body.all;
    if (Array.isArray(body.skills)) patch.skills = body.skills.map(String);
    if (!Object.keys(patch).length) throw new HttpError(400, 'to / all / skills 至少给一个', 'bad_request');
    try {
      await updateSkillRule(cfg, id, patch);
    } catch (e) {
      throw new HttpError(404, e instanceof Error ? e.message : String(e), 'not_found');
    }
    return hubView(cfg);
  });

  app.delete('/api/skills/rules/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    try {
      await deleteSkillRule(cfg, id);
    } catch (e) {
      throw new HttpError(404, e instanceof Error ? e.message : String(e), 'not_found');
    }
    return hubView(cfg);
  });

  // —— skills 已安装清单：宿主 + 受管容器的标准落点只读扫描（落点常量在 skillSync.ts，
  // 不收任何路径参数）。纯 readdir + SKILL.md 读，容器不必在跑。——
  app.get('/api/skills/inventory', async () => skillInventory(cfg));

  // —— 技能库（registry）：用户策展的权威技能集。入库的 from 形态由 resolveSyncSource
  // 校验（容器:路径 / 宿主路径），git 导入走专门探测+导入两步。——
  app.get('/api/skills/registry', async () => registryList());

  app.post('/api/skills/registry', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const from = String(body.from ?? '').trim();
    if (!from) throw new HttpError(400, 'from 必填（技能目录：<容器名>:<路径> 或宿主路径）', 'bad_request');
    try {
      const r = await registryAdd(cfg, from, body.force === true);
      distributeSkills(cfg); // 入库后显式分发（不等待——同步耗时随容器数，别拖住响应）
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('不合法') || msg.includes('不存在') || msg.includes('缺 SKILL.md')) {
        throw new HttpError(400, msg, 'bad_request');
      }
      if (msg.includes('已有同名')) throw new HttpError(409, msg, 'conflict');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  app.delete('/api/skills/registry/:name', async (req) => {
    try {
      await registryRemove((req.params as { name: string }).name);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e), 'bad_request');
    }
    distributeSkills(cfg); // 出库后显式分发（孤儿清理按清单收回容器上的旧条目）
    return registryList();
  });

  // 显式更新库条目：库是静态快照（来源改动不自动进库）。先比对内容指纹——来源没变
  // 幂等空转（changed:false），变了才重拉 + 全量分发（订阅侧只认库）。
  app.post('/api/skills/registry/:name/update', async (req) => {
    const name = (req.params as { name: string }).name;
    try {
      return await registryUpdate(cfg, name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('库中没有')) throw new HttpError(404, msg, 'not_found');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  // 检查更新（只读指纹比对，不动库不动分发）：单条 + 批量（头部「检查更新」，逐条
  // 独立 status，git 源的 ls-remote 失败不拖垮整批）。
  app.post('/api/skills/registry/check-updates', async () => ({ results: await registryCheckUpdates(cfg) }));

  app.post('/api/skills/registry/:name/check-update', async (req) => {
    const name = (req.params as { name: string }).name;
    try {
      return await registryCheckUpdate(cfg, name);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('库中没有')) throw new HttpError(404, msg, 'not_found');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  // git 导入：不带 path = 探测候选（不导入）；带 path = 导入该候选。
  app.post('/api/skills/registry/git', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const url = String(body.url ?? '').trim();
    if (!url) throw new HttpError(400, 'url 必填（git 仓库地址）', 'bad_request');
    const path = typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
    try {
      if (!path) return { candidates: await registryProbeGit(url) };
      const r = await registryImportGit(cfg, url, path, body.force === true);
      distributeSkills(cfg); // git 导入后显式分发（同入库）
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('已有同名')) throw new HttpError(409, msg, 'conflict');
      throw new HttpError(400, msg, 'bad_request');
    }
  });

  // —— skills 就地安装（文件面板「安装技能」的主入口）：pull 语义——人在哪个项目
  // 就装到哪。确保 <spot> 的安装规则存在（全局落点铺全部容器 / 项目落点跟项目走）
  // + 勾上这些技能 + 立即为该容器分发一次；规则此后由同步系统接管。不收任意写路径：
  // spot 限于 dev home 内（containerRel 校验），技能必须已在库里。——
  app.post('/api/skills/install', async (req) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const container = String(body.container ?? '').trim();
    const spot = String(body.spot ?? '').trim();
    const skills = Array.isArray(body.skills) ? [...new Set(body.skills.map(String))] : [];
    if (!container || !spot || !skills.length) {
      throw new HttpError(400, 'container / spot / skills 必填', 'bad_request');
    }
    try {
      return await installSkillsToSpot(cfg, container, spot, skills);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e), 'bad_request');
    }
  });

}
