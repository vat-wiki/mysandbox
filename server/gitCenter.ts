// Git 中心：内网 bare 仓库托管（~/.mysandbox/repos/<name>.git）。
// 两个互不相干的面：
//   /git/*             —— git Smart HTTP（git http-backend 的 CGI 协议），不进 token hook；
//                          能连到端口的人都能 clone/push，这是「内网无权限库」的有意取舍。
//   /api/git-center/*  —— 控制台的仓库管理/代码浏览，走全局 token hook（owner）。
// 所有 git 操作走 child_process 数组参数（无 shell 拼接），解析复用 gitpanel.ts。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPOS_DIR } from './config.js';
import { badRequest, conflict, notFound } from './errors.js';
import {
  assertBranchName,
  assertGitRelPath,
  parseHistoryLog,
  parseHistoryQuery,
  type GitCommit,
} from './gitpanel.js';

const execFileAsync = promisify(execFile);
// 空树 hash：initial commit 没有父提交时拿它当 diff 左侧（git 内置常量，所有版本一致）。
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const FILE_MAX = 512 * 1024;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function normalizeName(raw: unknown): string {
  let n = String(raw ?? '').trim();
  if (n.endsWith('.git')) n = n.slice(0, -4);
  // 拒绝 .. / 尾点 / 首尾空格等会撞到文件系统或 git 校验的名字；URL 与 API 共用这一道。
  if (!REPO_NAME_RE.test(n) || n.includes('..') || n.endsWith('.')) throw badRequest('仓库名不合法（字母/数字/._-，最长 64 字符）');
  return n;
}
const repoDir = (name: string): string => join(REPOS_DIR, `${name}.git`);
const qstr = (v: unknown): string => (typeof v === 'string' ? v : '');

async function ensureRoot(): Promise<void> {
  await mkdir(REPOS_DIR, { recursive: true, mode: 0o700 });
}

async function requireRepo(raw: unknown): Promise<{ name: string; dir: string }> {
  const name = normalizeName(raw);
  const dir = repoDir(name);
  if (!existsSync(join(dir, 'HEAD'))) throw notFound(`仓库 ${name} 不存在`);
  return { name, dir };
}

// git 子进程封装：--git-dir 直指 bare 仓库（不需要工作区）。失败时把 git stderr
// 原话抛出去（用户可读），ENOENT 单独提示（不能把「git 没装」伪装成仓库不存在）。
async function git(dir: string | null, args: string[], timeoutMs = 10_000): Promise<string> {
  const full = dir ? ['--git-dir', dir, ...args] : args;
  try {
    const { stdout } = await execFileAsync('git', full, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (err.code === 'ENOENT') throw new Error('系统未安装 git');
    throw new Error((err.stderr ? String(err.stderr) : err.message || 'git 执行失败').trim());
  }
}
// 探测性调用（空仓库 / 无效 ref 是正常态）：失败返回 null，不抛。
async function gitTry(dir: string, args: string[]): Promise<string | null> {
  try {
    return await git(dir, args);
  } catch {
    return null;
  }
}
// 大 blob 流式截断：execFile 的 maxBuffer 是事后兜底，这里到上限即 kill，避免整包进内存。
function gitBuffer(dir: string, args: string[], max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    child.stdout.on('data', (c: Buffer) => {
      if (done) return;
      total += c.length;
      if (total > max) {
        done = true;
        child.kill();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    child.on('error', reject);
    child.on('close', () => {
      if (!done) resolve(Buffer.concat(chunks));
    });
  });
}

interface RepoItem {
  name: string;
  description: string;
  updatedAt: number;
  empty: boolean;
}

async function listRepos(): Promise<RepoItem[]> {
  await ensureRoot();
  const entries = await readdir(REPOS_DIR, { withFileTypes: true });
  const items: RepoItem[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.endsWith('.git')) continue;
    const name = e.name.slice(0, -4);
    if (!REPO_NAME_RE.test(name)) continue;
    const dir = repoDir(name);
    if (!existsSync(join(dir, 'HEAD'))) continue;
    const rawDesc = (await readFile(join(dir, 'description'), 'utf8').catch(() => '')) || '';
    const description = rawDesc.startsWith('Unnamed repository') ? '' : rawDesc.trim();
    const last = await gitTry(dir, ['for-each-ref', '--count=1', '--sort=-committerdate', '--format=%(committerdate:unix)', 'refs/heads']);
    const updatedAt = Number(last?.trim() || 0) || (await stat(join(dir, 'HEAD'))).mtimeMs / 1000;
    items.push({ name, description, updatedAt, empty: !last?.trim() });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

interface RefRow {
  name: string;
  hash: string;
  date: string;
}
function parseRefRows(out: string): RefRow[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, hash, date] = line.split('\t');
      return { name: name ?? '', hash: hash ?? '', date: date ?? '' };
    });
}

async function repoDetail(dir: string) {
  const [head, branchesOut, tagsOut, countOut, lastOut] = await Promise.all([
    gitTry(dir, ['symbolic-ref', '--short', 'HEAD']),
    git(dir, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(creatordate:iso-strict)', 'refs/heads']),
    git(dir, ['for-each-ref', '--format=%(refname:short)%09%(objectname:short)%09%(creatordate:iso-strict)', 'refs/tags']),
    git(dir, ['rev-list', '--count', '--all']),
    gitTry(dir, ['log', '-1', '--format=%H%x00%h%x00%an%x00%aI%x00%s']),
  ]);
  let lastCommit: { hash: string; short: string; author: string; date: string; subject: string } | null = null;
  if (lastOut?.trim()) {
    const f = lastOut.trim().split('\0');
    if (f.length >= 5) lastCommit = { hash: f[0], short: f[1], author: f[2], date: f[3], subject: f[4] };
  }
  return {
    defaultBranch: head?.trim() || 'main',
    branches: parseRefRows(branchesOut),
    tags: parseRefRows(tagsOut),
    commitCount: Number(countOut.trim()) || 0,
    lastCommit,
  };
}

function queryOf(req: FastifyRequest): Record<string, string | undefined> {
  return (req.query ?? {}) as Record<string, string | undefined>;
}

// —— 管理 / 代码浏览 API ——
export function registerGitCenterRoutes(app: FastifyInstance): void {
  app.get('/api/git-center/repos', async () => ({ items: await listRepos() }));

  app.post('/api/git-center/repos', async (req) => {
    const b = (req.body ?? {}) as { name?: unknown; description?: unknown };
    const name = normalizeName(b.name);
    await ensureRoot();
    const dir = repoDir(name);
    if (existsSync(dir)) throw conflict(`仓库 ${name} 已存在`);
    await git(null, ['init', '--bare', '--initial-branch=main', dir]);
    // 匿名 Smart HTTP 推送必须显式开 receivepack（否则 http-backend 拒写）。
    await git(dir, ['config', 'http.receivepack', 'true']);
    await git(dir, ['config', 'http.uploadpack', 'true']);
    const desc = qstr(b.description).trim().slice(0, 500);
    if (desc) await writeFile(join(dir, 'description'), `${desc}\n`);
    return { name };
  });

  app.delete('/api/git-center/repos/:name', async (req) => {
    const { name, dir } = await requireRepo((req.params as { name: string }).name);
    await rm(dir, { recursive: true });
    return { ok: true, name };
  });

  app.get('/api/git-center/repos/:name', async (req) => {
    const { dir } = await requireRepo((req.params as { name: string }).name);
    return repoDetail(dir);
  });

  // 目录树：ref 为空段 = 根；子目录用 <ref>:<path> 当 tree-ish，ls-tree -z 抗特殊文件名。
  app.get('/api/git-center/repos/:name/tree', async (req) => {
    const { dir } = await requireRepo((req.params as { name: string }).name);
    const q = queryOf(req);
    const ref = qstr(q.ref) || 'HEAD';
    assertBranchName(ref);
    const path = qstr(q.path);
    if (path) assertGitRelPath(path, 'path');
    const spec = path ? `${ref}:${path}` : ref;
    const out = await gitTry(dir, ['ls-tree', '-z', '--long', spec]);
    if (out === null) {
      const unborn = (await gitTry(dir, ['rev-parse', '--verify', 'HEAD^{commit}'])) === null;
      if (unborn && (ref === 'HEAD' || ref === 'main')) return { ref, path, empty: true, entries: [] };
      throw badRequest('分支或目录不存在');
    }
    const entries = out
      .split('\0')
      .filter(Boolean)
      .map((rec) => {
        const tab = rec.indexOf('\t');
        if (tab < 0) return null;
        const meta = rec.slice(0, tab).split(/\s+/);
        const p = rec.slice(tab + 1);
        return { name: p.split('/').pop() || p, path: p, type: meta[1] ?? 'blob', size: Number(meta[3]) || 0 };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    return { ref, path, entries };
  });

  // 文件内容：二进制只报 size，不给 content；文本上限 512KB，超出截尾并标 truncated。
  app.get('/api/git-center/repos/:name/file', async (req) => {
    const { dir } = await requireRepo((req.params as { name: string }).name);
    const q = queryOf(req);
    const ref = qstr(q.ref) || 'HEAD';
    assertBranchName(ref);
    const path = assertGitRelPath(q.path, 'path');
    const buf = await gitBuffer(dir, ['show', `${ref}:${path}`], FILE_MAX + 4096);
    if (buf === null) throw badRequest('文件过大或不存在');
    if (buf.includes(0)) return { path, binary: true, content: '', size: buf.length, truncated: false };
    const truncated = buf.length > FILE_MAX;
    return { path, binary: false, content: buf.toString('utf8', 0, FILE_MAX), size: buf.length, truncated };
  });

  // 提交历史：与文件面板同一套格式（gitpanel.parseHistoryLog），前端可直接复用列表样式。
  app.get('/api/git-center/repos/:name/commits', async (req) => {
    const { dir } = await requireRepo((req.params as { name: string }).name);
    const { ref, limit, skip } = parseHistoryQuery(queryOf(req));
    const ok = (await gitTry(dir, ['rev-parse', '--verify', `${ref}^{commit}`])) !== null;
    if (!ok) {
      if (ref === 'HEAD') return { ref, unborn: true, commits: [] as GitCommit[], hasMore: false };
      throw badRequest('分支或提交不存在');
    }
    const out = await git(dir, [
      'log', '--decorate=short', '--date=iso-strict', `--max-count=${limit}`, `--skip=${skip}`,
      '--format=%H%x00%h%x00%P%x00%an%x00%aI%x00%s%x00%D%x00', ref, '--',
    ]);
    const commits = parseHistoryLog(out);
    return { ref, commits, hasMore: commits.length === limit };
  });

  // 提交差异：to 缺省 HEAD；from 缺省 = to 的父提交（首提交用空树）。
  app.get('/api/git-center/repos/:name/diff', async (req) => {
    const { dir } = await requireRepo((req.params as { name: string }).name);
    const q = queryOf(req);
    const to = qstr(q.to) || 'HEAD';
    assertBranchName(to);
    let from = qstr(q.from);
    if (from) assertBranchName(from);
    else from = (await gitTry(dir, ['rev-parse', '--verify', `${to}^`]))?.trim() || EMPTY_TREE;
    const patch = await git(dir, ['diff', '--no-color', '--find-renames', from, to]);
    const numstat = await git(dir, ['diff', '--no-color', '--numstat', from, to]);
    const files = numstat
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [a, d, p] = line.split('\t');
        return { path: p ?? '', additions: a === '-' ? 0 : Number(a) || 0, deletions: d === '-' ? 0 : Number(d) || 0 };
      });
    return { from, to, patch, files };
  });
}

// —— git Smart HTTP ——
// 直接把请求转成 CGI 环境交给 `git http-backend`，让 git 自己处理 advertise-refs /
// upload-pack / receive-pack / pack 协商与所有 dumb 端点；比手写四个端点更完整。
// 响应是「CGI 头 + 空行 + body」，这里切出头部再 hijack 裸流转发（pack 可能很大）。
export function registerGitHttp(app: FastifyInstance, port: number): void {
  // git 客户端的两种请求体是自定义 MIME，Fastify 默认无解析器 -> 415。
  app.addContentTypeParser(/^application\/x-git-(upload|receive)-pack-request$/, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/git/*',
    bodyLimit: 64 * 1024 * 1024,
    handler: async (req, reply) => {
      const rawPath = ((req.params as Record<string, string>)['*'] ?? '').replace(/^\/+/, '');
      const segs = rawPath.split('/').filter(Boolean);
      if (segs.length < 2 || !segs[0].endsWith('.git')) {
        return reply.code(400).send({ error: { code: 'bad_request', message: 'git 路径不合法' } });
      }
      let name: string;
      try {
        name = normalizeName(segs[0].slice(0, -4));
      } catch {
        return reply.code(400).send({ error: { code: 'bad_request', message: '仓库名不合法' } });
      }
      const dir = repoDir(name);
      if (!existsSync(join(dir, 'HEAD'))) {
        return reply.code(404).send({ error: { code: 'not_found', message: '仓库不存在' } });
      }
      const rest = `/${segs.slice(1).join('/')}`;
      await serveBackend(req, reply, name, rest, port);
    },
  });
}

async function serveBackend(req: FastifyRequest, reply: FastifyReply, name: string, rest: string, port: number): Promise<void> {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const rawUrl = req.url ?? '/';
  const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?') + 1) : '';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_PROJECT_ROOT: REPOS_DIR,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: `/${name}.git${rest}`,
    REQUEST_METHOD: req.method,
    REQUEST_URI: rawUrl,
    QUERY_STRING: query,
    CONTENT_TYPE: qstr(req.headers['content-type']),
    CONTENT_LENGTH: String(body.length),
    SERVER_PROTOCOL: 'HTTP/1.1',
    SERVER_NAME: String(req.headers.host ?? 'localhost').split(':')[0],
    SERVER_PORT: String(port),
    REMOTE_ADDR: req.ip,
  };
  const child = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  reply.hijack();

  let header = Buffer.alloc(0);
  let headersDone = false;
  child.stdout.on('data', (chunk: Buffer) => {
    if (headersDone) {
      reply.raw.write(chunk);
      return;
    }
    header = Buffer.concat([header, chunk]);
    const end = header.indexOf('\r\n\r\n');
    if (end < 0) return;
    headersDone = true;
    for (const line of header.subarray(0, end).toString('latin1').split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      const value = line.slice(i + 1).trim();
      if (key === 'status') {
        reply.raw.statusCode = Number(value.split(' ')[0]) || 200;
      } else if (!['content-length', 'transfer-encoding', 'connection'].includes(key)) {
        reply.raw.setHeader(key, value);
      }
    }
    const restBuf = header.subarray(end + 4);
    if (restBuf.length) reply.raw.write(restBuf);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // git 自己的诊断输出记到 fastify 日志，不回给客户端（回复正文必须保持 pack 纯净）。
    req.log.warn({ detail: chunk.toString('utf8').trim() }, 'git http-backend');
  });
  child.stdin.on('error', () => {});
  if (body.length) child.stdin.write(body);
  child.stdin.end();
  child.on('error', (e) => {
    req.log.error({ err: e }, 'git http-backend 启动失败');
    if (!reply.raw.headersSent) {
      reply.raw.statusCode = 500;
      reply.raw.setHeader('content-type', 'text/plain; charset=utf-8');
    }
    reply.raw.end('git http-backend 启动失败');
  });
  child.on('close', () => {
    if (!headersDone) reply.raw.statusCode = 200;
    reply.raw.end();
  });
}
