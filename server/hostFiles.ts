// 宿主文件浏览/编辑 REST 路由（浏览 + 编辑 + 新建/重命名/删除）。
// 与 files.ts（容器侧）一比一对齐：路由形状、错误码、2MB 上限、binary 判定、mtime 乐观锁
// 语义完全一致，前端 api.ts 按 '__host__' 哨兵切端点后 FilePanel/FileEditorDialog 零改动。
// 实现差异仅在执行层：容器侧走 execRun（find/base64/cat），本文件走 node:fs 直操作。
//
// 安全边界：token 本就等价宿主 leon 用户（uid 1000 直通，见 CLAUDE.md 安全模型），文件路由不
// 扩大权限面；实际权限受 server 运行用户约束，EACCES/EPERM 如实反馈 403（与容器侧 400
// 的唯一刻意差异——容器内以 uid 1000 执行，宿主侧无这层包装）。
import { stat, lstat, readdir, readFile, writeFile, mkdir, rename, rm, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import {
  cleanPath,
  parentOf,
  MAX_BYTES,
  classifyContent,
  contentDisposition,
  streamProbe,
  parseDiffProto,
  type FileEntry,
  type FilesView,
  type FileView,
} from './files.js';
import { parsePorcelainZ, type GitStatusView, type GitDiffView } from './gitpanel.js';

const execFileAsync = promisify(execFile);

// mtime 统一浮点秒（容器侧 find %T@ / date +%s.%N 同单位；前端只做等值比较与透传）。
const mtimeOf = (st: { mtimeMs: number }): number => st.mtimeMs / 1000;

// 存在性探测（跟随 symlink；断链 = 不存在，同 sh 的 [ -e ]）。探测本身的 EACCES 往外抛。
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return false;
    }
    throw e;
  }
}

// node:fs 错误 -> HttpError。msg 覆写 404 文案（对齐容器侧各路由的 "xxx not found:"）。
function mapErr(e: unknown, msg?: string): HttpError {
  const err = e as NodeJS.ErrnoException;
  const text = msg ?? (err.message || 'fs error');
  switch (err.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return notFound(text);
    case 'EACCES':
    case 'EPERM':
      return new HttpError(403, err.message || 'permission denied', 'forbidden');
    case 'EEXIST':
      return conflict(text);
    case 'EISDIR':
      return badRequest('not a regular file');
    default:
      return new HttpError(400, err.message || text, 'fs_failed');
  }
}

export async function registerHostFileRoutes(app: FastifyInstance): Promise<void> {
  // —— 列目录 ——
  // stat（跟随起始点 symlink，同 find -H）+ readdir（原生 utf8 文件名，无 find printf 的
  // tab/换行解析问题）+ 逐条 lstat（类型/size/mtime，同 find 对条目不跟随链接）。
  // socket/fifo/设备条目跳过（容器侧 find %y 输出 s/p/b/c 同样被过滤）。
  app.get('/api/host-terminal/files', async (req): Promise<FilesView> => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    let st;
    try {
      st = await stat(path);
    } catch (e) {
      throw mapErr(e, `path not found: ${path}`);
    }
    if (!st.isDirectory()) throw badRequest('not a directory');

    let names;
    try {
      names = await readdir(path);
    } catch (e) {
      throw mapErr(e, `path not found: ${path}`); // EACCES（如 /root）-> 403，别落兜底 500
    }
    const entries: FileEntry[] = [];
    for (const name of names) {
      let s;
      try {
        s = await lstat(join(path, name));
      } catch {
        continue; // 列举瞬间被删：同 find 静默容忍
      }
      const type: FileEntry['type'] | null = s.isDirectory()
        ? 'dir'
        : s.isSymbolicLink()
          ? 'link'
          : s.isFile()
            ? 'file'
            : null;
      if (!type) continue;
      entries.push({ name, type, size: s.size, mtime: mtimeOf(s) });
    }
    // 目录在前 + 名字序（同容器侧）。
    entries.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
    );
    return { path, parent: parentOf(path), entries, hostPath: path };
  });

  // —— 读文件 ——
  // stat（跟随尾部 symlink，同容器 [ -f ]）+ readFile + classifyContent（binary 规则单源）。
  app.get('/api/host-terminal/file', async (req): Promise<FileView> => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    let st;
    try {
      st = await stat(path);
    } catch (e) {
      throw mapErr(e, `file not found: ${path}`);
    }
    if (!st.isFile()) throw badRequest('not a regular file');
    if (st.size > MAX_BYTES) {
      throw new HttpError(413, `file too large (limit ${MAX_BYTES} bytes)`, 'too_large');
    }
    const buf = await readFile(path).catch((e) => {
      throw mapErr(e, `file not found: ${path}`);
    });
    const { binary, content } = classifyContent(buf);
    return { path, name, size: st.size, mtime: mtimeOf(st), binary, ...(binary ? {} : { content }) };
  });

  // —— 下载（文件/目录，流式）——（与容器侧 files.ts /download 一比一：探测→头→流，
  // streamProbe 竞速空产出归因；仅实现层换成 node fs / 宿主 tar）
  app.get('/api/host-terminal/download', async (req, reply) => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!name) throw badRequest('cannot download /');
    let st;
    try {
      st = await stat(path);
    } catch (e) {
      throw mapErr(e, `path not found: ${path}`);
    }
    if (st.isDirectory()) {
      const parent = dirname(path);
      const sp = spawn('tar', ['-C', parent, '-czf', '-', '--', name], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      sp.stderr?.on('error', () => { /* noop */ });
      sp.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
      sp.stdout?.on('error', () => { /* noop */ });
      const done = new Promise<{ exitCode: number; stderr: string }>((resolve) => {
        sp.on('error', (e) => resolve({ exitCode: -1, stderr: stderr + (stderr ? '\n' : '') + e.message }));
        sp.on('close', (code) => resolve({ exitCode: code ?? -1, stderr }));
      });
      reply.header('content-type', 'application/gzip');
      reply.header('content-disposition', contentDisposition(`${name}.tar.gz`));
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) {
          try { sp.kill('SIGKILL'); } catch { /* noop */ }
        }
      });
      const guard = await streamProbe(sp.stdout!, done);
      if (guard && guard.exitCode !== 0) {
        throw new HttpError(
          400,
          guard.stderr.trim() || `download failed (exit ${guard.exitCode})`,
          'download_failed',
        );
      }
      return reply.send(sp.stdout!);
    }
    if (!st.isFile()) throw badRequest('not a regular file or directory');
    // 先 open 再流：EACCES 这类「stat 能过但读不动」在发头前映射 403，不给浏览器半个坏文件。
    let fh;
    try {
      fh = await open(path, 'r');
    } catch (e) {
      throw mapErr(e, 'open failed');
    }
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(st.size));
    reply.header('content-disposition', contentDisposition(name));
    return reply.send(fh.createReadStream()); // autoClose 默认 true，读完/断开自动关句柄
  });

  // —— 写文件 ——
  // baseMtime 乐观锁（浮点秒等值比较，同容器侧）→ mkdir -p 父目录（编辑器「不存在=新建」
  // 依赖隐式建）→ writeFile。非原子写入与容器侧 cat > 对齐（保 inode/属主；temp+rename
  // 会换 inode 丢属主，不为宿主单方面升级）。
  app.put(
    '/api/host-terminal/file',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req): Promise<{ ok: true; mtime?: number }> => {
      const body = (req.body as { path?: unknown; content?: unknown; baseMtime?: unknown }) || {};
      const path = cleanPath(body.path);
      if (typeof body.content !== 'string') throw badRequest('content (string) required');
      const content = body.content;
      if (content.length > MAX_BYTES) {
        throw new HttpError(413, `content too large (limit ${MAX_BYTES} bytes)`, 'too_large');
      }
      const hasBaseMtime = typeof body.baseMtime === 'number' && body.baseMtime > 0;

      // mtime 冲突检测（有 baseMtime 才做）。文件被删/被换成目录按冲突处理（同容器侧）。
      if (hasBaseMtime) {
        let st;
        try {
          st = await stat(path);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            throw conflict('文件已被删除或不是普通文件，请重载');
          }
          throw mapErr(e);
        }
        if (!st.isFile()) throw conflict('文件已被删除或不是普通文件，请重载');
        if (mtimeOf(st) !== body.baseMtime) {
          throw conflict('文件在编辑期间被修改（mtime 不一致），请重载或覆盖');
        }
      }

      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, 'utf8');
      } catch (e) {
        throw mapErr(e, 'write failed');
      }
      // best-effort 回读新 mtime（同容器侧）。
      try {
        const st = await stat(path);
        return { ok: true, mtime: mtimeOf(st) };
      } catch {
        return { ok: true };
      }
    },
  );

  // —— 新建 ——
  // 存在性探测用 stat（断链 symlink 视为不存在——同容器 [ -e ]，随后写入穿透链接）。
  // mkdir 非递归：父目录必在的约定同容器侧（防笔误悄悄建目录链）。
  app.post('/api/host-terminal/fs/create', async (req): Promise<{ ok: true }> => {
    const body = (req.body as { path?: unknown; type?: unknown }) || {};
    const path = cleanPath(body.path);
    const type = body.type;
    if (type !== 'file' && type !== 'dir') throw badRequest('type must be "file" or "dir"');
    try {
      if (await exists(path)) throw conflict('同名文件或目录已存在');
      if (type === 'dir') await mkdir(path);
      else await writeFile(path, '');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw mapErr(e, 'create failed');
    }
    return { ok: true };
  });

  // —— 重命名 ——
  // name 校验与目标拼法同容器侧；mv 前查重防静默覆盖；rename 对 symlink 移动本体。
  app.post('/api/host-terminal/fs/rename', async (req): Promise<{ ok: true; to: string }> => {
    const body = (req.body as { path?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const name = body.name;
    if (
      typeof name !== 'string' ||
      !name ||
      name.includes('/') ||
      name === '.' ||
      name === '..' ||
      name.length > 255
    ) {
      throw badRequest('invalid name');
    }
    const parent = parentOf(path);
    const to = parent === '/' ? `/${name}` : `${parent}/${name}`;
    try {
      if (await exists(to)) throw conflict('同名文件或目录已存在');
      await rename(path, to);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw mapErr(e, 'rename failed');
    }
    return { ok: true, to };
  });

  // —— 删除 ——
  // rm recursive 通吃文件/目录/链接（对 symlink 只删本体）；无回收站（前端二次确认）。
  app.post('/api/host-terminal/fs/delete', async (req): Promise<{ ok: true }> => {
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    try {
      if (!(await exists(path))) throw notFound(`path not found: ${path}`);
      await rm(path, { recursive: true });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw mapErr(e, 'delete failed');
    }
    return { ok: true };
  });

  // —— git 仓库状态 / 变更对比（与容器侧 files.ts 两端点一比一对齐，解析单源 gitpanel.ts）——
  // 宿主没有 engine exec 抽象，直接 execFile git（数组参数，无 shell 拼接）。非仓库 ->
  // {repo:false} 200（同容器侧）；git 未装 -> 400 git_missing（不能伪装成非仓库）；
  // dubious ownership 等其余失败按 500 抛 git 原话——不做 safe.directory 放权（安全模型：
  // token 等价 leon 用户，但不主动抹平系统防护）。
  app.get('/api/host-terminal/git/status', async (req): Promise<GitStatusView> => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    let top: string;
    try {
      top = (await gitExec(['-C', path, 'rev-parse', '--show-toplevel'])).trim();
    } catch (e) {
      if (e instanceof HttpError) throw e; // git_missing 等已映射的真错误
      return { repo: false }; // rev-parse 失败 = 非仓库（正常态）
    }
    const out = await gitExec([
      '--no-optional-locks', '-C', top, 'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all',
    ]);
    return { repo: true, toplevel: top, ...parsePorcelainZ(out) };
  });

  app.get('/api/host-terminal/git/diff', async (req): Promise<GitDiffView> => {
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const headPath = q.headPath ? cleanPath(q.headPath, 'headPath') : path;

    let top: string;
    try {
      top = (await gitExec(['-C', dirname(path), 'rev-parse', '--show-toplevel'])).trim();
    } catch (e) {
      if (e instanceof HttpError) throw e; // git_missing 等已映射的真错误
      return { repo: false, toplevel: '', file: path, base: {}, work: {} };
    }
    // 与容器侧脚本同形的探测（unborn / 双侧尺寸 / 越界），只是逐条用 node API 跑。
    const relOf = (abs: string): string | null => {
      if (abs === top) return '';
      if (abs.startsWith(top + '/')) return abs.slice(top.length + 1);
      return null;
    };
    const wr = relOf(path);
    const hr = relOf(headPath);
    if (wr === null || hr === null) throw badRequest('path 不在该 git 仓库内');

    let unb = false;
    try {
      await gitExec(['-C', top, 'rev-parse', '-q', '--verify', 'HEAD']);
    } catch {
      unb = true; // 无任何提交：HEAD 校验失败但仓库存在（toplevel 刚 rev-parse 成功）
    }
    // HEAD 侧：cat-file -s 拿尺寸；show 流式读取至 MAX_BYTES+1 截断（防巨型 blob 进内存）。
    let bsize = 0;
    let bbuf: Buffer | null = null;
    if (!unb) {
      try {
        bsize = Number((await gitExec(['-C', top, 'cat-file', '-s', `HEAD:${hr}`])).trim()) || 0;
      } catch {
        bsize = -1; // HEAD 无此路径（untracked / 新增）
      }
      if (bsize > 0 && bsize <= MAX_BYTES) {
        bbuf = await gitShowBuffer(top, `HEAD:${hr}`);
      }
    }
    // 工作区侧：stat（跟随尾部 symlink，同容器 [ -f ]）+ readFile。
    let wsz = -1;
    let wbuf: Buffer | null = null;
    try {
      const st = await stat(path);
      if (st.isFile()) {
        wsz = st.size;
        if (wsz <= MAX_BYTES) wbuf = await readFile(path);
      }
    } catch {
      wsz = -1; // 已删除
    }

    // 组协议文本后复用容器侧的 parseDiffProto（FLAGS + BASE/WORK base64 段），保证两侧
    // 解析语义单源。flag 编码对齐脚本侧：n 不存在 / 小写可读 / 大写超限。
    const f = (size: number): string => (size < 0 ? 'n' : size > MAX_BYTES ? 'B' : 'b');
    const wflag = wsz < 0 ? 'n' : wsz > MAX_BYTES ? 'W' : 'w';
    const proto =
      `FLAGS ${unb ? 1 : 0} ${bsize < 0 ? 'n' : f(bsize)} ${wflag} ${bsize < 0 ? 0 : bsize} ${wsz < 0 ? 0 : wsz}\n` +
      `@@BASE@@\n${bbuf ? bbuf.toString('base64') : ''}` +
      `@@WORK@@\n${wbuf ? wbuf.toString('base64') : ''}`;
    const view = parseDiffProto(proto, path, headPath);
    return { ...view, toplevel: top };
  });
}

// git 子进程封装：数组参数、10s 超时、ENOENT（git 未装）映射 400 git_missing。
async function gitExec(args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string | number };
    if (err.code === 'ENOENT') {
      throw new HttpError(400, '宿主未安装 git', 'git_missing');
    }
    throw e;
  }
}

// `git show` 的输出收集：流式累计到 MAX_BYTES+1 即 kill（巨型 blob 不进全量内存，
// execFile 的 maxBuffer 是事后兜底不是流中截断）。
function gitShowBuffer(top: string, spec: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const child = spawn('git', ['-C', top, 'show', spec], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (c: Buffer) => {
      chunks.push(c);
      total += c.length;
      if (total > MAX_BYTES) child.kill('SIGKILL'); // 已超限，内容反正不用
    });
    child.stdout.on('end', () => resolve(Buffer.concat(chunks)));
    child.on('error', reject);
    child.stderr?.on('data', () => {}); // 排空 stderr 防阻塞；错误语义由退出码兜
  });
}
