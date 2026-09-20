// WSL2 引擎实现（接口见 types.ts），底层是 wsl.exe CLI + 安装簿纯文件。
// 设计决策/分歧点/Windows 实测清单见 docs/wsl2-migration.md（改这个文件前先读它）。
//
// 核心映射：容器 = WSL2 发行版实例（wsl --import 落地），基座 = 模板发行版。
// 与 LXC 的关键差异：
//   - 管理判定不写 rootfs 标记（\\wsl.localhost 读取会自动启动发行版，高频路径不可
//     有「看一眼就拉起停机容器」的副作用）——用 installDir 里的 mysandbox.json 安装簿
//     （D2），普通文件零 fork、不引导发行版。
//   - IP 是 NAT 动态的（caps.ipAuthority='runtime'）：spec.ip 只是记账（写进安装簿），
//     运行 IP 每次现查 hostname -I；IP 池去重按安装簿记账（D5）。
//   - home 直通走 \\wsl.localhost UNC（D3）——Windows 上 node fs 可直读直写，业务层
//     的「宿主直写 rootfs」路线（skillSync/aiconfig）零改动成立；非 Windows 平台
//     返回 null，调用方已有降级。
//   - 生命周期无 systemd-run 等价物：发行版 VM 归 WSL 服务管，mysandbox 重启不牵连。
//   - wsl.exe 管理命令输出是 UTF-16LE（带或不带 BOM，版本相关）——解码器见 decodeWsl
//     （D7）；--exec 透传的 Linux 进程输出是原样字节。
//   - PTY 需要 ConPTY：wsl.exe 管道模式下 Linux 侧没有 tty，tmux 起不来。execStream
//     用 node-pty（optionalDependencies + createRequire 懒加载，没装报人话错误）（D6）。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { readFile, writeFile, stat, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Config } from '../config.js';
import { getAllMeta } from '../state.js';
import { log } from '../logger.js';
import { notFound, conflict, badRequest } from '../errors.js';
import { DOCKER_API_HOSTNAME, DOCKER_API_PORT } from '../dockerApi.js';
import type {
  Engine,
  EngineEvent,
  EngineCaps,
  EventSubscription,
  ContainerInfo,
  ContainerView,
  CreateSpec,
  CreateSource,
  ExecOpts,
  ExecResult,
  ExecSpawnHandle,
  ExecStream,
  BaseAction,
  BaseActionOpts,
  BaseProgress,
  BaseStatus,
} from './types.js';

// —— 能力（对照 lxc.ts CAPS 的注释看差异理由）——
const CAPS: EngineCaps = {
  dataInsideContainer: true, // wsl --unregister 连 VHD 一起删（D4）
  liveRename: false, // 无 rename 原语：export→import→unregister（D8）
  portMappings: false, // 无端口映射概念；mirrored 模式下端口自动到宿主 localhost
  baseKind: 'template',
  baseActions: ['create', 'clone', 'export', 'import'],
  ipAuthority: 'runtime', // NAT 动态 IP，spec.ip 只是记账（D5）
};

// 测试出口：MYSANDBOX_WSL_BIN 指向 mock（scripts/mock-wsl.mjs）可在非 Windows 上
// 跑通编排/解析逻辑；Windows 上不设即 wsl.exe。
function wslBin(): string {
  return process.env.MYSANDBOX_WSL_BIN || 'wsl.exe';
}
function isWindows(): boolean {
  return platform() === 'win32';
}

// 名字校验沿用 LXC 的 NAME_RE（比 wsl 自身约束严：不让脏名字进 installDir 路径拼接，
// 跨引擎口径一致）。见 lxc.ts assertName 注释。
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
function assertName(id: string): string {
  if (!NAME_RE.test(id)) throw notFound(`invalid distro name "${id}"`);
  return id;
}

// —— 安装簿（D2）：installDir 里的纯文件元数据 ——
export function installRoot(): string {
  return join(homedir(), '.mysandbox', 'wsl');
}
function distroDir(name: string): string {
  return join(installRoot(), name);
}
interface DistroBookkeeping {
  managed?: boolean;
  assignedIp?: string;
  createdAt?: string;
  source?: string;
}
async function readBookkeeping(name: string): Promise<DistroBookkeeping | null> {
  try {
    return JSON.parse(await readFile(join(distroDir(name), 'mysandbox.json'), 'utf8'));
  } catch {
    return null;
  }
}
async function writeBookkeeping(name: string, patch: DistroBookkeeping): Promise<void> {
  const prev = (await readBookkeeping(name)) ?? {};
  const next = { ...prev, ...patch };
  await mkdir(distroDir(name), { recursive: true });
  await writeFile(join(distroDir(name), 'mysandbox.json'), JSON.stringify(next, null, 2), 'utf8');
}

// —— wsl.exe 调用 ——
// execFile + encoding:'buffer' 拿原始字节（管理命令是 UTF-16LE，见 decodeWsl）。
async function runWsl(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(wslBin(), args, {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    });
    return { ok: true, stdout: decodeWsl(stdout), stderr: decodeWsl(stderr) };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    // ⚠️ spawn 失败（ENOENT/EINVAL/EPERM）时 err.stderr 是**存在的空 Buffer**——它 truthy，
    // 所以 `err.stderr ? decodeWsl(err.stderr) : err.message` 会选中空串、把真正的失败
    // 原因（"spawn wsl.exe EPERM" 之类）整条吞掉，调用方只剩「什么都没有」。必须按长度判。
    const dec = (b?: Buffer) => (b && b.length ? decodeWsl(b) : '');
    return {
      ok: false,
      stdout: dec(err.stdout),
      stderr: dec(err.stderr) || err.message || '',
    };
  }
}

const execFileAsync = promisify(execFile);

// wsl.exe 管理命令输出 UTF-16LE（D7）：带 BOM 直接认；不带 BOM 时按「奇偶零字节对比」判——
// UTF-16LE 的 NUL 只落在**奇数位**（低字节在前），UTF-8 的 NUL 两边均等（纯 ASCII 文本里
// 根本没有 NUL）。这一条同时覆盖两种真实输出：
//   - 管理命令（--version/--help/--list*）恒 UTF-16LE → 奇数位零多；
//   - `distroIp` 走的 `-d <名> --exec hostname -I` 是 Linux 进程输出（纯 ASCII/UTF-8）→ 两边都 0 → 判 UTF-8。
// 早期实现按「前 256 字节内奇数位零 > 1/4」判，遇**短且全 CJK** 的输出会失配
// （实测 `--list --running` 零发行版时输出「没有正在运行的分发版。\r\n」24 字节，
//  奇数位只有 2 个零，2 > 6 不成立）→ 被当 UTF-8 解成乱码。Windows 实测钉死，见 docs 补记。
// BOM 字符（U+FEFF）解码后必须剥掉——否则 --list --quiet 的第一个发行版名被污染、
// 过不了名字过滤（mock 冒烟抓到的）。
export function decodeWsl(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  let zerosOdd = 0;
  let zerosEven = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 1) zerosOdd++;
    else zerosEven++;
  }
  if (zerosOdd > zerosEven) return buf.toString('utf16le');
  return buf.toString('utf8');
}

// 全部已注册发行版名（含停止的）。`--quiet` 一行一个。
// 实测（WSL 2.3.11.0）：`--list --quiet` 在**零发行版**时是 exit 0 + 空输出，不带提示语；
// 带中文提示语且 exit -1 的是 `--verbose` / `--running`（那两个函数只读 stdout、忽略 ok，无碍）。
// 「名格式」过滤保留作兜底——发行版名不可能含空格/CJK。
async function listRegistered(): Promise<string[]> {
  const r = await runWsl(['--list', '--quiet'], 10_000);
  if (!r.stdout.trim()) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim().replace(/\r$/, ''))
    .filter((l) => NAME_RE_NO_SLASH.test(l));
}
const NAME_RE_NO_SLASH = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function listRunning(): Promise<string[]> {
  const r = await runWsl(['--list', '--running'], 10_000);
  if (!r.stdout.trim()) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim().replace(/\r$/, ''))
    .filter((l) => NAME_RE_NO_SLASH.test(l));
}

// `--list --verbose`：`  NAME   STATE   VERSION` 表格。name→state 映射
// （Running/Stopped/Installing/Converting...）。
async function listStates(): Promise<Record<string, string>> {
  const r = await runWsl(['--list', '--verbose'], 10_000);
  const out: Record<string, string> = {};
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim();
    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    if (/^name$/i.test(cols[0])) continue; // 表头
    if (!NAME_RE_NO_SLASH.test(cols[0])) continue;
    out[cols[0]] = cols[1];
  }
  return out;
}

// WSL 状态 → web 侧 state 字符串（对齐 lxc.ts mapState 的口径）。
function mapState(wslState: string | undefined): { state: string; running: boolean } {
  const s = (wslState || '').toLowerCase();
  if (s === 'running') return { state: 'running', running: true };
  if (s === 'installing' || s === 'converting') return { state: 'restarting', running: false };
  return { state: 'exited', running: false };
}

// —— Engine.status ——
// 「可达」= Windows 平台 + wsl.exe 可用。非 Windows（且未设 mock 出口）直接给人话错误，
// 这是最早撞上的部署事实，不藏着。
async function status(_cfg: Config) {
  if (!isWindows() && !process.env.MYSANDBOX_WSL_BIN) {
    return {
      reachable: false,
      error:
        'wsl2 engine runs on Windows with WSL2 installed (wsl.exe). Set MYSANDBOX_WSL_BIN to override for testing.',
    };
  }
  const v = await runWsl(['--version'], 10_000);
  if (!v.ok) {
    // 只回错误**类别**，不回原始文本：status 经 /api/health 免鉴权下发，而原始 spawn
    // 错误里带完整可执行路径（可能含用户路径）——AGENTS.md 的 health 约束不放路径/配置值。
    // 类别已够分清「没装（ENOENT）/ 被安全策略或权限拦（EPERM、EACCES）/ 环境或参数坏
    // （EINVAL）」；原先固定一句 "not found or WSL not installed" 把这三者糊成一种，
    // Windows 实测第一次撞上的是「被拦」却报「没装」，误导排查。
    const reason = /\b(EPERM|EACCES|ENOENT|EINVAL)\b/i.exec(v.stderr)?.[1]?.toUpperCase() ?? 'unknown';
    return { reachable: false, error: `wsl.exe not usable (${reason})` };
  }
  const version = v.stdout.split('\n')[0]?.trim() || 'wsl';
  return { reachable: true, version };
}

// —— 列表 ——
async function listManaged(cfg: Config): Promise<ContainerView[]> {
  const template = cfg.wsl.template;
  const [names, states, meta] = await Promise.all([listRegistered(), listStates(), getAllMeta()]);
  const views: ContainerView[] = [];
  for (const name of names) {
    if (name === template) continue; // 基座不出现在容器列表（对齐 LXC）
    const book = await readBookkeeping(name);
    const { state, running } = mapState(states[name]);
    // IP 口径同 inspect：跑起来读真实值，停机显示安装簿记账 IP（D5）。
    const ip = running ? await distroIp(name) : (book?.assignedIp ?? null);
    const m = meta[name];
    views.push({
      id: name,
      name,
      displayName: m?.displayName,
      status: running ? 'Up' : 'Stopped',
      state,
      image: 'wsl2',
      ip,
      networks: [], // 无网桥概念（NAT）；受管判定靠安装簿
      managed: !!book?.managed,
      adopted: !!m?.managed,
      description: m?.description,
      tags: m?.tags,
      source: m?.source,
      labels: {},
      ports: [],
      created: createdAtMs(m ?? (book?.createdAt ? { createdAt: book.createdAt } : undefined)),
      command: '/sbin/init',
    });
  }
  views.sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (a.state !== 'running' && b.state === 'running') return 1;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });
  return views;
}

function createdAtMs(m: { createdAt?: string } | undefined): number {
  if (!m?.createdAt) return 0;
  const t = Date.parse(m.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

// 运行中发行版的真实 IP（D5）。两层取法，解析放在 JS 侧：
//   1) `hostname -I` —— GNU/inetutils 版才有（Ubuntu 之类标准发行版）。
//   2) `ip -4 -o addr show scope global` —— 精简发行版没有第 1 条（实测 Alpine/ BusyBox：
//      `hostname: unrecognized option: I`），但这条 busybox / iproute2 都支持。
// ⚠️ 两条都必须经 `sh -c` 跑，不能直调命令：**`wsl --exec <cmd>` 对首个参数不做完整
//    PATH 查找**——实测 `/bin`、`/usr/bin` 下的（sh / hostname / env）能找到，而
//    `/sbin`、`/usr/sbin` 下的（ip / ifconfig）直接
//    `WSL ERROR: CreateProcessCommon:500: execvpe(ip) failed: No such file or directory`。
//    经 shell 则用 shell 自己的 PATH 解析，正常。（引擎主执行路径本来就走
//    `/bin/sh -c 'exec "$@"'`，不受此限；只有这里原先是直调命令。）
// ⚠️ 第 2 条**必须排除 lo**：WSL 把 DNS 代理绑在 lo 上且标成 `scope global`
//    （实测 `lo inet 10.255.255.254/32 … scope global lo`），不过滤会拿到它而不是
//    eth0 的真实地址（实测 `eth0 inet 172.29.240.144/20`）。
// 两条都拿不到 → null。调用方把 null 显示成「—」，**不回退记账 IP**（wsl2 的记账 IP 在
// Windows 上不可达，回退等于给前端一个点了必失败的端口，理由见 docs 补记）。
async function distroIp(name: string): Promise<string | null> {
  const viaSh = async (cmd: string): Promise<string> => {
    const r = await runWsl(['-d', name, '--exec', 'sh', '-c', cmd], 10_000);
    return r.ok ? r.stdout : '';
  };
  const first = (await viaSh('hostname -I 2>/dev/null')).trim().split(/\s+/)[0];
  if (first) return first;

  const out = await viaSh('ip -4 -o addr show scope global 2>/dev/null');
  for (const line of out.split('\n')) {
    const cols = line.trim().split(/\s+/);
    // 形如 `2: eth0    inet 172.29.240.144/20 brd … scope global eth0`
    if (cols[1] === 'lo') continue;
    const i = cols.indexOf('inet');
    if (i < 0) continue;
    const ip = (cols[i + 1] ?? '').split('/')[0];
    if (ip) return ip;
  }
  return null;
}

async function inspect(cfg: Config, id: string): Promise<ContainerInfo> {
  const name = assertName(id);
  const states = await listStates();
  if (!(name in states)) throw notFound(`distro ${name} not found`);
  const { state, running } = mapState(states[name]);
  const book = await readBookkeeping(name);
  const ip = running ? await distroIp(name) : (book?.assignedIp ?? null);
  return {
    id: name,
    name,
    running,
    stateStatus: state,
    managed: !!book?.managed,
    networks: [],
    ip,
    ports: [],
  };
}

// —— 生命周期 ——
// 建容器 = 从模板发行版落地新发行版。三来源统一（模板 / 现有发行版 / 包），
// 落地后写安装簿 + 首启 seed + 启动。半成品清理：unregister + 删 installDir。
async function create(
  cfg: Config,
  spec: CreateSpec,
  onProgress?: (e: BaseProgress) => void,
): Promise<{ id: string }> {
  const name = assertName(spec.name);
  try {
    await materialize(cfg, name, spec.source, onProgress);
    await writeBookkeeping(name, {
      managed: true,
      assignedIp: spec.ip, // 记账 IP（D5）：真实 IP 是 NAT 动态的
      createdAt: new Date().toISOString(),
      source: spec.source
        ? spec.source.kind === 'container'
          ? `wsl2:${spec.source.name}`
          : `archive:${spec.source.path}`
        : `wsl2:${cfg.wsl.template}`,
    });

    onProgress?.({ status: '首启 seed' });
    await seedHome(cfg, name, spec);

    onProgress?.({ status: '启动容器' });
    await startDistro(name);
  } catch (e) {
    try {
      await runWsl(['--unregister', name], 60_000);
      await rm(distroDir(name), { recursive: true, force: true });
    } catch {
      /* noop */
    }
    throw e;
  }
  return { id: name };
}

// 落地新发行版（对齐 lxc.ts materialize 的三来源结构）。
async function materialize(
  cfg: Config,
  name: string,
  source: CreateSource | undefined,
  onProgress?: (e: BaseProgress) => void,
): Promise<void> {
  if (source == null || source.kind === 'container') {
    const src = source == null ? cfg.wsl.template : assertName(source.name);
    const registered = await listRegistered();
    if (!registered.includes(src)) {
      throw notFound(
        `WSL template distro "${src}" not found. Import one first (POST /api/base/create with a WSL distro tarball/vhdx), or set wsl.template in config.`,
      );
    }
    onProgress?.({ status: `克隆发行版 ${src} -> ${name}` });
    await cloneDistro(src, name);
    return;
  }
  // archive：直接导入用户提供的包（wsl --export 产物 .tar/.vhdx 或发行版 rootfs tar）
  onProgress?.({ status: `从包 ${source.path} 建容器 ${name}` });
  await importDistro(name, source.path, onProgress);
}

// --vhd 能力探测（D1）：块拷贝秒级 vs tar 全量分钟级。结果缓存（wsl 版本不会中途变）。
let vhdCache: boolean | null = null;
// ⚠️ 不能按 r.ok 判：`wsl --help` 的退出码是 **-1**（实测 WSL 2.3.11.0 返回 4294967295），
// 而 runWsl 走 execFile——非零退出即 reject → ok=false。早期实现写成 `r.ok && …`，
// 结果 --vhd 恒被判「不支持」，克隆永远退化成 tar 全量导出（分钟级）而非 vhd 块拷贝（秒级）。
// 改为只看输出文本；连一行输出都拿不到才当不可用，且此时**不缓存**（留给下次重试）。
async function vhdSupported(): Promise<boolean> {
  if (vhdCache != null) return vhdCache;
  const r = await runWsl(['--help'], 10_000);
  if (!r.stdout) return false;
  vhdCache = r.stdout.includes('--vhd');
  return vhdCache;
}

// 导出源发行版 → 导入为目标。导出前 terminate 源（一致性；9P/后续访问会自动拉起）。
//
// vhd 快路径（D1）实测结论（WSL 2.3.11.0）：`--export --vhd` **要求 WSL2 轻量 VM 处于停止
// 状态**——只要 VM 还在跑（任一发行版启动后它会存活一段时间，且 `--terminate <发行版>`
// 只停发行版、不停 VM），ext4.vhdx 被 VM 持有，导出直接报
// `Wsl/Service/ERROR_SHARING_VIOLATION`（实测 rc=127、无 stderr）。所以 vhd 只是「VM 正好
// 冷着」时的加速，**必须能降级 tar**（tar 导出实测在 VM 运行时可用），否则模板克隆在常见
// 状态下会整体失败。刻意**不**用 `wsl --shutdown` 清场：那是全 VM 级操作，会把用户正在跑的
// 所有发行版一起杀掉，违背 D8「生命周期按发行版」的边界。
async function cloneDistro(src: string, dst: string): Promise<void> {
  await mkdir(installRoot(), { recursive: true });
  await runWsl(['--terminate', src], 60_000);

  if (await vhdSupported()) {
    const tmpVhd = join(installRoot(), `.${dst}.export.tmp.vhdx`);
    try {
      const ex = await runWsl(['--export', src, tmpVhd, '--vhd'], 1_800_000);
      if (ex.ok) {
        await importDistro(dst, tmpVhd, undefined, true);
        return;
      }
      log.warn(
        { src, err: ex.stderr.trim().split('\n')[0] },
        'wsl2 clone: vhd 导出失败（多半是 WSL VM 还在跑、vhdx 被占用），降级 tar',
      );
    } finally {
      await rm(tmpVhd, { force: true }).catch(() => {});
    }
  }

  const tmpTar = join(installRoot(), `.${dst}.export.tmp.tar`);
  try {
    const ex = await runWsl(['--export', src, tmpTar], 1_800_000);
    if (!ex.ok) {
      throw new Error(`wsl --export "${src}" failed: ${ex.stderr.trim() || 'unknown error'}`);
    }
    await importDistro(dst, tmpTar, undefined, false);
  } finally {
    await rm(tmpTar, { force: true }).catch(() => {});
  }
}

// 导入一个包（.tar / .vhdx）为发行版。installDir 需不存在或为空——半残留先清。
async function importDistro(
  name: string,
  archivePath: string,
  onProgress?: (e: BaseProgress) => void,
  vhd?: boolean,
): Promise<void> {
  assertName(name);
  const p = archivePath.trim();
  if (!p || !existsSync(p)) throw notFound(`archive not found: ${p}`);
  const useVhd = vhd ?? /\.vhdx$/i.test(p);
  const dir = distroDir(name);
  await rm(dir, { recursive: true, force: true });
  // 旧版本 wsl 要求 installDir 已存在（实测清单 #2）：先建出来。
  await mkdir(dir, { recursive: true });
  onProgress?.({ status: `导入发行版包 -> ${name}${useVhd ? '（vhd）' : ''}` });
  const r = await runWsl(['--import', name, dir, p, ...(useVhd ? ['--vhd'] : [])], 1_800_000);
  if (!r.ok) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`wsl --import "${name}" failed: ${r.stderr.trim() || 'unknown error'}`);
  }
}

// 首启 home seed：与 lxc.ts seedHome 同语义（缺失才写，失败只 warn 不回滚）。
// 差异点：宿主 ssh/claude 模板路径是 Windows 路径，容器内经 wslpath 换算（无挂载）；
// 路径为空/不存在时对应段自动跳过（wslpath 失败 → 变量为空 → if 不进）。
async function seedHome(cfg: Config, name: string, spec: CreateSpec): Promise<void> {
  const script = `
set -u
cd /home/dev || exit 0
[ -f "$HOME/.zshrc" ] || { [ -f /etc/skel-home/.zshrc ] && cp /etc/skel-home/.zshrc "$HOME/.zshrc"; }
mkdir -p "$HOME/.local/bin" "$HOME/.claude"
[ -e "$HOME/.local/bin/claude" ] || ln -s /usr/local/bin/claude "$HOME/.local/bin/claude" 2>/dev/null
[ -e "$HOME/.claude.json" ] || printf '%s' '{}' > "$HOME/.claude.json"
mkdir -p "$HOME/.agents/skills"
if [ -L "$HOME/.claude/skills" ]; then rm -f "$HOME/.claude/skills"; fi
mkdir -p "$HOME/.claude/skills"
if [ ! -f "$HOME/.claude/settings.json" ]; then
  TPL=$(wslpath ${shq(cfg.claudeSettingsTemplate)} 2>/dev/null || true)
  [ -n "$TPL" ] && [ -f "$TPL" ] && cp "$TPL" "$HOME/.claude/settings.json"
fi
if [ ! -d "$HOME/.claude/skills/playwright-cli" ] && [ -d /etc/skel-home/.claude/skills/playwright-cli ]; then
  mkdir -p "$HOME/.claude/skills"
  cp -a /etc/skel-home/.claude/skills/playwright-cli "$HOME/.claude/skills/"
fi
if [ ! -d "$HOME/.ssh" ]; then
  SRC=$(wslpath ${shq(cfg.sshSource)} 2>/dev/null || true)
  if [ -n "$SRC" ] && [ -d "$SRC" ]; then
    cp -a "$SRC" "$HOME/.ssh"
    chmod 700 "$HOME/.ssh" 2>/dev/null || true
    chmod 600 "$HOME/.ssh"/id_* 2>/dev/null || true
  fi
fi
if [ ! -f "$HOME/.gitconfig" ]; then
  printf '[user]\\n\\tname = %s\\n\\temail = %s\\n[init]\\n\\tdefaultBranch = main\\n' \\
    ${shq(spec.gitName)} ${shq(spec.gitEmail)} > "$HOME/.gitconfig"
fi
exit 0
`;
  const r = await execRun(cfg, name, {
    Cmd: ['sh', '-c', script],
    User: '1000:1000',
    Tty: false,
    timeoutMs: 60_000,
  });
  if (r.exitCode !== 0) {
    log.warn({ name, exitCode: r.exitCode, stderr: r.stderr.slice(0, 500) }, 'wsl2 home seed failed');
  }
}

// —— start/stop/restart ——
// start：`-d <名> --exec true` 阻塞到发行版起来（首次拉 VM 可能十几秒）。幂等：
// 已在跑直接返回（对齐 LXC start 幂等约定——exec 本身也会拉起，但显式查一次省 fork）。
async function startDistro(name: string): Promise<void> {
  const states = await listStates();
  if ((states[name] || '').toLowerCase() === 'running') return;
  const r = await runWsl(['-d', name, '--exec', 'true'], 120_000);
  if (!r.ok) throw new Error(`wsl start "${name}" failed: ${r.stderr.trim() || 'unknown error'}`);
}

async function stopDistro(name: string, _t = 5): Promise<void> {
  // terminate 对已停发行版无害（幂等）。
  const r = await runWsl(['--terminate', name], 60_000);
  if (!r.ok) {
    const states = await listStates();
    if ((states[name] || '').toLowerCase() === 'running') {
      throw new Error(`wsl --terminate failed: ${r.stderr.trim() || 'unknown error'}`);
    }
  }
}

async function restartDistro(cfg: Config, id: string, t = 5): Promise<void> {
  await stopDistro(assertName(id), t);
  await startDistro(assertName(id));
}

// rename：无原语（D8）——export→import 新名→unregister 旧名。必须先停。
async function renameDistro(cfg: Config, id: string, newName: string): Promise<void> {
  const name = assertName(id);
  assertName(newName);
  const states = await listStates();
  if ((states[name] || '').toLowerCase() === 'running') {
    throw conflict('distro must be stopped before rename (WSL has no live rename)');
  }
  if ((await listRegistered()).includes(newName)) {
    throw conflict(`distro name "${newName}" is already taken`);
  }
  await cloneDistro(name, newName);
  const book = await readBookkeeping(name);
  if (book) await writeBookkeeping(newName, book);
  await runWsl(['--unregister', name], 120_000);
  await rm(distroDir(name), { recursive: true, force: true }).catch(() => {});
}

// remove：unregister 连 VHD 一起删（D4），再清安装簿目录。
async function removeDistro(cfg: Config, id: string, opts: { force?: boolean } = {}): Promise<void> {
  const name = assertName(id);
  if (opts.force ?? true) {
    try {
      await stopDistro(name);
    } catch {
      /* 已停或停不下来，unregister 自己处理 */
    }
  }
  const r = await runWsl(['--unregister', name], 300_000);
  if (!r.ok && (await listRegistered()).includes(name)) {
    throw new Error(`wsl --unregister failed: ${r.stderr.trim() || 'unknown error'}`);
  }
  await rm(distroDir(name), { recursive: true, force: true }).catch(() => {});
}

// —— exec ——
// `wsl.exe -d <名> -u <user> --exec env … /bin/sh -c 'cd … || cd /; exec "$@"' sh <Cmd…>`
// --exec 不经默认 shell，argv 直传（注入面与 lxc-attach 同级）；cwd 兜底与 LXC 同款
// sh 包装（WorkingDir 不存在时退 home，行为一致）。
function execArgs(cfg: Config, name: string, opts: ExecOpts): string[] {
  return ['-d', name, ...execArgv(cfg, opts)];
}

// 不带 -d 的 exec 参数段（runExec/execStream/execSpawn 共享，-d 在各自入口拼）。
function execArgv(cfg: Config, opts: ExecOpts): string[] {
  const user = mapUser(opts.User);
  const cwd = opts.WorkingDir || (user === 'root' ? '/root' : '/home/dev');
  const env = [
    `HOME=${user === 'root' ? '/root' : '/home/dev'}`,
    // docker API 桥（dockerApi.enabled）：同 lxc.ts attachArgs。host.docker.internal
    // 由 hosts-sync 写进容器 /etc/hosts；Windows 上 Docker Desktop 另有自答，互不冲突。
    ...(cfg.dockerApi.enabled
      ? [`DOCKER_HOST=tcp://${DOCKER_API_HOSTNAME}:${DOCKER_API_PORT}`]
      : []),
    ...(opts.Env ?? []),
  ];
  if (!env.some((e) => e.startsWith('LANG=') || e.startsWith('LC_ALL='))) {
    env.push('LANG=C.UTF-8');
  }
  // PATH 不显式设：--exec 下 wsl 给发行版默认 PATH（含 /usr/bin 等），Windows 侧
  // PATH 经 interop 追加在尾部，不遮蔽。
  const args = ['-u', user, '--exec', 'env', ...env];
  args.push('/bin/sh', '-c', `cd ${shq(cwd)} 2>/dev/null || cd /; exec "$@"`, 'sh', ...opts.Cmd);
  return args;
}

// ExecOpts.User（LXC 口径，混着名字与数字）→ wsl -u 的用户名。gid 无对应旗标（跟随
// user），丢弃——现有调用方 gid 均与 uid 配套。未知名字保守落 dev。
// 纯数字原样传（wsl -u 接受 uid；实测清单 #4）。
function mapUser(user: string | undefined): string {
  if (!user) return 'dev';
  const u = user.split(':')[0];
  if (u === 'root' || u === '0') return 'root';
  if (u === 'dev' || u === '1000') return 'dev';
  if (/^\d+$/.test(u)) return u;
  return 'dev';
}

// 单引号 shell 转义（只用于 cd 路径与 seed 脚本内插值；路径可能来自配置）。
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// 跑命令收结果（结构与超时语义对齐 lxc.ts runAttach：timeout → stderr 追加
// [mysandbox: timeout]、exitCode -1，batch.ts/files.ts 依赖这个约定）。
async function execRun(cfg: Config, id: string, opts: ExecOpts): Promise<ExecResult> {
  return runExec(cfg, assertName(id), opts, null);
}
async function execFeed(
  cfg: Config,
  id: string,
  opts: ExecOpts,
  input: Buffer,
): Promise<ExecResult> {
  return runExec(cfg, assertName(id), opts, input);
}

function runExec(
  cfg: Config,
  name: string,
  opts: ExecOpts,
  input: Buffer | null,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = execArgs(cfg, name, opts);
    const child = spawn(wslBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch { /* noop */ }
        }, opts.timeoutMs)
      : null;
    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        stderr += stderr ? '\n[mysandbox: timeout]' : '[mysandbox: timeout]';
        exitCode = -1;
      }
      resolve({ exitCode, stdout, stderr });
    };
    child.stdin?.on('error', () => { /* noop */ });
    child.stdout?.on('error', () => { /* noop */ });
    child.stderr?.on('error', () => { /* noop */ });
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      stderr += (stderr ? '\n' : '') + (e instanceof Error ? e.message : String(e));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
    if (input) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

// —— PTY 流（terminal.ts 的底座）——
// node-pty 的 ConPTY spawn wsl.exe（D6）：wsl.exe 管道模式下 Linux 侧没有 tty，
// tmux 起不来，必须 ConPTY。resize 走 pty.resize（不再需要 script(1)/stty）。
// node-pty 是 optionalDependencies + 懒加载：没装时终端报人话错误，其余功能不受牵连。
// createRequire 兜类型解析（optionalDependencies 在无工具链的机器上可能装不上）。
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ): PtyTerm;
}
interface PtyTerm {
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
let ptyMod: PtyModule | null = null;
function loadPty(): PtyModule {
  if (ptyMod) return ptyMod;
  try {
    const req = createRequire(import.meta.url);
    ptyMod = req('node-pty') as PtyModule;
    return ptyMod;
  } catch {
    throw new Error(
      'wsl2 terminal requires node-pty (npm install node-pty). Other wsl2 features work without it.',
    );
  }
}

async function execStream(cfg: Config, id: string, opts: ExecOpts): Promise<ExecStream> {
  const name = assertName(id);
  const pty = loadPty();
  const args = ['-d', name, ...execArgv(cfg, opts)];
  const term = pty.spawn(wslBin(), args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: homedir(),
    env: { ...process.env } as Record<string, string>,
  });
  const duplex = new Duplex({
    read() { /* push 由 onData 驱动 */ },
    write(chunk, _enc, cb) {
      try { term.write(chunk.toString('utf8')); } catch { /* 已死 */ }
      cb();
    },
    destroy(_err, cb) {
      try { term.kill(); } catch { /* noop */ }
      cb();
    },
  });
  duplex.on('error', () => { /* noop */ });
  term.onData((d: string) => duplex.push(d));
  term.onExit(() => {
    duplex.push(null); // EOF → 上层关 socket
  });
  return {
    stream: duplex,
    resize: async (cols, rows) => {
      try {
        term.resize(cols, rows);
      } catch {
        /* 会话刚退出 */
      }
    },
  };
}

// —— 二进制流式 exec（files.ts 下载路由）——
// 管道模式 stdout 应为字节直通（D9 实测清单 #5 必须钉死：若 CRLF 改写则下载全体退化）。
function execSpawn(cfg: Config, id: string, opts: ExecOpts): ExecSpawnHandle {
  const args = execArgs(cfg, assertName(id), opts);
  const child = spawn(wslBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdin?.on('error', () => { /* noop */ });
  child.stderr?.on('error', () => { /* noop */ });
  child.stdout?.on('error', () => { /* noop */ });
  child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
  const done = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
    child.on('error', (e) => {
      resolve({ exitCode: -1, stderr: stderr + (stderr ? '\n' : '') + (e instanceof Error ? e.message : String(e)) });
    });
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
  });
  return {
    stdout: child.stdout!,
    done,
    kill: () => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    },
  };
}

// 进程退出时清掉派生的 wsl.exe（mock/实测环境对齐 lxc.ts children 的兜底；
// 发行版本体不在此列——WSL VM 归 WSL 服务管）。
const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
  }
});

// —— 网络 ——
// 权威源 = 安装簿的 assignedIp（D2/D5）：纯文件扫描，零 fork、不引导发行版。
// 真实 IP（NAT 动态）不进池记账——池管的是「分配记录」的去重。
async function assignedIps(_cfg: Config): Promise<Set<string>> {
  const set = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = await readdir(installRoot());
  } catch {
    return set;
  }
  for (const d of dirs) {
    if (!NAME_RE_NO_SLASH.test(d)) continue;
    const book = await readBookkeeping(d);
    if (book?.assignedIp) set.add(book.assignedIp);
  }
  return set;
}

async function nameExists(_cfg: Config, name: string): Promise<boolean> {
  return (await listRegistered()).includes(assertName(name));
}

// —— 事件 ——
// 无 monitor 原语（D8）：5s 轮询 --list --running，diff 出 start/stop。轮询不主动
// 断——closed 只在 close() 时 resolve（调用方退避重连逻辑用不上，但接口语义保持）。
async function subscribeEvents(
  _cfg: Config,
  onEvent: (ev: EngineEvent) => void,
): Promise<EventSubscription> {
  let prev = new Set(await listRunning().catch(() => []));
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const timer = setInterval(async () => {
    let cur: Set<string>;
    try {
      cur = new Set(await listRunning());
    } catch {
      return; // 一次失败不重置 diff 基线
    }
    for (const n of cur) if (!prev.has(n)) onEvent({ containerId: n, action: 'start' });
    for (const n of prev) if (!cur.has(n)) onEvent({ containerId: n, action: 'stop' });
    prev = cur;
  }, 5_000);
  timer.unref?.();
  return {
    close() {
      clearInterval(timer);
      resolveClosed();
    },
    closed,
  };
}

// —— 基座（模板发行版）——
async function baseStatus(cfg: Config): Promise<BaseStatus> {
  const t = cfg.wsl.template;
  // exists 与 context 独立计算（对齐 BaseStatus 契约：App 轮询，不能因 context 抛）。
  const registered = await listRegistered().catch(() => [] as string[]);
  const exists = registered.includes(t);
  const states = exists ? await listStates().catch(() => ({}) as Record<string, string>) : {};
  return {
    kind: 'template',
    name: t,
    exists,
    // ready = exists：导出前我们自动 terminate 源（D10），没有 LXC「必须 STOPPED」的
    // 前置——lxc-copy 对 running 源静默失败，wsl --export 不会。
    ready: exists,
    context: null,
    detail: exists ? { state: states[t] || 'Unknown', installDir: distroDir(t) } : undefined,
  };
}

// 基座动作分发（语义对齐 lxc.ts runBaseAction + template.ts，实现本地化到 wsl 原语）。
async function runBaseAction(
  cfg: Config,
  action: BaseAction,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const t = cfg.wsl.template;
  if (action === 'create' || action === 'import') {
    // create/import：把现成的 WSL 发行版包（rootfs tar / --export 产物 .tar|.vhdx）
    // 导入为模板。opts.path 必给。已存在默认拒绝（force 覆盖）。
    if (!opts.path) throw badRequest(`base ${action} requires "path" (WSL distro tarball or vhdx)`);
    const registered = await listRegistered();
    if (registered.includes(t)) {
      if (!opts.force) throw conflict(`template "${t}" already exists (use force to overwrite)`);
      onProgress?.({ status: `移除旧模板 ${t}` });
      await runWsl(['--unregister', t], 300_000);
      await rm(distroDir(t), { recursive: true, force: true }).catch(() => {});
    }
    await importDistro(t, expandTilde(opts.path), onProgress);
    return { name: t };
  }
  if (action === 'clone') {
    // 把现有发行版固化成模板（对齐 LXC clone：源先停，完成后不自动启回）。
    const from = opts.from || '';
    if (!from) throw badRequest('base clone requires "from" (distro name)');
    assertName(from);
    if (!(await listRegistered()).includes(from)) throw notFound(`distro ${from} not found`);
    onProgress?.({ status: `停止 ${from}（导出要求，完成后不自动重启）` });
    await runWsl(['--terminate', from], 60_000);
    if ((await listRegistered()).includes(t)) {
      if (!opts.force) throw conflict(`template "${t}" already exists (use force to overwrite)`);
      await runWsl(['--unregister', t], 300_000);
      await rm(distroDir(t), { recursive: true, force: true }).catch(() => {});
    }
    await cloneDistro(from, t);
    return { name: t, from };
  }
  if (action === 'export') {
    const registered = await listRegistered();
    if (!registered.includes(t)) throw notFound(`template "${t}" not found`);
    const outDir = join(homedir(), '.mysandbox', 'exports');
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const explicit = opts.path ? expandTilde(opts.path) : null;
    await runWsl(['--terminate', t], 60_000);

    // vhd 优先（块拷贝）；但实测 VM 在跑时 `--export --vhd` 会被 ext4.vhdx 占用打回
    // （ERROR_SHARING_VIOLATION，详见 cloneDistro 注释）→ 失败即降级 tar（VM 在跑时可用）。
    // 显式给了 .vhdx 路径 = 用户点名要这个格式，不偷偷换，直接把真实原因抛出去。
    const vhdOk = await vhdSupported();
    const tryVhd = vhdOk && (explicit == null || /\.vhdx$/i.test(explicit));
    if (tryVhd) {
      const vhdOut = explicit ?? join(outDir, `${t}-${stamp}.vhdx`);
      onProgress?.({ status: `导出模板 ${t} -> ${vhdOut}（vhd）` });
      const rv = await runWsl(['--export', t, vhdOut, '--vhd'], 1_800_000);
      if (rv.ok) return { name: t, path: vhdOut };
      if (explicit) {
        throw new Error(
          `wsl --export --vhd "${vhdOut}" failed: ${rv.stderr.trim() || 'unknown error（多为 WSL VM 未停、vhdx 被占用）'}`,
        );
      }
      log.warn(
        { template: t, err: rv.stderr.trim().split('\n')[0] },
        'wsl2 base export: vhd 导出失败（多半是 WSL VM 还在跑），降级 tar',
      );
    }
    const out = explicit ?? join(outDir, `${t}-${stamp}.tar`);
    onProgress?.({ status: `导出模板 ${t} -> ${out}` });
    const r = await runWsl(['--export', t, out], 1_800_000);
    if (!r.ok) throw new Error(`wsl --export failed: ${r.stderr.trim() || 'unknown error'}`);
    return { name: t, path: out };
  }
  throw badRequest(`engine wsl2 does not support base action "${action}"`);
}

// 基座体积 = 模板 ext4.vhdx 文件大小（不再需要 LXC 那种 rootfs 遍历）。
async function baseSize(cfg: Config): Promise<number | null> {
  try {
    const s = await stat(join(distroDir(cfg.wsl.template), 'ext4.vhdx'));
    return s.size;
  } catch {
    return null;
  }
}

// —— 宿主侧路径（D3）——
// \\wsl.localhost UNC 在 Windows 上 node fs 可直读直写（9P 映射到发行版默认用户）；
// 非 Windows 平台返回 null，调用方（files/skillSync/aiconfig/open）已有降级。
// ⚠️ 读 \\wsl.localhost 会自动启动已停发行版——高频路径走安装簿（D2），别加新消费点。
function wslRoot(name: string): string | null {
  if (!isWindows()) return null;
  return `\\\\wsl.localhost\\${assertName(name)}`;
}

async function readTemplateHosts(cfg: Config): Promise<string | null> {
  const root = wslRoot(cfg.wsl.template);
  if (!root) return null;
  try {
    return await readFile(join(root, 'etc', 'hosts'), 'utf8');
  } catch {
    return null;
  }
}

// 包内 /etc/hosts（「从包建容器」预览）。tar 包（wsl --export 产物，路径在顶层）用
// 宿主 tar 试两种布局；vhdx 包读不了（要挂载），返回 null 降级。
async function readArchiveHosts(_cfg: Config, archivePath: string): Promise<string | null> {
  const p = expandTilde((archivePath || '').trim());
  if (!p || !existsSync(p)) return null;
  if (/\.vhdx$/i.test(p)) return null;
  for (const member of ['etc/hosts', './etc/hosts']) {
    const r = await runHost(['tar', '-xOf', p, member], 30_000);
    if (r.ok && r.stdout.trim()) return r.stdout;
  }
  return null;
}

async function runHost(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(args[0], args.slice(1), { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export const wsl2Engine: Engine = {
  name: 'wsl2',
  caps: CAPS,
  status,
  listManaged,
  inspect,
  create,
  start: (cfg, id) => startDistro(assertName(id)),
  stop: (cfg, id, t) => stopDistro(assertName(id), t),
  restart: restartDistro,
  rename: renameDistro,
  remove: removeDistro,
  execRun,
  execFeed,
  execStream,
  execSpawn,
  assignedIps,
  subscribeEvents,
  baseStatus,
  runBaseAction,
  baseName: (cfg) => cfg.wsl.template,
  baseSize,
  nameExists,
  hostHomePath: (_cfg, name) => (wslRoot(name) ? `${wslRoot(name)}\\home\\dev` : null),
  rootfsPath: (_cfg, name) => wslRoot(name),
  readTemplateHosts,
  readArchiveHosts,
};
