// 受限账户路由（分享用）：账户 = 只能操作白名单容器的第二凭证层（终端 + 文件面板）。
// 管理边界全部收口在 index.ts 的鉴权 hook：
//   - POST /api/account/login 公开（无凭证登录，同 /api/auth/session 的公开形态）；
//   - GET  /api/account/me 账户身份可达（hook 白名单内），owner 也可达（回 owner 形态）；
//   - /api/accounts* CRUD 只对 owner 开放——账户身份不在 hook 白名单，天然 403。
// 数据在 state.ts（SandboxAccount，0600 sidecar）；token 派生在 auth.ts（accountToken）。
import type { FastifyInstance } from 'fastify';
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import {
  addAccount,
  deleteAccount,
  getAccount,
  getAccounts,
  updateAccount,
} from './state.js';
import { accountToken } from './auth.js';
import { badRequest, conflict, notFound } from './errors.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

// 存储格式 `scrypt:<salt hex>:<hash hex>`：前缀留升级余地（换参数/换算法时旧哈希可辨）。
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseContainers(v: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(v) || (!allowEmpty && v.length === 0)) {
    throw badRequest('containers (non-empty string array) required');
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string' || !NAME_RE.test(x)) throw badRequest('invalid container name in containers');
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

function publicAccount(a: { name: string; containers: string[]; createdAt?: string }) {
  return { name: a.name, containers: a.containers, createdAt: a.createdAt };
}

export async function registerAccounts(app: FastifyInstance, cfg: Config): Promise<void> {
  // —— 公开登录：用户名 + 密码换账户 token（前端存 localStorage，走 X-Sandbox-Token）——
  // 恒回 401 不区分「账户不存在/密码错」（不泄露账户名存在性）。
  app.post('/api/account/login', async (req, reply) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!name || !password) throw badRequest('name and password required');
    const acct = await getAccount(name);
    if (!acct || !(await verifyPassword(password, acct.passwordHash))) {
      return reply.code(401).send({
        error: { code: 'unauthorized', message: 'invalid account or password' },
      });
    }
    return {
      token: accountToken(acct.name, cfg),
      name: acct.name,
      containers: acct.containers,
    };
  });

  // —— 当前身份：账户形态（GuestConsole 启动校验）与 owner 形态（App 分流用）——
  // owner 也能调（回 {kind:'owner'}）：同一浏览器两种凭证并存时主 token 优先，
  // 前端据此回控制台而不是受限页。
  app.get('/api/account/me', async (req) => {
    const ident = req.sandboxIdentity;
    if (ident?.kind === 'account') {
      return { kind: 'account' as const, name: ident.name, containers: [...ident.containers] };
    }
    return { kind: 'owner' as const };
  });

  // —— owner 管理 CRUD（账户身份打不进来：hook 白名单不含 /api/accounts*）——
  app.get('/api/accounts', async () => ({
    items: (await getAccounts()).map(publicAccount),
  }));

  app.post('/api/accounts', async (req) => {
    const b = (req.body || {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!NAME_RE.test(name)) throw badRequest('name must match ^[a-z0-9][a-z0-9_-]{0,30}$');
    if (password.length < 6) throw badRequest('password must be at least 6 chars');
    const containers = parseContainers(b.containers);
    const created = await addAccount({
      name,
      passwordHash: await hashPassword(password),
      containers,
      createdAt: new Date().toISOString(),
    });
    if (!created) throw conflict('account name already exists');
    return publicAccount(created);
  });

  app.put('/api/accounts/:name', async (req) => {
    const { name } = req.params as { name: string };
    const b = (req.body || {}) as Record<string, unknown>;
    const patch: { passwordHash?: string; containers?: string[] } = {};
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 6) {
        throw badRequest('password must be at least 6 chars');
      }
      patch.passwordHash = await hashPassword(b.password);
    }
    if (b.containers !== undefined) patch.containers = parseContainers(b.containers, true);
    if (!Object.keys(patch).length) throw badRequest('nothing to update');
    const updated = await updateAccount(name, patch);
    if (!updated) throw notFound(`account ${name} not found`);
    return publicAccount(updated);
  });

  app.delete('/api/accounts/:name', async (req) => {
    const { name } = req.params as { name: string };
    if (!(await deleteAccount(name))) throw notFound(`account ${name} not found`);
    return { ok: true };
  });
}
