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
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { Config } from './config.js';
import { TERMID_RE, type TermSessionView } from './terminal.js';

const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
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
  pid?: number;
  role?: string;
  message?: string;
  sid?: number;
  name?: string;
  cols?: number;
  rows?: number;
  history?: string;
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
  if (response.title) sendJson(channel.socket, { type: 'title', text: response.title });
  if (response.cwd) sendJson(channel.socket, { type: 'cwd', text: response.cwd });
  if (response.foreground) sendJson(channel.socket, { type: 'foreground', text: response.foreground });
}

export function agentForTarget(target: string): AgentRecord | undefined {
  return agents.get(target);
}

export function sendAgentFrame(target: string, frame: Buffer): boolean {
  const agent = agents.get(target);
  return agent ? sendAgent(agent, frame) : false;
}

// —— 会话发现 / 结束（/api/terminal-sessions 的 msmux 段，routes.ts 组合）——
// agent 在线时直接问它 daemon 的 list；单个 agent 超时/断线只丢该目标，不影响 tmux 段。
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

export async function listMuxSessions(): Promise<TermSessionView[]> {
  const settled = await Promise.allSettled(
    [...agents.values()].map(async (agent): Promise<TermSessionView[]> => {
      const where = termSessionOfMuxTarget(agent.target);
      if (!where) return [];
      let response: MuxResponse;
      try {
        response = await withControl(agent, () => sendAndWait(agent, { type: 'list' }, 8_000));
      } catch {
        return [];
      }
      if (response.type !== 'sessions' || !Array.isArray(response.sessions)) return [];
      const rows: TermSessionView[] = [];
      for (const info of response.sessions) {
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
          target: agent.target,
          lastSeq: Number(info.last_seq) || 0,
        });
      }
      return rows;
    }),
  );
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}

/** 单目标会话元数据（分屏继承源 pane cwd 用；会话不存在返回 undefined）。 */
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

export async function killMuxSession(target: string, termId: string): Promise<void> {
  if (!TERMID_RE.test(termId)) throw new Error('invalid termId');
  if (!/^(host|c:[A-Za-z0-9][A-Za-z0-9_.-]{0,62}|s:[A-Za-z0-9][A-Za-z0-9_.-]{0,62}|ssh:[A-Za-z0-9][A-Za-z0-9_.-]{0,62})$/.test(target)) {
    throw new Error('invalid mux target');
  }
  const agent = agents.get(target);
  if (!agent) throw new Error('msmux agent not connected');
  const response = await withControl(agent, () =>
    sendAndWait(agent, { type: 'kill', name: `mysandbox-${termId}` }, 8_000),
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
    const agent = agents.get(target);
    if (!agent) {
      // 先发 error 帧（浏览器端会消费并显示）再关——close code 本身到不了页面的
      // onclose 参数，只发 close 用户只能看到无来由的「已断开 (1011)」。
      sendJson(socket, { type: 'error', message: 'msmux agent 未连接：请先在 设置 → 终端后端 部署/重连该目标' });
      try { socket.close(1011, 'msmux agent not connected'); } catch { /* noop */ }
      return;
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
