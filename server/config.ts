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
  // 模板容器：建容器 = lxc-copy 克隆它。
  // 克隆要求模板处于 STOPPED（lxc-copy 对运行中的源静默失败）。
  lxc: z
    .object({
      template: z.string().default('ms-template'),
    })
    .default({ template: 'ms-template' }),
  // 容器 veth 挂的宿主网桥设备名（如 br-f0cc7d98dca0）。
  network: z.string().default('dev-lan'),
  // docker 服务层：配套服务（数据库等）跑在 docker 里，与 LXC 容器同桥互通。
  services: z
    .object({
      enabled: z.boolean().default(true),
      // docker 网络名（⚠️ 不是顶层 network 的桥设备名；两者经 br-<网络id前12位> 对应，
      // services.ts 的 bridgeOk 校验这个关系）。服务必须挂现有网络——新建 docker 网络
      // 会落到 daemon.json 的 10.201.0.0/16 池，不在 LXC 同桥。
      network: z.string().default('dev-lan'),
      // 服务静态 IP 池（docker 动态分配从 .2 顺排，.200+ 天然隔离；占用判定见
      // services.ts allocateServiceIp——网络端点 ∪ state.services ∪ reserved）。
      ipPool: z
        .object({
          from: z.string().default('10.88.0.200'),
          to: z.string().default('10.88.0.240'),
          reserved: z.array(z.string()).default([]),
        })
        .default({ from: '10.88.0.200', to: '10.88.0.240', reserved: [] }),
      // 镜像拉取硬超时（毫秒，默认 30 分钟）。慢速网络下兜底用；正常卡死会被
      // 5 分钟无输出看门狗先拦下（见 docker.ts pullImageStream 的 idleMs）。
      pullTimeoutMs: z.number().int().default(1_800_000),
    })
    .default({ enabled: true, network: 'dev-lan', ipPool: { from: '10.88.0.200', to: '10.88.0.240', reserved: [] }, pullTimeoutMs: 1_800_000 }),
  sshSource: z.string(),
  claudeSettingsTemplate: z.string().default(''),
  ipPool: z.object({
    from: z.string(),
    to: z.string(),
    reserved: z.array(z.string()).default([]),
  }),
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
      lxc: parsed.lxc,
      network: parsed.network,
      services: parsed.services,
      sshSource: parsed.sshSource,
      claudeSettingsTemplate: parsed.claudeSettingsTemplate,
      ipPool: parsed.ipPool,
      git: parsed.git,
      ui: parsed.ui,
      token: parsed.token,
    });
    await writeFile(CONFIG_FILE, out, { mode: 0o600 });
    await chmod(CONFIG_FILE, 0o600);
  }

  return { config: parsed, firstRun: !fileExisted, tokenGenerated };
}
