// 集群管理：peer 加入/退出、gossip 发现、心跳、状态维护。
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { log } from './logger.js';
import type { Config } from './config.js';
import {
  ensureWgInit, loadWgState, saveWgState, rebuildTunnel,
  generateMachineId, nextAvailableSubnet, type WgState, type WgPeer,
} from './wireguard.js';

const CLUSTER_DIR = join(homedir(), '.mysandbox');
const CLUSTER_FILE = join(CLUSTER_DIR, 'cluster.json');

export interface ClusterPeer {
  machineId: string;
  name: string;
  url: string;
  token: string;
  overlayIp: string;
  containerSubnet: string;
  serviceSubnet: string;
  addedAt: string;
  lastSeenAt?: string;
}

export interface ClusterState {
  machineId: string;
  name: string;
  peers: ClusterPeer[];
}

export async function loadClusterState(): Promise<ClusterState | null> {
  if (!existsSync(CLUSTER_FILE)) return null;
  const raw = await readFile(CLUSTER_FILE, 'utf8');
  return JSON.parse(raw) as ClusterState;
}

export async function saveClusterState(state: ClusterState): Promise<void> {
  await mkdir(CLUSTER_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CLUSTER_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(CLUSTER_FILE, 0o600);
}

async function peerFetch(url: string, token: string, path: string, method: string = 'GET', body?: unknown): Promise<unknown> {
  const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
    method,
    headers: { 'x-sandbox-token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`peer ${url}${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export async function joinCluster(cfg: Config, peerUrl: string, peerToken: string, peerName?: string): Promise<ClusterState> {
  const info = (await peerFetch(peerUrl, peerToken, '/api/cluster/info')) as {
    machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; publicKey: string;
  };
  const wgState = await ensureWgInit(await getOrCreateMachineId());
  const mySubnet = cfg.ipPool.from.split('.').slice(0, 3).join('.') + '.0/24';
  if (info.containerSubnet === mySubnet) {
    throw new Error(`容器网段冲突：本机 ${mySubnet} 与对方相同。请修改本机或对方的 config.yaml ipPool 后重试。`);
  }
  const myServiceSubnet = serviceSubnetOf(cfg);

  // overlay 子网冲突检测：本机还没加过 peer（peers 为空）且对方也是 10.99.0.x
  // → 重新分配本机的 overlay 子网（取下一个可用段）。已有 peer 的 gossip 合并
  // 阶段由 receiveGossip 的 nextAvailableSubnet 兜底。
  if (wgState.peers.length === 0) {
    const peerOverlayPrefix = info.overlayIp.split('.').slice(0, 3).join('.');
    const myOverlayPrefix = wgState.overlayIp.split('.').slice(0, 3).join('.');
    if (peerOverlayPrefix === myOverlayPrefix) {
      const nextPrefix = nextAvailableSubnet(wgState.peers.length
        ? wgState.peers
        : [{ id: info.machineId, name: '', publicKey: '', endpoint: '', overlayIp: info.overlayIp, allowedIps: [], addedAt: '' }]);
      wgState.overlayIp = `${nextPrefix}.1`;
      wgState.overlaySubnet = `${nextPrefix}.0/24`;
      await saveWgState(wgState);
      log.info({ oldIp: `10.99.0.1`, newIp: wgState.overlayIp }, 'cluster: overlay subnet reassigned');
    }
  }

  let cluster = await loadClusterState();
  if (!cluster) cluster = { machineId: wgState.machineId, name: hostname(), peers: [] };

  const now = new Date().toISOString();
  const peer: ClusterPeer = {
    machineId: info.machineId,
    name: peerName ?? info.name,
    url: peerUrl.replace(/\/$/, ''),
    token: peerToken,
    overlayIp: info.overlayIp,
    containerSubnet: info.containerSubnet,
    serviceSubnet: info.serviceSubnet,
    addedAt: now,
    lastSeenAt: now,
  };
  const existing = cluster.peers.find((p) => p.machineId === info.machineId);
  if (existing) Object.assign(existing, peer);
  else cluster.peers.push(peer);
  await saveClusterState(cluster);

  const selfInfo = {
    machineId: wgState.machineId,
    name: cluster.name,
    overlayIp: wgState.overlayIp,
    containerSubnet: mySubnet,
    serviceSubnet: myServiceSubnet,
    publicKey: wgState.keyPair.publicKey,
    endpoint: `${await detectPublicIp()}:51820`,
  };
  await peerFetch(peerUrl, peerToken, '/api/cluster/peer', 'PUT', selfInfo);

  const wgPeer: WgPeer = {
    id: info.machineId,
    name: peer.name,
    publicKey: info.publicKey,
    endpoint: `${await detectPublicIp()}:51820`,
    overlayIp: info.overlayIp,
    allowedIps: [info.overlayIp.split('.').slice(0, 3).join('.') + '.0/24', info.containerSubnet, info.serviceSubnet],
    addedAt: now,
  };
  wgState.peers = wgState.peers.filter((p) => p.id !== info.machineId);
  wgState.peers.push(wgPeer);
  await saveWgState(wgState);
  await rebuildTunnel(wgState);

  log.info({ peer: peer.name, url: peerUrl }, 'cluster: joined');
  return cluster;
}

export async function acceptPeer(cfg: Config, peerInfo: {
  machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; publicKey: string; endpoint: string;
}): Promise<void> {
  const wgState = await ensureWgInit(await getOrCreateMachineId());
  const now = new Date().toISOString();
  const wgPeer: WgPeer = {
    id: peerInfo.machineId,
    name: peerInfo.name,
    publicKey: peerInfo.publicKey,
    endpoint: peerInfo.endpoint,
    overlayIp: peerInfo.overlayIp,
    allowedIps: [peerInfo.overlayIp.split('.').slice(0, 3).join('.') + '.0/24', peerInfo.containerSubnet, peerInfo.serviceSubnet],
    addedAt: now,
  };
  wgState.peers = wgState.peers.filter((p) => p.id !== peerInfo.machineId);
  wgState.peers.push(wgPeer);
  await saveWgState(wgState);
  await rebuildTunnel(wgState);

  let cluster = await loadClusterState();
  if (!cluster) cluster = { machineId: wgState.machineId, name: hostname(), peers: [] };
  const existing = cluster.peers.find((p) => p.machineId === peerInfo.machineId);
  if (!existing) {
    cluster.peers.push({
      machineId: peerInfo.machineId,
      name: peerInfo.name,
      url: '',
      token: '',
      overlayIp: peerInfo.overlayIp,
      containerSubnet: peerInfo.containerSubnet,
      serviceSubnet: peerInfo.serviceSubnet,
      addedAt: now,
    });
  } else {
    existing.overlayIp = peerInfo.overlayIp;
    existing.containerSubnet = peerInfo.containerSubnet;
    existing.serviceSubnet = peerInfo.serviceSubnet;
  }
  await saveClusterState(cluster);
  log.info({ peer: peerInfo.name }, 'cluster: peer accepted');
}

export async function heartbeat(cfg: Config): Promise<void> {
  const cluster = await loadClusterState();
  if (!cluster || cluster.peers.length === 0) return;
  const wgState = await loadWgState();
  if (!wgState) return;

  for (const peer of cluster.peers) {
    if (!peer.url || !peer.token) continue;
    try {
      const info = (await peerFetch(peer.url, peer.token, '/api/cluster/info')) as {
        machineId: string; name: string; overlayIp: string; containerSubnet: string;
      };
      peer.lastSeenAt = new Date().toISOString();
      const gossip = cluster.peers
        .filter((p) => p.machineId !== peer.machineId)
        .map((p) => ({ machineId: p.machineId, name: p.name, overlayIp: p.overlayIp, containerSubnet: p.containerSubnet, serviceSubnet: p.serviceSubnet, url: p.url, token: p.token }));
      // 发送方自己的信息也带上（对方据此更新 lastSeenAt + 补 url/token）
      const self = {
        machineId: cluster.machineId,
        name: cluster.name,
        overlayIp: wgState.overlayIp,
        containerSubnet: cfg.ipPool.from.split('.').slice(0, 3).join('.') + '.0/24',
        serviceSubnet: serviceSubnetOf(cfg),
        url: '', // 对方主动调我们的 info 时不走 gossip——这里只是告知"我在线"
        token: '',
      };
      await peerFetch(peer.url, peer.token, '/api/cluster/gossip', 'POST', { from: self, peers: gossip });
    } catch (e) {
      log.debug({ peer: peer.name, err: String(e) }, 'cluster: heartbeat failed');
    }
  }
  await saveClusterState(cluster);
}

export async function leaveCluster(cfg: Config, machineId: string): Promise<void> {
  const cluster = await loadClusterState();
  if (!cluster) return;
  const peer = cluster.peers.find((p) => p.machineId === machineId);
  if (peer?.url && peer?.token) {
    try {
      await peerFetch(peer.url, peer.token, `/api/cluster/peer/${cluster.machineId}`, 'DELETE');
    } catch (e) {
      log.warn({ peer: peer.name, err: String(e) }, 'cluster: notify peer DELETE failed');
    }
  }
  cluster.peers = cluster.peers.filter((p) => p.machineId !== machineId);
  await saveClusterState(cluster);

  const wgState = await loadWgState();
  if (wgState) {
    wgState.peers = wgState.peers.filter((p) => p.id !== machineId);
    await saveWgState(wgState);
    await rebuildTunnel(wgState);
  }
  log.info({ machineId }, 'cluster: peer removed');
}

export async function receiveGossip(cfg: Config, fromMachineId: string, peers: Array<{
  machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; url?: string; token?: string;
}>): Promise<void> {
  const cluster = await loadClusterState();
  if (!cluster) return;
  const wgState = await loadWgState();
  if (!wgState) return;

  for (const gp of peers) {
    if (gp.machineId === cluster.machineId) continue;
    const existing = cluster.peers.find((p) => p.machineId === gp.machineId);
    if (!existing) {
      cluster.peers.push({
        machineId: gp.machineId,
        name: gp.name,
        url: gp.url ?? '',
        token: gp.token ?? '',
        overlayIp: gp.overlayIp,
        containerSubnet: gp.containerSubnet,
        serviceSubnet: gp.serviceSubnet,
        addedAt: new Date().toISOString(),
      });
    }
  }
  // 发送方的心跳到达：更新它的 lastSeenAt（被动 side 的 url/token 我们没有，但至少知道它在线）
  const sender = cluster.peers.find((p) => p.machineId === fromMachineId);
  if (sender) sender.lastSeenAt = new Date().toISOString();
  await saveClusterState(cluster);
}

export async function selfInfo(cfg: Config): Promise<{
  machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; publicKey: string;
}> {
  const wgState = await ensureWgInit(await getOrCreateMachineId());
  const cluster = await loadClusterState();
  return {
    machineId: wgState.machineId,
    name: cluster?.name ?? hostname(),
    overlayIp: wgState.overlayIp,
    containerSubnet: cfg.ipPool.from.split('.').slice(0, 3).join('.') + '.0/24',
    serviceSubnet: serviceSubnetOf(cfg),
    publicKey: wgState.keyPair.publicKey,
  };
}

function hostname(): string {
  return osHostname();
}

function serviceSubnetOf(cfg: Config): string {
  return cfg.services.ipPool.from.split('.').slice(0, 3).join('.') + '.0/24';
}

// peer 服务端点（hosts 注入用）：`<peer名>.<服务名>` → peer 的服务 IP（经 WireGuard 路由）。
export async function peerServiceEndpoints(cfg: Config): Promise<{ name: string; ip: string }[]> {
  const cluster = await loadClusterState();
  if (!cluster || cluster.peers.length === 0) return [];
  const out: { name: string; ip: string }[] = [];
  for (const peer of cluster.peers) {
    if (!peer.url || !peer.token) continue;
    try {
      const res = (await peerFetch(peer.url, peer.token, '/api/services')) as { items?: Array<{ name: string; ip?: string | null; state?: string }> };
      if (!res.items) continue;
      for (const svc of res.items) {
        if (svc.state !== 'running' || !svc.ip || !svc.name) continue;
        out.push({ name: `${peer.name}.${svc.name}`, ip: svc.ip });
      }
    } catch (e) {
      log.debug({ peer: peer.name, err: String(e) }, 'cluster: peer service fetch failed');
    }
  }
  return out;
}

let cachedMachineId: string | null = null;
async function getOrCreateMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;
  const state = await loadWgState();
  if (state) { cachedMachineId = state.machineId; return state.machineId; }
  cachedMachineId = generateMachineId();
  return cachedMachineId;
}

async function detectPublicIp(): Promise<string> {
  const { networkInterfaces } = await import('node:os');
  const ifaces = networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs || name.startsWith('lo') || name.startsWith('wg') || name.startsWith('docker')) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
export function startHeartbeat(cfg: Config): void {
  if (heartbeatTimer) return;
  // 启动清理：peers 为空但隧道还在跑（上次退出没 down 干净），拆掉。
  loadWgState().then((state) => {
    if (state && state.peers.length === 0) {
      import('./wireguard.js').then(({ wgStatus, wgDown }) =>
        wgStatus().then((s) => { if (s.up) return wgDown(); }),
      ).catch(() => {});
    }
  }).catch(() => {});
  heartbeatTimer = setInterval(() => { heartbeat(cfg).catch(() => {}); }, 30_000);
  heartbeatTimer.unref();
}

// —— P2：模板跨机拉取 ——
export async function pullTemplate(
  cfg: Config,
  peerMachineId: string,
): Promise<{ ok: boolean; error?: string }> {
  const cluster = await loadClusterState();
  if (!cluster) return { ok: false, error: 'not in a cluster' };
  const peer = cluster.peers.find((p) => p.machineId === peerMachineId);
  if (!peer?.url || !peer?.token) return { ok: false, error: 'peer not found or unreachable' };

  const tmpPath = `/tmp/mysandbox-pull-template-${Date.now()}.tar.zst`;
  try {
    const res = await fetch(`${peer.url}/api/base/export`, {
      method: 'POST',
      headers: { 'x-sandbox-token': peer.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: tmpPath }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!res.ok) return { ok: false, error: `peer export failed: ${res.status}` };
    await res.text();

    const dl = await fetch(`${peer.url}/api/host-terminal/download?path=${encodeURIComponent(tmpPath)}`, {
      headers: { 'x-sandbox-token': peer.token },
      signal: AbortSignal.timeout(600_000),
    });
    if (!dl.ok) return { ok: false, error: `peer download failed: ${dl.status}` };
    const buf = Buffer.from(await dl.arrayBuffer());

    const localTmp = `/tmp/mysandbox-pulled-template-${Date.now()}.tar.zst`;
    const { writeFile, unlink } = await import('node:fs/promises');
    await writeFile(localTmp, buf);
    try {
      const { getEngine } = await import('./engine/index.js');
      const engine = getEngine(cfg);
      const noop = (_e: unknown) => {};
      await engine.runBaseAction(cfg, 'import', { path: localTmp }, noop);
    } finally {
      await unlink(localTmp).catch(() => {});
    }
    log.info({ peer: peer.name }, 'cluster: template pulled');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// —— P2：技能跨机同步 ——
export async function syncSkillsFromPeer(
  cfg: Config,
  peerMachineId: string,
): Promise<{ ok: boolean; installed: string[]; error?: string }> {
  const cluster = await loadClusterState();
  if (!cluster) return { ok: false, installed: [], error: 'not in a cluster' };
  const peer = cluster.peers.find((p) => p.machineId === peerMachineId);
  if (!peer?.url || !peer?.token) return { ok: false, installed: [], error: 'peer not found or unreachable' };

  try {
    const hub = (await peerFetch(peer.url, peer.token, '/api/skills/hub')) as {
      skills?: Array<{ name: string }>;
    };
    const names = (hub.skills ?? []).map((s) => s.name);
    if (names.length === 0) return { ok: true, installed: [] };

    const installed: string[] = [];
    for (const name of names) {
      try {
        const skill = (await peerFetch(peer.url, peer.token, `/api/skills/registry/${encodeURIComponent(name)}`)) as {
          content?: string;
        };
        if (!skill.content) continue;
        const { mkdir, writeFile } = await import('node:fs/promises');
        const hubDir = join(homedir(), '.mysandbox', 'skills');
        await mkdir(hubDir, { recursive: true, mode: 0o700 });
        await writeFile(join(hubDir, `${name}.md`), skill.content, 'utf8');
        installed.push(name);
      } catch {
        // 单个技能失败不阻塞
      }
    }
    log.info({ peer: peer.name, count: installed.length }, 'cluster: skills synced');
    return { ok: true, installed };
  } catch (e) {
    return { ok: false, installed: [], error: e instanceof Error ? e.message : String(e) };
  }
}
