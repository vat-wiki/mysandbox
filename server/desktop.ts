// 容器桌面：两条 WS 路由。
//
// - /ws/desktop（控制流，文本帧 JSON）：连接即触发 ensureDesktop()（按需装包 + 起桌面服务），
//   期间发 {type:'progress', message}；就绪发 {type:'ready'}，之后保持挂着（心跳/早断感知），
//   失败发 {type:'error', message} 并关。前端拿 ready 后才去连 RFB 流。
// - /ws/desktop-vnc（RFB 透传，纯二进制）：net.connect(容器IP:5901) 双向 pipe。
//   **不掺任何文本帧**——noVNC 的 Websock 只消费二进制 RFB 数据，混入文本帧会破坏协议流。
//   这就是拆两条路由的原因：ensure 的进度必须走独立通道。
//
// 形态：容器内 Xvfb(虚拟 X) + XFCE + x11vnc(RFB 服务)，宿主 mysandbox 做代理。
// 按需启动（照 terminal.ts 的 tmuxReady 模式）：首次连接容器里没有桌面栈 -> ensureDesktop()
// 先装包（apt 换源 aliyun + install xvfb/x11vnc/xfce4/dbus-x11——官方源被 fake-ip DNS 污染
// 不可用，aliyun 实测直连可达）再起服务；桌面栈已活着（Xvfb 进程在 + 5901 在听）则秒 ready。
//
// 生命周期：桌面进程 setsid nohup 常驻容器内（dev 用户），与浏览器、与 mysandbox 进程解耦——
// 关 Dialog 只断代理（TCP destroy），桌面留着，重开秒连复用；容器重启后进程没了，
// 下次连接探测失败自动重起（desktopReady 缓存清掉）。
//
// 安全：/ws/ 前缀在全局鉴权 hook 内（token 必验）；x11vnc -nopw——到达 RFB 必先过
// mysandbox token，等价现有终端面；容器 5901 只在容器内/同桥可达，UI 不暴露直连。
import type { FastifyInstance } from 'fastify';
import { connect as tcpConnect } from 'node:net';
import type { Config } from './config.js';
import { execRun, listManaged } from './engine/index.js';

// 桌面服务常量：X display 编号与 RFB 端口。容器内独占、无多桌面并存（v1）。
const X_DISPLAY = ':10';
const VNC_PORT = 5901;

// 已确认桌面栈活着的容器 id（进程级缓存）。探测仍兜底：容器重启后缓存失效靠
// ensureDesktop 的实测探测纠正（缓存命中但连接失败时清缓存重试一次）。
const desktopReady = new Set<string>();

// 进度帧：{type:'progress', message}。只在控制流 /ws/desktop 上发（文本帧），RFB 流上永不发。
interface ProgressSink {
  (message: string): void;
}

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

// 容器内 5901 是否可连（TCP 握手）。timeout 1s 快失败。
async function vncReachable(cfg: Config, id: string): Promise<boolean> {
  const r = await sh(cfg, id, 'timeout 1 bash -c "echo > /dev/tcp/127.0.0.1/' + VNC_PORT + '" 2>/dev/null');
  return r.exitCode === 0;
}

// 桌面栈是否活着：Xvfb 进程在 + RFB 端口可连。任一不满足即认为没起（半死状态也重起）。
async function desktopAlive(cfg: Config, id: string): Promise<boolean> {
  const r = await sh(cfg, id, 'pgrep -x Xvfb >/dev/null 2>&1');
  if (r.exitCode !== 0) return false;
  return vncReachable(cfg, id);
}

// 幂等换源：官方源（archive/security.ubuntu.com）→ aliyun。已是 aliyun 则不动。
// sed -i 直接改 /etc/apt/sources.list；Ubuntu 24.04 模板就是单文件 sources.list（实测）。
async function ensureMirror(cfg: Config, id: string): Promise<void> {
  await sh(
    cfg,
    id,
    'sed -i "s|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; ' +
      's|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g" /etc/apt/sources.list',
  );
}

// 起桌面三件套（dev 用户、setsid 常驻）。分步起而非一条脚本：Xvfb 要先就位 x11vnc 才连得上
// socket；每步间隔靠 sleep 粗同步，末尾统一轮询 5901 判定就绪。
async function startDesktopStack(cfg: Config, id: string, w: number, h: number): Promise<void> {
  // 清残留（上次半死状态的 X lock / 旧进程）：pkill 幂等、rm lock 文件防 Xvfb 拒启。
  await sh(cfg, id, 'pkill -x Xvfb 2>/dev/null; pkill -x x11vnc 2>/dev/null; rm -f /tmp/.X10-lock /tmp/.X11-unix/X10; true');
  // 1) Xvfb：虚拟 X server，分辨率即桌面分辨率（v1 固定，连接时定死）。
  await sh(
    cfg,
    id,
    `su - dev -c "setsid nohup Xvfb ${X_DISPLAY} -screen 0 ${w}x${h}x24 -nolisten tcp >/tmp/ms-xvfb.log 2>&1 & sleep 1"`,
    { user: 'root', timeoutMs: 10_000 },
  );
  // 2) x11vnc：把 X display 映成 RFB。forever=客户端断开后不退出；shared=多客户端并发。
  await sh(
    cfg,
    id,
    `su - dev -c "setsid nohup x11vnc -display ${X_DISPLAY} -rfbport ${VNC_PORT} -nopw -shared -forever -quiet >/tmp/ms-x11vnc.log 2>&1 & sleep 1"`,
    { user: 'root', timeoutMs: 10_000 },
  );
  // 3) XFCE 会话：往 Xvfb 里画桌面（任务栏/图标/窗口管理）。迟到几秒无妨，RFB 已可连
  //    （先黑屏、会话起来后出画面）。
  await sh(
    cfg,
    id,
    `su - dev -c "setsid nohup env DISPLAY=${X_DISPLAY} startxfce4 >/tmp/ms-xfce.log 2>&1 &"`,
    { user: 'root', timeoutMs: 10_000 },
  );
}

// 确保容器内桌面可用（装包 + 起服务 + 就绪轮询）。onProgress 报人话进度。
async function ensureDesktop(cfg: Config, id: string, w: number, h: number, onProgress: ProgressSink): Promise<void> {
  // 快路径：缓存 + 实测双确认（缓存防重复探测开销，实测防容器重启后缓存陈旧）。
  if (desktopReady.has(id) && (await desktopAlive(cfg, id))) return;
  desktopReady.delete(id);

  onProgress('检查桌面组件…');
  const has = await sh(cfg, id, 'command -v Xvfb >/dev/null && command -v x11vnc >/dev/null && command -v startxfce4 >/dev/null');
  if (has.exitCode !== 0) {
    onProgress('安装桌面组件（Xvfb/XFCE/x11vnc，约几分钟）…');
    await ensureMirror(cfg, id);
    const r = await sh(
      cfg,
      id,
      'DEBIAN_FRONTEND=noninteractive apt-get update -qq && ' +
        'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xvfb x11vnc xfce4 dbus-x11',
      { timeoutMs: 600_000 },
    );
    if (r.exitCode !== 0) {
      throw new Error(`桌面组件安装失败：${(r.stderr || r.stdout).slice(-300)}`);
    }
  }

  onProgress('启动桌面服务…');
  await startDesktopStack(cfg, id, w, h);

  onProgress('等待桌面就绪…');
  for (let i = 0; i < 15; i++) {
    if (await vncReachable(cfg, id)) {
      desktopReady.add(id);
      return;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  // 诊断信息带上：三份日志的尾巴直接进错误消息，用户不用进容器翻。
  const diag = await sh(cfg, id, 'tail -n 5 /tmp/ms-xvfb.log /tmp/ms-x11vnc.log /tmp/ms-xfce.log 2>/dev/null || true');
  throw new Error(`桌面服务未就绪（15s 超时）。日志摘要：\n${diag.stdout.slice(0, 500)}`);
}

// 容器 id/name → { ip }（校验 running）。找不到/不在跑抛 HttpError 形状的 Error。
async function resolveTarget(cfg: Config, id: string): Promise<{ ip: string; name: string }> {
  const items = await listManaged(cfg);
  const c = items.find((x) => x.id === id || x.name === id);
  if (!c) throw new Error('container not found');
  if (c.state !== 'running') throw new Error('container not running');
  if (!c.ip) throw new Error('container has no ip');
  return { ip: c.ip, name: c.name };
}

// 控制帧发送（文本帧，仅控制流）。客户端已断时静默。
function sendJson(socket: { send: (d: string) => void }, obj: unknown): void {
  try {
    socket.send(JSON.stringify(obj));
  } catch {
    /* noop */
  }
}

export async function registerDesktop(app: FastifyInstance, cfg: Config): Promise<void> {
  const log = app.log;

  // —— 控制流：ensure + 进度 + ready ——
  // ready 后保持连接挂着：前端拿它当「桌面会话还在被关注」的信号（断了即暂停 RFB 重连尝试，
  // v1 其实不做自动重连——Dialog 关闭时控制流自然断，顺带让服务端感知客户端离开）。
  app.get('/ws/desktop', { websocket: true }, async (socket, req) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const id = q.id;
    const w = Math.min(Math.max(Number(q.w) || 1280, 640), 2560);
    const h = Math.min(Math.max(Number(q.h) || 800, 480), 1600);
    if (!id) {
      socket.close(1008, 'missing container id');
      return;
    }
    try {
      await resolveTarget(cfg, id);
    } catch (e) {
      socket.close(1008, e instanceof Error ? e.message : 'container unavailable');
      return;
    }

    try {
      await ensureDesktop(cfg, id, w, h, (m) => sendJson(socket, { type: 'progress', message: m }));
      sendJson(socket, { type: 'ready' });
    } catch (e) {
      sendJson(socket, { type: 'error', message: e instanceof Error ? e.message : String(e) });
      socket.close(1011, 'desktop ensure failed');
      return;
    }
    // ready 后此连接静默挂着，前端关闭 Dialog 时断开即可（无服务端收尾动作）。
  });

  // —— RFB 透传：纯二进制，net.connect 到容器 5901 ——
  app.get('/ws/desktop-vnc', { websocket: true }, async (socket, req) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const id = q.id;
    if (!id) {
      socket.close(1008, 'missing container id');
      return;
    }
    let host = '';
    try {
      host = (await resolveTarget(cfg, id)).ip;
    } catch (e) {
      socket.close(1008, e instanceof Error ? e.message : 'container unavailable');
      return;
    }
    // 桌面没起就直连（前端没先走控制流）：不 ensure，直接报错——协议要求先 ready 再连。
    if (!desktopReady.has(id) && !(await desktopAlive(cfg, id))) {
      socket.close(1008, 'desktop not started');
      return;
    }

    const vnc = tcpConnect({ host, port: VNC_PORT }, () => {
      log.info({ id, host }, 'desktop rfb proxy established');
    });
    vnc.on('error', (err) => {
      log.warn({ id, err: String(err) }, 'desktop rfb proxy error');
      try {
        socket.close(1011, 'vnc connection failed');
      } catch {
        /* noop */
      }
    });
    vnc.on('close', () => {
      // 桌面进程还活着（只是代理断了）；下次连接 desktopAlive 会重新核实。
      try {
        socket.close();
      } catch {
        /* noop */
      }
    });
    vnc.on('data', (chunk) => {
      if (socket.readyState === socket.OPEN) socket.send(chunk);
    });
    socket.on('message', (data: Buffer) => {
      if (vnc.writable) vnc.write(data);
    });
    socket.on('close', () => {
      // 只断代理，不动容器内桌面（重开 Dialog 秒连复用）。
      vnc.destroy();
    });
    // TCP 半开兜底：OS keepalive 探死连接，不设应用层空闲断开（长时观察桌面是合法场景）。
    vnc.setKeepAlive(true, 30_000);
  });
}

// 导出给测试/诊断用：判断容器桌面是否已在跑。
export async function isDesktopRunning(cfg: Config, id: string): Promise<boolean> {
  return desktopAlive(cfg, id);
}
