// 集群管理：peer 加入/退出、gossip 发现、心跳、状态维护。
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname as osHostname } from 'node:os';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { log } from './logger.js';
import type { Config } from './config.js';
import {
  ensureWgInit, loadWgState, saveWgState, rebuildTunnel, wgSupported, WG_UNSUPPORTED_MSG,
  generateMachineId, nextAvailableSubnet, type WgState, type WgPeer,
} from './wireguard.js';
import {
  loadAllocTable, saveAllocTable, electCoordinator, allocateIn, lookupEntry, mergeTables, mismatchOf,
  type AllocTable, type AllocEntry,
} from './clusterAlloc.js';

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

// —— 集群 peer 之间的 HTTP 调用 ——
// ⚠️ 不走全局 `fetch`：集群间的 HTTPS 基本都是**自签证书**（tls.ts 现场签发的那种），
// 而 node 的 fetch（undici）严格校验 → `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，抛出时只剩一句
// `fetch failed`，前端 toast 显示「加入失败: fetch failed」——用户只能猜是不是 token 错了
// （实测：对方 10-12-135-150 的证书就是这样，token 本身是好的，200 能拿回 cluster info）。
// 集群是**内网互信**场景：token 已经是授权凭据（等同宿主权限），证书在这里不承担身份
// 验证职责（它只是加密通道），所以这一处放行自签——**只放这一处**，不设全局 dispatcher，
// 别把它扩散到其它 fetch 调用上。
// 顺带把网络层错误也翻成人话（连接拒绝 / 超时 / DNS / 401），否则排查只能靠猜。
async function peerFetch(url: string, token: string, path: string, method: string = 'GET', body?: unknown): Promise<unknown> {
  const target = new URL(`${url.replace(/\/$/, '')}${path}`);
  const mod = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const headers: Record<string, string> = {
    'x-sandbox-token': token,
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
  };
  const text = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = mod(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
        // 自签证书放行（理由见上）。仅此一处。
        rejectUnauthorized: false,
        timeout: 10_000,
      },
      (res) => {
        let buf = '';
        res.on('data', (c: Buffer) => { buf += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`连接 ${target.host} 超时（10s）`));
    });
    req.on('error', (e: NodeJS.ErrnoException) => {
      const code = e.code ?? '';
      const why =
        code === 'ECONNREFUSED' ? '对方端口未监听/被防火墙挡了'
          : code === 'ENOTFOUND' ? '域名解析失败'
            : code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' ? '网络不可达'
              : code === 'ECONNRESET' ? '连接被重置'
                : e.message;
      reject(new Error(`无法连接 ${target.host}：${why}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
  if (text.status < 200 || text.status >= 300) {
    if (text.status === 401 || text.status === 403) {
      throw new Error(`对方拒绝了这台机器的身份（HTTP ${text.status}）——token 不对或已换过`);
    }
    throw new Error(`对方 ${url}${path} 返回 HTTP ${text.status}: ${text.body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(text.body) as unknown;
  } catch {
    throw new Error(`对方 ${url}${path} 返回的不是 JSON: ${text.body.slice(0, 200)}`);
  }
}

export async function joinCluster(cfg: Config, peerUrl: string, peerToken: string, peerName?: string): Promise<ClusterState> {
  // 先查本机能力：没有 wireguard 时连了对方也没用（隧道建不起来），早失败早给准话。
  if (!(await wgSupported())) throw new Error(WG_UNSUPPORTED_MSG);
  const info = (await peerFetch(peerUrl, peerToken, '/api/cluster/info')) as {
    machineId: string; name: string; overlayIp: string; containerSubnet: string; serviceSubnet: string; publicKey: string;
  };
  const wgState = await ensureWgInit(await getOrCreateMachineId());
  const mySubnet = cfg.ipPool.from.split('.').slice(0, 3).join('.') + '.0/24';

  // —— IP 段：由裁决节点统一分配（详见 clusterAlloc.ts 文件头）——
  // 入网第一步不是建隧道，是「拿号」：向裁决节点申请三段（overlay / 容器 / 服务网段），
  // 拿到后连同全表一起存本地。冲突检测随之变成「表里有没有撞」，而不是各算各的再对骂。
  const alloc = await requestAllocation(cfg, wgState.machineId, {
    contactUrl: peerUrl,
    contactToken: peerToken,
    contactMachineId: info.machineId,
    other: [
      { machineId: info.machineId, name: info.name, containerSubnet: info.containerSubnet, serviceSubnet: info.serviceSubnet, overlaySubnet: info.overlayIp ? info.overlayIp.split('.').slice(0, 3).join('.') + '.0/24' : '' },
    ],
  });
  if (alloc) {
    const mine = lookupEntry(alloc, wgState.machineId);
    if (mine) {
      // 表里的 overlay 段就是本机的：机内 IP 恒为 <段>.1。
      wgState.overlaySubnet = mine.overlaySubnet;
      wgState.overlayIp = `${mine.overlaySubnet.replace(/\.0\/24$/, '')}.1`;
      await saveWgState(wgState);
      log.info({ overlay: mine.overlaySubnet, container: mine.containerSubnet, service: mine.serviceSubnet }, 'cluster: ip allocated');
      const bad = mismatchOf(mine, mySubnet, serviceSubnetOf(cfg));
      if (bad.container || bad.service) {
        // 分配是权威的，但本机 config 还没跟上——不改用户配置，只把话说明白。
        log.warn(
          { allocated: mine, actual: { container: mySubnet, service: serviceSubnetOf(cfg) } },
          'cluster: 已分配的网段与本机 config.yaml 不一致，需要改 ipPool 才能生效',
        );
      }
    }
  }
  const myServiceSubnet = serviceSubnetOf(cfg);

  // overlay 段的冲突检测**已移除**：原先是本机自己算一个没撞的段（各算各的，两台默认
  // 配置的新机器必然都算出 10.99.0.x，然后互相覆盖）。现在 overlay 与容器/服务段一样由
  // 裁决节点统一发放（见上方 requestAllocation）。

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
  // 同上：被加入的一方也需要本机有 wireguard 才能建隧道。
  if (!(await wgSupported())) throw new Error(WG_UNSUPPORTED_MSG);
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

// —— IP 分配表的对外接口（供 routes.ts 与 joinCluster 用）——

// 本机这份表（没有则按已知 peers 现建：把每个已知 peer 的现有网段登记进去，避免新表
// 把已在跑的网段重新发出去）。
export async function allocSnapshot(cfg: Config): Promise<AllocTable> {
  const table = await loadAllocTable();
  if (table) return table;
  const cluster = await loadClusterState();
  const myId = await getOrCreateMachineId();
  const items: AllocEntry[] = [];
  const seen = new Set<string>();
  // 已知 peer 的现有网段先落进表里（老节点没有表，凭它们自报的网段登记）。
  for (const p of cluster?.peers ?? []) {
    if (!p.machineId || seen.has(p.machineId)) continue;
    seen.add(p.machineId);
    if (!p.containerSubnet) continue;
    items.push({
      machineId: p.machineId,
      name: p.name,
      overlaySubnet: p.overlayIp ? p.overlayIp.split('.').slice(0, 3).join('.') + '.0/24' : '10.99.0.0/24',
      containerSubnet: p.containerSubnet,
      serviceSubnet: p.serviceSubnet || '',
      updatedAt: p.addedAt || new Date().toISOString(),
    });
  }
  const ids = [myId, ...(cluster?.peers ?? []).map((p) => p.machineId)];
  const t: AllocTable = { version: 1, coordinator: electCoordinator(ids), updatedAt: new Date().toISOString(), items };
  await saveAllocTable(t);
  return t;
}

// 处理「给我分配一段」：只由裁决节点改表；非裁决节点把请求转发给裁决节点
// （转发是必要的——新节点只认识它连上的那一个 peer，未必认识裁决节点）。
export async function handleAllocate(
  cfg: Config,
  body: { machineId?: string; name?: string },
): Promise<AllocTable> {
  const machineId = String(body.machineId ?? '').trim();
  if (!machineId) throw new Error('machineId required');
  const name = String(body.name ?? '').trim();
  const cluster = await loadClusterState();
  const myId = await getOrCreateMachineId();
  const ids = [myId, machineId, ...(cluster?.peers ?? []).map((p) => p.machineId)];
  const coordinator = electCoordinator(ids);

  let table = (await loadAllocTable()) ?? (await allocSnapshot(cfg));
  table = { ...table, coordinator };

  if (coordinator !== myId) {
    // 我不是裁决节点：转给它（我认识它的话），让它签发表。
    const coord = cluster?.peers.find((p) => p.machineId === coordinator);
    if (!coord?.url || !coord?.token) {
      throw new Error(`裁决节点 ${coordinator.slice(0, 8)} 不在线或本机不认识它，无法分配网段`);
    }
    const issued = (await peerFetch(coord.url, coord.token, '/api/cluster/allocate', 'POST', { machineId, name })) as AllocTable;
    await saveAllocTable(mergeTables(table, issued) ?? issued);
    return issued;
  }
  const res = allocateIn(table, machineId, name);
  if (res.changed) await saveAllocTable(res.table);
  return res.table;
}

// 入网时「拿号」：向裁决节点申请；拿不到（老版本节点没有这个端点）则**降级**——
// 按老逻辑本地算一个不冲突的段，保证旧集群仍能加进来，只是失去了统一分配的好处。
async function requestAllocation(
  cfg: Config,
  myMachineId: string,
  ctx: { contactUrl: string; contactToken: string; contactMachineId: string; other: Array<{ machineId: string; name: string; containerSubnet: string; serviceSubnet: string; overlaySubnet: string }> },
): Promise<AllocTable | null> {
  const cluster = await loadClusterState();
  const ids = [myMachineId, ctx.contactMachineId, ...(cluster?.peers ?? []).map((p) => p.machineId)];
  const coordinator = electCoordinator(ids);
  const myName = cluster?.name ?? hostname();

  let table = (await loadAllocTable()) ?? {
    version: 1,
    coordinator,
    updatedAt: new Date().toISOString(),
    items: ctx.other
      .filter((o) => o.machineId && o.containerSubnet)
      .map((o) => ({
        machineId: o.machineId,
        name: o.name,
        overlaySubnet: o.overlaySubnet || '10.99.0.0/24',
        containerSubnet: o.containerSubnet,
        serviceSubnet: o.serviceSubnet,
        updatedAt: new Date().toISOString(),
      })),
  };
  table = { ...table, coordinator };

  if (coordinator === myMachineId) {
    const res = allocateIn(table, myMachineId, myName);
    await saveAllocTable(res.table);
    return res.table;
  }
  // 裁决节点就是我连上的这台：直接向它要；否则从已知 peers 里找它。
  const coordPeer = coordinator === ctx.contactMachineId
    ? { url: ctx.contactUrl, token: ctx.contactToken }
    : (() => {
        const p = cluster?.peers.find((x) => x.machineId === coordinator);
        return p?.url && p.token ? { url: p.url, token: p.token } : null;
      })();
  if (!coordPeer) {
    // 认识不到裁决节点：先请联系人转交（老版本联系人会 404，走下面的降级）。
    try {
      const issued = (await peerFetch(ctx.contactUrl, ctx.contactToken, '/api/cluster/allocate', 'POST', {
        machineId: myMachineId,
        name: myName,
      })) as AllocTable;
      await saveAllocTable(mergeTables(table, issued) ?? issued);
      return issued;
    } catch (e) {
      log.warn({ err: String(e) }, 'cluster: 无法从裁决节点取到分配表，降级为本地分配');
      const res = allocateIn(table, myMachineId, myName);
      await saveAllocTable(res.table);
      return res.table;
    }
  }
  try {
    const issued = (await peerFetch(coordPeer.url, coordPeer.token, '/api/cluster/allocate', 'POST', {
      machineId: myMachineId,
      name: myName,
    })) as AllocTable;
    await saveAllocTable(mergeTables(table, issued) ?? issued);
    return issued;
  } catch (e) {
    log.warn({ err: String(e) }, 'cluster: allocate 请求失败（对方可能是旧版本），降级为本地分配');
    const res = allocateIn(table, myMachineId, myName);
    await saveAllocTable(res.table);
    return res.table;
  }
}

// 心跳同步：向每个 peer 拉它的表，按版本号合并（gossip 最终一致）。
export async function syncAlloc(cfg: Config): Promise<void> {
  const cluster = await loadClusterState();
  if (!cluster || cluster.peers.length === 0) return;
  let mine = await loadAllocTable();
  for (const peer of cluster.peers) {
    if (!peer.url || !peer.token) continue;
    try {
      const theirs = (await peerFetch(peer.url, peer.token, '/api/cluster/allocations')) as AllocTable;
      mine = mergeTables(mine, theirs);
    } catch (e) {
      log.debug({ peer: peer.name, err: String(e) }, 'cluster: alloc table sync failed');
    }
  }
  if (mine) await saveAllocTable(mine);
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
  // IP 分配表随心跳对账（低频、幂等，失败下一拍再来）。
  await syncAlloc(cfg).catch(() => {});
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
  // 平台没有 wireguard（Windows）：不再让 ensureWgInit 去 spawn 不存在的 wg 然后抛
  // ENOENT（那是 /api/cluster/info 在 Windows 上恒 500 的原因）。本机信息照常返回，
  // 只是**没有 publicKey/overlayIp**——加进来的人拿不到隧道凭据，这是能力边界不是故障。
  if (!(await wgSupported())) {
    const cluster = await loadClusterState();
    return {
      machineId: cluster?.machineId ?? (await getOrCreateMachineId()),
      name: cluster?.name ?? hostname(),
      overlayIp: '',
      containerSubnet: cfg.ipPool.from.split('.').slice(0, 3).join('.') + '.0/24',
      serviceSubnet: serviceSubnetOf(cfg),
      publicKey: '',
    };
  }
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
// machineId 必须**跨进程稳定**：它是集群身份（peer 识别、IP 分配表主键、裁决节点选举的输入）。
// 原先只存在 wg state 里——而 wg state 由 ensureWgInit 生成，Windows（没有 wireguard）上
// 永远拿不到 → 每次进程重启都现生成一个随机 id → 集群里表现为「一台新机器」，分配表每
// 次多一条、裁决节点选举跟着乱（实测：重启前后 coordinator 从 fef5… 变 3e27…）。
// 故独立落到 ~/.mysandbox/machine-id，先于 wg state 使用。
const MACHINE_ID_FILE = join(homedir(), '.mysandbox', 'machine-id');
async function getOrCreateMachineId(): Promise<string> {
  if (cachedMachineId) return cachedMachineId;
  const state = await loadWgState();
  if (state?.machineId) { cachedMachineId = state.machineId; return state.machineId; }
  try {
    const raw = (await readFile(MACHINE_ID_FILE, 'utf8')).trim();
    if (/^[0-9a-f]{16}$/.test(raw)) { cachedMachineId = raw; return raw; }
  } catch { /* 还没生成过 */ }
  const id = generateMachineId();
  try {
    await mkdir(join(homedir(), '.mysandbox'), { recursive: true, mode: 0o700 });
    await writeFile(MACHINE_ID_FILE, id, { mode: 0o600 });
    await chmod(MACHINE_ID_FILE, 0o600);
  } catch (e) {
    log.warn({ err: String(e) }, 'cluster: machine-id 落盘失败（身份将不稳定）');
  }
  cachedMachineId = id;
  return id;
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
