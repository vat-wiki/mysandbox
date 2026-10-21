// Web Push 站外推送：「agent 等输入」的移动端通道。浏览器通知（lib/browserNotify，
// 页面内 new Notification）依赖页面活着——移动端 Chrome 对后台 tab 降频/冻结，agent
// 干完活的时刻页面多半没在跑，in-page 通知在移动端先天残废。推送经系统通道下发，
// 页面没开/冻结也照收，是平台为此设计的唯一通道。触发源是服务端已有的权威信号：
// agentNotify 的 waiting 表（hook POST /notify 落点），不依赖任何活着的前端。
//
// 组成：
//   - VAPID 密钥：首用生成，与订阅底账同存 ~/.mysandbox/push.json（0600）
//   - 订阅：前端 pushManager.subscribe 后 POST /api/push/subscribe 登记；端点失效
//     （404/410，浏览器重置/订阅过期）发送时顺带清除
//   - 「在看」抑制：控制台页面可见时前端定时 POST /api/push/watching 心跳（30s TTL）；
//     心跳新鲜期内到达的 waiting 不推——用户在场，琥珀标足够。刻意的粗粒度：任何
//     一台设备的控制台可见都算「在场」——桌面上正看着，手机不该响。
//   - 去重（pushedKeys）：同一会话的 waiting 只推一次；noteOutput（agent 恢复干活）
//     或心跳（用户看过控制台）重置，下个回合完成再推。
// 范围：只推 agent 精准信号（waiting）——通用「无输出」启发式是给站内琥珀标的，
// 直推手机太吵。
//
// 通知点击深链：SW（web/public/service-worker.js）带 ?focusTerm=kind|cid|termId 打开/
// 聚焦控制台，ContainerList 落到对应组；页面已开则 postMessage 同款语义。
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { STATE_DIR } from './config.js';
import { HttpError } from './errors.js';
import { log } from './logger.js';

const PUSH_FILE = join(STATE_DIR, 'push.json');

interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: string;
}
interface PushShape {
  vapid?: { publicKey: string; privateKey: string };
  subs: PushSub[];
}

let cache: PushShape | null = null;

function load(): PushShape {
  if (cache) return cache;
  if (existsSync(PUSH_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(PUSH_FILE, 'utf8')) as PushShape;
      cache = { vapid: parsed.vapid, subs: Array.isArray(parsed.subs) ? parsed.subs : [] };
      return cache;
    } catch {
      log.warn({ file: PUSH_FILE }, 'web push: state file corrupt, starting fresh');
    }
  }
  cache = { subs: [] };
  return cache;
}

// 半截文件会丢 VAPID（丢了所有已发订阅全部作废）——原子写，state.json 同款。
function persist(s: PushShape): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${PUSH_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, PUSH_FILE);
  cache = s;
}

function ensureVapid(): { publicKey: string; privateKey: string } {
  const s = load();
  if (!s.vapid) {
    s.vapid = webpush.generateVAPIDKeys();
    persist(s);
    log.info('web push: VAPID keys generated');
  }
  return s.vapid;
}

// 路由 GET /api/push/key：前端 subscribe 的 applicationServerKey。
export function pushPublicKey(): string {
  return ensureVapid().publicKey;
}

// 路由 POST /api/push/subscribe。形状不对回 400——订阅坏着不如明说。
export function subscribePush(body: unknown): void {
  const b = (body || {}) as Record<string, unknown>;
  const endpoint = typeof b.endpoint === 'string' ? b.endpoint : '';
  const keys = b.keys as Record<string, unknown> | undefined;
  const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh : '';
  const auth = typeof keys?.auth === 'string' ? keys.auth : '';
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    throw new HttpError(400, 'push subscription 形状不对（endpoint/keys 缺失）', 'bad_request');
  }
  const s = load();
  const sub: PushSub = { endpoint, keys: { p256dh, auth }, createdAt: new Date().toISOString() };
  const i = s.subs.findIndex((x) => x.endpoint === endpoint);
  if (i >= 0) s.subs[i] = sub;
  else s.subs.push(sub);
  persist(s);
}

export function unsubscribePush(endpoint: string): void {
  const s = load();
  const next = s.subs.filter((x) => x.endpoint !== endpoint);
  if (next.length === s.subs.length) return;
  s.subs = next;
  persist(s);
}

// —— 「在看」心跳与去重（进程内，同 waiting 表不持久化）——

const WATCHING_TTL_MS = 30_000; // 心跳间隔前端 10s，两拍容错
let lastWatchingAt = 0;
const pushedKeys = new Map<string, number>();
const PUSHED_TTL_MS = 6 * 60 * 60 * 1000; // 同 waiting 兜底 TTL

// 路由 POST /api/push/watching：前端页面可见期间的定时心跳。心跳本身也重置去重——
// 用户看过控制台，挂着的事件算已被琥珀标送达，下个回合完成再推。
export function noteWatching(): void {
  lastWatchingAt = Date.now();
  pushedKeys.clear();
}

function watchingRecently(): boolean {
  return Date.now() - lastWatchingAt < WATCHING_TTL_MS;
}

// agentNotify.noteOutput（agent 恢复干活）调：新回合的完成要能再推。
export function forgetPushed(key: string): void {
  pushedKeys.delete(key);
}

const VAPID_SUBJECT = 'mailto:mysandbox@local';

// agentNotify.remember（waiting 落表）触发，fire-and-forget。去重/抑制在发送前判，
// 失败只记 debug——hook 链路不该被推送的抖动拖累。
export async function pushAgentWaiting(
  key: string,
  info: { agent: string; event: string; message?: string },
): Promise<void> {
  try {
    if (watchingRecently()) return;
    const now = Date.now();
    for (const [k, at] of pushedKeys) if (now - at > PUSHED_TTL_MS) pushedKeys.delete(k);
    if (pushedKeys.has(key)) return;
    const s = load();
    if (!s.subs.length) return;
    pushedKeys.set(key, now);

    const [kind, cid, termId] = key.split('|');
    const where = kind === 'host' ? '本机' : cid || '容器';
    const body = info.message
      ? `${info.agent} 在等你：${info.message.slice(0, 120)}`
      : `${info.agent} 可能已完成或在等你输入`;
    const payload = JSON.stringify({
      title: `终端提醒 · ${where}`,
      body,
      tag: `msb-wait-${key}`,
      focus: { kind, containerId: cid || '', termId },
    });
    webpush.setVapidDetails(VAPID_SUBJECT, ensureVapid().publicKey, ensureVapid().privateKey);
    const results = await Promise.allSettled(
      s.subs.map(async (sub) => {
        try {
          await webpush.sendNotification(sub, payload);
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            unsubscribePush(sub.endpoint); // 端点已失效：顺带清账
            log.info({ endpoint: sub.endpoint, status }, 'web push: dead subscription removed');
          }
          throw e;
        }
      }),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) log.debug({ key, failed, total: s.subs.length }, 'web push: sent with failures');
    else log.info({ key, total: s.subs.length }, 'web push: agent waiting pushed');
  } catch (e) {
    log.debug({ err: String(e) }, 'web push failed');
  }
}
