// IP 池：权威源 = 引擎的 assignedIps（LXC 扫容器 config 的 lxc.net.0.ipv4.address；
// wsl2 扫安装簿记账，见 docs/wsl2-migration.md D5——记账 IP 管去重，真实 IP 是 NAT 动态的）。
// 假设 /24：前 3 段为前缀，第 4 段在 from..to 间分配。
// 网关约定为 <前缀>.1（宿主在 mysandbox0 桥上的副 IP，由
// /etc/systemd/system/mysandbox-net.service 挂载，含网段出网 MASQUERADE）——
// 仅 LXC 语义；wsl2 引擎下 gatewayOf 无消费方（无网关 IP 直连路径）。
import type { Config } from './config.js';
import { getEngine } from './engine/index.js';

function prefix(ip: string): string {
  return ip.split('.').slice(0, 3).join('.');
}
function lastOctet(ip: string): number {
  return Number(ip.split('.')[3]) || 0;
}

export function gatewayOf(cfg: Config): string {
  return `${prefix(cfg.ipPool.from)}.1`;
}

export async function assignedIps(cfg: Config): Promise<Set<string>> {
  return getEngine(cfg).assignedIps(cfg);
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
