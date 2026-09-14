// TestLens 批量配置（设置弹框「TestLens」分区）：往目标 home 写两份种子文件——
//   ~/.agent-browser/config.json {"cdp": <地址>}（agent-browser 直连 TestLens 托管
//   Chrome 的 CDP 端点）+ ~/.testlens.json {"host": <地址>}（testlens CLI 配置）。
//
// 约定（名字即契约）：容器内走 hosts 服务块的服务名 http://testlens:<port>；本机
// 换算 http://localhost:<port>（端口已发布到宿主，服务名在宿主不可解析）。
//
// 文件即真相：view 读各目标 home 的实际文件值（不存 sidecar 状态，改了文件刷新即见）；
// install 读-改-写 JSON 合并——只动 cdp/host 两个键，project/token 等用户键原样保留。
// 项目级 .testlens.json 靠 CLI 从 cwd 向上查找天然优先于 home 种子（repo 文件先命中），
// 本模块只写 home 兜底默认值，两者互不干扰。
//
// home 直写与 aiconfig 同形（D1 uid 直通，容器不必在跑；宿主 home 同样直写）。

import { homedir } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Config } from './config.js';
import { listManaged } from './engine/index.js';
import { HOST_TARGET, getAllServiceMeta } from './state.js';
import { homeOf } from './aiconfig.js';
import { HttpError } from './errors.js';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// TestLens 服务名（state.services 的 key）：suggest 与默认地址都从它来。
const SERVICE_NAME = 'testlens';

export interface TestlensTargetView {
  id: string; // 容器名 | '__host__'
  name: string; // 展示名（'本机' / 容器名）
  agentBrowser: string | null; // ~/.agent-browser/config.json 的 cdp 值
  testlensJson: string | null; // ~/.testlens.json 的 host 值
  error?: string; // home 缺失/读失败（目标仍列出，便于弹框点名）
}

export interface TestlensView {
  targets: TestlensTargetView[];
  suggestedHost: string | null; // 检测到 testlens 服务时给约定地址，否则 null
}

export interface TestlensInstallItem {
  id: string;
  name: string;
  ok: boolean;
  files: { file: string; action: 'created' | 'merged' | 'overwritten' | 'same' }[];
  error?: string;
}

const AGENT_BROWSER_REL = '.agent-browser/config.json';
const TESTLENS_REL = '.testlens.json';

function targetName(target: string): string {
  return target === HOST_TARGET ? '本机' : target;
}

// 读 JSON 对象文件；缺失/坏 JSON/非对象一律 null（调用方自行区分语义）。
async function readJsonObject(p: string): Promise<Record<string, unknown> | null> {
  try {
    const obj = JSON.parse(await readFile(p, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function viewOne(cfg: Config, target: string): Promise<TestlensTargetView> {
  const base: TestlensTargetView = {
    id: target,
    name: targetName(target),
    agentBrowser: null,
    testlensJson: null,
  };
  const home = homeOf(cfg, target);
  if (!home || !existsSync(home)) return { ...base, error: 'home 不可达（rootfs 未就绪或非标准布局）' };
  const ab = await readJsonObject(path.join(home, AGENT_BROWSER_REL));
  const tl = await readJsonObject(path.join(home, TESTLENS_REL));
  return {
    ...base,
    agentBrowser: typeof ab?.cdp === 'string' ? (ab.cdp as string) : null,
    testlensJson: typeof tl?.host === 'string' ? (tl.host as string) : null,
  };
}

// 服务名地址换算本机地址：http://testlens:10004 → http://localhost:10004。
// 非 localhost 换算（用户填了 IP/域名）原样返回——本机写什么由用户填的值负责，
// 只有约定服务名形态才需要换算（宿主解析不了容器 hosts 名）。
function hostSideUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === SERVICE_NAME) u.hostname = 'localhost';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url;
  }
}

// 单目标写两份种子。读-改-写合并：键值已一致 = 'same'（不刷 mtime）；坏 JSON = 整体
// 覆盖并标注 'overwritten'（用户显式动作，但要点名）；其余保留用户键只动目标键。
async function seedOneFile(
  home: string,
  rel: string,
  key: string,
  value: string,
): Promise<TestlensInstallItem['files'][number]> {
  const p = path.join(home, rel);
  let obj: Record<string, unknown> = {};
  let action: TestlensInstallItem['files'][number]['action'] = 'created';
  const existing = await readJsonObject(p);
  if (existing) {
    if (existing[key] === value) return { file: rel, action: 'same' };
    obj = existing;
    action = 'merged';
  } else if (existsSync(p)) {
    action = 'overwritten'; // 文件在但坏 JSON/非对象：显式覆盖
  }
  obj[key] = value;
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  return { file: rel, action };
}

async function installOneTarget(cfg: Config, target: string, hostUrl: string): Promise<TestlensInstallItem> {
  const item: TestlensInstallItem = { id: target, name: targetName(target), ok: false, files: [] };
  try {
    const home = homeOf(cfg, target);
    if (!home || !existsSync(home)) {
      item.error = 'home 不可达（rootfs 未就绪或非标准布局）';
      return item;
    }
    const url = target === HOST_TARGET ? hostSideUrl(hostUrl) : hostUrl;
    item.files.push(await seedOneFile(home, AGENT_BROWSER_REL, 'cdp', url));
    item.files.push(await seedOneFile(home, TESTLENS_REL, 'host', url));
    item.ok = true;
  } catch (e) {
    item.error = errMsg(e);
  }
  return item;
}

export async function testlensView(cfg: Config): Promise<TestlensView> {
  const targets = [HOST_TARGET, ...(await listManaged(cfg)).map((v) => v.id)];
  const views = await Promise.all(targets.map((t) => viewOne(cfg, t)));
  const metas = await getAllServiceMeta();
  const svc = metas[SERVICE_NAME];
  const port = svc?.ports?.[0];
  return {
    targets: views,
    suggestedHost: port ? `http://${SERVICE_NAME}:${port}` : null,
  };
}

export async function testlensInstall(cfg: Config, body: Record<string, unknown>): Promise<TestlensInstallItem[]> {
  const hostUrl = String(body.host ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(hostUrl)) throw new HttpError(400, 'host 必须以 http:// 或 https:// 开头', 'bad_request');
  const targets = Array.isArray(body.targets) ? [...new Set(body.targets.map(String))] : [];
  if (!targets.length) throw new HttpError(400, 'targets 必填（__host__ 或容器名）', 'bad_request');
  const known = new Set([HOST_TARGET, ...(await listManaged(cfg)).map((v) => v.id)]);
  const unknown = targets.filter((t) => !known.has(t));
  if (unknown.length) throw new HttpError(400, `未知目标：${unknown.join('、')}`, 'bad_request');
  return Promise.all(targets.map((t) => installOneTarget(cfg, t, hostUrl)));
}
