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
    // 自签名 HTTPS（server/tls.ts：本地 CA + 泛域名叶子，首次启用自动生成，
    // CA 导入信任库一次即可覆盖控制台与全部 vhost 子域）。关闭 = 纯 HTTP。
    tls: z.boolean().default(false),
  }),
  // 模板容器：建容器 = lxc-copy 克隆它。
  // 克隆要求模板处于 STOPPED（lxc-copy 对运行中的源静默失败）。
  lxc: z
    .object({
      template: z.string().default('ms-template'),
    })
    .default({ template: 'ms-template' }),
  // 容器 veth 挂的宿主网桥设备名（mysandbox 自有桥 mysandbox0，mysandbox-net.service 建）。
  network: z.string().default('mysandbox0'),
  // docker 服务层：配套服务（数据库等）跑在 docker 里，与 LXC 容器同桥互通。
  services: z
    .object({
      enabled: z.boolean().default(true),
      // docker 网络名（⚠️ 不是顶层 network 的桥设备名）。LXC 在自有桥 mysandbox0 上，
      // 两网段经宿主路由互通（mysandbox-docker-interop.service 放行跨桥转发）。
      // 网络自持：缺失时按服务池隐含的 /24 自动创建（services.ts ensureServiceNetwork）。
      network: z.string().default('mysandbox-lan'),
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
    .default({ enabled: true, network: 'mysandbox-lan', ipPool: { from: '10.88.0.200', to: '10.88.0.240', reserved: [] }, pullTimeoutMs: 1_800_000 }),
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
  // 终端输出活动监测（「无输出提醒」）：输出安静超过 quietSeconds 秒且前端判定
  // 没人看着时弹提醒（agent 干完活/等输入场景）。扫描与判定见 server/activity.ts。
  terminal: z
    .object({
      quietSeconds: z.number().int().default(15),
    })
    .default({ quietSeconds: 15 }),
  // 宿主防火墙（ufw）追加放行（环境特例：热点访问 console、宿主 clash 代理/GLM 网关等）。
  // 核心放行（容器 DNS 53、非 localhost 监听时的 console 端口、LXC 桥 route）由
  // firewall.ts 从 listen/ipPool/services 推导，不经这里；应用在 mysandbox-firewall.service。
  firewall: z
    .object({
      allow: z
        .array(
          z.object({
            from: z.string(), // 来源网段（CIDR 或 IP）
            port: z.number().int().optional(), // 缺省 = 全端口
            proto: z.enum(['tcp', 'udp']).optional(), // 缺省 tcp（有 port 时）
            comment: z.string().optional(),
          }),
        )
        .default([]),
    })
    .default({ allow: [] }),
  // 宿主 docker API 桥（server/dockerApi.ts）：容器内 docker CLI 免安装直用宿主 dockerd。
  // mysandbox 进程内跑 TCP(<网关IP>:2375) → dockerApi.socket 的透传代理；容器侧 hosts
  // 注入 host.docker.internal → 网关（hosts-sync）+ DOCKER_HOST 注入（engine attachArgs
  // 与 scripts/zshrc 兜底）。⚠️ docker 能力 = 宿主 root 级权限（可挂宿主 /），端口只对
  // LXC 网段放行（firewall.ts），且随 mysandbox 进程存活——默认关，明确要才开。
  dockerApi: z
    .object({
      enabled: z.boolean().default(false),
      // dockerd 的 unix socket。换 podman 等替代品时改这里（socket 兼容 docker API 则桥照用）。
      socket: z.string().default('/var/run/docker.sock'),
    })
    .default({ enabled: false, socket: '/var/run/docker.sock' }),
  // Web 代理（server/proxy.ts）：面板外经 mysandbox 访问容器/服务的 HTTP(+WS) 端口。
  proxy: z
    .object({
      // vhost 基域名：auto = 按默认路由 IPv4 生成 <ip-连字符>.sslip.io（零配置，公共 DNS
      // 恒等该 IP；tailscale 地址会一并列为候选）；off = 关闭 vhost（仅子路径门面）；
      // 其他值 = 自有域名（需泛解析 *.<域名> → 宿主 IP）。sslip.io 不在 Public Suffix
      // List（实测），Domain cookie/same-site 成立；有自有域名优先自有。
      vhost: z.string().default('auto'),
      // 钉死基 IP（多网卡/动态 IP 环境）；auto = 默认路由接口 IPv4。
      ip: z.string().default('auto'),
    })
    .default({ vhost: 'auto', ip: 'auto' }),
  // peer API（server/peer.ts）：容器间命令互通的转发枢纽。绑网关 IP 的迷你 HTTP
  // 服务（POST /exec 由宿主代为 lxc-attach / docker exec / 直接 spawn），容器内
  // `mysandbox exec <目标> -- 命令` 走它，免 SSH。端口可配（peer.json 随种子刷新，
  // 不像 DOCKER_API_PORT 有模板静态文本的陈旧分叉）。
  peer: z
    .object({
      enabled: z.boolean().default(true),
      port: z.number().int().default(7331),
    })
    .default({ enabled: true, port: 7331 }),
  token: z.string().optional(),
  // peer API 凭据（与主 token 分离：peer 端点只有 targets/exec，控制台全量 API 不在内）。
  // 首启随 token 一起生成；宿主自动种进每个受管容器的 ~/.config/mysandbox/peer.json。
  peerToken: z.string().optional(),
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
  // peerToken 缺失就补生成（存量 config 升级路径）：与主 token 同等随机度，落盘 0600。
  if (!userCfg.peerToken) {
    userCfg.peerToken = randomBytes(24).toString('hex');
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
      terminal: parsed.terminal,
      firewall: parsed.firewall,
      dockerApi: parsed.dockerApi,
      proxy: parsed.proxy,
      peer: parsed.peer,
      token: parsed.token,
      peerToken: parsed.peerToken,
    });
    await writeFile(CONFIG_FILE, out, { mode: 0o600 });
    await chmod(CONFIG_FILE, 0o600);
  }

  return { config: parsed, firstRun: !fileExisted, tokenGenerated };
}
