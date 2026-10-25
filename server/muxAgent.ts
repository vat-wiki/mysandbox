// msmux 回连端点（目标侧 agent 主动连入，不要求目标暴露入站端口）。
//
// 两个入口：
//   /ws/mux-agent     agent 注册 + 控制/数据多路复用（独立 muxToken）
//   /ws/mux-terminal  浏览器终端桥：把前端的 resize/输入/kill 转成 msmux 帧，
//                     把 agent 的已渲染历史和实时输出转回现有 Terminal.vue 协议
//
// 一个 agent 连接可承载多个 sid。控制请求带单调递增 id，响应按 id 关联；
// 终端数据帧与 title/cwd/foreground/exit 事件按 sid 直接路由。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { execRun } from './engine/index.js';
import { getVersion } from './version.js';
import { getMuxDeployInfo, getMuxDeployTargets, getSshTargets } from './state.js';
import { sshExec } from './sshChannel.js';
import { TERMID_RE, type TermSessionView } from './terminal.js';

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
// 参与连接时自动部署/升级的目标：host、LXC 容器、SSH 目标（docker 服务不参与，走 tmux）。
const AUTO_DEPLOY_TARGETS = /^host$|^(c|ssh):/;
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const KIND_JSON = 1;
const KIND_DATA = 2;
const KIND_PING = 3;

interface PendingControl {
  resolve: (response: MuxResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface MuxChannel {
  socket: WebSocket;
  target: string;
  name: string;
  sid: number | null;
  createdAt: number;
}

interface MuxSessionMeta {
  title?: string;
  cwd?: string;
  foreground?: string;
}

interface AgentRecord {
  target: string;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  protocol: number | null;
  appVersion: string | null;
  pid: number | null;
  remote: string;
  channels: Map<number, MuxChannel>;
  pending: Map<number, PendingControl>;
  nextControlId: number;
  control: Promise<void>;
  log: FastifyInstance['log'];
}

interface MuxResponse {
  id?: number;
  type: string;
  version?: number;
  app_version?: string;
  pid?: number;
  role?: string;
  message?: string;
  sid?: number;
  name?: string;
  cols?: number;
  rows?: number;
  history?: string;
  modes?: string;
  title?: string;
  cwd?: string;
  foreground?: string;
  sessions?: {
    name: string;
    attached: number;
    created_at: number;
    title?: string;
    cwd?: string;
    foreground?: string;
    alive?: boolean;
    last_seq?: number;
  }[];
}

interface DecodedFrame {
  kind: 'json' | 'data' | 'ping';
  json?: MuxResponse;
  sid?: number;
  data?: Buffer;
}

const agents = new Map<string, AgentRecord>();

// 目标侧凭据 = HMAC(muxToken, target)。muxToken 是宿主 master，绝不下发；
// 每个目标只拿到「只能注册自己 target」的派生 token——目标 A 无法冒充 host/B。
// 轮换 muxToken 即让全部目标旧 token 失效（重新部署 agent 即可）。
export function muxAgentToken(cfg: Config, target: string): string {
  if (!cfg.muxToken) return '';
  return createHmac('sha256', cfg.muxToken).update(`msmux-agent:v1:${target}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function requestToken(req: FastifyRequest): string {
  const h = req.headers['x-sandbox-token'];
  if (typeof h === 'string') return h;
  const q = req.query as Record<string, unknown> | undefined;
  return typeof q?.token === 'string' ? q.token : '';
}

function encodeJson(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  return Buffer.concat([Buffer.from([KIND_JSON]), body]);
}

function encodeData(sid: number, data: Buffer): Buffer {
  const head = Buffer.allocUnsafe(5);
  head[0] = KIND_DATA;
  head.writeUInt32BE(sid >>> 0, 1);
  return Buffer.concat([head, data]);
}

function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 1) return null;
  const kind = buf[0];
  if (kind === KIND_PING) return { kind: 'ping' };
  if (kind === KIND_JSON) {
    try {
      return { kind: 'json', json: JSON.parse(buf.subarray(1).toString('utf8')) as MuxResponse };
    } catch {
      return null;
    }
  }
  if (kind === KIND_DATA) {
    if (buf.length < 5) return null;
    return { kind: 'data', sid: buf.readUInt32BE(1), data: buf.subarray(5) };
  }
  return null;
}

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(value));
}

function sendBinary(socket: WebSocket, data: Buffer): void {
  if (socket.readyState === 1) socket.send(data);
}

function sendAgent(agent: AgentRecord, frame: Buffer): boolean {
  if (agent.socket.readyState !== 1) return false;
  agent.socket.send(frame);
  return true;
}

function sendAndWait(
  agent: AgentRecord,
  payload: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<MuxResponse> {
  return new Promise((resolve, reject) => {
    if (agent.socket.readyState !== 1) {
      reject(new Error('msmux agent is not connected'));
      return;
    }
    const id = agent.nextControlId++;
    const entry: PendingControl = {
      resolve,
      reject,
      timer: setTimeout(() => {
        agent.pending.delete(id);
        reject(new Error('msmux control timeout'));
      }, timeoutMs),
    };
    agent.pending.set(id, entry);
    const frame = encodeJson({ ...payload, id });
    agent.socket.send(frame, (error) => {
      if (!error) return;
      agent.pending.delete(id);
      clearTimeout(entry.timer);
      reject(error);
    });
  });
}

async function withControl<T>(agent: AgentRecord, fn: () => Promise<T>): Promise<T> {
  const previous = agent.control;
  let release!: () => void;
  agent.control = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function handleAgentMessage(agent: AgentRecord, buf: Buffer): void {
  agent.lastSeenAt = Date.now();
  const frame = decodeFrame(buf);
  if (!frame) return;
  if (frame.kind === 'ping') return;
  if (frame.kind === 'data') {
    const channel = frame.sid != null ? agent.channels.get(frame.sid) : undefined;
    if (channel && frame.data) sendBinary(channel.socket, Buffer.from(frame.data));
    return;
  }
  const response = frame.json;
  if (!response) return;

  if (response.type === 'hello') {
    agent.protocol = typeof response.version === 'number' ? response.version : agent.protocol;
    agent.appVersion = typeof response.app_version === 'string' && response.app_version
      ? response.app_version
      : agent.appVersion;
    agent.pid = typeof response.pid === 'number' ? response.pid : agent.pid;
    return;
  }
  if (response.type === 'title') {
    const channel = response.sid != null ? agent.channels.get(response.sid) : undefined;
    if (channel && response.title) sendJson(channel.socket, { type: 'title', text: response.title });
    return;
  }
  if (response.type === 'cwd' || response.type === 'foreground') {
    const channel = response.sid != null ? agent.channels.get(response.sid) : undefined;
    if (channel) {
      sendJson(channel.socket, {
        type: response.type,
        text: response.type === 'cwd' ? response.cwd ?? '' : response.foreground ?? '',
      });
    }
    return;
  }
  if (response.type === 'exit') {
    const channel = response.sid != null ? agent.channels.get(response.sid) : undefined;
    if (channel) {
      agent.channels.delete(response.sid!);
      sendJson(channel.socket, { type: 'exit', code: null });
      try { channel.socket.close(1000, 'session exited'); } catch { /* noop */ }
    }
    return;
  }

  const pending = response.id != null ? agent.pending.get(response.id) : undefined;
  if (pending) {
    agent.pending.delete(response.id!);
    clearTimeout(pending.timer);
    pending.resolve(response);
  } else {
    // resize/detach/kill 是 fire-and-forget：不带 id 的 ok/error 是它们的正常回执。
    // 带 id 却找不到 waiter 才真的可疑（响应超时后才到、或协议错位）。
    const level = response.id == null && (response.type === 'ok' || response.type === 'error')
      ? 'debug'
      : 'warn';
    agent.log[level]({ target: agent.target, type: response.type, id: response.id }, 'unsolicited msmux control response');
  }
}

async function attachChannel(
  agent: AgentRecord,
  channel: MuxChannel,
  opts: { cols: number; rows: number; shell: string; cwd?: string; create: boolean; resume: boolean },
): Promise<void> {
  const attach = {
    type: 'attach',
    name: channel.name,
    cols: opts.cols,
    rows: opts.rows,
    resume: opts.resume,
  };
  const response = await withControl(agent, async () => {
    let resp = await sendAndWait(agent, attach);
    if (opts.create && resp.type === 'error' && /no such session/i.test(resp.message ?? '')) {
      const created = await sendAndWait(agent, {
        type: 'new',
        name: channel.name,
        cwd: opts.cwd ?? null,
        argv: opts.shell ? [opts.shell] : [],
        env: [
          ['MSMUX_WEB', '1'],
          ['MYSANDBOX_WEB', '1'],
        ],
        cols: opts.cols,
        rows: opts.rows,
      });
      if (created.type === 'error') throw new Error(created.message ?? 'msmux create failed');
      resp = await sendAndWait(agent, attach);
    }
    return resp;
  });
  if (response.type !== 'attached' || typeof response.sid !== 'number') {
    throw new Error(response.message ?? 'msmux attach failed');
  }
  const sid = response.sid;
  channel.sid = sid;
  agent.channels.set(sid, channel);
  const history = Buffer.from(response.history ?? '', 'base64').toString('utf8');
  sendJson(channel.socket, { type: opts.resume ? 'history-delta' : 'history', text: history });
  // resume 补发终端输入模式（?1000/?1003/?1006 鼠标上报、?2004 括号粘贴等）：断线窗口内
  // app 可能改过模式，浏览器端 xterm 要重同步——触屏滚动的 SGR 滚轮转换依赖 xterm 的
  // mouseTrackingMode。首次 attach 的模式随首屏 Data 帧下发（daemon 侧拼好），不走这里。
  if (opts.resume && response.modes) {
    sendJson(channel.socket, {
      type: 'modes',
      text: Buffer.from(response.modes, 'base64').toString('utf8'),
    });
  }
  if (response.title) sendJson(channel.socket, { type: 'title', text: response.title });
  if (response.cwd) sendJson(channel.socket, { type: 'cwd', text: response.cwd });
  if (response.foreground) sendJson(channel.socket, { type: 'foreground', text: response.foreground });
}

export function agentForTarget(target: string): AgentRecord | undefined {
  return agents.get(target);
}

// 短轮询等 agent 上线：agent 侧每 2s 重试回连，服务重启等瞬断在这个窗口内自愈，
// 不值得直接触发重部署。超时返回 false（不抛错）。
async function waitForAgentQuiet(target: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!agents.get(target)) {
    if (Date.now() >= until) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return true;
}

export function sendAgentFrame(target: string, frame: Buffer): boolean {
  const agent = agents.get(target);
  return agent ? sendAgent(agent, frame) : false;
}

// —— 会话发现 / 结束（/api/terminal-sessions 的 msmux 段，routes.ts 组合）——
// 会话发现沿用 tmux 的思路：**查询时去源头枚举，不自维护清单**。
//   agent 在线 → 经 agent 问 daemon 的 list（轻，活动监测每拍都走这条）；
//   agent 回连断开但进程还活着（mysandbox 重启/网络抖动）→ 目标侧 daemon socket 仍在，
//     经既有执行通道跑 `msmux ls --json` 直接问（仅显式 includeOffline 的主动查询走，
//     不进活动监测/前台探测这类高频路径——那会每拍起 lxc exec / ssh exec）；
//   agent 进程死了（远端重启）→ socket 不在，命令失败，该目标降级为空——与 tmux
//     server 不在时的语义一致。
// 会话名沿用浏览器侧的 mysandbox-<termId> 约定，回复给前端的 termId 剥掉前缀后可直接
// 交给 /ws/mux-terminal?name=mysandbox-<termId> 重新 attach。
function termSessionOfMuxTarget(target: string): Pick<TermSessionView, 'kind' | 'containerId'> | null {
  if (target === 'host') return { kind: 'host' };
  const m = /^(c|s|ssh):(.+)$/.exec(target);
  if (!m) return null;
  return {
    kind: m[1] === 'c' ? 'container' : m[1] === 's' ? 'service' : 'ssh',
    containerId: m[2],
  };
}

const execFileAsync = promisify(execFile);
// host 部署的二进制固定路径（muxDeploy.ts deployHost 写入）。
const HOST_MUX_BIN = join(homedir(), '.mysandbox', 'mux', 'msmux');

function rowsFromSessions(
  target: string,
  where: Pick<TermSessionView, 'kind' | 'containerId'>,
  sessions: MuxResponse['sessions'],
): TermSessionView[] {
  const rows: TermSessionView[] = [];
  if (!sessions) return rows;
  for (const info of sessions) {
    if (info.alive === false) continue;
    const m = /^mysandbox-([A-Za-z0-9_-]{4,64})$/.exec(info.name);
    if (!m || !TERMID_RE.test(m[1])) continue;
    rows.push({
      kind: where.kind,
      containerId: where.containerId,
      termId: m[1],
      attached: Number(info.attached) || 0,
      created: Number(info.created_at) || 0,
      cwd: info.cwd || undefined,
      title: info.title || undefined,
      foreground: info.foreground || undefined,
      backend: 'msmux',
      target,
      lastSeq: Number(info.last_seq) || 0,
    });
  }
  return rows;
}

// 离线目标的目标侧枚举：按 target 种类挑执行通道跑 `msmux ls --json`（daemon 的
// Unix socket 就在目标上）。socket 路径推导（session.rs socket_path）：
//   有 XDG_RUNTIME_DIR → $XDG_RUNTIME_DIR/msmux/msmux.sock；否则 /tmp/msmux-<uid>.sock。
// 容器/宿主 agent 由 systemd 单元拉起、无 XDG_RUNTIME_DIR → /tmp 兜底；exec 侧用
// `env -u` 保持同款环境才命中同一个 socket。SSH 目标 agent 经 nohup（登录会话带
// XDG_RUNTIME_DIR）→ ssh 登录同样带，天然一致。
async function listOfflineTargetSessions(cfg: Config, target: string): Promise<TermSessionView[]> {
  const where = termSessionOfMuxTarget(target);
  if (!where) return [];
  let stdout = '';
  try {
    if (target === 'host') {
      stdout = (
        await execFileAsync(HOST_MUX_BIN, ['ls', '--json'], { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 })
      ).stdout;
    } else if (target.startsWith('c:')) {
      const r = await execRun(cfg, target.slice(2), {
        Cmd: ['sh', '-c', 'exec env -u XDG_RUNTIME_DIR /home/dev/.local/bin/msmux ls --json'],
        User: 'dev',
        WorkingDir: '/home/dev',
        timeoutMs: 8_000,
      });
      if (r.exitCode !== 0) return [];
      stdout = r.stdout;
    } else if (target.startsWith('ssh:')) {
      const t = (await getSshTargets()).find((x) => x.name === target.slice(4));
      if (!t) return [];
      const r = await sshExec(t, ['sh', '-c', 'exec "$HOME/.local/bin/msmux" ls --json'], 8_000);
      if (r.exitCode !== 0) return [];
      stdout = r.stdout;
    } else {
      return [];
    }
    return rowsFromSessions(target, where, JSON.parse(stdout) as MuxResponse['sessions']);
  } catch {
    return [];
  }
}

export async function listMuxSessions(
  cfg: Config,
  opts: { includeOffline?: boolean } = {},
): Promise<TermSessionView[]> {
  const online = [...agents.values()];
  const onlineTargets = new Set(online.map((a) => a.target));
  const tasks = online.map(async (agent): Promise<TermSessionView[]> => {
    const where = termSessionOfMuxTarget(agent.target);
    if (!where) return [];
    let response: MuxResponse;
    try {
      response = await withControl(agent, () => sendAndWait(agent, { type: 'list' }, 8_000));
    } catch {
      return [];
    }
    if (response.type !== 'sessions') return [];
    return rowsFromSessions(agent.target, where, response.sessions);
  });
  // 离线枚举只查部署过的目标（state.muxDeploys），已在线的跳过。
  if (opts.includeOffline) {
    for (const target of await getMuxDeployTargets()) {
      if (!onlineTargets.has(target)) tasks.push(listOfflineTargetSessions(cfg, target));
    }
  }
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

/** 单目标会话元数据（host cwd 轮询/分屏继承源 pane cwd 用；会话不存在返回 undefined）。 */
export async function muxSessionMeta(target: string, termId: string): Promise<MuxSessionMeta | undefined> {
  const agent = agents.get(target);
  if (!agent) return undefined;
  const response = await withControl(agent, () => sendAndWait(agent, { type: 'list' }, 8_000));
  if (response.type !== 'sessions' || !Array.isArray(response.sessions)) return undefined;
  const name = `mysandbox-${termId}`;
  const info = response.sessions.find((s) => s.name === name && s.alive !== false);
  return info ? { title: info.title, cwd: info.cwd, foreground: info.foreground } : undefined;
}

/** 当前在线的 msmux 目标（活动监测据此清理断线目标的旧会话状态）。 */
export function muxAgentTargets(): string[] {
  return [...agents.keys()];
}

export async function killMuxSession(cfg: Config, target: string, termId: string): Promise<void> {
  if (!TERMID_RE.test(termId)) throw new Error('invalid termId');
  if (!/^(host|c:[A-Za-z0-9][A-Za-z0-9_.-]{0,62}|s:[A-Za-z0-9][A-Za-z0-9_.-]{0,62}|ssh:[A-Za-z0-9][A-Za-z0-9_.-]{0,62})$/.test(target)) {
    throw new Error('invalid mux target');
  }
  const name = `mysandbox-${termId}`;
  const agent = agents.get(target);
  if (!agent) {
    // 离线兜底（与查询枚举同思路）：目标侧 daemon 还在（agent 回连断开）就经执行通道
    // 直接 kill；agent 进程死了会话本来已不存在，报错让前端提示即可。
    try {
      if (target === 'host') {
        await execFileAsync(HOST_MUX_BIN, ['kill', name], { timeout: 8_000 });
      } else if (target.startsWith('c:')) {
        const r = await execRun(cfg, target.slice(2), {
          Cmd: ['sh', '-c', `exec env -u XDG_RUNTIME_DIR /home/dev/.local/bin/msmux kill ${JSON.stringify(name)}`],
          User: 'dev',
          WorkingDir: '/home/dev',
          timeoutMs: 8_000,
        });
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'msmux kill failed');
      } else if (target.startsWith('ssh:')) {
        const t = (await getSshTargets()).find((x) => x.name === target.slice(4));
        if (!t) throw new Error(`SSH 目标 ${target.slice(4)} 不存在`);
        const r = await sshExec(t, ['sh', '-c', `exec "$HOME/.local/bin/msmux" kill ${JSON.stringify(name)}`], 8_000);
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || 'msmux kill failed');
      } else {
        throw new Error('msmux agent not connected');
      }
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  const response = await withControl(agent, () =>
    sendAndWait(agent, { type: 'kill', name }, 8_000),
  );
  if (response.type === 'error') throw new Error(response.message ?? 'msmux kill failed');
}

export async function registerMuxAgent(app: FastifyInstance, cfg: Config): Promise<void> {
  app.get('/ws/mux-agent', {
    websocket: true,
    // 在 upgrade 前完成鉴权：token 错误时 agent 直接拿到 401，
    // 不会出现「握手成功、随即被 1008 关闭」的假连接状态。
    preValidation: async (req, reply) => {
      const headerTarget = req.headers['x-msmux-target'];
      if (typeof headerTarget !== 'string' || !TARGET_RE.test(headerTarget)) {
        return reply.code(400).send({
          error: { code: 'bad_request', message: 'invalid mux target' },
        });
      }
      if (!safeEqual(requestToken(req), muxAgentToken(cfg, headerTarget))) {
        return reply.code(401).send({
          error: { code: 'unauthorized', message: 'invalid mux token' },
        });
      }
    },
  }, (socket, req) => {
    const headerTarget = req.headers['x-msmux-target'];
    const target = typeof headerTarget === 'string' ? headerTarget : '';

    const previous = agents.get(target);
    if (previous && previous.socket !== socket) {
      // 替换日志：旧 socket 的 close 守卫（agents.get(target)?.socket !== socket）会静默跳过
      // "agent disconnected"，换连接不留痕——排查 agent 侧反复掉线重连（浏览器终端被连带
      // 1012 关闭、用户看到断连横幅风暴）时这里曾是盲区。
      app.log.info({ target, previousPid: previous.pid }, 'msmux agent replaced by newer connection');
      for (const channel of previous.channels.values()) {
        try { channel.socket.close(1012, 'agent replaced'); } catch { /* noop */ }
      }
      try { previous.socket.close(1012, 'replaced by newer agent'); } catch { /* noop */ }
    }
    const record: AgentRecord = {
      target,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      protocol: null,
      appVersion: null,
      pid: null,
      remote: req.socket.remoteAddress ?? 'unknown',
      channels: new Map(),
      pending: new Map(),
      nextControlId: 1,
      control: Promise.resolve(),
      log: app.log,
    };
    agents.set(target, record);
    app.log.info({ target, remote: record.remote }, 'msmux agent connected');

    socket.on('message', (data: unknown, isBinary?: boolean) => {
      if (!isBinary) return;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      handleAgentMessage(record, buf);
    });
    const cleanup = () => {
      if (agents.get(target)?.socket !== socket) return;
      agents.delete(target);
      for (const pending of record.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('msmux agent disconnected'));
      }
      record.pending.clear();
      for (const channel of record.channels.values()) {
        try { channel.socket.close(1011, 'msmux agent disconnected'); } catch { /* noop */ }
      }
      record.channels.clear();
      app.log.info({ target }, 'msmux agent disconnected');
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  app.get('/ws/mux-terminal', { websocket: true }, async (socket, req) => {
    if (req.sandboxIdentity?.kind !== 'owner') {
      try { socket.close(1008, 'owner only'); } catch { /* noop */ }
      return;
    }
    const q = (req.query as Record<string, string | undefined>) || {};
    const target = q.target ?? '';
    if (!TARGET_RE.test(target)) {
      try { socket.close(1008, 'invalid mux target'); } catch { /* noop */ }
      return;
    }
    let agent = agents.get(target);
    if (!agent) {
      // agent 不在线：先给一个重连宽限窗（agent 侧每 2s 重试回连，服务重启等瞬断
      // 自己会好），仍不在线且目标支持时做连接时自动部署（见 autoDeployMuxAgent）；
      // 都拿不到再按原样发 error 帧关连接。
      let settled = await waitForAgentQuiet(target, 3_000);
      if (!settled && cfg.mux.autoDeploy && AUTO_DEPLOY_TARGETS.test(target)) {
        try {
          // 动态 import：muxDeploy.ts 静态 import 本模块（muxAgentToken/agentForTarget），
          // 反向引用会成环；部署只在缺 agent/升级时发生，运行时拉起没有问题。
          const { autoDeployMuxAgent } = await import('./muxDeploy.js');
          app.log.info({ target }, 'msmux auto deploy: agent offline, deploying');
          const result = await autoDeployMuxAgent(cfg, target);
          app.log.info({ target, connected: result.connected }, 'msmux auto deploy done');
          settled = result.connected;
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          app.log.warn({ target, message }, 'msmux auto deploy failed');
          sendJson(socket, { type: 'error', message: `msmux 自动部署失败：${message}` });
          try { socket.close(1011, 'msmux auto deploy failed'); } catch { /* noop */ }
          return;
        }
      }
      agent = settled ? agents.get(target) : undefined;
      if (!agent) {
        // 先发 error 帧（浏览器端会消费并显示）再关——close code 本身到不了页面的
        // onclose 参数，只发 close 用户只能看到无来由的「已断开 (1011)」。
        sendJson(socket, {
          type: 'error',
          message: 'msmux agent 未连接：请检查目标侧 agent（mysandbox mux agents）',
        });
        try { socket.close(1011, 'msmux agent not connected'); } catch { /* noop */ }
        return;
      }
    } else if (cfg.mux.autoDeploy && AUTO_DEPLOY_TARGETS.test(target)) {
      // agent 在线：升级判断——部署记录的 sha256 与当前二进制不同（或无记录时
      // app_version ≠ 控制台版本，老 agent 未上报版本也视为旧）= 目标侧跑的不是
      // 当前那份 → 重部署替换。升级失败不阻塞连接，继续用旧 agent。
      try {
        const { autoDeployMuxAgent, currentBinarySha256 } = await import('./muxDeploy.js');
        const rec = await getMuxDeployInfo(target).catch(() => undefined);
        const stale = rec?.sha256
          ? (await currentBinarySha256()) !== rec.sha256
          : agent.appVersion !== getVersion();
        if (stale) {
          app.log.info({ target, from: agent.appVersion ?? '?' }, 'msmux auto upgrade: redeploying');
          const result = await autoDeployMuxAgent(cfg, target);
          app.log.info({ target, connected: result.connected }, 'msmux auto upgrade done');
          agent = agents.get(target) ?? agent;
        }
      } catch (e) {
        app.log.warn(
          { target, message: e instanceof Error ? e.message : String(e) },
          'msmux auto upgrade failed',
        );
      }
    }
    const termId = q.termId ?? '';
    const name = q.name || (termId ? `mysandbox-${termId}` : '');
    if (!SESSION_RE.test(name)) {
      sendJson(socket, { type: 'error', message: '会话名非法（termId 格式错误）' });
      try { socket.close(1008, 'invalid session name'); } catch { /* noop */ }
      return;
    }
    const channel: MuxChannel = {
      socket,
      target,
      name,
      sid: null,
      createdAt: Date.now(),
    };
    const cols = Math.max(1, Number(q.cols) || 120);
    const rows = Math.max(1, Number(q.rows) || 40);
    // 没传 shell 时让目标侧 agent 用它的 $SHELL（SSH 远端常用 bash；容器/宿主终端
    // 仍显式传 zsh/bash）。
    const shell = q.shell || '';
    const create = q.create !== '0';
    const resume = q.resume === '1';
    const fromTermId = q.from ?? '';
    let cwd = q.cwd;
    if (fromTermId && TERMID_RE.test(fromTermId)) {
      cwd = (await muxSessionMeta(target, fromTermId).catch(() => undefined))?.cwd || cwd;
    }

    socket.on('message', (data: unknown, isBinary?: boolean) => {
      const sid = channel.sid;
      if (isBinary !== false && sid != null) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        sendAgent(agent, encodeData(sid, buf));
        return;
      }
      if (typeof data !== 'string' && !Buffer.isBuffer(data)) return;
      let msg: { type?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse((typeof data === 'string' ? data : data.toString()).toString()) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === 'resize' && sid != null) {
        sendAgent(agent, encodeJson({
          type: 'resize',
          sid,
          cols: Math.max(1, msg.cols ?? cols),
          rows: Math.max(1, msg.rows ?? rows),
        }));
      } else if (msg.type === 'detach' && sid != null) {
        sendAgent(agent, encodeJson({ type: 'detach', sid }));
        agent.channels.delete(sid);
        channel.sid = null;
        try { socket.close(1000, 'detached'); } catch { /* noop */ }
      } else if (msg.type === 'kill') {
        sendAgent(agent, encodeJson({ type: 'kill', name }));
        if (sid != null) sendAgent(agent, encodeJson({ type: 'detach', sid }));
      }
    });
    socket.on('close', () => {
      if (channel.sid != null) {
        sendAgent(agent, encodeJson({ type: 'detach', sid: channel.sid }));
        agent.channels.delete(channel.sid);
      }
    });
    socket.on('error', () => {
      if (channel.sid != null) {
        sendAgent(agent, encodeJson({ type: 'detach', sid: channel.sid }));
        agent.channels.delete(channel.sid);
      }
    });

    try {
      await attachChannel(agent, channel, {
        cols,
        rows,
        shell,
        cwd,
        create,
        resume,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(socket, { type: 'error', message });
      try { socket.close(1011, 'msmux attach failed'); } catch { /* noop */ }
    }
  });

  app.get('/api/mux/agents', async (req, reply) => {
    if (req.sandboxIdentity?.kind !== 'owner') {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'owner only' },
      });
    }
    return {
      agents: [...agents.values()].map((a) => ({
        target: a.target,
        connectedAt: a.connectedAt,
        lastSeenAt: a.lastSeenAt,
        protocol: a.protocol,
        appVersion: a.appVersion,
        pid: a.pid,
        remote: a.remote,
        channels: a.channels.size,
      })),
    };
  });

  app.get('/api/mux/agents/:target/sessions', async (req, reply) => {
    if (req.sandboxIdentity?.kind !== 'owner') {
      return reply.code(403).send({
        error: { code: 'forbidden', message: 'owner only' },
      });
    }
    const target = (req.params as { target?: string }).target ?? '';
    const agent = agents.get(target);
    if (!agent) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'msmux agent not connected' },
      });
    }
    try {
      const response = await withControl(agent, () => sendAndWait(agent, { type: 'list' }));
      return response;
    } catch (e) {
      return reply.code(502).send({
        error: { code: 'agent_error', message: e instanceof Error ? e.message : String(e) },
      });
    }
  });
}
