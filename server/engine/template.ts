// LXC 基座（模板容器）管理：status / clone / export / import。engine: lxc 时取代 image.ts。
//
// 「模板容器」是 D3 的产物：没有镜像仓库、没有分层，一个手工调好的 STOPPED 容器就是基座，
// 建容器 = `lxc-copy` 克隆它（见 engine/lxc.ts create）。由此四个动作的语义：
//   - status：模板存在？STOPPED（可克隆）？多大？制作脚本在哪？
//   - clone ：把某个现有容器固化成模板（调好一个容器 → 变成新基座）
//   - export：模板打包成 tar.zst（「仓库」就是一个文件）
//   - import：从 tar.zst 恢复模板
//
// ## unprivileged 的 uid 折叠问题（这个文件的核心难点）
//
// rootfs 里的文件属主是**宿主 100000+**（容器 root=100000），当前用户（leon）读不到
// `rootfs/root` 这类 0700 目录——`du`/`tar` 直接 Permission denied。所以凡是要遍历整个
// rootfs 的操作（算大小、打包、解包）都必须包在 `lxc-usernsexec` 里：进到那套 idmap 的
// user namespace，容器 root 在里面就是 ns-root，rootfs 全可读，而落到宿主文件系统上的
// uid 仍是 100000（映射是双向的，不会提权）。
//   - 打包/解包必须 `--numeric-owner`：ns 里 100000 段没有对应的 passwd 条目，
//     tar 默认按名字存会解析失败或存成错的名字，回来 uid 就全乱了。
//   - 解包的目标父目录必须让 ns-root 能写：`<lxcpath>/<name>` 由**宿主用户**先建好
//     （mode 0755，属主 leon），ns-root 对它有写权（实测确认：ns 里 leon 的 uid 1000
//     被映射，目录的 owner-write 生效）。
import { spawn } from 'node:child_process';
import { mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { Config } from '../config.js';
import { expandTilde } from '../config.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { log } from '../logger.js';
import type { BaseActionOpts, BaseProgress, BaseStatus } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// 模板制作脚本（LXC 版的 Dockerfile）。dev: server/engine/ -> 根；packaged: dist/server/engine/ -> 根。
// 与 config.ts:loadDefaultYaml / index.ts:findWebDist / image.ts:findImageContext 同款双候选。
export function findTemplateScript(): string | null {
  const candidates = [
    join(__dirname, '..', '..', 'scripts', 'lxc-template.sh'), // dev
    join(__dirname, '..', '..', '..', 'scripts', 'lxc-template.sh'), // dist/server/engine/
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// —— usernsexec 包装 ——
// idmap 参数从容器 config 的 lxc.idmap 行来（而不是硬编码 100000）：用户可能改过 subuid 段，
// 用错的 map 打包出来的 tar 属主全是错的，且解包后容器起不来——必须以 config 为准。
function idmapArgs(config: string): string[] {
  const args: string[] = [];
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0 || line.slice(0, eq).trim() !== 'lxc.idmap') continue;
    // `u 0 100000 1000` -> `-m u:0:100000:1000`
    const parts = line.slice(eq + 1).trim().split(/\s+/);
    if (parts.length !== 4) continue;
    args.push('-m', parts.join(':'));
  }
  return args;
}

// 在容器的 user namespace 里跑一条命令（见文件头）。idmap 缺失时直接抛——
// 静默降级成宿主身份跑只会得到 Permission denied 或属主错乱的产物。
// io：把归档数据经**管道**在宿主侧读写（见 exportTemplate 注释里的属主坑）。
function nsRun(
  config: string,
  argv: string[],
  onProgress?: (e: BaseProgress) => void,
  timeoutMs = 30 * 60_000,
  io?: { stdout?: Writable; stdin?: Readable },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const maps = idmapArgs(config);
  if (maps.length === 0) {
    throw new Error(
      'container config has no lxc.idmap lines — unprivileged LXC expected (see ~/.config/lxc/default.conf)',
    );
  }
  return spawnCollect('lxc-usernsexec', [...maps, '--', ...argv], onProgress, timeoutMs, io);
}

// 克隆去重：清空 rootfs 的 /etc/machine-id（空文件 systemd 首启会重新生成）。
// 不清的话所有克隆共享模板身份——实测踩坑正是它：容器内 udev 的 MACAddressPolicy=persistent
// 按 machine-id 哈希出 MAC，两个容器同 MAC 挂同一座桥，桥 fdb 端口摆动、容器间 ARP 永远
// 达不成（网络层修法是 lxc.ts create() 写死随机 hwaddr，这里把 machine-id 碰撞一并消掉）。
// 文件属主是容器 root（宿主 uid 100000），宿主用户写不了，必须在 ns 里 truncate。
// 失败只 warn：hwaddr 已兜住网络层，这里失败不该让建容器回滚。
export async function resetMachineId(containerDir: string, config: string): Promise<void> {
  try {
    const target = join(containerDir, 'rootfs', 'etc', 'machine-id');
    const r = await nsRun(config, ['truncate', '-s', '0', target], undefined, 30_000);
    if (!r.ok) {
      log.warn({ stderr: r.stderr.slice(0, 300) }, 'reset machine-id failed (continuing)');
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'reset machine-id failed (continuing)');
  }
}

// 归还容器 home 的属主（容器内视角 dev:dev = ns 里的 1000:1000）：模板制作过程/源容器
// 可能以 root 在 /home/dev 下落文件（.local/.config 等），克隆链会传染（脏模板 → 脏容器），
// 宿主 seed（uid 1000 直读直写）就 EACCES——实测踩坑：容器 CLI/peer.json 种子全挂。
// 在 create() 里统一防御，失败只 warn（seed 失败本身也只 warn，见 seedHome）。
export async function fixHomeOwnership(containerDir: string, config: string): Promise<void> {
  try {
    const target = join(containerDir, 'rootfs', 'home', 'dev');
    const r = await nsRun(config, ['chown', '-R', '1000:1000', target], undefined, 120_000);
    if (!r.ok) {
      log.warn({ stderr: r.stderr.slice(0, 300) }, 'fix home ownership failed (continuing)');
    }
  } catch (e) {
    log.warn({ err: String(e) }, 'fix home ownership failed (continuing)');
  }
}

// spawn + 收集输出 + 把 stderr 逐行当进度推出去（lxc/tar 的进度都走 stderr）。
// io.stdout 给出时，子进程 stdout 直接 pipe 到它（归档数据流，不进内存）。
function spawnCollect(
  cmd: string,
  args: string[],
  onProgress?: (e: BaseProgress) => void,
  timeoutMs = 30 * 60_000,
  io?: { stdout?: Writable; stdin?: Readable },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, {
      stdio: [io?.stdin ? 'pipe' : 'ignore', io?.stdout ? 'pipe' : 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    // 归档数据落宿主侧的流；其余情况按文本收集
    let sinkDone: Promise<void> | null = null;
    if (io?.stdout && child.stdout) {
      sinkDone = new Promise<void>((done, fail) => {
        io.stdout!.on('error', fail);
        io.stdout!.on('finish', () => done());
        child.stdout!.on('error', fail);
        child.stdout!.pipe(io.stdout!);
      }).catch((e) => {
        stderr += `\n${String(e)}`;
      });
    } else {
      child.stdout?.on('data', (b: Buffer) => {
        const s = b.toString();
        stdout += s;
        onProgress?.({ stream: s });
      });
    }
    if (io?.stdin && child.stdin) {
      io.stdin.on('error', () => {
        /* 上游读错由退出码体现 */
      });
      io.stdin.pipe(child.stdin);
    }
    child.stderr?.on('data', (b: Buffer) => {
      const s = b.toString();
      stderr += s;
      onProgress?.({ stream: s });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ ok: false, stdout, stderr: stderr + String(e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      void Promise.resolve(sinkDone).then(() =>
        resolveP({ ok: code === 0, stdout, stderr }),
      );
    });
  });
}

// —— status ——
// exists / ready 分开：模板在但在跑 → exists=true, ready=false（lxc-copy 对运行中的源
// **静默失败**，必须在这里就告诉用户去 lxc-stop，而不是等建容器时报错）。
export async function templateStatus(cfg: Config, deps: TemplateDeps): Promise<BaseStatus> {
  const name = cfg.lxc.template;
  const script = findTemplateScript();
  const base: BaseStatus = {
    kind: 'template',
    name,
    exists: false,
    ready: false,
    context: script,
    ...(script ? {} : { contextError: 'scripts/lxc-template.sh not found (packaged without it?)' }),
  };
  const config = await deps.readConfig(name).catch(() => null);
  if (config == null) {
    return { ...base, notReady: `模板容器 ${name} 不存在——用「从零制作」建一个，或 import 一个包` };
  }
  const info = await deps.infoLines(name);
  const state = (info?.State ?? 'STOPPED').toUpperCase();
  const dir = deps.containerDir(name);
  let createdAt: string | undefined;
  try {
    createdAt = (await stat(deps.configPath(name))).mtime.toISOString();
  } catch {
    /* noop */
  }
  const detail: Record<string, string> = { state, rootfs: join(dir, 'rootfs') };
  const src = await templateSource(dir);
  if (src) detail.source = src;
  // 制作标记：building/failed → 不可克隆（结构在但契约工具没装全，见标记注释）。
  // 容器 RUNNING + building = 制作正在进行（合法中间态）；STOPPED + building = 被中断。
  const build = await buildState(deps, name);
  if (build) detail.build = build.state;
  const ready = state === 'STOPPED' && !build;
  let notReady: string | undefined;
  if (state !== 'STOPPED') {
    notReady =
      build?.state === 'building'
        ? `模板制作进行中（${state}）——完成后自动停机`
        : `模板正在运行（${state}）——克隆要求已停：lxc-stop -n ${name}`;
  } else if (build) {
    notReady =
      build.state === 'failed'
        ? `模板制作上次失败${build.note ? `：${build.note}` : ''}——进宿主终端重跑 scripts/lxc-template.sh ${name} 补齐（幂等），或从零制作（force）重建`
        : `模板制作被中断——从零制作（force）重建，或重跑 scripts/lxc-template.sh ${name} 补齐（幂等）`;
  }
  return {
    ...base,
    exists: true,
    ready,
    ...(notReady ? { notReady } : {}),
    createdAt,
    detail,
    // size 不在这里算：du 整个 rootfs 要秒级（2.8G 实测 ~0.1s 冷缓存更久），
    // 而 App 每 15s 轮询一次这个接口。按需通过 /api/base/size 单独取。
  };
}

// 模板旁记一行来源（clone 来自哪个容器 / import 来自哪个包），纯信息展示。
const SOURCE_FILE = 'mysandbox-template-source';
async function templateSource(dir: string): Promise<string | null> {
  try {
    return (await readFile(join(dir, SOURCE_FILE), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

// —— 制作状态标记 ——
// 「exists && STOPPED」≠「制作完成」：create/clone/import 中途被杀（服务重启、断流、断电）
// 会留下一个结构完整但没跑完制作脚本的模板，克隆它出来的容器没有契约工具（node/zsh 缺失）。
// 实测踩坑：脚本跑到一半服务被重启，半成品模板 ready:true。约定：
//   - 三个制作动作开跑即写 {state:'building'}，成功**删除**标记，失败改 {state:'failed'};
//   - 没有标记 = 制作完成（机制上线前就存在的老模板天然兼容，无需迁移）。
// ⚠️ 标记文件放**容器目录之外**（<lxcpath>/.<name>.mysandbox-build）：lxc-copy 按目录判
// 「容器已存在」（实测：预建目录+空内容，copy 静默失败 exit 1），目录内放任何东西都会破坏它。
const BUILD_FILE = 'mysandbox-template-build';
function buildMarkerPath(deps: TemplateDeps, name: string): string {
  return join(dirname(deps.containerDir(name)), `.${name}.${BUILD_FILE}`);
}
interface BuildMarker {
  state: 'building' | 'failed';
  at?: string;
  note?: string;
}
async function markBuild(deps: TemplateDeps, name: string, state: BuildMarker['state'], note?: string): Promise<void> {
  try {
    const marker: BuildMarker = { state, at: new Date().toISOString(), ...(note ? { note } : {}) };
    await writeFile(buildMarkerPath(deps, name), JSON.stringify(marker));
  } catch {
    /* 写不上时标记丢失——status 退回旧行为，不影响主流程 */
  }
}
async function clearBuild(deps: TemplateDeps, name: string): Promise<void> {
  try {
    await rm(buildMarkerPath(deps, name), { force: true });
  } catch {
    /* noop */
  }
}
async function buildState(deps: TemplateDeps, name: string): Promise<BuildMarker | null> {
  try {
    const raw = JSON.parse(await readFile(buildMarkerPath(deps, name), 'utf8')) as BuildMarker;
    return raw?.state === 'building' || raw?.state === 'failed' ? raw : null;
  } catch {
    return null;
  }
}

// rootfs 实际占用（字节）。必须在 ns 里算，见文件头。
export async function templateSize(cfg: Config, deps: TemplateDeps): Promise<number | null> {
  const name = cfg.lxc.template;
  const config = await deps.readConfig(name);
  if (config == null) throw notFound(`template ${name} not found`);
  const r = await nsRun(config, ['du', '-sb', join(deps.containerDir(name), 'rootfs')], undefined, 120_000);
  if (!r.ok) return null;
  const n = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(n) ? n : null;
}

// engine/lxc.ts 注入的依赖（避免两个模块循环 import：lxc.ts 已经 import 本文件）。
// gateway/resolveBridge/allocateIp 是 network.ts/lxc.ts 的能力，注入而非直接 import——
// network.ts 反向 import engine/index.js，template.ts 再去 import 它会多出一个环。
export interface TemplateDeps {
  readConfig(name: string): Promise<string | null>;
  configPath(name: string): string;
  containerDir(name: string): string;
  infoLines(name: string): Promise<Record<string, string> | null>;
  stop(cfg: Config, name: string): Promise<void>;
  start(cfg: Config, name: string): Promise<void>;
  gateway(cfg: Config): string;
  resolveBridge(cfg: Config): Promise<string | null>;
  allocateIp(cfg: Config): Promise<string | null>;
  remove(cfg: Config, name: string): Promise<void>;
  assertName(name: string): string;
}

// —— clone：把现有容器固化成模板 ——
// 语义：源容器先停（lxc-copy 要求），克隆成 cfg.lxc.template，源容器保持停止状态交还用户
// （不自动重启：用户可能正是想「调好就停在这」，重启反而多一次意外的开机副作用）。
export async function cloneTemplate(
  cfg: Config,
  deps: TemplateDeps,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const from = deps.assertName((opts.from || '').trim());
  const name = cfg.lxc.template;
  if (from === name) throw badRequest('source container is the template itself');
  if ((await deps.readConfig(from)) == null) throw notFound(`container ${from} not found`);

  if ((await deps.readConfig(name)) != null) {
    if (!opts.force) {
      throw conflict(
        `template "${name}" already exists — pass force to replace it (the old template is destroyed)`,
      );
    }
    onProgress?.({ status: `销毁旧模板 ${name}` });
    await deps.remove(cfg, name);
  }

  const info = await deps.infoLines(from);
  if ((info?.State ?? 'STOPPED').toUpperCase() !== 'STOPPED') {
    onProgress?.({ status: `停止 ${from}（克隆要求源已停）` });
    await deps.stop(cfg, from);
  }

  onProgress?.({ status: `克隆 ${from} -> ${name}（复制 rootfs，可能要几分钟）` });
  // 制作标记先于拷贝：拷贝中途被杀 → status 如实报「未完成」（见 BUILD_FILE 注释）。
  // 标记在容器目录之外——不能预建目录，lxc-copy 按目录判「已存在」会静默失败（实测踩坑）。
  // 目录残留也一并清掉：失败的拷贝会留下 100000 属主的半成品目录（宿主用户不可写，
  // writeSource/后续操作全挂），tar 按目录合并解包也会让旧文件漏进来。
  await rm(deps.containerDir(name), { recursive: true, force: true }).catch(() => {});
  await markBuild(deps, name, 'building');
  const r = await spawnCollect('lxc-copy', ['-n', from, '-N', name], onProgress, 30 * 60_000);
  if (!r.ok) {
    await markBuild(deps, name, 'failed', tail(r.stderr) || 'lxc-copy failed');
    await deps.remove(cfg, name).catch(() => {});
    await rm(deps.containerDir(name), { recursive: true, force: true }).catch(() => {});
    throw new Error(`lxc-copy failed: ${r.stderr.trim() || 'no error output (is the source running?)'}`);
  }
  await clearBuild(deps, name);
  await writeSource(deps.containerDir(name), `clone of container "${from}"`);
  onProgress?.({ status: `模板 ${name} 就绪（已停止，可直接建容器）` });
  log.info({ from, template: name }, 'lxc template cloned');
  return { template: name, from };
}

async function writeSource(dir: string, text: string): Promise<void> {
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, SOURCE_FILE), `${text}\n`);
  } catch {
    /* 纯展示信息，写不上不影响功能 */
  }
}

// —— create：从零制作模板（全新机器的起点）——
// lxc-template.sh 只会加工「已存在且在跑」的容器，缺的前半段（lxc-create 出容器）在这里补齐。
// 命令就是迁移文档 PoC 验证过的那条（noble 而非 24.04——download 索引里没有这个别名）。
// 失败语义：lxc-create 失败清掉半成品；脚本失败**容器保留**（正在运行）——脚本幂等
// （每步先探测再装），可进宿主终端手工重跑补缺，或 force 从零重建。
export async function createTemplate(
  cfg: Config,
  deps: TemplateDeps,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const name = cfg.lxc.template;
  const script = findTemplateScript();
  if (!script) throw new Error('scripts/lxc-template.sh not found (packaged without it?)');

  if ((await deps.readConfig(name)) != null) {
    if (!opts.force) {
      throw conflict(
        `template "${name}" already exists — pass force to replace it (the old template is destroyed)`,
      );
    }
    onProgress?.({ status: `销毁旧模板 ${name}` });
    await deps.remove(cfg, name);
  }

  // 桥没就绪就别开始：下载 + 十几分钟的脚本全白跑。
  const bridge = await deps.resolveBridge(cfg);
  if (!bridge) {
    throw new Error(`bridge "${cfg.network}" not found — bring it up first (mysandbox-net.service)`);
  }
  // 模板自身也占一个池内 IP（assignedIps 扫全部 config，含模板，天然计占用）。
  const ip = await deps.allocateIp(cfg);
  if (ip == null) throw new Error('IP pool exhausted — the template itself needs an address from cfg.ipPool');

  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  onProgress?.({ status: `下载 ubuntu noble rootfs（${arch}，lxc-create download 模板）` });
  // 制作标记先于下载：下载/脚本任一环节被杀（服务重启/断流），status 都能如实报「未完成」
  // 而不是把半成品当 ready（实测踩坑：脚本中途服务被重启，残留模板 ready:true）。
  await markBuild(deps, name, 'building');
  const r = await spawnCollect(
    'lxc-create',
    ['-n', name, '-t', 'download', '--', '-d', 'ubuntu', '-r', 'noble', '-a', arch],
    onProgress,
    30 * 60_000,
  );
  if (!r.ok) {
    // 半成品清掉。rootfs 内容属主是宿主 uid 100000 段（unprivileged 建时经 userns 落盘），
    // 宿主 rm 删不净，必须走 lxc-destroy（liblxc 自己经 userns 删）；config 没写成时
    // destroy 会报「not defined」，再兜一层宿主 rm 清 leon 属主的空壳目录。
    await deps.remove(cfg, name).catch(() => {});
    await rm(deps.containerDir(name), { recursive: true, force: true }).catch(() => {});
    await markBuild(deps, name, 'failed', tail(r.stderr) || 'lxc-create failed');
    throw new Error(`lxc-create failed: ${tail(r.stderr) || 'unknown error'}`);
  }

  // 网络对齐当前配置——必须做：lxc-create 的网络来自 default.conf，新机器上可能陈旧/缺
  // 静态 IP（本机实测 default.conf 还指着旧 docker 桥且无地址，不重写就是无网容器，
  // 脚本第一步 DNS 就挂）。桥/gateway 跟 cfg 走（gateway = <池前缀>.1，与脚本 dns 步
  // 写死的上游一致），IP 用上面分配的。
  await alignCreatedConfig(cfg, deps, name, ip, bridge);

  onProgress?.({ status: '启动新容器' });
  await deps.start(cfg, name);

  onProgress?.({ status: '跑制作脚本（apt + npm 占大头，10–20 分钟）' });
  const s = await spawnCollect('bash', [script, name], onProgress, 60 * 60_000);
  if (!s.ok) {
    // 失败标记：容器保留供排查，status 从此报「制作失败」而非 ready——
    // 这正是半成品模板被误判 ready 的防护点（重跑脚本/force 重建成功后标记清除）。
    await markBuild(
      deps,
      name,
      'failed',
      tail(s.stderr, 200) || 'template script failed',
    );
    throw new Error(
      `template script failed — 容器 ${name} 保留（正在运行）供排查：可进宿主终端重跑 ` +
        `scripts/lxc-template.sh ${name}（脚本幂等，只补缺的），或 force 从零重建。 ${tail(s.stderr) || ''}`,
    );
  }

  onProgress?.({ status: `停止 ${name}（克隆要求已停）` });
  await deps.stop(cfg, name);
  await clearBuild(deps, name);
  await writeSource(deps.containerDir(name), 'created from scratch (lxc-create + scripts/lxc-template.sh)');
  log.info({ template: name }, 'lxc template created from scratch');
  onProgress?.({ status: `模板 ${name} 就绪（已停止，可直接建容器）` });
  return { template: name };
}

// lxc-create 产物的 config 修正（范围对齐 create() 克隆后的改写）：桥/IP/网关 +
// apparmor unconfined（Ubuntu 默认 profile 不许 systemd 挂 cgroup2，见 docs/lxc-migration.md
// 宿主准备 #4）。setConfigValue 经动态 import 拿（lxc.ts 反向 import 本文件，同款防环）。
async function alignCreatedConfig(
  cfg: Config,
  deps: TemplateDeps,
  name: string,
  ip: string,
  bridge: string,
): Promise<void> {
  const { setConfigValue } = await import('./lxc.js');
  const content = await deps.readConfig(name);
  if (content == null) throw new Error(`lxc-create succeeded but config missing for ${name}`);
  let next = setConfigValue(content, 'lxc.net.0.type', 'veth');
  next = setConfigValue(next, 'lxc.net.0.link', bridge);
  next = setConfigValue(next, 'lxc.net.0.ipv4.address', `${ip}/24`);
  next = setConfigValue(next, 'lxc.net.0.ipv4.gateway', deps.gateway(cfg));
  next = setConfigValue(next, 'lxc.apparmor.profile', 'unconfined');
  await writeFile(deps.configPath(name), next);
}

// —— export：模板/任意容器 -> 单个 tar.zst（config + rootfs）——
// 「仓库」就是一个文件：LXC 没有 registry，而模板本来就是整机 rootfs，压成一个文件
// 拷到别的机器 import 是最直接的分发方式。zstd 比 gzip 快数倍且比率更好（2.8G rootfs 差别明显）。
// opts.from 缺省 = 模板（BasePanel 语义）；给了 = 任意容器（容器行菜单「导出为包」）。
export async function exportTemplate(
  cfg: Config,
  deps: TemplateDeps,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const isTemplate = !(opts.from || '').trim();
  const name = isTemplate ? cfg.lxc.template : deps.assertName((opts.from || '').trim());
  const config = await deps.readConfig(name);
  if (config == null) throw notFound(`${isTemplate ? 'template' : 'container'} "${name}" not found`);
  const info = await deps.infoLines(name);
  const state = (info?.State ?? 'STOPPED').toUpperCase();
  if (state !== 'STOPPED') {
    // 不自动停：普通容器在跑说明有活跃终端/服务，静默停它的代价远高于收益——
    // 要求用户自己停（跑着导出的 rootfs 也在变，包内容不可信）。
    throw conflict(
      isTemplate
        ? `template "${name}" must be stopped before export (currently ${state})`
        : `container "${name}" is running — stop it first (菜单 ⋯ → 停止), export needs a quiescent rootfs (currently ${state})`,
    );
  }
  const out = resolveArchivePath(opts.path, `${name}.tar.zst`);
  if (existsSync(out) && !opts.force) {
    throw conflict(`archive already exists: ${out} — pass force to overwrite`);
  }
  await mkdir(dirname(out), { recursive: true });

  onProgress?.({ status: `打包 ${name} -> ${out}` });
  // ⚠️ 归档文件必须由**宿主进程**创建，不能让 ns 里的 tar 自己 `-f out` 写：
  // ns 内创建的文件属主是宿主 uid 100000，而宿主用户（uid 1000）对它**连删都删不掉**
  // （实测 `rm` → Operation not permitted：文件在 init userns 拥有的挂载上，
  // 宿主用户对 100000 的文件没有任何权限）。用户导出个包结果自己管不了它，不可接受。
  // 所以 tar 写 stdout，宿主侧 createWriteStream 落盘 —— 文件属主是 leon，可读可删可拷走。
  // -C <lxcpath> 后只取 <name>/：归档里带一层容器名目录，import 时用 --strip-components=1
  // 落到目标名下——这样导出的包与「叫什么名字」解耦，换名 import 也能用。
  const sink = createWriteStream(out, { mode: 0o644 });
  const r = await nsRun(
    config,
    [
      'tar', '--numeric-owner', '--zstd', '-cf', '-',
      '-C', dirname(deps.containerDir(name)), `${name}/config`, `${name}/rootfs`,
    ],
    onProgress,
    30 * 60_000,
    { stdout: sink },
  );
  if (!r.ok) {
    await rm(out, { force: true }); // 半成品包比没有包更坏（import 时才发现坏）
    throw new Error(`tar failed: ${tail(r.stderr) || 'unknown error'}`);
  }
  const size = await stat(out).then((s) => s.size).catch(() => 0);
  log.info({ container: name, path: out, size }, 'lxc container exported');
  return { path: out, size };
}

// —— import：tar.zst -> 模板 ——
export async function importTemplate(
  cfg: Config,
  deps: TemplateDeps,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const name = cfg.lxc.template;
  const src = resolveArchivePath(opts.path, '');
  if (!src || !existsSync(src)) throw badRequest(`archive not found: ${src || '(no path given)'}`);

  if ((await deps.readConfig(name)) != null) {
    if (!opts.force) {
      throw conflict(`template "${name}" already exists — pass force to replace it`);
    }
    onProgress?.({ status: `销毁旧模板 ${name}` });
    await deps.remove(cfg, name);
  }

  // 制作标记：解包中途被杀 → status 如实报「未完成」（解包失败会清目录，标记随现场保留）。
  // 目录先清：tar 是按目录合并解包——残留的半成品文件会漏进新模板；且失败拷贝留下的
  // 100000 属主目录让宿主用户不可写（writeSource/后续操作全挂）。
  await rm(deps.containerDir(name), { recursive: true, force: true }).catch(() => {});
  await markBuild(deps, name, 'building');
  await importArchiveTo(cfg, deps, name, src, onProgress);
  await clearBuild(deps, name);
  await writeSource(deps.containerDir(name), `import of ${src}`);
  log.info({ template: name, path: src }, 'lxc template imported');
  onProgress?.({ status: `模板 ${name} 就绪` });
  return { template: name, from: src };
}

// 把 tar.zst 包解到名为 name 的容器目录（宿主建目录 0755 + ns 内解包 + 改写 config）。
// importTemplate（目标 = 模板名，带 force/销毁旧模板/writeSource）与 engine.create 的
// 包来源（目标 = 新容器名，调用方保证名字未占用）共用。失败时清掉半成品目录。
export async function importArchiveTo(
  cfg: Config,
  deps: TemplateDeps,
  name: string,
  archivePath: string,
  onProgress?: (e: BaseProgress) => void,
): Promise<void> {
  // idmap 取自**当前宿主**的 default.conf，而不是包里的 config：包可能来自 subuid 段不同的
  // 机器，用包里的 map 解包会写出本机 subuid 范围外的 uid（容器起不来且删不掉）。
  const defaults = await readDefaultConf();
  if (!defaults) {
    throw new Error(
      'no ~/.config/lxc/default.conf with lxc.idmap — set up unprivileged LXC first (see docs/lxc-migration.md)',
    );
  }
  const dir = deps.containerDir(name);
  // 目标父目录由宿主用户建（0755），ns-root 才有地方写（见文件头）。
  await mkdir(dir, { recursive: true, mode: 0o755 });
  onProgress?.({ status: `解包 ${archivePath} -> ${dir}` });
  const r = await nsRun(
    defaults,
    ['tar', '--numeric-owner', '--zstd', '-xf', archivePath, '-C', dir, '--strip-components=1'],
    onProgress,
  );
  if (!r.ok) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`tar extract failed: ${tail(r.stderr) || 'unknown error'}`);
  }
  // 包里的 config 带的是源机器的 rootfs 路径与 idmap，就地改成本机的。
  await rewriteImportedConfig(cfg, deps, name, defaults);
}

// 解包后的 config 修正：rootfs 路径 + idmap 换成本机的，uts.name 换成模板名。
// 其余（网络、挂载）保留源机器的——建容器时 engine/lxc.ts create() 会按当前配置改写。
async function rewriteImportedConfig(
  cfg: Config,
  deps: TemplateDeps,
  name: string,
  defaults: string,
): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const p = deps.configPath(name);
  let content = await readFile(p, 'utf8');
  const keep = content
    .split('\n')
    .filter((l) => !/^\s*lxc\.idmap\s*=/.test(l))
    .join('\n');
  const maps = defaults
    .split('\n')
    .filter((l) => /^\s*lxc\.idmap\s*=/.test(l))
    .join('\n');
  content = `${keep.trimEnd()}\n${maps.trimEnd()}\n`;
  const { setConfigValue } = await import('./lxc.js');
  content = setConfigValue(content, 'lxc.rootfs.path', `dir:${join(deps.containerDir(name), 'rootfs')}`);
  content = setConfigValue(content, 'lxc.uts.name', name);
  await writeFile(p, content);
  void cfg;
}

// ⚠️ 不走 xdgConfigHome()：liblxc 硬编码 `$HOME/.config/lxc/default.conf`，不认 XDG_CONFIG_HOME
// （见 lxc.ts lxcPath() 注释）。读别的地方会拿到和 lxc-create 用的不是同一份 idmap。
async function readDefaultConf(): Promise<string | null> {
  const p = join(homedir(), '.config', 'lxc', 'default.conf');
  try {
    const content = await readFile(p, 'utf8');
    return /lxc\.idmap/.test(content) ? content : null;
  } catch {
    return null;
  }
}

// 归档路径：相对路径落到 ~/（避免落进 CWD——服务是 systemd user service，CWD 不确定）。
function resolveArchivePath(p: string | undefined, fallbackName: string): string {
  const raw = (p || '').trim();
  if (!raw) {
    if (!fallbackName) return '';
    return join(expandTilde('~'), fallbackName);
  }
  const ex = expandTilde(raw);
  return isAbsolute(ex) ? resolve(ex) : resolve(expandTilde('~'), ex);
}

// tar/lxc 的错误往往在 stderr 末尾，前面全是进度噪音。
function tail(s: string, n = 400): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}
