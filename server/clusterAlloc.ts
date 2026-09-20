// 集群 IP 分配表：一个**裁决节点**统一分配，每个节点各存一份，靠 gossip 拉齐。
//
// 为什么要有这张表（取代原先「各算各的」）：
// 原来每台机器按自己的 config.yaml 各算各的 `containerSubnet` / `serviceSubnet`，再加一句
// 「相等就报错」——于是默认配置的两台机器一相遇必然撞车（实测本机 10.88.10.0/24 与
// 10.12.135.150 的 leon 完全相同），且**谁该改**没有答案：两边都被告知「请修改本机的
// config.yaml」。统一分配后：新节点入网时由裁决节点发一个不冲突的网段，冲突从根上消失。
//
// 裁决节点怎么定：**确定性选举，不跑选主协议**——取集群内已知 machineId 里字典序最小的
// 那个。所有节点拿同一份 machineId 集合算出来的结果必然相同，不需要通信、不会脑裂；
// 裁决节点离线时新节点无法分配（返回明确错误），而已分配的表继续有效。
//
// 一致性：表带 `version`（每次分配 +1）。同步时**大版本胜出**；同版本按条合并
// （同一 machineId 取 updatedAt 新的）。这是 gossip 的常规最终一致，不追求强一致——
// 分配这种低频、幂等（同一 machineId 永远拿同一段）的操作足够。
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ALLOC_FILE = join(homedir(), '.mysandbox', 'cluster-alloc.json');

export interface AllocEntry {
  machineId: string;
  name: string;
  overlaySubnet: string; // WireGuard overlay 段：10.99.<n>.0/24（机内 IP = .1）
  containerSubnet: string; // 容器网段：10.88.<n>.0/24
  serviceSubnet: string; // docker 服务网段：10.88.<128+n>.0/24
  updatedAt: string;
}

export interface AllocTable {
  version: number; // 每次分配 +1；同步时以大者为准
  coordinator: string; // 裁决节点的 machineId（确定性选举得出）
  updatedAt: string;
  items: AllocEntry[];
}

// 三个池的起点第三段（container 与 service 刻意错开 118 段，避免互相吃）。
const OVERLAY_BASE = [10, 99, 0];
const CONTAINER_BASE = [10, 88, 10];
const SERVICE_BASE = [10, 88, 128];

function subnetAt(base: number[], n: number): string {
  return `${base[0]}.${base[1]}.${base[2] + n}.0/24`;
}
function thirdOctet(subnet: string): number | null {
  const m = /^\d+\.\d+\.(\d+)\.0\/24$/.exec(subnet);
  return m ? Number(m[1]) : null;
}

// 在池里找第一个没被占用的段（按第三段从小到大扫；已用集合来自表里同池的条目）。
function nextFree(base: number[], used: Set<string>): string {
  for (let n = 0; n < 128; n++) {
    const s = subnetAt(base, n);
    if (!used.has(s)) return s;
  }
  throw new Error('IP 池耗尽（128 个节点上限）');
}

export async function loadAllocTable(): Promise<AllocTable | null> {
  if (!existsSync(ALLOC_FILE)) return null;
  try {
    return JSON.parse(await readFile(ALLOC_FILE, 'utf8')) as AllocTable;
  } catch {
    return null;
  }
}

export async function saveAllocTable(t: AllocTable): Promise<void> {
  await mkdir(join(homedir(), '.mysandbox'), { recursive: true, mode: 0o700 });
  await writeFile(ALLOC_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
  await chmod(ALLOC_FILE, 0o600);
}

// 裁决节点 = machineId 字典序最小者（确定性，无需通信）。
export function electCoordinator(ids: string[]): string {
  const uniq = [...new Set(ids.filter(Boolean))].sort();
  return uniq[0] ?? '';
}

export function lookupEntry(t: AllocTable | null, machineId: string): AllocEntry | null {
  return t?.items.find((i) => i.machineId === machineId) ?? null;
}

// 分配（幂等）：同一 machineId 重复请求返回原条目，只更新名字。
// 只有裁决节点会真的改表（版本号 +1），其余节点只读 + 同步。
export function allocateIn(t: AllocTable, machineId: string, name: string): { table: AllocTable; entry: AllocEntry; changed: boolean } {
  const items = [...t.items];
  const idx = items.findIndex((i) => i.machineId === machineId);
  if (idx >= 0) {
    const old = items[idx];
    if (old.name === name) return { table: t, entry: old, changed: false };
    const updated: AllocEntry = { ...old, name, updatedAt: new Date().toISOString() };
    items[idx] = updated;
    return { table: { ...t, version: t.version + 1, updatedAt: updated.updatedAt, items }, entry: updated, changed: true };
  }
  const usedOverlay = new Set(items.map((i) => i.overlaySubnet));
  const usedContainer = new Set(items.map((i) => i.containerSubnet));
  const usedService = new Set(items.map((i) => i.serviceSubnet));
  // 已被占用但不在表里的段也要避开：表里可能混有旧条目（第三段超出本池起点也算占用）。
  for (const i of items) {
    const o = thirdOctet(i.overlaySubnet);
    const c = thirdOctet(i.containerSubnet);
    const s = thirdOctet(i.serviceSubnet);
    if (o !== null) usedOverlay.add(subnetAt(OVERLAY_BASE, o - OVERLAY_BASE[2]));
    if (c !== null) usedContainer.add(subnetAt(CONTAINER_BASE, c - CONTAINER_BASE[2]));
    if (s !== null) usedService.add(subnetAt(SERVICE_BASE, s - SERVICE_BASE[2]));
  }
  const now = new Date().toISOString();
  const entry: AllocEntry = {
    machineId,
    name: name || machineId.slice(0, 6),
    overlaySubnet: nextFree(OVERLAY_BASE, usedOverlay),
    containerSubnet: nextFree(CONTAINER_BASE, usedContainer),
    serviceSubnet: nextFree(SERVICE_BASE, usedService),
    updatedAt: now,
  };
  items.push(entry);
  return { table: { ...t, version: t.version + 1, updatedAt: now, items }, entry, changed: true };
}

// 合并两份表：版本号大的整体胜出（那是裁决节点签发的新结果）；同版本按条并集，
// 同一 machineId 取 updatedAt 新的那条（两端各自补了对方的未知条目）。
export function mergeTables(a: AllocTable | null, b: AllocTable | null): AllocTable | null {
  if (!a) return b;
  if (!b) return a;
  if (b.version > a.version) return b;
  if (a.version > b.version) return a;
  const items = [...a.items];
  for (const it of b.items) {
    const idx = items.findIndex((i) => i.machineId === it.machineId);
    if (idx < 0) items.push(it);
    else if (it.updatedAt > items[idx].updatedAt) items[idx] = it;
  }
  return { ...a, items, updatedAt: new Date().toISOString() };
}

// 本机在表里的段与本机 config 实际网段是否一致（不一致 = 分配了但没落到配置上）。
export function mismatchOf(
  entry: AllocEntry | null,
  actualContainerSubnet: string,
  actualServiceSubnet: string,
): { container: boolean; service: boolean } {
  if (!entry) return { container: false, service: false };
  return {
    container: entry.containerSubnet !== actualContainerSubnet,
    service: entry.serviceSubnet !== actualServiceSubnet,
  };
}
