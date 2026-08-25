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
import { mkdir, rm, stat, readFile } from 'node:fs/promises';
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
    return { ...base, notReady: `模板容器 ${name} 不存在——先制作一个，或 import 一个包` };
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
  const ready = state === 'STOPPED';
  return {
    ...base,
    exists: true,
    ready,
    ...(ready ? {} : { notReady: `模板正在运行（${state}）——克隆要求已停：lxc-stop -n ${name}` }),
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
export interface TemplateDeps {
  readConfig(name: string): Promise<string | null>;
  configPath(name: string): string;
  containerDir(name: string): string;
  infoLines(name: string): Promise<Record<string, string> | null>;
  stop(cfg: Config, name: string): Promise<void>;
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
  const r = await spawnCollect('lxc-copy', ['-n', from, '-N', name], onProgress, 30 * 60_000);
  if (!r.ok) {
    throw new Error(`lxc-copy failed: ${r.stderr.trim() || 'no error output (is the source running?)'}`);
  }
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

// —— export：模板 -> 单个 tar.zst（config + rootfs）——
// 「仓库」就是一个文件：LXC 没有 registry，而模板本来就是整机 rootfs，压成一个文件
// 拷到别的机器 import 是最直接的分发方式。zstd 比 gzip 快数倍且比率更好（2.8G rootfs 差别明显）。
export async function exportTemplate(
  cfg: Config,
  deps: TemplateDeps,
  opts: BaseActionOpts,
  onProgress?: (e: BaseProgress) => void,
): Promise<Record<string, unknown>> {
  const name = cfg.lxc.template;
  const config = await deps.readConfig(name);
  if (config == null) throw notFound(`template ${name} not found`);
  const info = await deps.infoLines(name);
  const state = (info?.State ?? 'STOPPED').toUpperCase();
  if (state !== 'STOPPED') {
    throw conflict(`template "${name}" must be stopped before export (currently ${state})`);
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
  log.info({ template: name, path: out, size }, 'lxc template exported');
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
  onProgress?.({ status: `解包 ${src} -> ${dir}` });
  const r = await nsRun(
    defaults,
    ['tar', '--numeric-owner', '--zstd', '-xf', src, '-C', dir, '--strip-components=1'],
    onProgress,
  );
  if (!r.ok) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`tar extract failed: ${tail(r.stderr) || 'unknown error'}`);
  }
  // 包里的 config 带的是源机器的 rootfs 路径与 idmap，就地改成本机的。
  await rewriteImportedConfig(cfg, deps, name, defaults);
  await writeSource(dir, `import of ${src}`);
  log.info({ template: name, path: src }, 'lxc template imported');
  onProgress?.({ status: `模板 ${name} 就绪` });
  return { template: name, from: src };
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
