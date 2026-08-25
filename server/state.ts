// sidecar 状态：易变元数据（adopted/displayName/description/tags）。存在 XDG data 目录。
// label 不可变，所以这些走 JSON。容器名作 key。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { STATE_FILE, STATE_DIR } from './config.js';

export interface ContainerMeta {
  managed: boolean; // 纳入管理（adopted 或 mysandbox 创建后登记）
  adopted: boolean;
  displayName?: string;
  description?: string;
  tags?: string[];
  source?: string; // 'mysandbox' | 'dener' | 自定义
  ipHint?: string;
  createdAt?: string;
  // 最后成功应用的 hosts 内容 sha256 前 16 位；事件路径据此跳过无变化重刷。
  hostsHash?: string;
}

// docker 服务（数据库等）的 sidecar 元数据。与容器同款两层身份模型：
// docker label 是不可变身份（mysandbox.kind=service，随容器走），这里只存易变/展示数据
// 与停机时也必须保留的 IP 记录（network inspect 只列 running 端点，静态 IP 占用判定靠它）。
// ⚠️ env 含密码：state.json 本就 0600；列表 API 只回 envKeys，绝不回值。
export interface ServiceMeta {
  preset: string; // 'postgres' | 'redis' | 'mysql' | 'custom'
  image: string;
  env: Record<string, string>;
  command?: string[];
  volume: string | null; // 'mysandbox-svc-<name>' | null（custom 可无卷）
  ip: string; // 创建时分配的静态 IP（权威在 docker IPAMConfig，此处为停机占用记录）
  ports?: number[];
  description?: string;
  createdAt: string;
}

interface StateShape {
  containers: Record<string, ContainerMeta>;
  services: Record<string, ServiceMeta>;
}

let cache: StateShape | null = null;

async function load(): Promise<StateShape> {
  if (cache) return cache;
  if (!existsSync(STATE_FILE)) {
    cache = { containers: {}, services: {} };
    return cache;
  }
  try {
    cache = JSON.parse(await readFile(STATE_FILE, 'utf8')) as StateShape;
    if (!cache.containers) cache.containers = {};
    if (!cache.services) cache.services = {};
  } catch {
    cache = { containers: {}, services: {} };
  }
  return cache;
}

async function persist(s: StateShape): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  cache = s;
}

export async function getMeta(name: string): Promise<ContainerMeta | undefined> {
  return (await load()).containers[name];
}

export async function getAllMeta(): Promise<Record<string, ContainerMeta>> {
  return (await load()).containers;
}

export async function setMeta(name: string, patch: Partial<ContainerMeta>): Promise<ContainerMeta> {
  const s = await load();
  const prev = s.containers[name] || { managed: false, adopted: false };
  const next: ContainerMeta = { ...prev, ...patch };
  s.containers[name] = next;
  await persist(s);
  return next;
}

export async function deleteMeta(name: string): Promise<void> {
  const s = await load();
  delete s.containers[name];
  await persist(s);
}

// —— docker 服务 meta（与容器 meta 同款 API 形状） ——

export async function getServiceMeta(name: string): Promise<ServiceMeta | undefined> {
  return (await load()).services[name];
}

export async function getAllServiceMeta(): Promise<Record<string, ServiceMeta>> {
  return (await load()).services;
}

export async function setServiceMeta(name: string, meta: ServiceMeta): Promise<ServiceMeta> {
  const s = await load();
  s.services[name] = meta;
  await persist(s);
  return meta;
}

export async function deleteServiceMeta(name: string): Promise<void> {
  const s = await load();
  delete s.services[name];
  await persist(s);
}

export function resetStateCache(): void {
  cache = null;
}
