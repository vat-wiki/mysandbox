// WireGuard 隧道管理：密钥对生成、配置文件写入、wg-quick up/down。
// 每台 mysandbox 一个 interface（默认 mysandbox-wg0），peer 间点对点全互联。
// 状态持久化在 ~/.mysandbox/wireguard/ 下（keypair + peers.json）。
//
// 依赖：wireguard-tools（wg genkey / wg pubkey / wg-quick）。
// 需要内核模块 wireguard（Linux 5.6+ 内建，或 DKMS 安装）。
// 运行用户是普通用户（mysandbox 是 user service），wg-quick 需要 root——
// 通过 sudo 执行（install.sh 已把 wg-quick 加入 sudoers NOPASSWD）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

export const WG_DIR = join(homedir(), '.mysandbox', 'wireguard');
export const WG_INTERFACE = 'mysandbox-wg0';
export const WG_PORT = 51820;
// overlay 网段：每台 peer 分配一个 /24 子网（从 10.99.0.0/16 顺切）。
// 本机的 overlay IP = <子网>.1（宿主在 wg0 上的地址）。
export const WG_OVERLAY_PREFIX = '10.99';

export interface WgKeyPair {
  privateKey: string;
  publicKey: string;
}

export interface WgPeer {
  id: string; // peer 唯一标识（mysandbox machineId）
  name: string; // 显示名
  publicKey: string; // WireGuard 公钥
  endpoint: string; // ip:port（初始加入时的可达地址）
  overlayIp: string; // peer 在 overlay 网络的 IP（<子网>.1）
  allowedIps: string[]; // peer 的容器网段（如 10.88.10.0/24）+ overlay 子网
  addedAt: string;
}

export interface WgState {
  machineId: string;
  keyPair: WgKeyPair;
  overlayIp: string; // 本机 overlay IP
  overlaySubnet: string; // 本机 overlay 子网（如 10.99.0.0/24）
  peers: WgPeer[];
}

function stateFile(): string {
  return join(WG_DIR, 'state.json');
}

function wgConfigFile(): string {
  return join(WG_DIR, `${WG_INTERFACE}.conf`);
}

// sudo 封装：wg-quick 和 wg set 需要 root。install.sh 配置 sudoers NOPASSWD。
async function sudo(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', [cmd, ...args], { timeout: 15_000 });
}

// —— 密钥对 ——
export async function generateKeyPair(): Promise<WgKeyPair> {
  const { stdout: privateKey } = await execFileAsync('wg', ['genkey'], { timeout: 5_000 });
  const { stdout: publicKey } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const proc = execFile('wg', ['pubkey'], { timeout: 5_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: '' });
    });
    proc.stdin?.write(privateKey.trim());
    proc.stdin?.end();
  });
  return { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
}

// —— 状态读写 ——
export async function loadWgState(): Promise<WgState | null> {
  if (!existsSync(stateFile())) return null;
  const raw = await readFile(stateFile(), 'utf8');
  return JSON.parse(raw) as WgState;
}

export async function saveWgState(state: WgState): Promise<void> {
  await mkdir(WG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(stateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
  await chmod(stateFile(), 0o600);
}

// 分配 overlay 子网：找 peers 里已用子网之外的下一个可用 /24。
export function nextAvailableSubnet(peers: WgPeer[]): string {
  const used = new Set(peers.map((p) => p.overlayIp.split('.').slice(0, 3).join('.')));
  for (let i = 0; i < 256; i++) {
    const subnet = `${WG_OVERLAY_PREFIX}.${i}`;
    if (!used.has(subnet)) return subnet;
  }
  throw new Error('overlay subnet exhausted (10.99.0.0/16 = 256 peers)');
}

// —— wg-quick 配置文件生成 ——
export function renderWgConfig(state: WgState): string {
  const lines: string[] = [];
  lines.push('[Interface]');
  lines.push(`PrivateKey = ${state.keyPair.privateKey}`);
  lines.push(`Address = ${state.overlayIp}/24`);
  lines.push(`ListenPort = ${WG_PORT}`);
  lines.push('');
  for (const peer of state.peers) {
    lines.push(`# Peer: ${peer.name} (${peer.id})`);
    lines.push('[Peer]');
    lines.push(`PublicKey = ${peer.publicKey}`);
    lines.push(`Endpoint = ${peer.endpoint}`);
    lines.push(`AllowedIPs = ${peer.allowedIps.join(', ')}`);
    lines.push('PersistentKeepalive = 25');
    lines.push('');
  }
  return lines.join('\n');
}

// 写 wg-quick 配置到标准位置（/etc/wireguard/<iface>.conf）+ 本地副本。
export async function writeWgConfig(state: WgState): Promise<void> {
  const conf = renderWgConfig(state);
  await mkdir(WG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(wgConfigFile(), conf, { mode: 0o600 });
  await chmod(wgConfigFile(), 0o600);
  // wg-quick 从 /etc/wireguard/ 读配置——需要 root 复制过去。
  await sudo('cp', [wgConfigFile(), `/etc/wireguard/${WG_INTERFACE}.conf`]);
  await sudo('chmod', ['600', `/etc/wireguard/${WG_INTERFACE}.conf`]);
}

// —— 隧道启停 ——
export async function wgUp(): Promise<void> {
  try {
    await sudo('wg-quick', ['up', WG_INTERFACE]);
    log.info({ interface: WG_INTERFACE }, 'wireguard: tunnel up');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('already exists')) {
      log.debug({ interface: WG_INTERFACE }, 'wireguard: already up');
      return;
    }
    throw new Error(`wg-quick up failed: ${msg}`);
  }
}

export async function wgDown(): Promise<void> {
  try {
    await sudo('wg-quick', ['down', WG_INTERFACE]);
    log.info({ interface: WG_INTERFACE }, 'wireguard: tunnel down');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('is not present') || msg.includes('No such device')) {
      return;
    }
    log.warn({ interface: WG_INTERFACE, err: msg }, 'wireguard: wg-quick down failed');
  }
}

// 隧道状态（wg show 的解析太简单了，直接看接口在不在 + wg show handshake）。
export async function wgStatus(): Promise<{ up: boolean; peers: number; handshakePeers: number }> {
  try {
    const { stdout } = await execFileAsync('wg', ['show', WG_INTERFACE], { timeout: 5_000 });
    const peerCount = (stdout.match(/^peer:/gm) ?? []).length;
    const handshakeCount = (stdout.match(/latest handshake:/g) ?? []).length;
    return { up: true, peers: peerCount, handshakePeers: handshakeCount };
  } catch {
    return { up: false, peers: 0, handshakePeers: 0 };
  }
}

// —— 初始化：首启生成 keypair + 分配 overlay 子网 ——
export async function ensureWgInit(machineId: string): Promise<WgState> {
  let state = await loadWgState();
  if (state) return state;

  const keyPair = await generateKeyPair();
  state = {
    machineId,
    keyPair,
    overlayIp: `${WG_OVERLAY_PREFIX}.0.1`,
    overlaySubnet: `${WG_OVERLAY_PREFIX}.0.0/24`,
    peers: [],
  };
  await saveWgState(state);
  log.info({ machineId, overlayIp: state.overlayIp }, 'wireguard: initialized');
  return state;
}

// —— 隧道重建（加/删 peer 后调用）——
export async function rebuildTunnel(state: WgState): Promise<void> {
  // 无 peer 时直接 down（写了空配置的 wg-quick up 会失败，也不该有一个空隧道挂着）
  if (state.peers.length === 0) {
    const status = await wgStatus();
    if (status.up) await wgDown();
    return;
  }
  await writeWgConfig(state);
  // 如果隧道在跑，先 down 再 up；否则只写配置。
  const status = await wgStatus();
  if (status.up) {
    await wgDown();
  }
  await wgUp();
}

// 生成 machineId（首次随机，落盘后不变——peer 间用这个识别对方）。
export function generateMachineId(): string {
  return randomBytes(8).toString('hex');
}
