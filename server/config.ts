// 配置加载：随包 default.yaml ← XDG 用户 config.yaml（首启生成 + 注入随机 token）← 环境变量。
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad, dump as yamlDump } from 'js-yaml';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function xdgConfigHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}
export function xdgDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
}

export const CONFIG_DIR = join(xdgConfigHome(), 'mysandbox');
export const CONFIG_FILE = join(CONFIG_DIR, 'config.yaml');
export const STATE_DIR = join(xdgDataHome(), 'mysandbox');
export const STATE_FILE = join(STATE_DIR, 'state.json');

export const ConfigSchema = z.object({
  listen: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(7321),
  }),
  // 容器引擎：'docker'（原形态）| 'lxc'（系统容器，见 docs/lxc-migration.md）。
  // 迁移期可切换回退；两者容器共用同一座网桥，同 LAN 互通。
  engine: z.enum(['docker', 'lxc']).default('docker'),
  docker: z.object({
    socketPath: z.string().default('/var/run/docker.sock'),
  }),
  // LXC 引擎专属配置（engine: lxc 时生效）。
  lxc: z
    .object({
      // 模板容器名：建容器 = lxc-copy 克隆它（D3，取代 docker 镜像）。
      // 克隆要求模板处于 STOPPED（lxc-copy 对运行中的源静默失败）。
      template: z.string().default('ms-template'),
    })
    .default({ template: 'ms-template' }),
  image: z.string().default('dev'),
  // 远程镜像仓库（host/path，如 ghcr.io/leon/mysandbox）；空=未配，push/pull 需显式给 ref。
  registry: z.string().default(''),
  // push/pull 用的 tag（本地基础镜像仍由 image 字段决定）。
  imageTag: z.string().default('latest'),
  // 镜像构建上下文目录（外部化）；空=随包内置 image/ 自动定位。支持 ~，须为绝对路径。
  imageDir: z.string().default(''),
  network: z.string().default('dev-lan'),
  dataRoot: z.string(),
  sshSource: z.string(),
  claudeSettingsTemplate: z.string().default(''),
  ipPool: z.object({
    from: z.string(),
    to: z.string(),
    reserved: z.array(z.string()).default([]),
  }),
  restartPolicy: z.string().default('unless-stopped'),
  git: z.object({
    name: z.string().default('dev'),
    email: z.string().default('dev@local'),
  }),
  ui: z.object({
    defaultShell: z.string().default('zsh'),
  }),
  token: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

function defaultPaths() {
  return {
    dataRoot: join(STATE_DIR, 'data'),
    sshSource: join(homedir(), '.ssh'),
  };
}

// `~`/`~/x` → homedir 展开（其余原样返回）。imageDir 等路径配置的输入归一。
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

async function loadDefaultYaml(): Promise<Record<string, unknown>> {
  const candidates = [
    join(__dirname, '..', 'config.default.yaml'), // dev: server/ -> root
    join(__dirname, '..', '..', 'config.default.yaml'), // dist/ -> root
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const txt = await readFile(p, 'utf8');
      return (yamlLoad(txt) as Record<string, unknown>) || {};
    }
  }
  return {};
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, bv] of Object.entries(b)) {
    if (isObject(bv) && isObject(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

export interface LoadResult {
  config: Config;
  firstRun: boolean;
  tokenGenerated: boolean;
}

export async function loadConfig(): Promise<LoadResult> {
  const defaults = await loadDefaultYaml();
  const paths = defaultPaths();
  if (!defaults.dataRoot) defaults.dataRoot = paths.dataRoot;
  if (!defaults.sshSource) defaults.sshSource = paths.sshSource;

  const fileExisted = existsSync(CONFIG_FILE);
  let userCfg: Record<string, unknown> = {};
  if (fileExisted) {
    userCfg = (yamlLoad(await readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>) || {};
  }

  let tokenGenerated = false;
  if (!userCfg.token) {
    userCfg.token = randomBytes(24).toString('hex');
    tokenGenerated = true;
  }

  const merged = deepMerge(defaults, userCfg);
  const parsed = ConfigSchema.parse(merged);

  // 持久化：文件不存在或缺 token 时写回（0600），确保 token 落盘。
  if (!fileExisted || tokenGenerated) {
    await mkdir(CONFIG_DIR, { recursive: true });
    const out = yamlDump({
      listen: parsed.listen,
      engine: parsed.engine,
      docker: parsed.docker,
      lxc: parsed.lxc,
      image: parsed.image,
      registry: parsed.registry,
      imageTag: parsed.imageTag,
      imageDir: parsed.imageDir,
      network: parsed.network,
      dataRoot: parsed.dataRoot,
      sshSource: parsed.sshSource,
      claudeSettingsTemplate: parsed.claudeSettingsTemplate,
      ipPool: parsed.ipPool,
      restartPolicy: parsed.restartPolicy,
      git: parsed.git,
      ui: parsed.ui,
      token: parsed.token,
    });
    await writeFile(CONFIG_FILE, out, { mode: 0o600 });
    await chmod(CONFIG_FILE, 0o600);
  }

  return { config: parsed, firstRun: !fileExisted, tokenGenerated };
}
