// docker 服务的 compose 文件层：一服务 = <CONFIG_DIR>/compose/<名>/compose.yaml。
//
// 设计规则（v2 服务层的根）：**文件是唯一配置真相**。创建 = mysandbox 生成首版文件 +
// compose up；之后 mysandbox 绝不重生成覆盖——面板编辑保存即写文件再 up -d，终端
// vim 改同一份文件等价。删除 = compose down + 删目录。meta（sidecar）只剩展示性
// 数据（displayName/description/ports/ip 记账），不再持有 env/command 这类「配置」。
//
// 文件形状（实测验证过 docker compose v5）：
//   - 顶层 name: <服务名> = compose 项目名；service key/container_name 同名。
//   - 网络/卷一律 external——mysandbox-lan 由 ensureServiceNetwork 自持，卷由
//     ensureVolume 预建（external 卷 compose 不加 <project>_ 前缀、down 不删卷，
//     恰好保住 mysandbox-svc-<名> 命名与「删服务才许删卷」的边界）。
//   - 漂移检测 = 容器 label com.docker.compose.config-hash vs `compose config --hash`：
//     前者是最后一次 up 时 compose 按配置算的 hash，后者是当前文件的 hash，不一致
//     即「改了文件还没应用」。同一算法来源，逐字节可比。
//   - 卷挂载、build: .（自研镜像迭代）等用户可自由加；cwd 恒为服务目录，相对路径可用。
//
// 权限：目录 0700、compose.yaml 0600——env 含密码（与 state.json 同一泄露面）。
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { load as yamlLoad } from 'js-yaml';
import { CONFIG_DIR } from './config.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

export function composeDir(name: string): string {
  return `${CONFIG_DIR}/compose/${name}`;
}

export function composeFileOf(name: string): string {
  return `${composeDir(name)}/compose.yaml`;
}

export async function composeFileExists(name: string): Promise<boolean> {
  try {
    return (await stat(composeFileOf(name))).isFile();
  } catch {
    return false;
  }
}

// —— 生成 ——
export interface ComposeServiceDef {
  name: string; // = 项目名 + service key + container_name
  image: string;
  env: Record<string, string>;
  command?: string[];
  volume: { source: string; target: string } | null;
  ip: string;
  network: string;
  labels: Record<string, string>;
}

export function buildComposeYaml(def: ComposeServiceDef): string {
  // 手写发射而非 js-yaml dump：本机 js-yaml 5.2.3 的 dump 把一切字符串打成 `>-`
  // 折叠块标量（合法但没法读）。YAML 是 JSON 超集，值用 JSON 引号规则发出——
  // 可读、引号/转义有 JSON 语义兜底（密码里的特殊字符安全），键是受控固定词表。
  const q = (s: string): string => JSON.stringify(s);
  const L: string[] = [];
  L.push(`name: ${q(def.name)}`);
  L.push('services:');
  L.push(`  ${def.name}:`);
  L.push(`    image: ${q(def.image)}`);
  L.push(`    container_name: ${q(def.name)}`);
  L.push(`    hostname: ${q(def.name)}`);
  L.push(`    restart: ${q('unless-stopped')}`);
  L.push('    networks:');
  L.push(`      ${def.network}:`);
  L.push(`        ipv4_address: ${q(def.ip)}`);
  if (Object.keys(def.env).length) {
    L.push('    environment:');
    for (const [k, v] of Object.entries(def.env)) L.push(`      ${k}: ${q(v)}`);
  }
  if (def.command?.length) {
    L.push('    command:');
    for (const c of def.command) L.push(`      - ${q(c)}`);
  }
  if (def.volume) {
    L.push('    volumes:');
    L.push(`      - ${q(`${def.volume.source}:${def.volume.target}`)}`);
  }
  if (Object.keys(def.labels).length) {
    L.push('    labels:');
    for (const [k, v] of Object.entries(def.labels)) L.push(`      ${k}: ${q(v)}`);
  }
  if (def.volume) {
    L.push('volumes:');
    L.push(`  ${def.volume.source}:`);
    L.push('    external: true');
    L.push(`    name: ${q(def.volume.source)}`);
  }
  L.push('networks:');
  L.push(`  ${def.network}:`);
  L.push('    external: true');
  L.push(`    name: ${q(def.network)}`);
  const header = [
    `# mysandbox 服务 ${def.name} 的唯一配置真相（首版由 mysandbox 生成，之后归你）。`,
    '# 面板「配置」页保存即应用（docker compose up -d）；终端改完本文件后',
    '#   docker compose -f 本文件 up -d   亦可，两者等价。',
    '# 网络/数据卷是 external 的（mysandbox 自持资产），compose 不会动它们。',
    '',
  ].join('\n');
  return header + L.join('\n') + '\n';
}

// —— 读取/解析 ——
// 解析出业务关心的字段（listServices 的 env 展示、连接命令、config 视图）。
// 坏文件返回 null（显示层降级，不炸轮询）；serviceKey 取 services 下第一个 key——
// 用户改过 service key 时 hash 校验要对得上他改后的形状。
export interface ParsedCompose {
  serviceKey: string;
  image?: string;
  env: Record<string, string>;
  command?: string[];
  volume?: string | null;
  ip?: string;
  build: boolean;
}

function parseComposeDoc(yaml: string): { serviceKey: string; svc: Record<string, unknown> } | null {
  let doc: unknown;
  try {
    doc = yamlLoad(yaml);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const services = (doc as Record<string, unknown>).services;
  if (!services || typeof services !== 'object') return null;
  const entry = Object.entries(services as Record<string, unknown>)[0];
  if (!entry || !entry[1] || typeof entry[1] !== 'object') return null;
  return { serviceKey: entry[0], svc: entry[1] as Record<string, unknown> };
}

export async function readComposeService(name: string): Promise<ParsedCompose | null> {
  let yaml: string;
  try {
    yaml = await readFile(composeFileOf(name), 'utf8');
  } catch {
    return null;
  }
  const parsed = parseComposeDoc(yaml);
  if (!parsed) return null;
  const { serviceKey, svc } = parsed;
  const env: Record<string, string> = {};
  if (svc.environment && typeof svc.environment === 'object') {
    for (const [k, v] of Object.entries(svc.environment as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') env[k] = String(v);
    }
  }
  const volumes = Array.isArray(svc.volumes) ? (svc.volumes as unknown[]) : [];
  const volStr = volumes.find((v): v is string => typeof v === 'string' && v.includes(':'));
  const networks = svc.networks && typeof svc.networks === 'object' ? (svc.networks as Record<string, unknown>) : {};
  const net = Object.values(networks)[0];
  const ip =
    net && typeof net === 'object' && typeof (net as Record<string, unknown>).ipv4_address === 'string'
      ? ((net as Record<string, unknown>).ipv4_address as string)
      : undefined;
  return {
    serviceKey,
    image: typeof svc.image === 'string' ? svc.image : undefined,
    env,
    command: Array.isArray(svc.command) ? (svc.command as unknown[]).map(String) : undefined,
    volume: volStr ? volStr.split(':')[0] : null,
    ip,
    build: svc.build != null,
  };
}

export async function readComposeYaml(name: string): Promise<string | null> {
  try {
    return await readFile(composeFileOf(name), 'utf8');
  } catch {
    return null;
  }
}

// —— 写入（先经 compose config --quiet 校验，坏文件绝不落盘——否则 delete 的
// compose down 也会跟着解析失败，服务就删不掉了）——
export async function writeCompose(name: string, yaml: string): Promise<void> {
  const dir = composeDir(name);
  const file = composeFileOf(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${dir}/.compose.yaml.tmp`;
  await writeFile(tmp, yaml, { mode: 0o600 });
  const invalid = await validateComposeFile(tmp);
  if (invalid) {
    await rm(tmp, { force: true });
    throw new Error(`compose 文件校验失败：${invalid}`);
  }
  await rename(tmp, file);
}

// 校验单个文件：resolve(null) = 合法，resolve(msg) = compose 的人话报错。
function validateComposeFile(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', '-f', file, 'config', '--quiet'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (b: Buffer) => (err += b.toString('utf8')));
    child.on('error', (e) => resolve(String(e)));
    child.on('close', (code) =>
      resolve(code === 0 ? null : err.trim().split('\n').pop() || `docker compose config exited ${code}`),
    );
  });
}

// —— hash（漂移检测）——
// `compose config --hash <service>`：按当前文件算出与容器 label 同源的 hash（客户端
// 计算，不碰 daemon）。文件坏/缺失返回 null。
export async function composeFileHash(name: string): Promise<string | null> {
  const yaml = await readComposeYaml(name);
  if (!yaml) return null;
  const parsed = parseComposeDoc(yaml);
  if (!parsed) return null;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '-f', composeFileOf(name), 'config', '--hash', parsed.serviceKey],
      { timeout: 10_000 },
    );
    const hash = stdout.trim().split(/\s+/)[1] ?? '';
    return hash || null;
  } catch {
    return null;
  }
}

// —— compose up（创建/应用/迁移共用的收敛动作）——
// 输出已是人话行（Pulling/Pulled/Created/Started），直接逐行进任务日志；硬顶 +
// 5min 无输出看门狗（TLS 卡死的 pull 完全静默，同旧 pullImageStream 的教训）。
// 取消 = SIGKILL compose CLI：半途状态（旧容器已停未启等）由下一次 up 幂等收敛，
// 这正是声明式底账的好处，取消不再有「必须落在 rm 之前」的时序枷锁。
export interface ComposeUpOpts {
  build?: boolean;
  onLine: (line: string) => void;
  signal?: AbortSignal;
  hardTimeoutMs?: number; // 缺省 30min
  idleMs?: number; // 缺省 5min
}

export async function composeUp(name: string, opts: ComposeUpOpts): Promise<void> {
  const file = composeFileOf(name);
  const timeoutMs = opts.hardTimeoutMs ?? 30 * 60_000;
  const idleMs = opts.idleMs ?? 5 * 60_000;
  await new Promise<void>((resolveP, rejectP) => {
    const args = ['compose', '-f', file, 'up', '-d'];
    if (opts.build) args.push('--build');
    const child = spawn('docker', args, { cwd: composeDir(name), stdio: ['ignore', 'pipe', 'pipe'] });
    const tail: string[] = [];
    let done = false;
    let hardTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let killed: 'timeout' | 'idle' | 'cancel' | null = null;

    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      fn();
    };
    const armIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killed = 'idle';
        child.kill('SIGKILL');
      }, idleMs);
    };
    hardTimer = setTimeout(() => {
      killed = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    armIdle();

    const feed = (b: Buffer): void => {
      armIdle();
      for (const line of b.toString('utf8').split('\n')) {
        const s = line.trim();
        if (!s) continue;
        tail.push(s);
        if (tail.length > 50) tail.splice(0, tail.length - 50);
        opts.onLine(s);
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (e) => finish(() => rejectP(e)));
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) {
          resolveP();
        } else if (killed === 'cancel' || opts.signal?.aborted) {
          rejectP(Object.assign(new Error(`已取消 ${name} 的 compose up`), { canceled: true }));
        } else if (killed === 'timeout') {
          rejectP(new Error(`compose up 超时（${Math.round(timeoutMs / 60_000)} 分钟）——服务 ${name}`));
        } else if (killed === 'idle') {
          rejectP(new Error(`compose up 停滞（5 分钟无输出）——网络受限或 registry 不可达，服务 ${name}`));
        } else {
          rejectP(new Error(tail.slice(-6).join('\n') || `docker compose up exited ${code}`));
        }
      });
    });
    opts.signal?.addEventListener('abort', () => {
      killed = 'cancel';
      child.kill('SIGKILL');
    }, { once: true });
  });
}

// compose down（删除路径）：移除容器与 compose 自己的网络（external 网络不受影响）。
// 文件坏了 down 会失败——调用方回退 docker rm -f。
export async function composeDown(name: string): Promise<void> {
  await execFileAsync('docker', ['compose', '-f', composeFileOf(name), 'down'], {
    timeout: 90_000,
    cwd: composeDir(name),
  });
}

// 删除服务目录（文件随服务走：服务没了底账也没了）。
export async function removeComposeDir(name: string): Promise<void> {
  await rm(composeDir(name), { recursive: true, force: true });
}

// 首启兜底：compose 根目录建出来（服务面板至少能列路径）。
export function ensureComposeRoot(): void {
  if (!existsSync(`${CONFIG_DIR}/compose`)) {
    void mkdir(`${CONFIG_DIR}/compose`, { recursive: true, mode: 0o700 }).catch((e) =>
      log.warn({ err: String(e) }, 'compose root mkdir failed'),
    );
  }
}
