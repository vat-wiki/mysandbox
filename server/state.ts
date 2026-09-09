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
}

// docker 服务（数据库等）的 sidecar 元数据。与容器同款两层身份模型：
// docker label 是不可变身份（mysandbox.kind=service，随容器走），这里只存易变/展示数据
// 与停机时也必须保留的 IP 记录（network inspect 只列 running 端点，静态 IP 占用判定靠它）。
// ⚠️ env 含密码：state.json 本就 0600；列表 API 回全量 env（token = 宿主完整权限，
// 鉴权边界在 token 上收住，UI 需展示连接凭据）。
export interface ServiceMeta {
  preset: string; // 'postgres' | 'redis' | 'mysql' | 'custom'
  image: string;
  env: Record<string, string>;
  command?: string[];
  volume: string | null; // 'mysandbox-svc-<name>' | null（custom 可无卷）
  ip: string; // 创建时分配的静态 IP（权威在 docker IPAMConfig，此处为停机占用记录）
  ports?: number[];
  displayName?: string; // 显示名（侧栏卡片/终端 tab），不动容器真名——与容器 meta.displayName 同语义
  description?: string;
  createdAt: string;
}

// AI 网关（myapikey 等）最近一次批量下发的配置存档。形状同 aiconfig.ts 的
// AiGatewayInput（两路端点 + opencode/pi 的 wire 多选）+ updatedAt。含 apiKey——
// state.json 本就 0600，与 services.env 同一泄露面；GET 回全量供前端预填改 key 重推。
export interface AiGatewayState {
  endpoints: {
    openai?: { baseUrl: string };
    anthropic?: { baseUrl: string };
  };
  apiKey: string;
  tools: { claude: boolean; codex: boolean; opencode: boolean; pi: boolean };
  wire?: {
    opencode?: ('openai-chat' | 'openai-responses' | 'anthropic-messages')[];
    pi?: ('openai-chat' | 'openai-responses' | 'anthropic-messages')[];
  };
  models?: string[];
  setDefault?: boolean;
  updatedAt: string;
}

interface StateShape {
  containers: Record<string, ContainerMeta>;
  services: Record<string, ServiceMeta>;
  aiGateway?: AiGatewayState;
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

// —— AI 网关配置存档（全局一份，不按容器分）——

export async function getAiGateway(): Promise<AiGatewayState | undefined> {
  return (await load()).aiGateway;
}

export async function setAiGateway(state: AiGatewayState): Promise<void> {
  const s = await load();
  s.aiGateway = state;
  await persist(s);
}

export function resetStateCache(): void {
  cache = null;
}
