// Agent 精准空闲提醒：通用「输出安静」启发式（activity.ts）对 agent 会话误报率高——
// agent 干活的 TUI 重绘/思考停顿与「干完活」在输出层面无法区分。而 claude/codex/
// opencode/pi 都有官方的回合完成/等权限回调（claude hooks Stop+Notification、codex
// notify agent-turn-complete、opencode session.idle 插件、pi agent_settled 扩展），
// 这里把它们接进来：
//
//   agent CLI 的 hook/插件 → 种子脚本 agent-notify.mjs（$TMUX_PANE 反查 tmux 会话名）
//     → peer API POST /notify（peer.ts，x-peer-token 统一鉴权）
//     → 本模块记 waiting / agentSeen → GET /api/terminal-activity 一并下发
//     → 前端 ContainerList：有 waiting 的组精准挂标；收到过信号的会话整体退出启发式。
//
// 配置写入器走宿主直写 rootfs（D1 uid 直通，容器不必在跑；本机 = 同套 writer 的另一个
// base，与 aiconfig.ts 同思路），落点与所有权：
//   - claude    .claude/settings.json 的 hooks.Stop / hooks.Notification——只增删 command
//               含 agent-notify.mjs 特征的条目，用户自己的 hooks 零接触
//   - codex     .codex/config.toml 顶层 notify——单值键，用户自装（值不含特征）不抢
//   - opencode  .config/opencode/plugin/msb-notify.js——独立文件，整文件 owned
//   - pi        .pi/agent/extensions/msb-notify.js——同上
// 触发链路：启动 sweep（cli.ts）+ 建容器补发（lifecycle.ts）+ 容器 start 事件补发。
// 容器内的种子（agent-notify.mjs + peer.json 的 self 字段）在 container-cli.ts/peer.ts。
// 事件语义与「回合恢复清除」的竞态推导见 noteOutput / OUTPUT_GRACE_MS 注释。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pLimit from 'p-limit';
import type { Config } from './config.js';
import { HOST_TARGET } from './state.js';
import { allTargets, homeOf, tomlSetTopLevel } from './aiconfig.js';
import { getEngine, listManaged, subscribeEvents } from './engine/index.js';
import { gatewayOf } from './network.js';
import { log } from './logger.js';

// —— 种子脚本（容器与宿主同一份；writeIfChanged 自更新）——

// agent-notify.mjs：hook/插件 → 宿主 peer API 的回调内核。纯 ESM、不用模板字符串/
// 反斜杠转义惯例之外注意：本文件内嵌的脚本正则里的 \x 需写成 \\x（TS 模板字面量转义）。
export const AGENT_NOTIFY_SCRIPT = `#!/usr/bin/env node
// mysandbox agent 通知钩子（宿主 mysandbox 种子写入，内容变更会自动覆盖——勿手改）。
// 用法: node agent-notify.mjs <agent> <event> [message] [--stdin]
//   claude       hooks 生成 stop / notify --stdin 两条命令（stdin 收 hook JSON 取 .message）
//   codex        notify 程序（事件 JSON 追加为末位 argv，type 剥 'agent-' 前缀透传）
//   opencode/pi  插件薄壳 spawn 本脚本传 event
// 行为：读 peer.json → $TMUX_PANE 反查 tmux 会话名 → POST peer /notify。
// 铁律：永不非零退出、永不写 stdout/stderr——对 agent 完全透明（claude hook exit 2
// 才会打断回合；exit 0 + 无输出 = 无感）。总闸 3s，POST 超时 2s。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { basename } from 'node:path';

const HOME = process.env.HOME || '/home/dev';
let peer = null;
try { peer = JSON.parse(readFileSync(HOME + '/.config/mysandbox/peer.json', 'utf8')); } catch {}

// stdin 读 hook JSON（race 500ms——stdin 不关也不能挂住 hook）。
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 500);
  });
}

// tmux 会话名反查。socket 必须从 $TMUX 首字段推——宿主终端在 -L mysandbox-host 专用
// socket 上，裸 tmux 查默认 socket 查空（容器内才是 default）。
function sessionName() {
  const sock = basename(String(process.env.TMUX).split(',')[0] || '');
  const prefix = sock && sock !== 'default' ? ['-L', sock] : [];
  return execFileSync(
    'tmux',
    [...prefix, 'display-message', '-p', '-t', process.env.TMUX_PANE, '#{session_name}'],
    { timeout: 2000, encoding: 'utf8' },
  ).trim();
}

async function main() {
  const args = process.argv.slice(2);
  const agent = args[0] || '';
  let event = args[1] || '';
  let message = args[2] && !args[2].startsWith('--') ? args[2] : '';
  if (!agent || !peer || !peer.url) return;
  // 不在 tmux 里 = 不在 mysandbox 终端（别处跑的 agent 没有可归属的会话），静默。
  if (!process.env.TMUX || !process.env.TMUX_PANE) return;
  // codex：事件 JSON 是追加的 argv——逐个尝试解析，取含 type 的项。未知 type 原样
  // 透传（剥 'agent-' 前缀），codex 未来新增事件类型零改动生效。
  for (const a of args) {
    if (a.startsWith('--')) continue;
    try {
      const j = JSON.parse(a);
      if (j && typeof j === 'object' && typeof j.type === 'string') {
        event = j.type.replace(/^agent-/, '');
        if (!message) message = String(j['last-assistant-message'] || j.message || '');
      }
    } catch {}
  }
  if (args.includes('--stdin')) {
    try {
      const j = JSON.parse(await readStdin());
      if (j && typeof j === 'object' && !message) message = String(j.message || '');
    } catch {}
  }
  if (!event) return;
  message = message.replace(/[\\x00-\\x1f\\x7f]+/g, ' ').slice(0, 300);
  let session;
  try { session = sessionName(); } catch { return; }
  const body = JSON.stringify({
    session,
    agent,
    event,
    ...(message ? { message } : {}),
    ...(peer.self ? { self: peer.self } : {}),
  });
  await new Promise((resolve) => {
    let u;
    try { u = new URL(peer.url); } catch { resolve(); return; }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: '/notify',
        method: 'POST',
        headers: {
          'x-peer-token': peer.token || '',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.setTimeout(2000, () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.write(body);
    req.end();
  });
}

main().catch(() => {});
// 总闸：任何路径 3s 内退出（stdin 不关 / POST 黑洞都拖不住 agent 的 hook）。
setTimeout(() => process.exit(0), 3000);
`;

// opencode 插件（薄壳）：命中事件 spawn 内核脚本，detached 不阻塞 opencode 本体。
export const OPENCODE_PLUGIN_SCRIPT = `// mysandbox 通知插件（宿主 mysandbox 写入，内容变更会自动覆盖——勿手改）。
// session.idle / session.error → spawn agent-notify.mjs（回合收尾/出错提醒）。
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const script = homedir() + '/.config/mysandbox/agent-notify.mjs'

export const MsbNotify = async () => ({
  event: async ({ event }) => {
    try {
      if (event.type !== 'session.idle' && event.type !== 'session.error') return
      const ev = event.type === 'session.idle' ? 'idle' : 'error'
      spawn(process.execPath, [script, 'opencode', ev], { stdio: 'ignore', detached: true }).unref()
    } catch {}
  },
})
`;

// pi 扩展（薄壳，ExtensionFactory 形态）：agent_settled = 回合收尾且无重试/压缩/排队
// 续跑（aborted = 用户主动打断，不打扰）。
export const PI_EXTENSION_SCRIPT = `// mysandbox 通知扩展（宿主 mysandbox 写入，内容变更会自动覆盖——勿手改）。
// agent_settled → spawn agent-notify.mjs（回合收尾提醒；用户打断的不报）。
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

const script = homedir() + '/.config/mysandbox/agent-notify.mjs'

export default function (pi) {
  pi.on('agent_settled', (event) => {
    try {
      if (!event || event.aborted) return
      spawn(process.execPath, [script, 'pi', 'settled'], { stdio: 'ignore', detached: true }).unref()
    } catch {}
  })
}
`;

// —— 状态（进程内，同 activity.ts 不持久化：重启即丢，下次 notify 自动重建）——

export interface AgentWaitingView {
  kind: 'host' | 'container';
  containerId?: string;
  termId: string;
  agent: string;
  event: string;
  message?: string;
  agoSeconds: number;
}

interface Waiting {
  agent: string;
  event: string;
  message?: string;
  at: number;
}

// key 与 activity.ts 的 entries 同构：`${kind}|${containerId}|${termId}`（routes/activity
// 两处拼 key 共用这个，防三处手拼漂移）。
export const agentKeyOf = (kind: 'host' | 'container', cid: string, termId: string): string =>
  `${kind}|${cid}|${termId}`;

const WAITING_TTL_MS = 6 * 60 * 60 * 1000; // waiting 兜底 TTL（懒清扫）
const SEEN_TTL_MS = 48 * 60 * 60 * 1000; // agentSeen 标记 TTL（懒清扫）
// 输出清除宽限：hook 在回答/权限提示**渲染之后**才触发，扫描（5s 拍）会紧随其后检测
// 到那段输出的 hash 变化——见输出即清会把刚挂上的 waiting 秒杀。只清宽限期外的输出
// 变化（真恢复干活必然持续重绘，跨过宽限）。
const OUTPUT_GRACE_MS = 25_000;

const waiting = new Map<string, Waiting>();
// agentSeen：收到过任意 notify 的会话标记，随 activity items 下发 `agent` 字段——前端
// 据此整体退出通用启发式（精准信号接管：没 waiting = agent 在干活或已消费，不提醒）。
const agentSeen = new Map<string, { agent: string; lastAt: number }>();

function sweepTtl(now: number): void {
  for (const [k, w] of waiting) if (now - w.at > WAITING_TTL_MS) waiting.delete(k);
  for (const [k, s] of agentSeen) if (now - s.lastAt > SEEN_TTL_MS) agentSeen.delete(k);
}

function remember(key: string, agent: string, event: string, message: string | undefined, now: number): void {
  waiting.set(key, { agent, event, ...(message ? { message } : {}), at: now });
  agentSeen.set(key, { agent, lastAt: now });
}

const NOTIFY_AGENTS = new Set(['claude', 'codex', 'opencode', 'pi']);
// 会话名形状与 activity.ts 的 termIdOf 同构（宿主 / 容器前缀）。形状不符 = 不是
// mysandbox 终端（用户自建 tmux 里跑的 agent），丢弃。
const HOST_NAME_RE = /^(?:mysandbox-host|h)-([A-Za-z0-9_-]{4,64})$/;
const CT_NAME_RE = /^(?:mysandbox|ms)-([A-Za-z0-9_-]{1,8})-([A-Za-z0-9_-]{4,64})$/;
// case 模式里的 glob 元字符按单字符通配处理（adopted 容器名不受 NAME_RE 约束）——
// 与 activity.ts 的 globSafe 同款（复制不共用：避免 activity ↔ agentNotify 循环依赖）。
const globSafe = (s: string): string => s.replace(/[*?[\]\\]/g, '?');

// peer.ts 的 POST /notify 落点。校验/反解任一步不过 = 静默丢弃（只留 debug 日志），
// 永不抛——hook 侧不重试，丢了等下一次事件。
export async function recordAgentNotify(cfg: Config, body: unknown): Promise<void> {
  try {
    if (!cfg.terminal.agentNotify) return;
    if (!body || typeof body !== 'object') return;
    const b = body as Record<string, unknown>;
    const session = typeof b.session === 'string' ? b.session : '';
    const agent = typeof b.agent === 'string' ? b.agent : '';
    const event = typeof b.event === 'string' ? b.event : '';
    const message = typeof b.message === 'string' ? b.message.slice(0, 400) : undefined;
    const self = typeof b.self === 'string' ? b.self.slice(0, 200) : undefined;
    if (!session || session.length > 200 || !event || event.length > 40 || !NOTIFY_AGENTS.has(agent)) return;
    const now = Date.now();
    sweepTtl(now);

    const hm = HOST_NAME_RE.exec(session);
    if (hm) {
      remember(agentKeyOf('host', '', hm[1]), agent, event, message, now);
      return;
    }
    const cm = CT_NAME_RE.exec(session);
    if (!cm) {
      log.debug({ session, agent }, 'agent notify: unmatched session, dropped');
      return;
    }
    // 容器侧反解：peer.json 的 self（种子时烙进容器的容器名）权威；缺失/校验不过回退
    // 短 id 反查 listManaged（唯一命中才认——短 id 定长锚定消歧，同 activity.ts 思路）。
    let names: string[] = [];
    try {
      names = (await listManaged(cfg)).map((v) => v.id);
    } catch {
      return; // 引擎不可用：丢弃（waiting 是状态制，下次事件自动重建）
    }
    const short = globSafe(cm[1]);
    let name: string | null = null;
    if (self && names.includes(self) && globSafe(self.slice(0, 8)) === short) {
      name = self;
    } else {
      const hits = names.filter((n) => globSafe(n.slice(0, 8)) === short);
      if (hits.length === 1) name = hits[0];
      else log.debug({ session, self, hits: hits.length }, 'agent notify: container ambiguous, dropped');
    }
    if (!name) return;
    remember(agentKeyOf('container', name, cm[2]), agent, event, message, now);
  } catch (e) {
    log.debug({ err: String(e) }, 'agent notify record failed');
  }
}

// activity.ts 扫到该会话有新输出时调：只清宽限期外的 waiting（见 OUTPUT_GRACE_MS 注释）。
export function noteOutput(key: string, now: number): void {
  const w = waiting.get(key);
  if (w && now - w.at >= OUTPUT_GRACE_MS) waiting.delete(key);
}

// 会话消失（activity 清理循环）时把两张表一起清，防容器消亡后残留。
export function forgetSession(key: string): void {
  waiting.delete(key);
  agentSeen.delete(key);
}

// routes.ts 下发：items 的 agent 注记（有 = 该会话退出启发式）。
export function agentSeenOf(key: string): string | undefined {
  const s = agentSeen.get(key);
  if (!s) return undefined;
  if (Date.now() - s.lastAt > SEEN_TTL_MS) {
    agentSeen.delete(key);
    return undefined;
  }
  return s.agent;
}

// routes.ts 下发：agentWaiting 数组（前端精准挂标的唯一依据）。
export function agentWaitingView(): AgentWaitingView[] {
  const now = Date.now();
  sweepTtl(now);
  const out: AgentWaitingView[] = [];
  for (const [key, w] of waiting) {
    const [kind, cid, termId] = key.split('|');
    out.push({
      kind: kind as 'host' | 'container',
      containerId: cid || undefined,
      termId,
      agent: w.agent,
      event: w.event,
      ...(w.message ? { message: w.message } : {}),
      agoSeconds: Math.max(0, Math.floor((now - w.at) / 1000)),
    });
  }
  return out;
}

// —— 配置写入器（宿主直写 rootfs；writeIfChanged 幂等，单工具失败不拖垮其它）——

// 内容没变就不写；变了覆盖（自更新，与 container-cli.ts 的 writeIfChanged 同语义）。
function writeIfChanged(target: string, content: string, mode: number): void {
  try {
    if (readFileSync(target, 'utf8') === content) return;
  } catch {
    // 不存在：落到下面的 writeFileSync。
  }
  mkdirSync(join(target, '..'), { recursive: true, mode: 0o755 });
  writeFileSync(target, content, { mode });
}

// 本特征串 = 「这条配置是 mysandbox 写的」的所有权判据（claude 条目 / codex notify 值）。
const OWNED_MARKER = 'agent-notify.mjs';

// claude hooks：settings.json 的 hooks.Stop / hooks.Notification 各保证恰好一条我们的
// 条目（command 含 OWNED_MARKER 即认领），同特征残条目剔除，用户条目零接触。
// 坏 JSON 跳过不写——不能 {} 重建覆盖用户的 settings（与 aiconfig readJsonObject 同口径）。
function applyClaudeHooks(home: string, notes: string[]): void {
  const p = join(home, '.claude/settings.json');
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    obj = parsed as Record<string, unknown>;
  } catch {
    if (existsSync(p)) notes.push('claude settings.json 坏 JSON，跳过');
    return;
  }
  const before = JSON.stringify(obj);
  const hooks = (obj.hooks && typeof obj.hooks === 'object' && !Array.isArray(obj.hooks)
    ? { ...(obj.hooks as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  for (const [key, ev] of [
    ['Stop', 'stop'],
    ['Notification', 'notify'],
  ] as const) {
    const arr = Array.isArray(hooks[key]) ? (hooks[key] as unknown[]).filter((e) => !isOwnedHookEntry(e)) : [];
    arr.push({
      hooks: [
        {
          type: 'command',
          command: 'node "$HOME/.config/mysandbox/agent-notify.mjs" claude ' + ev + ' --stdin',
          timeout: 10,
        },
      ],
    });
    hooks[key] = arr;
  }
  obj.hooks = hooks;
  if (JSON.stringify(obj) === before) return;
  mkdirSync(join(home, '.claude'), { recursive: true, mode: 0o755 });
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
}

function isOwnedHookEntry(e: unknown): boolean {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const hs = (e as Record<string, unknown>).hooks;
  if (!Array.isArray(hs)) return false;
  return hs.some(
    (h) => h && typeof h === 'object' && typeof (h as Record<string, unknown>).command === 'string' &&
      String((h as Record<string, unknown>).command).includes(OWNED_MARKER),
  );
}

// codex notify：config.toml 顶层 notify（单值键）。已存在且不含特征 = 用户自装，跳过
// 不抢；否则写入/覆盖。⚠️ 路径必须绝对——codex notify 是 exec 直调不经 shell，$HOME
// 不展开（claude hooks 走 sh 才能用 $HOME 通吃宿主/容器）。
function applyCodexNotify(home: string, notes: string[]): void {
  const p = join(home, '.codex/config.toml');
  let toml = '';
  try {
    toml = readFileSync(p, 'utf8');
  } catch {
    toml = ''; // 缺文件从空起步（只含 notify 一行，codex 其余键走默认）
  }
  const scopeEnd = toml.split('\n').findIndex((l) => l.trim().startsWith('[') && !l.trim().startsWith('#['));
  const topLines = scopeEnd === -1 ? toml.split('\n') : toml.split('\n').slice(0, scopeEnd);
  for (const l of topLines) {
    if (/^notify\s*=/.test(l.trim())) {
      if (!l.includes(OWNED_MARKER)) notes.push('codex notify 已被用户占用，跳过');
      return;
    }
  }
  const line = 'notify = ["node", ' + JSON.stringify(join(home, '.config/mysandbox/agent-notify.mjs')) + ', "codex"]';
  const next = tomlSetTopLevel(toml, 'notify', line);
  if (next === toml) return;
  mkdirSync(join(home, '.codex'), { recursive: true, mode: 0o755 });
  writeFileSync(p, next, { mode: 0o600 });
}

function enabled(cfg: Config): boolean {
  return cfg.terminal.agentNotify && !!cfg.peer?.enabled && !!cfg.peerToken;
}

// 单目标（本机 | 容器名）落全部四工具配置。容器的 peer.json（带 self）由
// seedContainerCli 负责，这里不碰；宿主的 peer.json（无 self）在这里落。
async function applyToTarget(cfg: Config, target: string): Promise<void> {
  const home = homeOf(cfg, target);
  if (!home || !existsSync(home)) return;
  const notes: string[] = [];
  writeIfChanged(join(home, '.config/mysandbox/agent-notify.mjs'), AGENT_NOTIFY_SCRIPT, 0o755);
  if (target === HOST_TARGET) {
    writeIfChanged(
      join(home, '.config/mysandbox/peer.json'),
      JSON.stringify({ url: 'http://' + gatewayOf(cfg) + ':' + cfg.peer!.port, token: cfg.peerToken }),
      0o600,
    );
  }
  applyClaudeHooks(home, notes);
  applyCodexNotify(home, notes);
  writeIfChanged(join(home, '.config/opencode/plugin/msb-notify.js'), OPENCODE_PLUGIN_SCRIPT, 0o755);
  writeIfChanged(join(home, '.pi/agent/extensions/msb-notify.js'), PI_EXTENSION_SCRIPT, 0o755);
  if (notes.length) log.info({ target, notes }, 'agent notify config notes');
}

// 启动 sweep（cli.ts 装配）：全部目标（本机 + 受管容器 + 模板——模板装了新容器克隆即带）。
// 声明独立于 AI 绑定：无绑定用户也要有精准提醒。
export async function sweepAgentNotify(cfg: Config): Promise<void> {
  if (!enabled(cfg)) return;
  let targets: string[] = [];
  try {
    targets = await allTargets(cfg);
  } catch (e) {
    log.warn({ err: String(e) }, 'agent notify sweep: list targets failed');
    return;
  }
  const limit = pLimit(4);
  const results = await Promise.all(
    targets.map((t) =>
      limit(async () => {
        try {
          await applyToTarget(cfg, t);
          return true;
        } catch (e) {
          log.warn({ target: t, err: String(e) }, 'agent notify apply failed');
          return false;
        }
      }),
    ),
  );
  log.info(
    { op: 'agent-notify', ok: results.filter(Boolean).length, failed: results.filter((r) => !r).length },
    'agent notify sweep done',
  );
}

// 建容器补发（lifecycle.create 后调用）：尽力而为不抛（失败靠下次 sweep / start 事件追平）。
export async function applyAgentNotifyToContainer(cfg: Config, name: string): Promise<void> {
  if (!enabled(cfg)) return;
  try {
    await applyToTarget(cfg, name);
    log.info({ container: name }, 'agent notify applied to container');
  } catch (e) {
    log.warn({ container: name, err: String(e) }, 'agent notify apply to container failed');
  }
}

// 容器 start/restart 事件补发（cli.ts 装配）：断线指数退避重连（ai-config 同款骨架）。
// ⚠️ debounce 4s 刻意比 aiconfig 的 start 事件补发（2s）晚——两边读-改-写同一批 home
// 下的 TOML/JSON，并发会互相覆盖（实测 aiconfig 会把本模块刚写的 codex notify 行冲掉），
// 错开让 aiconfig 的写先落地。
const notifyStartTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function startAgentNotifyEvents(cfg: Config): void {
  if (!enabled(cfg)) return;
  void (async () => {
    let delay = 1_000;
    for (;;) {
      try {
        const sub = await subscribeEvents(cfg, (ev) => {
          if (ev.action !== 'start' && ev.action !== 'restart') return;
          const id = ev.containerId;
          const t = notifyStartTimers.get(id);
          if (t) clearTimeout(t);
          notifyStartTimers.set(
            id,
            setTimeout(() => {
              notifyStartTimers.delete(id);
              void applyAgentNotifyToContainer(cfg, id);
            }, 4_000),
          );
        });
        delay = 1_000;
        log.info({ engine: getEngine(cfg).name }, 'agent notify event sync: subscribed');
        await sub.closed;
      } catch (e) {
        log.warn({ err: String(e), retryMs: delay }, 'agent notify event sync: subscribe failed, retrying');
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  })();
}
