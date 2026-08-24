// 宿主文件浏览/编辑 REST 路由（浏览 + 编辑 + 新建/重命名/删除）。
// 与 files.ts（容器侧）一比一对齐：路由形状、错误码、2MB 上限、binary 判定、mtime 乐观锁
// 语义完全一致，前端 api.ts 按 '__host__' 哨兵切端点后 FilePanel/FileEditorDialog 零改动。
// 实现差异仅在执行层：容器侧走 docker exec（find/base64/cat），本文件走 node:fs 直操作。
//
// 安全边界：token 本就等价宿主 root（docker.sock，见 hostTerminal.ts 头注），文件路由不
// 扩大权限面；实际权限受 server 运行用户约束，EACCES/EPERM 如实反馈 403（与容器侧 400
// 的唯一刻意差异——容器内以 uid 1000 执行，宿主侧无这层包装）。
import { stat, lstat, readdir, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import {
  cleanPath,
  parentOf,
  MAX_BYTES,
  classifyContent,
  type FileEntry,
  type FilesView,
  type FileView,
} from './files.js';

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
    return { path, parent: parentOf(path), entries };
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
}
