// 容器内 code-server（浏览器版 VS Code）：照 desktop.ts 的按需 ensure 模式，
// 走 SSE（beginSse，create 容器同款）——装包可能要几分钟，进度人话帧给前端 toast。
// 打开 = 前端 serviceUrl('c', name, PORT, ip)，与容器端口点击同一条路径（代理口径
// 经 Web 代理、直连口径 IP:端口，见 web/src/lib/proxy.ts）。
//
// 生命周期：setsid nohup 起在容器内（dev 用户），关标签页/重启 mysandbox 都不影响；
// 闲置自动停——浏览器关掉 tab 后本端口无 ESTABLISHED 连接，超过 cfg.codeServer.
// idleStopMinutes 即被周期 sweep 停掉（磁盘安装保留，下次 ensure 秒级重起）。
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
import { log } from './logger.js';

// 端口选 7332：与 7321（控制台）/7331（peer）同族好记；8080 是 dev server 重灾区，
// 容器内自起服务容易撞。容器各自网络命名空间，多容器同端口互不冲突，无需可配。
export const CODE_SERVER_PORT = 7332;

// 已确认 code-server 活着的容器 id（进程级缓存，同 desktopReady 的取舍）。
const ready = new Set<string>();

// 闲置停：每容器最近一次「有连接」的时间（进程内，同 jobs.ts 取舍——重启后重新计时，
// 最多多宽限一个闲置周期，无害）。浏览器开着 code-server 才有监听端口的 ESTABLISHED
// 连接（workbench websocket），关 tab 即断——连接数就是在用的唯一可靠信号。
const lastSeen = new Map<string, number>();

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

// code-server 是否活着：进程在（[c] 防 pgrep -f 匹配到探测命令自己）+ HTTP 实测 200。
// 仅 TCP 可连判不出半残树起的 500（cet 实测踩过：端口通、页面 500）——curl 在模板契约里。
// -L 必带：code-server 记住上次工作区后，裸 `/` 会 302 到 `/?folder=…`（实测踩过：
// 固定等 200 的探活被 302 卡到超时），跟随重定向到 workbench 才是「真的能服务」。
async function alive(cfg: Config, id: string): Promise<boolean> {
  const r = await sh(cfg, id, `pgrep -f 'code-serv[e]r' >/dev/null 2>&1`);
  if (r.exitCode !== 0) return false;
  const http = await sh(cfg, id, `curl -sL -o /dev/null -w '%{http_code}' http://127.0.0.1:${CODE_SERVER_PORT}/`, {
    timeoutMs: 15_000,
  });
  return http.exitCode === 0 && http.stdout.trim() === '200';
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
    // 前置：依赖链里的 kerberos（vscode 自带依赖）要 node-gyp 本地编译，缺 gssapi
    // 头文件必挂（cet 实测）；g++/make/python3 模板契约已带，这里只补 krb5 头。
    // ⚠️ 不能用 --ignore-scripts 绕：postinstall 还负责补 vscode 子树的缺失依赖
    // （@microsoft/1ds-core-js 等），跳过它装是半残树、起服务 500（同日实测）。
    onProgress('安装 code-server（npm 全局，约几分钟）…');
    await sh(
      cfg,
      id,
      'dpkg -s libkrb5-dev >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq libkrb5-dev; }',
      { timeoutMs: 300_000 },
    );
    // 残缺安装先清掉：上次半途失败的树留着会让 npm 复用/直接撞 EEXIST。
    await sh(cfg, id, 'npm rm -g code-server 2>/dev/null; rm -rf /usr/local/lib/node_modules/code-server; true');
    let r = await sh(cfg, id, 'npm install -g code-server@latest', { timeoutMs: 900_000 });
    if (r.exitCode !== 0) {
      onProgress('默认 registry 失败，换 npmmirror 镜像重试…');
      r = await sh(
        cfg,
        id,
        'npm install -g --registry=https://registry.npmmirror.com code-server@latest',
        { timeoutMs: 900_000 },
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

// ---- 闲置自动停（cfg.codeServer.idleStopMinutes，0 = 关闭）----
// 照 activity.ts 的周期 sweep 形态：inFlight 防重入 + unref。对每台运行中容器一次
// exec 同时探「进程在不在 + 监听端口的 ESTABLISHED 连接数」（/proc/net/tcp，状态 01，
// 本地端口十六进制，由常量换算——改端口不会两处失同步）——不额外引入探测连接，
// 也不会被 curl 探活误刷。

const SWEEP_MS = 5 * 60_000;

const PORT_HEX = CODE_SERVER_PORT.toString(16).toUpperCase();

// 单容器一拍：返回 'none'（进程没了）| 数字（established 连接数）。
async function idleProbe(cfg: Config, id: string): Promise<'none' | number> {
  const r = await sh(
    cfg,
    id,
    `pgrep -f 'code-serv[e]r' >/dev/null 2>&1 || { echo none; exit 0; }
     awk 'NR>1 && $4=="01" && $2 ~ /:${PORT_HEX}$/' /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l`,
  );
  if (r.exitCode !== 0) return 'none';
  const out = r.stdout.trim();
  if (out === 'none') return 'none';
  const n = Number(out);
  return Number.isFinite(n) ? n : 0;
}

async function stopCodeServer(cfg: Config, id: string, name: string): Promise<void> {
  // setsid 起的进程有自己的会话/进程组，但子进程（pty host 等）cmdline 各异——
  // pkill 按特征全杀，TERM 后补 KILL 收尾；监听端口在主进程，端口必释放。
  await sh(cfg, id, `pkill -f 'code-serv[e]r' 2>/dev/null; sleep 1; pkill -9 -f 'code-serv[e]r' 2>/dev/null; true`, {
    timeoutMs: 15_000,
  });
  lastSeen.delete(id);
  ready.delete(id);
  log.info({ container: name }, 'code-server 闲置自动停止');
}

async function idleTick(cfg: Config): Promise<void> {
  const idleMs = cfg.codeServer.idleStopMinutes * 60_000;
  if (idleMs <= 0) return;
  const items = await listManaged(cfg);
  const running = items.filter((c) => c.state === 'running');
  // 容器没了/停了：计时条目一并清（进程自然消亡，下次起算从零宽限）。
  const aliveIds = new Set(running.map((c) => c.id));
  for (const id of [...lastSeen.keys()]) if (!aliveIds.has(id)) lastSeen.delete(id);
  await Promise.allSettled(
    running.map(async (c) => {
      const now = Date.now();
      const conns = await idleProbe(cfg, c.id);
      if (conns === 'none') {
        lastSeen.delete(c.id);
        ready.delete(c.id);
        return;
      }
      if (conns > 0) {
        lastSeen.set(c.id, now);
        return;
      }
      // 活着但没连接：首见只记基线（起服务到开 tab 之间有间隙，别误杀），超时才停。
      const since = lastSeen.get(c.id);
      if (since === undefined) {
        lastSeen.set(c.id, now);
        return;
      }
      if (now - since >= idleMs) await stopCodeServer(cfg, c.id, c.name);
    }),
  );
}

let sweepStarted = false;

// 启动闲置 sweep（幂等；buildServer 装配时调一次）。
export function startCodeServerIdleSweeper(cfg: Config): void {
  if (sweepStarted) return;
  sweepStarted = true;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void idleTick(cfg)
      .catch((e) => log.debug({ err: String(e) }, 'code-server idle sweep failed'))
      .finally(() => {
        inFlight = false;
      });
  }, SWEEP_MS);
  timer.unref(); // 不阻止进程退出
}

export async function registerCodeServer(app: FastifyInstance, cfg: Config): Promise<void> {
  // SSE：进度帧（status）+ done 帧（result = {name, ip}，前端拼打开 URL）。错误走 error 帧。
  app.post('/api/containers/:id/code-server', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sink, finalize } = beginSse(reply);
    await finalize(() => ensureCodeServer(cfg, id, (m) => sink({ status: m })));
  });
}
