// dev-lan IP 池：docker 侧权威源 = network.inspect().Containers（含停掉但未删的容器），
// LXC 侧 = 各容器 config 里的 lxc.net.0.ipv4.address。
// 假设 /24：前 3 段为前缀，第 4 段在 from..to 间分配。
//
// 关键：**两个引擎共用同一座网桥**（见 docs/lxc-migration.md D2），所以分配新 IP 时必须
// 同时看两边已占用的地址，否则迁移过渡期（docker 老容器 + LXC 新容器并存）会撞 IP。
// 单边不可达（比如切到 lxc 后 docker 没装）不算错，当空集处理。
import type { Config } from './config.js';
import { dockerEngine, lxcEngine } from './engine/index.js';

function prefix(ip: string): string {
  return ip.split('.').slice(0, 3).join('.');
}
function lastOctet(ip: string): number {
  return Number(ip.split('.')[3]) || 0;
}

export async function assignedIps(cfg: Config): Promise<Set<string>> {
  const sets = await Promise.all(
    [dockerEngine, lxcEngine].map(async (e) => {
      try {
        return await e.assignedIps(cfg);
      } catch {
        return new Set<string>();
      }
    }),
  );
  const all = new Set<string>();
  for (const s of sets) for (const ip of s) all.add(ip);
  return all;
}

export async function isFree(cfg: Config, ip: string): Promise<boolean> {
  return !(await assignedIps(cfg)).has(ip);
}

export async function allocate(cfg: Config): Promise<string | null> {
  const used = await assignedIps(cfg);
  const reserved = new Set(cfg.ipPool.reserved);
  const from = lastOctet(cfg.ipPool.from);
  const to = lastOctet(cfg.ipPool.to);
  const pre = prefix(cfg.ipPool.from);
  for (let n = from; n <= to; n++) {
    const ip = `${pre}.${n}`;
    if (!used.has(ip) && !reserved.has(ip)) return ip;
  }
  return null;
}

export interface IpPoolView {
  network: string;
  pool: { from: string; to: string };
  reserved: string[];
  assigned: string[];
  free: string[];
}

export async function ipPoolView(cfg: Config): Promise<IpPoolView> {
  const used = await assignedIps(cfg);
  const reserved = new Set(cfg.ipPool.reserved);
  const from = lastOctet(cfg.ipPool.from);
  const to = lastOctet(cfg.ipPool.to);
  const pre = prefix(cfg.ipPool.from);
  const free: string[] = [];
  for (let n = from; n <= to; n++) {
    const ip = `${pre}.${n}`;
    if (!used.has(ip) && !reserved.has(ip)) free.push(ip);
  }
  const cmp = (a: string, b: string) => lastOctet(a) - lastOctet(b);
  return {
    network: cfg.network,
    pool: { from: cfg.ipPool.from, to: cfg.ipPool.to },
    reserved: cfg.ipPool.reserved,
    assigned: [...used].sort(cmp),
    free: free.sort(cmp),
  };
}
