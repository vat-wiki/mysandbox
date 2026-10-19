// 容器内 code-server（浏览器版 VS Code）：照 desktop.ts 的按需 ensure 模式，
// 走 SSE（beginSse，create 容器同款）——装包可能要几分钟，进度人话帧给前端 toast。
// 打开 = 前端 serviceUrl('c', name, 8080, ip)，与容器端口点击同一条路径（代理口径
// 经 Web 代理、直连口径 IP:端口，见 web/src/lib/proxy.ts）。
//
// 生命周期：setsid nohup 常驻容器内（dev 用户），关标签页/重启 mysandbox 都不影响；
// 容器重启后进程没了，ready 缓存被 alive 实测探测纠正，下次触发自动重起。
// 安装通道 npm 全局（与模板 AI CLI 同通道——registry 在本部署网络实测可达，
// coder 的 install.sh 走 code-server.dev + github releases，无 npm 稳）。
// 安全：--auth none——到达服务必先过代理 cookie 鉴权（代理口径）或自管网段可达性
// （直连口径；ufw 对外部网段默认全拒，见 firewall.ts 信任模型），面板现有面之外
// 不新增暴露。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { execRun, listManaged } from './engine/index.js';
import { beginSse } from './sse.js';

export const CODE_SERVER_PORT = 8080;

// 已确认 code-server 活着的容器 id（进程级缓存，同 desktopReady 的取舍）。
const ready = new Set<string>();

async function sh(
  cfg: Config,
  id: string,
  cmd: string,
  opts: { user?: string; timeoutMs?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return execRun(cfg, id, {
    Cmd: ['sh', '-c', cmd],
    User: opts.user ?? 'root',
    Tty: false,
    timeoutMs: opts.timeoutMs ?? 15_000,
  });
}

// 容器内 8080 是否可连（TCP 握手，1s 快失败）。
async function portReachable(cfg: Config, id: string): Promise<boolean> {
  const r = await sh(cfg, id, `timeout 1 bash -c "echo > /dev/tcp/127.0.0.1/${CODE_SERVER_PORT}" 2>/dev/null`);
  return r.exitCode === 0;
}

// code-server 是否活着：进程在（[c] 防 pgrep -f 匹配到探测命令自己）+ 端口可连。
// 任一不满足即认为没起（半死状态也重起）。
async function alive(cfg: Config, id: string): Promise<boolean> {
  const r = await sh(cfg, id, `pgrep -f 'code-serv[e]r' >/dev/null 2>&1`);
  if (r.exitCode !== 0) return false;
  return portReachable(cfg, id);
}

// 容器 id/name → { ip, name }（校验 running）。与 desktop.ts 的 resolveTarget 同款
// （那边是私有实现；两行差异不值得为此抽公共模块）。
async function resolveTarget(cfg: Config, id: string): Promise<{ ip: string; name: string }> {
  const items = await listManaged(cfg);
  const c = items.find((x) => x.id === id || x.name === id);
  if (!c) throw new Error('container not found');
  if (c.state !== 'running') throw new Error('container not running');
  if (!c.ip) throw new Error('container has no ip');
  return { ip: c.ip, name: c.name };
}

// 确保容器内 code-server 可用（缺装装 + 没起起 + 就绪轮询）。返回目标供前端拼 URL。
export async function ensureCodeServer(
  cfg: Config,
  id: string,
  onProgress: (message: string) => void,
): Promise<{ name: string; ip: string }> {
  const target = await resolveTarget(cfg, id);
  // 快路径：缓存 + 实测双确认（缓存防重复探测开销，实测防容器重启后缓存陈旧）。
  if (ready.has(id) && (await alive(cfg, id))) return target;
  ready.delete(id);

  onProgress('检查 code-server…');
  const has = await sh(cfg, id, 'command -v code-server >/dev/null');
  if (has.exitCode !== 0) {
    onProgress('安装 code-server（npm 全局，约一两分钟）…');
    // --ignore-scripts：依赖链里的 kerberos/argon2 是 native 模块，容器缺 libkrb5-dev
    // 等头文件时 node-gyp 编译失败整包报废（cet 实测）。脚本不跑完全能用：4.141 的
    // npm 包自带产物（dev 容器 scripts 被拦下后照常跑），且 --auth none 下 argon2
    // （密码哈希）/kerberos（企业认证）根本不会走到。
    let r = await sh(cfg, id, 'npm install -g --ignore-scripts code-server@latest', {
      timeoutMs: 600_000,
    });
    if (r.exitCode !== 0) {
      onProgress('默认 registry 失败，换 npmmirror 镜像重试…');
      r = await sh(
        cfg,
        id,
        'npm install -g --ignore-scripts --registry=https://registry.npmmirror.com code-server@latest',
        { timeoutMs: 600_000 },
      );
    }
    if (r.exitCode !== 0) {
      throw new Error(`code-server 安装失败：${(r.stderr || r.stdout).slice(-300)}`);
    }
  }

  onProgress('启动 code-server…');
  await sh(
    cfg,
    id,
    `su - dev -c "setsid nohup code-server --auth none --bind-addr 0.0.0.0:${CODE_SERVER_PORT} >/tmp/mysandbox-code-server.log 2>&1 & sleep 1"`,
    { timeoutMs: 10_000 },
  );

  onProgress('等待就绪…');
  for (let i = 0; i < 20; i++) {
    if (await alive(cfg, id)) {
      ready.add(id);
      return target;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  // 诊断信息带上：日志尾巴直接进错误消息，用户不用进容器翻。
  const diag = await sh(cfg, id, 'tail -n 8 /tmp/mysandbox-code-server.log 2>/dev/null || true');
  throw new Error(`code-server 未就绪（20s 超时）。日志摘要：\n${diag.stdout.slice(0, 500)}`);
}

export async function registerCodeServer(app: FastifyInstance, cfg: Config): Promise<void> {
  // SSE：进度帧（status）+ done 帧（result = {name, ip}，前端拼打开 URL）。错误走 error 帧。
  app.post('/api/containers/:id/code-server', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sink, finalize } = beginSse(reply);
    await finalize(() => ensureCodeServer(cfg, id, (m) => sink({ status: m })));
  });
}
