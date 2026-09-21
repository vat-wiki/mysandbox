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
import { homedir, platform } from 'node:os';
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

// —— WireGuard 二进制 / 平台能力 ——
// Windows 走官方客户端（WireGuard for Windows）：`wg.exe` 在 Program Files 下（**不在
// PATH**，必须拼绝对路径），而 `wg-quick` **不存在**——隧道由 `wireguard.exe
// /installtunnelservice <conf>` 注册成一个 Windows 服务来承载（注册要管理员一次，之后
// 服务自己监视 conf 文件变化并重载，普通用户改配置即可生效）。
const WG_WIN_DIR = 'C:\\Program Files\\WireGuard';
// 官方客户端没有 wg-quick，隧道走 `wireguard.exe /installtunnelservice`（见 wgUp 注释）。
function wgBin(): string {
  if (platform() === 'win32') return join(WG_WIN_DIR, 'wg.exe');
  return 'wg';
}

let wgSupport: boolean | null = null;
export async function wgSupported(): Promise<boolean> {
  if (wgSupport !== null) return wgSupport;
  if (platform() === 'win32') {
    // 官方客户端装了就有 wg.exe；没装就是没装（此时加入集群必然失败，给人话错误）。
    wgSupport = existsSync(wgBin());
    return wgSupport;
  }
  try {
    await execFileAsync('sh', ['-c', 'command -v wg >/dev/null && command -v wg-quick >/dev/null'], { timeout: 5_000 });
    wgSupport = true;
  } catch {
    wgSupport = false;
  }
  return wgSupport;
}

// 人话错误：集群隧道在这台机器上不可用的原因（给前端 toast 用）。
export const WG_UNSUPPORTED_MSG =
  platform() === 'win32'
    ? '未安装 WireGuard for Windows（或不在 C:\\Program Files\\WireGuard）。装好后重启 mysandbox 即可加入集群'
    : '集群隧道依赖 wireguard-tools（wg / wg-quick），当前平台没有或未移植（仅 Linux 支持）';

// sudo 封装：wg-quick 和 wg set 需要 root。install.sh 配置 sudoers NOPASSWD。
async function sudo(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('sudo', [cmd, ...args], { timeout: 15_000 });
}

// —— 密钥对 ——
export async function generateKeyPair(): Promise<WgKeyPair> {
  const bin = wgBin();
  const { stdout: privateKey } = await execFileAsync(bin, ['genkey'], { timeout: 5_000 });
  const { stdout: publicKey } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const proc = execFile(bin, ['pubkey'], { timeout: 5_000 }, (err, stdout) => {
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

// 写配置：Linux 额外复制到 /etc/wireguard（wg-quick 从那儿读，需要 root）。
// Windows：conf 放用户目录（mysandbox 进程在计划任务里以最高权限跑， wg/隧道操作都免提权）。
export async function writeWgConfig(state: WgState): Promise<void> {
  const conf = renderWgConfig(state);
  await mkdir(WG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(wgConfigFile(), conf, { mode: 0o600 });
  await chmod(wgConfigFile(), 0o600);
  if (platform() === 'win32') return;
  // wg-quick 从 /etc/wireguard/ 读配置——需要 root 复制过去。
  await sudo('cp', [wgConfigFile(), `/etc/wireguard/${WG_INTERFACE}.conf`]);
  await sudo('chmod', ['600', `/etc/wireguard/${WG_INTERFACE}.conf`]);
}

// —— 隧道启停 ——
// Windows：`wireguard.exe /installtunnelservice <conf>` 对同名隧道是「卸旧装新」的幂等
// 更新——每次 peer 变化重跑一遍即完成重载。它要管理员，而 mysandbox 的计划任务以
// RunLevel Highest 运行（见 scripts/win/mysandbox.ps1），因此进程内直接成功、无 UAC。
// ⚠️ 不能指望 manager 服务监视配置目录：实测它只会把 conf 收编成 .dpapi 入库，
// 装隧道只发生在 GUI IPC 请求或 manager 重启时——别在「写文件等自动生效」上浪费时间。
export async function wgUp(): Promise<void> {
  if (platform() === 'win32') {
    await execFileAsync(join(WG_WIN_DIR, 'wireguard.exe'), ['/installtunnelservice', wgConfigFile()], { timeout: 30_000 });
    log.info({ interface: WG_INTERFACE }, 'wireguard: tunnel service installed/updated');
    return;
  }
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
  if (platform() === 'win32') {
    try {
      await execFileAsync(join(WG_WIN_DIR, 'wireguard.exe'), ['/uninstalltunnelservice', WG_INTERFACE], { timeout: 30_000 });
      log.info({ interface: WG_INTERFACE }, 'wireguard: tunnel service removed');
    } catch (e) {
      log.warn({ interface: WG_INTERFACE, err: String(e) }, 'wireguard: uninstall tunnel service failed');
    }
    return;
  }
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
// 不给外部直接用的裸查询：wgUp 的 Windows 分支要在「还没判支持」时也问一次接口在不在。
async function wgStatusRaw(): Promise<{ up: boolean; peers: number; handshakePeers: number }> {
  try {
    const { stdout } = await execFileAsync(wgBin(), ['show', WG_INTERFACE], { timeout: 5_000 });
    const peerCount = (stdout.match(/^peer:/gm) ?? []).length;
    const handshakeCount = (stdout.match(/latest handshake:/g) ?? []).length;
    return { up: true, peers: peerCount, handshakePeers: handshakeCount };
  } catch (e) {
    // Windows：隧道接口归 SYSTEM，普通用户的 `wg show` 拿到的是 **Permission denied**——
    // 这恰恰证明接口活着（不存在会报 file not found）。peer 数从本地 state 补，
    // handshake 计数拿不到（要管理员），显示为 0 但隧道是真在跑的。
    const err = e as { stderr?: string };
    if (platform() === 'win32' && /permission denied/i.test(err.stderr ?? '')) {
      const st = await loadWgState();
      return { up: true, peers: st?.peers.length ?? 0, handshakePeers: 0 };
    }
    return { up: false, peers: 0, handshakePeers: 0 };
  }
}

export async function wgStatus(): Promise<{ up: boolean; peers: number; handshakePeers: number }> {
  // 平台不支持（没装 wireguard-tools / 没装 WireGuard for Windows）：别去 spawn 一个必然
  // 不存在的 wg，否则每拍状态轮询都产生一次 ENOENT（/api/cluster/status 的 tunnel 段就是这条）。
  if (!(await wgSupported())) return { up: false, peers: 0, handshakePeers: 0 };
  return wgStatusRaw();
}

// —— 初始化：首启生成 keypair + 分配 overlay 子网 ——
export async function ensureWgInit(machineId: string): Promise<WgState> {
  let state = await loadWgState();
  if (state) return state;
  if (!(await wgSupported())) throw new Error(WG_UNSUPPORTED_MSG);

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
  if (!(await wgSupported())) throw new Error(WG_UNSUPPORTED_MSG);
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
