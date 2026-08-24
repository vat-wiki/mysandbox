// dev-lan IP 池：权威源 = network.inspect().Containers（含停掉但未删的容器）。
// 假设 /24：前 3 段为前缀，第 4 段在 from..to 间分配。
import type { Config } from './config.js';
import { getDocker } from './engine/index.js';

function prefix(ip: string): string {
  return ip.split('.').slice(0, 3).join('.');
}
function lastOctet(ip: string): number {
  return Number(ip.split('.')[3]) || 0;
}
function bare(ipWithCidr: string): string {
  return ipWithCidr.split('/')[0];
}

export async function assignedIps(cfg: Config): Promise<Set<string>> {
  try {
    const info = await getDocker(cfg).getNetwork(cfg.network).inspect();
    const set = new Set<string>();
    for (const c of Object.values(info.Containers || {})) {
      if (c.IPv4Address) set.add(bare(c.IPv4Address));
    }
    return set;
  } catch {
    return new Set();
  }
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
