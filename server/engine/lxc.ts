// LXC 引擎实现（接口见 types.ts），底层是 lxc-* CLI + 容器 config 纯文本。
//
// 「容器 = 一台开机的机器」是这层的核心语义差异：LXC 容器跑真 systemd（PID 1），
// 起停就是开关机，没有 Cmd/Entrypoint/镜像那套概念。
//
// ## 运行环境硬约束（PoC 实测，改这个文件前必读）
//
// LXC 命令必须在**已委派 cgroup 的 systemd user manager 环境**里跑。裸 shell（SSH session）
// 落在 root 属主的 `session-<n>.scope`，`lxc-start` 报 `cgroup.threads is not writable`
// → 容器秒退 255；`lxc-attach` 报 `cgroup_attach_move_into_leaf: Permission denied`。
// 因此 **mysandbox 必须以 systemd user service 形态运行**（`systemctl --user` + linger），
// 落在已委派的 `user@1000.service` 下。实测结论：
//   - 本进程直接 spawn `lxc-attach`（子进程继承本进程 cgroup）→ 直接可用，无需任何包装；
//   - `lxc-start` 不能直接 spawn：容器进程会挂在本服务的 cgroup 下，mysandbox 一重启就
//     被 systemd 连带清杀。必须 `systemd-run --user --unit=mysandbox-<name>` 把容器放进
//     **自己的**瞬态单元（见 startContainer 注释）。
//   - 由此 `lxc.cgroup.dir` 不需要配、`/sys/fs/cgroup/lxc` 也不需要 sudo 预建——容器 cgroup
//     自然落在 `user@1000.service/app.slice/mysandbox-<name>.service/lxc.payload.<name>`。
//
// ## PTY
//
// 终端复用 hostTerminal.ts 的方案：`script(1)` 提供 PTY
// 包住 `lxc-attach`，resize 走子进程 pts 上的 `stty -F`（详见 execStream 注释）。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { Duplex } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { Config } from '../config.js';
import { expandTilde } from '../config.js';
import { getAllMeta, type ContainerMeta } from '../state.js';
import { log } from '../logger.js';
import { notFound, conflict, badRequest } from '../errors.js';
import { gatewayOf, allocate } from '../network.js';
import { DOCKER_API_HOSTNAME, DOCKER_API_PORT } from '../dockerApi.js';
import {
  templateStatus,
  templateSize,
  cloneTemplate,
  createTemplate,
  exportTemplate,
  importTemplate,
  importArchiveTo,
  resetMachineId,
  fixHomeOwnership,
  type TemplateDeps,
} from './template.js';
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

const execFileAsync = promisify(execFile);

// LXC 形态的能力（见 types.ts EngineCaps）：
// - dataInsideContainer：D4 决定 home 在 rootfs 内，lxc-destroy 连数据一起删，
//   「删容器保留数据」不存在——业务层/web 据此改文案与选项。
// - liveRename：LXC 无 rename 原语，lxc-copy -R 要求容器已停。
// - portMappings：固定 IP 直连（D2），不做 NAT。
// - baseKind/baseActions：基座是「模板容器」而非镜像，没有 registry 所以没有 build/pull/push；
//   create（从零制作：lxc-create 下载 rootfs + 跑制作脚本）、clone（把调好的容器固化成模板）、
//   export/import（打包成 tar.zst 当分发形态）见 template.ts。
const CAPS: EngineCaps = {
  dataInsideContainer: true,
  liveRename: false,
  portMappings: false,
  baseKind: 'template',
  baseActions: ['create', 'clone', 'export', 'import'],
};

// 受管理标记（D5：LXC 没有 label，用 config 里的纯文本键；可 diff、可手改）。
// lxc.environment 是唯一「随容器走、启动时注入、不被 LXC 校验拒绝」的自定义键。
export const MANAGED_KEY = 'MYSANDBOX_MANAGED';
const MANAGED_LINE = `lxc.environment = ${MANAGED_KEY}=true`;

// 容器根目录（unprivileged LXC 默认 lxcpath）。rootfs 在 <lxcpath>/<name>/rootfs（D4：home 在 rootfs 内）。
// ⚠️ 这里**不能**用 xdgDataHome()：liblxc 把非特权 lxcpath 硬编码成 `$HOME/.local/share/lxc`，
// 不认 XDG_DATA_HOME（strings liblxc 只有该字面量，XDG 相关仅 XDG_RUNTIME_DIR）。跟着 XDG 走
// 会在设了该变量的环境里与 lxc-* 命令看的路径分叉——我们说容器不存在，lxc-ls 说存在。
// 同理 template.ts 读 default.conf 必须走 $HOME/.config/lxc，不走 xdgConfigHome()。
export function lxcPath(): string {
  return join(homedir(), '.local', 'share', 'lxc');
}
export function containerDir(name: string): string {
  return join(lxcPath(), name);
}
export function configPath(name: string): string {
  return join(containerDir(name), 'config');
}
// 容器内 /home/dev 在宿主侧的真实路径（D1 uid 直通 → 属主就是 leon，files.ts 可直读）。
export function containerHomePath(name: string): string {
  return join(containerDir(name), 'rootfs', 'home', 'dev');
}

// LXC 里「id」就是容器名。engine 接口的 id 参数一律当名字用。
// 名字校验挡住 shell 元字符与路径穿越——所有 lxc-* 调用都用 execFile/spawn 数组参数（无 shell），
// 这里再挡一层是为了不让脏名字进 config 路径拼接。
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
function assertName(id: string): string {
  if (!NAME_RE.test(id)) throw notFound(`invalid container name "${id}"`);
  return id;
}

// 跑一条外部命令（lxc-* 为主）。
// 不加 systemd-run 包装：本进程已在 user manager 环境里（见文件头注释），子进程继承 cgroup 即可。
// 失败不抛，返回 ok:false 由调用方按语义处理（lxc CLI 大量用非零退出表达「没这个容器」/
// 「没在跑」这类正常状态）。
async function run(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(args[0], args.slice(1), {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

// —— Engine.status：LXC 可用性 ——
// 没有 daemon 可连（这正是选裸 LXC 的理由之一），「可达」= CLI 在 + user manager 环境对。
// 后者是最常见的部署错误（mysandbox 没作为 systemd user service 跑），必须在这里报出来，
// 否则用户只会看到「建容器成功但秒退」这种难查的表象。
async function status(_cfg: Config) {
  const v = await run(['lxc-start', '--version'], 5_000);
  if (!v.ok) {
    return { reachable: false, error: 'lxc CLI not found (apt install lxc uidmap lxcfs)' };
  }
  const version = v.stdout.trim();
  if (!process.env.XDG_RUNTIME_DIR) {
    return {
      reachable: false,
      version,
      error:
        'no systemd user manager environment (XDG_RUNTIME_DIR unset). mysandbox must run as a systemd user service: `systemctl --user`',
    };
  }
  return { reachable: true, version };
}

// —— config 读写：LXC 的「元数据」就是这个纯文本文件 ——
export async function readConfig(name: string): Promise<string | null> {
  const p = configPath(assertName(name));
  if (!existsSync(p)) return null;
  return readFile(p, 'utf8');
}

// 取 config 里某个键的值（最后一次出现的为准，与 LXC 自身的后覆盖前语义一致）。
export function configValue(content: string, key: string): string | null {
  let found: string | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== key) continue;
    found = line.slice(eq + 1).trim();
  }
  return found;
}

// 受管理判定（D5）：config 里有 MANAGED_KEY 标记。
function isManagedConfig(content: string): boolean {
  return configValue(content, 'lxc.environment') === `${MANAGED_KEY}=true`
    || content.includes(MANAGED_LINE);
}

// 往 config 追加受管理标记（adopt 外部容器用；幂等）。
export async function markManaged(name: string): Promise<void> {
  const content = await readConfig(name);
  if (content == null) throw notFound(`container ${name} not found`);
  if (isManagedConfig(content)) return;
  const sep = content.endsWith('\n') ? '' : '\n';
  await writeFile(configPath(name), `${content}${sep}${MANAGED_LINE}\n`);
}

// 改写 config 里某个键（最后一次出现的那行原地替换；不存在则追加）。
// 「最后一次为准」与 configValue 的读取语义对称——LXC 自身也是后覆盖前。
export function setConfigValue(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() === key) lastIdx = i;
  }
  if (lastIdx >= 0) {
    lines[lastIdx] = `${key} = ${value}`;
    return lines.join('\n');
  }
  const sep = content.endsWith('\n') || content === '' ? '' : '\n';
  return `${content}${sep}${key} = ${value}\n`;
}

// 本地管理段（02:)的随机 MAC，给克隆出来的容器一个与模板无关的身份（见 create 注释）。
function randomMac(): string {
  const b = randomBytes(6);
  b[0] = (b[0] | 0x02) & 0xfe; // locally administered, unicast
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
}

// —— 状态查询 ——
// lxc-info -n X 的输出是 `Key:<空白>Value` 行。一次调用取全（state/pid/ip），避免多次 fork。
async function infoLines(name: string): Promise<Record<string, string> | null> {
  const r = await run(['lxc-info', '-n', assertName(name)], 10_000);
  if (!r.ok) return null;
  const out: Record<string, string> = {};
  for (const line of r.stdout.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k && !out[k]) out[k] = v; // 首次出现为准（TX/RX bytes 那几行带前导空格，key 不冲突）
  }
  return out;
}

// 全部已定义容器名（含停止的）。-1 = 一行一个，比 -f 的列对齐输出好解析。
async function listNames(): Promise<string[]> {
  const r = await run(['lxc-ls', '-1'], 10_000);
  if (!r.ok) return [];
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// LXC 的 STOPPED/RUNNING/FROZEN → web 侧约定的 state 字符串（running/exited/...）。
function mapState(lxcState: string): { state: string; running: boolean } {
  const s = (lxcState || '').toUpperCase();
  if (s === 'RUNNING') return { state: 'running', running: true };
  if (s === 'FROZEN') return { state: 'paused', running: false };
  if (s === 'STARTING') return { state: 'restarting', running: false };
  if (s === 'STOPPING') return { state: 'exited', running: false };
  return { state: 'exited', running: false };
}

// 列出受管理容器：config 有标记 或 挂在配置的网桥上。
// 模板容器本身不算——它两条判定都命中（克隆来源带标记、网桥共用），但它是「基座」不是工作容器，
// 「基座不出现在容器列表」。assignedIps 独立扫全部 config，模板 IP 仍算占用。
async function listManaged(cfg: Config): Promise<ContainerView[]> {
  const names = await listNames();
  const meta = await getAllMeta();
  const bridge = await resolveBridge(cfg);
  const views: ContainerView[] = [];
  for (const name of names) {
    if (name === cfg.lxc.template) continue;
    const content = await readConfig(name);
    if (content == null) continue;
    const managed = isManagedConfig(content);
    const link = configValue(content, 'lxc.net.0.link');
    const onNet = !!bridge && link === bridge;
    if (!managed && !onNet) continue;

    const info = await infoLines(name);
    const { state, running } = mapState(info?.State ?? 'STOPPED');
    // IP：跑起来的读 lxc-info（真实态）；停的读 config 静态配置（LXC 的 IP 是配出来的，
    // 停机容器也能显示它的固定 IP，UI 体验更好）。
    const ip = running
      ? info?.IP || null
      : (configValue(content, 'lxc.net.0.ipv4.address') || '').split('/')[0] || null;
    const m: ContainerMeta | undefined = meta[name];
    views.push({
      id: name, // LXC 无独立 id，名字即 id
      name,
      displayName: m?.displayName,
      status: running ? 'Up' : 'Stopped',
      state,
      image: 'lxc', // LXC 无镜像概念（D3：模板容器克隆而来）；模板来源记在 sidecar source
      ip,
      networks: link ? [cfg.network] : [],
      managed,
      adopted: !!m?.managed,
      description: m?.description,
      tags: m?.tags,
      source: m?.source,
      labels: {}, // LXC 无 label
      ports: [], // LXC 直连固定 IP，无 NAT 端口映射（D2）
      created: createdAtMs(m),
      command: '/sbin/init', // 真 init，不是 sleep infinity
    });
  }
  views.sort((a, b) => {
    if (a.state === 'running' && b.state !== 'running') return -1;
    if (a.state !== 'running' && b.state === 'running') return 1;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });
  return views;
}

function createdAtMs(m: ContainerMeta | undefined): number {
  if (!m?.createdAt) return 0;
  const t = Date.parse(m.createdAt);
  return Number.isNaN(t) ? 0 : t;
}

// 配置的网桥设备名 → 存在性确认（cfg.network 直接给桥名，如 mysandbox0）。
// 桥由 mysandbox-net.service 建（独立于 docker）。缓存：桥名只在配置里变，查一次
// /sys/class/net 足够。
let bridgeCache: { network: string; bridge: string | null } | null = null;
export async function resolveBridge(cfg: Config): Promise<string | null> {
  if (bridgeCache && bridgeCache.network === cfg.network) return bridgeCache.bridge;
  const bridge = existsSync(`/sys/class/net/${cfg.network}`) ? cfg.network : null;
  if (bridge == null) {
    // 不存在的桥是最早会撞上的部署错误（容器建好了起不来网），给足上下文。
    log.warn(`bridge "${cfg.network}" not found in /sys/class/net — set network: to the host bridge device name`);
  }
  bridgeCache = { network: cfg.network, bridge };
  return bridge;
}

// —— inspect 归一 ——
async function inspect(cfg: Config, id: string): Promise<ContainerInfo> {
  const name = assertName(id);
  const content = await readConfig(name);
  if (content == null) throw notFound(`container ${name} not found`);
  const info = await infoLines(name);
  const { state, running } = mapState(info?.State ?? 'STOPPED');
  const link = configValue(content, 'lxc.net.0.link');
  const bridge = await resolveBridge(cfg);
  // IP 口径同 listManaged：跑起来读 lxc-info（真实态），停机读 config 静态配置。
  const ip = running
    ? info?.IP || null
    : (configValue(content, 'lxc.net.0.ipv4.address') || '').split('/')[0] || null;
  return {
    id: name,
    name,
    running,
    stateStatus: state,
    managed: isManagedConfig(content),
    networks: link && link === bridge ? [cfg.network] : link ? [link] : [],
    ip,
    ports: [],
  };
}

// —— 生命周期 ——
// 建容器 = 克隆模板容器（D3：镜像的替代物）+ 改写 config。
//
// 实测约束（写这段时踩到的，勿改）：
//   - **lxc-copy 要求源容器已停**。源在跑时它 exit 1 且 **stderr 全空**——没有任何错误信息，
//     所以必须自己前置检查并给人话错误，否则用户只会看到「建容器失败，原因不明」。
//   - lxc-copy **已经**帮我们改好 `lxc.rootfs.path` 与 `lxc.uts.name`（实测 diff 确认），
//     所以只需改 IP。（设计文档原先说 uts.name 也要手改，是错的，已回写修正。）
//   - 克隆继承源的静态 IP → 必撞，改写是强制的，不是优化。
// 落地 rootfs：三来源（模板克隆 / 现有容器克隆 / tar.zst 解包）。
// 落地后新容器目录结构与 config 形状对 finalizeCreated 是统一的。
async function materialize(
  cfg: Config,
  name: string,
  source: CreateSource | undefined,
  onProgress?: (e: BaseProgress) => void,
): Promise<void> {
  // 缺省 = 模板（既有行为）
  if (source == null) {
    const template = cfg.lxc.template;
    assertName(template);
    // 模板存在性：给「先建模板」的明确指引，不让 lxc-copy 抛看不懂的东西。
    if ((await readConfig(template)) == null) {
      throw notFound(
        `LXC template container "${template}" not found. Create it first (see docs/lxc-migration.md), or set lxc.template in config.`,
      );
    }
    const tInfo = await infoLines(template);
    const tState = (tInfo?.State ?? 'STOPPED').toUpperCase();
    if (tState !== 'STOPPED') {
      throw new Error(
        `LXC template "${template}" must be stopped before cloning (currently ${tState}). ` +
          'lxc-copy fails silently on a running source.',
      );
    }
    onProgress?.({ status: `克隆模板 ${template} -> ${name}` });
    await cloneCopy(template, name);
    return;
  }

  if (source.kind === 'container') {
    const src = assertName(source.name);
    if ((await readConfig(src)) == null) throw notFound(`source container "${src}" not found`);
    // 在跑则先停（与 base clone 同语义）：lxc-copy 对运行中的源 exit 1 且 stderr 全空。
    // 停完不自动启回来——源是什么状态交还用户。
    const sInfo = await infoLines(src);
    const sState = (sInfo?.State ?? 'STOPPED').toUpperCase();
    if (sState !== 'STOPPED') {
      onProgress?.({ status: `停止 ${src}（克隆要求源已停，完成后不自动重启）` });
      await stopContainer(cfg, src);
    }
    onProgress?.({ status: `克隆容器 ${src} -> ${name}` });
    await cloneCopy(src, name);
    return;
  }

  // archive：解包落地（idmap 按本机 default.conf 重写，见 importArchiveTo 注释）
  onProgress?.({ status: `从包 ${source.path} 建容器 ${name}` });
  await importArchiveTo(cfg, templateDeps, name, expandTilde(source.path.trim()), onProgress);
}

// lxc-copy 的统一包装：失败给人话错误（含「源在跑」的提示——stderr 常常是空的）。
async function cloneCopy(from: string, to: string): Promise<void> {
  const r = await run(['lxc-copy', '-n', from, '-N', to], 300_000);
  if (!r.ok) {
    throw new Error(
      `lxc-copy from "${from}" failed: ${r.stderr.trim() || 'no error output (is the source running?)'}`,
    );
  }
}

async function create(
  cfg: Config,
  spec: CreateSpec,
  onProgress?: (e: BaseProgress) => void,
): Promise<{ id: string }> {
  const name = assertName(spec.name);

  try {
    await materialize(cfg, name, spec.source, onProgress);

    // 落地后改写 config：IP（克隆继承源的必撞）+ 网关（网段可能已与源不同）+ 受管理标记
    // + 网桥对齐当前配置 + ssh 只读挂载。三种来源统一走这段——解包路径的 config 已被
    // rewriteImportedConfig 修过 rootfs.path/uts.name/idmap，其余键照改不误。
    onProgress?.({ status: '改写网络配置' });
    const content = await readConfig(name);
    if (content == null) throw new Error(`clone succeeded but config missing for ${name}`);
    let next = setConfigValue(content, 'lxc.net.0.type', 'veth');
    next = setConfigValue(next, 'lxc.net.0.ipv4.address', `${spec.ip}/24`);
    next = setConfigValue(next, 'lxc.net.0.ipv4.gateway', gatewayOf(cfg));
    // MAC：克隆继承源的 machine-id，容器内 udev 的 MACAddressPolicy=persistent 按
    // machine-id 哈希出**同一个** MAC——两个同 MAC 接口挂同一座桥，fdb 端口来回摆，
    // 容器间 ARP 永远达不成（实测：宿主→容器通、容器→容器 No route to host）。
    // config 写死 hwaddr 后 LXC 直接用它，不落在 udev 的哈希路径上。
    next = setConfigValue(next, 'lxc.net.0.hwaddr', randomMac());
    const bridge = await resolveBridge(cfg);
    if (bridge) next = setConfigValue(next, 'lxc.net.0.link', bridge);
    // 宿主 ~/.ssh 只读进容器 /mnt/host/.ssh。
    // 相对路径 + create=dir：LXC 的挂载点相对 rootfs，挂载点不存在时自动建。
    // unprivileged 下实测可读、写被 ro 挡住——首启 seed 与 batch ssh reseed 都依赖它。
    // sshSource 留空（config 可置空）则不挂：空源的 mount entry 会让 lxc-start 死在 mount 阶段。
    if (cfg.sshSource) {
      next = setConfigValue(
        next,
        'lxc.mount.entry',
        `${cfg.sshSource} mnt/host/.ssh none bind,ro,create=dir 0 0`,
      );
    }
    if (cfg.claudeSettingsTemplate) {
      next = `${next.endsWith('\n') ? next : next + '\n'}lxc.mount.entry = ${cfg.claudeSettingsTemplate} mnt/claude-settings.template none bind,ro,create=file 0 0\n`;
    }
    if (!isManagedConfig(next)) {
      const sep = next.endsWith('\n') ? '' : '\n';
      next = `${next}${sep}${MANAGED_LINE}\n`;
    }
    await writeFile(configPath(name), next);

    // 首启前清空 machine-id（systemd 会重新生成）：克隆连身份一起拷，所有容器
    // 共享源的 machine-id（见 template.ts resetMachineId 注释的踩坑记录）。
    await resetMachineId(containerDir(name), next);
    // home 属主统一归还 dev：脏模板的 root 属主文件经克隆链传染，宿主 seed 直读直写
    // 会 EACCES（实测踩坑：.local 卡死容器 CLI/peer.json 种子）。
    await fixHomeOwnership(containerDir(name), next);

    onProgress?.({ status: '启动容器' });
    await startContainer(cfg, name);
    // 首启 seed：
    // LXC 侧 PID 1 是真 systemd、不存在 entrypoint 钩子，所以由引擎在建完后 attach 进去跑一次。
    // 语义保持「缺失才写」——用户后续改了 ~/.zshrc / ~/.gitconfig 不会被覆盖。
    onProgress?.({ status: '首启 seed' });
    await seedHome(cfg, name, spec);
  } catch (e) {
    // 半成品清理。LXC 下 rootfs 就是数据，
    // 一起删——此时容器刚克隆出来还没有用户数据，删掉是安全的。
    // 解包路径下 ns 内写的文件属主是 100000，宿主 rm 删不净，必须走 lxc-destroy。
    try {
      await removeContainer(cfg, name, { force: true });
    } catch {
      /* noop */
    }
    throw e;
  }
  return { id: name };
}

// 首启 home seed：LXC 版的 image/entrypoint.sh。
//
// 为什么在这儿而不是容器内的某个 unit：每次起容器都查一遍成本高且不可靠，
// LXC 侧 PID 1 是发行版自己的 systemd，塞一个 mysandbox 专属 unit 进 rootfs 等于给模板
// 加隐式契约（模板换了就静默失效）。建容器是唯一需要 seed 的时刻——克隆出来的 home 就是
// 模板的 home，之后归用户——所以放在 create 里跑一次，语义更准也更好排查。
//
// 「缺失才写」逐条对齐 entrypoint.sh：用户改过的文件绝不覆盖。
// 失败只 warn 不抛：容器已经建好并跑起来了，seed 半途失败不该把它回滚掉
// （对齐 lifecycle.ts 里 applyInitialHosts 的取舍）。
async function seedHome(cfg: Config, name: string, spec: CreateSpec): Promise<void> {
  const script = `
set -u
cd /home/dev || exit 0
[ -f "$HOME/.zshrc" ] || { [ -f /etc/skel-home/.zshrc ] && cp /etc/skel-home/.zshrc "$HOME/.zshrc"; }
mkdir -p "$HOME/.local/bin" "$HOME/.claude"
[ -e "$HOME/.local/bin/claude" ] || ln -s /usr/local/bin/claude "$HOME/.local/bin/claude" 2>/dev/null
[ -e "$HOME/.claude.json" ] || printf '%s' '{}' > "$HOME/.claude.json"
# 全局技能目录：~/.agents/skills 是唯一真身，~/.claude/skills 是指向它的相对软链
# （claude 等工具读软链；相对路径宿主侧直写 rootfs 也能解析）。存量非软链目录先并入。
mkdir -p "$HOME/.agents/skills"
if [ -d "$HOME/.claude/skills" ] && [ ! -L "$HOME/.claude/skills" ]; then
  cp -a "$HOME/.claude/skills/." "$HOME/.agents/skills/"
  rm -rf "$HOME/.claude/skills"
fi
[ -L "$HOME/.claude/skills" ] || ln -s ../.agents/skills "$HOME/.claude/skills"
if [ ! -f "$HOME/.claude/settings.json" ] && [ -f /mnt/claude-settings.template ]; then
  cp /mnt/claude-settings.template "$HOME/.claude/settings.json"
fi
if [ ! -d "$HOME/.claude/skills/playwright-cli" ] && [ -d /etc/skel-home/.claude/skills/playwright-cli ]; then
  mkdir -p "$HOME/.claude/skills"
  cp -a /etc/skel-home/.claude/skills/playwright-cli "$HOME/.claude/skills/"
fi
# ssh：从只读挂载的宿主 key 拷一份可写副本（挂载点见 create 里的 lxc.mount.entry）
if [ -d /mnt/host/.ssh ] && [ ! -d "$HOME/.ssh" ]; then
  cp -a /mnt/host/.ssh "$HOME/.ssh"
  chmod 700 "$HOME/.ssh"
  chmod 600 "$HOME/.ssh"/id_* 2>/dev/null || true
fi
if [ ! -f "$HOME/.gitconfig" ]; then
  printf '[user]\\n\\tname = %s\\n\\temail = %s\\n[init]\\n\\tdefaultBranch = main\\n' \
    ${shq(spec.gitName)} ${shq(spec.gitEmail)} > "$HOME/.gitconfig"
fi
exit 0
`;
  const r = await runAttach(cfg, name, {
    Cmd: ['sh', '-c', script],
    User: '1000:1000',
    Tty: false,
    timeoutMs: 30_000,
  }, null);
  if (r.exitCode !== 0) {
    log.warn({ name, exitCode: r.exitCode, stderr: r.stderr.slice(0, 500) }, 'lxc home seed failed');
  }
}

// 启动：必须放进**独立的** systemd user 瞬态单元（见文件头）。`-F`（前台）+ 单元常驻，
// 这样容器 cgroup 挂在 mysandbox-<name>.service 而非 mysandbox 自己的服务下——
// mysandbox 重启/升级不会连带杀掉所有容器（实测直接 spawn 会被清杀）。
// --collect：单元退出后自动回收，不留 failed 残骸。
async function startContainer(_cfg: Config, id: string): Promise<void> {
  const name = assertName(id);
  // 幂等：已在跑就直接返回。少这一步，systemd-run 会
  // 撞上同名单元报「already loaded」，把「本来就好着」变成 500。
  const cur = await infoLines(name);
  if ((cur?.State ?? 'STOPPED').toUpperCase() === 'RUNNING') return;
  // 容器已停但单元还挂着（异常退出没被 --collect 回收）：先清掉占位，否则同名单元冲突。
  // 单元不存在时 reset-failed 报错无害，忽略。
  await run(['systemctl', '--user', 'reset-failed', unitName(name)], 5_000);
  const r = await run(
    [
      'systemd-run', '--user', `--unit=${unitName(name)}`, '--collect',
      '--property=KillMode=mixed', // 停机时先 TERM 主进程（lxc-start 会优雅停容器），再收尾
      'lxc-start', '-n', name, '-F',
    ],
    20_000,
  );
  if (!r.ok) throw new Error(`lxc-start failed: ${r.stderr.trim() || 'unknown error'}`);
  // systemd-run 立刻返回（单元后台跑），等 RUNNING 才算启动成功——否则调用方拿到 ok
  // 但容器还没起来（PID 1 起 systemd 要几秒），后续 exec 全失败。
  await waitState(name, 'RUNNING', 30_000);
}

export function unitName(name: string): string {
  return `mysandbox-${name}.service`;
}

// 轮询等状态（LXC 无事件等待原语；lxc-wait 存在但对 unprivileged + 瞬态单元路径不稳）。
async function waitState(name: string, want: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = await infoLines(name);
    if ((info?.State ?? 'STOPPED').toUpperCase() === want) return;
    if (Date.now() > deadline) {
      throw new Error(`container ${name} did not reach ${want} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// 停止：lxc-stop 给容器 init 发关机信号（真关机）。
// -t 是宽限秒数，超时后强杀。
async function stopContainer(_cfg: Config, id: string, t = 5): Promise<void> {
  const name = assertName(id);
  const r = await run(['lxc-stop', '-n', name, '-t', String(t)], (t + 20) * 1000);
  // 已经停了：lxc-stop 报错但语义上是成功。
  if (!r.ok) {
    const info = await infoLines(name);
    if ((info?.State ?? 'STOPPED').toUpperCase() !== 'STOPPED') {
      throw new Error(`lxc-stop failed: ${r.stderr.trim() || 'unknown error'}`);
    }
  }
  // 瞬态单元通常随 lxc-start 退出自行回收（--collect）；残留就显式停，防单元名占用下次启动。
  await run(['systemctl', '--user', 'stop', unitName(name)], 10_000);
}

async function restartContainer(cfg: Config, id: string, t = 5): Promise<void> {
  await stopContainer(cfg, id, t);
  await startContainer(cfg, id);
}

// 重命名：LXC 无 rename 原语。lxc-copy -R 是「移动」（改名不复制数据），但要求容器已停。
// 与 create 同款坑：源在跑时 lxc-copy exit 1 且 stderr 全空，故先自行检查状态给人话错误。
async function renameContainer(_cfg: Config, id: string, newName: string): Promise<void> {
  const name = assertName(id);
  assertName(newName);
  const info = await infoLines(name);
  if ((info?.State ?? 'STOPPED').toUpperCase() !== 'STOPPED') {
    throw conflict('container must be stopped before rename (LXC has no live rename)');
  }
  const r = await run(['lxc-copy', '-n', name, '-N', newName, '-R'], 60_000);
  if (!r.ok) throw new Error(`rename failed: ${r.stderr.trim() || 'unknown error'}`);
  // uts.name（容器 hostname）：lxc-copy 通常会改，但 -R 路径不保证，显式对齐一次（幂等）。
  const content = await readConfig(newName);
  if (content != null) {
    const next = setConfigValue(content, 'lxc.uts.name', newName);
    if (next !== content) await writeFile(configPath(newName), next);
  }
}

// 删除：先停再 lxc-destroy（连 rootfs 一起删——D4 下 home 在 rootfs 内，
// 所以「删数据」与「删容器」在 LXC 里是同一件事，lifecycle 层的 deleteData 语义要相应调整）。
async function removeContainer(cfg: Config, id: string, opts: { force?: boolean } = {}): Promise<void> {
  const name = assertName(id);
  if (opts.force ?? true) {
    try {
      await stopContainer(cfg, name, 5);
    } catch {
      /* 已停或停不下来，交给 destroy -f */
    }
  }
  const r = await run(['lxc-destroy', '-n', name, '-f'], 120_000);
  if (!r.ok && existsSync(containerDir(name))) {
    throw new Error(`lxc-destroy failed: ${r.stderr.trim() || 'unknown error'}`);
  }
}

// —— exec ——
// lxc-attach 直接 spawn（本进程已在 user manager 环境，子进程继承 cgroup）。
// --clear-env：不把 mysandbox 服务的环境泄进容器；
// 需要的变量用 -v 显式带。-u/-g 走容器内 uid（默认 1000 dev）。
function attachArgs(cfg: Config, name: string, opts: ExecOpts): string[] {
  const { uid, gid } = parseUser(opts.User);
  const args = ['lxc-attach', '-n', name, '--clear-env', '-u', String(uid), '-g', String(gid)];
  const env = [
    `HOME=${uid === 0 ? '/root' : '/home/dev'}`,
    'PATH=/home/dev/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    // docker API 桥（dockerApi.enabled）：容器内进程直用宿主 dockerd（server/dockerApi.ts）。
    // host.docker.internal 由 hosts-sync 写进容器 /etc/hosts（services 尾块）→ 网关 IP；
    // tmux 老 server 起的 shell 吃不到这里的 env，scripts/zshrc 里有同款条件导出兜底。
    ...(cfg.dockerApi.enabled
      ? [`DOCKER_HOST=tcp://${DOCKER_API_HOSTNAME}:${DOCKER_API_PORT}`]
      : []),
    ...(opts.Env ?? []),
  ];
  // locale 兜底：--clear-env 后调用方的 LANG 进不来，容器内进程会跑在 C/ASCII charmap 下。
  // 后果（实测）：zsh ZLE 与 tmux 按「字节」数多字节字符宽度——af-magic 提示符的 »(C2 BB)
  // 被 tmux 解码失败替换成字面 `_`，且光标列数与 xterm.js 的 UTF-8 渲染恒差 1 列，
  // 表现为提示符后输入/退格残留删不掉的幽灵字符。C.UTF-8 是 glibc 内置 locale，无需
  // locale-gen。调用方显式给过 LANG/LC_ALL 则尊重其选择。
  if (!env.some((e) => e.startsWith('LANG=') || e.startsWith('LC_ALL='))) {
    env.push('LANG=C.UTF-8');
  }
  for (const e of env) args.push('-v', e);
  args.push('--');
  // WorkingDir：lxc-attach 无 --cwd，用 sh -c 'cd X && exec "$@"' 包一层。
  // exec "$@" 保证信号/退出码直达目标命令（不多一层 sh 吞掉）。
  const cwd = opts.WorkingDir || (uid === 0 ? '/root' : '/home/dev');
  args.push('/bin/sh', '-c', `cd ${shq(cwd)} 2>/dev/null || cd /; exec "$@"`, 'sh', ...opts.Cmd);
  return args;
}

// ExecOpts 的 User 字符串 → uid/gid。`lxc-attach -u/-g` **只吃数字**，
// 而调用方传的 User 混着名字（'root'、'root:root'、'1000:1000'），
// 调用方混着用：hosts-sync/lifecycle 传 'root:root'，terminal 传 'root'，files 传 '1000:1000'）。
// 所以这里必须自己把名字映射成数字——早前只 Number() 转换，'root' 变 NaN 后落回默认
// 1000，导致「以 root 写 /etc/hosts」实际以 dev 身份跑、Permission denied。
// 容器内 passwd 不去查：镜像契约钉死了 root=0 / dev=1000（模板脚本 verify 段断言），
// 查 passwd 要多一次 attach，不值当。未知名字保守落 dev（1000）而非 root。
const USER_IDS: Record<string, number> = { root: 0, dev: 1000 };
function toId(token: string | undefined, fallback: number): number {
  if (token == null || token === '') return fallback;
  const n = Number(token);
  if (Number.isInteger(n) && n >= 0) return n;
  return USER_IDS[token] ?? 1000;
}
function parseUser(user: string | undefined): { uid: number; gid: number } {
  if (!user) return { uid: 1000, gid: 1000 };
  const [u, g] = user.split(':');
  const uid = toId(u, 1000);
  // 'root'（无冒号）应当是 root:root：gid 缺省跟随 uid。
  const gid = toId(g, uid);
  return { uid, gid };
}

// 单引号 shell 转义（只用于上面那句 cd，路径来自 WorkingDir 配置）。
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// 跑命令收结果。spawn 天然分离 stdout/stderr。
// 超时语义：stderr 追加 [mysandbox: timeout]、exitCode -1，
// 因为 batch.ts/files.ts 依赖这个约定。
async function execRun(cfg: Config, id: string, opts: ExecOpts): Promise<ExecResult> {
  return runAttach(cfg, assertName(id), opts, null);
}

// stdin 版：喂完 input 后半关闭（对 `cat > file` 即 EOF）。用途：
// 写大文件绕开 argv 128KB 上限。
async function execFeed(
  cfg: Config,
  id: string,
  opts: ExecOpts,
  input: Buffer,
): Promise<ExecResult> {
  return runAttach(cfg, assertName(id), opts, input);
}

function runAttach(cfg: Config, name: string, opts: ExecOpts, input: Buffer | null): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = attachArgs(cfg, name, opts);
    const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
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
    // 三流都挂 error：容器没跑/attach 失败时写 stdin 会 EPIPE，不吞会崩整个 mysandbox
    // （与 hostTerminal.ts 同款教训）。
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
// PTY：复用 hostTerminal.ts 的 script(1) 方案：
//   script -q -f -e -c '<cmd>' /dev/null 给命令开一个真 pty；
//   resize 走子进程的 pts 上 `stty -F <pts> cols N rows M`（tmux 3.4 refresh-client 不支持 -x/-y）。
// stdin/stdout 用 PassThrough 拼成 Duplex，上层拿到 Tty 单流语义（stderr 合入 stdout）。
async function execStream(cfg: Config, id: string, opts: ExecOpts): Promise<ExecStream> {
  const name = assertName(id);
  // script 的 -c 收单个字符串命令，所以 attach 参数要拼成 shell 串。所有片段单引号转义，
  // Cmd 来自 terminal.ts 的常量 + 正则校验过的会话名，无注入面（但转义照做，防将来传入变脏）。
  const cmd = attachArgs(cfg, name, opts).map(shq).join(' ');
  const child = spawn('script', ['-q', '-f', '-e', '-c', cmd, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // SHELL 压成 /bin/sh：script 用 $SHELL 跑 -c 串，用户登录 zsh 会做 =word 展开
    // （hostTerminal.ts 实测踩过：tmux attach -t =h-xxx 被 zsh 当命令路径查找）。
    env: { ...process.env, TERM: 'xterm-256color', SHELL: '/bin/sh' },
  });
  children.add(child);
  child.stdin?.on('error', () => { /* noop */ });
  child.stdout?.on('error', () => { /* noop */ });
  child.stderr?.on('error', () => { /* noop */ });

  // 双向壳：write → script stdin；script stdout+stderr → push 出去（Tty 单流语义，
  // ）。destroy() 由 Duplex 的 _destroy 转成杀进程。
  const duplex = new Duplex({
    read() { /* push 由下面的 stdout/stderr 监听驱动 */ },
    write(chunk, _enc, cb) {
      try { child.stdin?.write(chunk); } catch { /* script 已死 */ }
      cb();
    },
    destroy(err, cb) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
      // SIGTERM 后 script 要 ~2s 才真退（同 hostTerminal.ts 的观察）；兜一发 KILL。
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } }, 500).unref();
      cb(err);
    },
  });
  // destroy 触发 'error' 不吞会崩进程。
  duplex.on('error', () => { /* noop */ });
  child.stdout?.on('data', (d: Buffer) => duplex.push(d));
  child.stderr?.on('data', (d: Buffer) => duplex.push(d));
  child.on('exit', () => {
    children.delete(child);
    duplex.push(null); // EOF → 上层 stream.on('end') 关 socket
  });

  return {
    stream: duplex,
    resize: async (cols, rows) => {
      const pts = await childTty(child.pid!);
      if (pts) await applyTtySize(pts, cols, rows);
    },
  };
}

// 本进程派生的 script 子进程：node 退出（含 tsx watch 热重启）时同步 SIGKILL，
// 否则遗留 script 拿着 pts 挂在容器里（=幽灵 attach，卡 stale 尺寸）。同 hostTerminal.ts。
const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of children) {
    try { c.kill('SIGKILL'); } catch { /* noop */ }
  }
});

// —— 二进制流式 exec（files.ts 下载路由）——
// 与 runAttach 同参同环境（attachArgs），但 stdout 保持原始字节流不收包、stderr 聚成
// 字符串。错误兜底形状与 runAttach 一致（exitCode -1、stderr 带原因），调用方好归因。
function execSpawn(cfg: Config, id: string, opts: ExecOpts): ExecSpawnHandle {
  const args = attachArgs(cfg, assertName(id), opts);
  const child = spawn(args[0], args.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  // 三流 error 必挂：容器没跑/attach 失败时写 stdin EPIPE，不吞会崩整个 mysandbox（runAttach 同款）。
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

// script 子进程的 pts。script 自己的 controlling tty 继承自 node（无 tty），
// 它为命令开的 pts 挂在**子进程**身上，所以查 --ppid。同 hostTerminal.ts 的 childTty。
function childTty(pid: number): Promise<string | null> {
  return new Promise((resolvePromise) => {
    execFile('ps', ['-o', 'tty=', '--ppid', String(pid)], { timeout: 2_000 }, (err, stdout) => {
      const t = (stdout ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && l !== '?');
      resolvePromise(!err && t ? `/dev/${t}` : null);
    });
  });
}

async function applyTtySize(pts: string, cols: number, rows: number): Promise<void> {
  try {
    await execFileAsync('stty', ['-F', pts, 'cols', String(cols), 'rows', String(rows)], {
      timeout: 2_000,
    });
  } catch { /* pts 可能刚随退出消失 */ }
}

// —— 网络 ——
// 已占 IP：LXC 的 IP 是 config 里配死的（D2 静态分配），所以扫全部容器 config 就是权威源——
// 停机容器的 IP 也算占用（不会被重新分配）。
async function assignedIps(_cfg: Config): Promise<Set<string>> {
  const set = new Set<string>();
  for (const name of await listNames()) {
    const content = await readConfig(name);
    if (content == null) continue;
    const addr = configValue(content, 'lxc.net.0.ipv4.address');
    if (addr) {
      const ip = addr.split('/')[0].trim();
      if (ip) set.add(ip);
    }
  }
  return set;
}

// —— 建容器前置查重 ——
// lxc-ls 列的是「已定义」的容器（含停止的），正是 LXC 的名字唯一性范围。
async function nameExists(_cfg: Config, name: string): Promise<boolean> {
  return (await listNames()).includes(name);
}

// —— 事件 ——
// LXC 有 lxc-monitor，但它按 lxcpath 监听、输出是行文本状态迁移。hosts-sync 只关心
// 「容器起来了，去刷 /etc/hosts」，所以订阅 RUNNING 迁移即可。
// 注意 lxc-monitor 是常驻前台进程，用 spawn 而非 execFile。
async function subscribeEvents(
  _cfg: Config,
  onEvent: (ev: EngineEvent) => void,
): Promise<EventSubscription> {
  const child = spawn('lxc-monitor', [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('error', () => { /* noop */ });
  child.stderr?.on('error', () => { /* noop */ });
  // closed：monitor 进程退出/起不来即视为断开，调用方退避重连。
  let resolveClosed: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  child.on('exit', () => resolveClosed());
  child.on('error', () => resolveClosed());
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      // 形如：'ms-dev' changed state to [RUNNING]
      const m = /^'([^']+)' changed state to \[RUNNING\]/.exec(line);
      if (m) onEvent({ containerId: m[1], action: 'start' });
    }
  });
  return {
    close() {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    },
    closed,
  };
}

// —— 基座（模板容器）：实现在 template.ts，这里只做依赖注入与动作分发 ——
// deps 注入而非让 template.ts 直接 import 本文件：本文件已经 import template.ts，
// 反向 import 会成环（ESM 能跑但初始化顺序脆，不值当）。
const templateDeps: TemplateDeps = {
  readConfig,
  configPath,
  containerDir,
  infoLines,
  stop: (cfg, name) => stopContainer(cfg, name),
  start: (cfg, name) => startContainer(cfg, name),
  gateway: (cfg) => gatewayOf(cfg),
  resolveBridge: (cfg) => resolveBridge(cfg),
  allocateIp: (cfg) => allocate(cfg),
  remove: (cfg, name) => removeContainer(cfg, name, { force: true }),
  assertName,
};

async function baseStatus(cfg: Config): Promise<BaseStatus> {
  return templateStatus(cfg, templateDeps);
}

async function runBaseAction(
  cfg: Config,
  action: BaseAction,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  if (action === 'create') return createTemplate(cfg, templateDeps, opts, onProgress);
  if (action === 'clone') return cloneTemplate(cfg, templateDeps, opts, onProgress);
  if (action === 'export') return exportTemplate(cfg, templateDeps, opts, onProgress);
  if (action === 'import') return importTemplate(cfg, templateDeps, opts, onProgress);
  throw badRequest(`engine lxc does not support base action "${action}"`);
}

// 模板 rootfs 占用（单独接口：算一次要遍历 2.8G 的 rootfs，不能塞进被轮询的 baseStatus）。
export async function lxcTemplateSize(cfg: Config): Promise<number | null> {
  return templateSize(cfg, templateDeps);
}

export const lxcEngine: Engine = {
  name: 'lxc',
  caps: CAPS,
  status,
  listManaged,
  inspect,
  create,
  start: startContainer,
  stop: stopContainer,
  restart: restartContainer,
  rename: renameContainer,
  remove: removeContainer,
  execRun,
  execFeed,
  execStream,
  execSpawn,
  assignedIps,
  subscribeEvents,
  baseStatus,
  runBaseAction,
  nameExists,
  hostHomePath: (_cfg, name) => containerHomePath(name),
  rootfsPath: (_cfg, name) => join(containerDir(name), 'rootfs'),
  readTemplateHosts: async (cfg) => {
    try {
      return await readFile(join(containerDir(cfg.lxc.template), 'rootfs', 'etc', 'hosts'), 'utf8');
    } catch {
      return null;
    }
  },
  // 包内 /etc/hosts（「从包建容器」预览）。归档由宿主进程落盘（exportTemplate 的属主坑），
  // 宿主侧直接 tar 即可，不需要 usernsexec。--wildcards 吃掉归档里那层容器名目录。
  readArchiveHosts: async (_cfg, archivePath) => {
    const p = expandTilde((archivePath || '').trim());
    if (!p || !existsSync(p)) return null;
    const r = await run(['tar', '--zstd', '-xOf', p, '--wildcards', '*/rootfs/etc/hosts'], 30_000);
    if (!r.ok || !r.stdout.trim()) return null;
    return r.stdout;
  },
};
