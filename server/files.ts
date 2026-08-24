// 容器文件浏览/编辑 REST 路由（浏览 + 编辑 + 新建/重命名/删除）。
// 全部走 docker exec（find -printf 列目录、base64 读、stdin cat > 写），对 managed 与
// adopted 容器一视同仁（adopted 无 dataRoot 挂载，宿主 fs 直读方案对它不成立）。
//
// 安全边界：容器即沙箱（终端 exec 本就任意命令），故不做 .. 防护；路径校验只保证
// 「绝对路径、无 \0、长度合理」让 exec 不被怪输入玩坏。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { execRun, execFeed } from './docker.js';
import { resolve, requireControlled } from './routes.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { TERMID_RE, sessionName } from './terminal.js';

// 读/写一致的内容上限：超限返回 413（PUT 的路由级 bodyLimit 放得更宽，因 JSON 转义最坏
// 膨胀 ~6x：2MB 内容 -> ~12MB body，留余量到 16MB）。hostFiles.ts 复用同一上限。
export const MAX_BYTES = 2 * 1024 * 1024;

export interface FileEntry {
  name: string;
  type: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
}
export interface FilesView {
  path: string;
  parent: string | null;
  entries: FileEntry[];
}
export interface FileView {
  path: string;
  name: string;
  size: number;
  mtime: number;
  binary: boolean;
  content?: string;
}

// 绝对路径校验与规整：去尾斜杠（根除外）。非 string/非绝对/含 \0/超长 -> 400。
// hostFiles.ts 复用（两侧校验语义一致）。
export function cleanPath(raw: unknown, field = 'path'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) {
    throw badRequest(`${field} must be an absolute path`);
  }
  if (raw.includes('\0') || raw.length > 4096) {
    throw badRequest(`invalid ${field}`);
  }
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1);
  return raw;
}

// JS 侧算父目录（/ 的 parent 为 null），省一次 exec。
export function parentOf(p: string): string | null {
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

// 内容二进制判定：含 \0 或非法 UTF-8（GBK 等）-> 只读（binary=true 不带 content）。
// 非 UTF-8 文本若照常解码，编辑保存会有损往返毁文件。hostFiles.ts 复用（两侧规则单源）。
export function classifyContent(buf: Buffer): { binary: boolean; content?: string } {
  if (buf.includes(0)) return { binary: true };
  try {
    return { binary: false, content: new TextDecoder('utf-8', { fatal: true }).decode(buf) };
  } catch {
    return { binary: true };
  }
}

// 每条路由统一前置：受管理容器 + 运行中（exec 只对 running 容器有意义）。
async function resolveRunning(cfg: Config, id: string) {
  const r = await resolve(cfg, id);
  requireControlled(r);
  if (!r.running) throw conflict('container not running');
  return r;
}

// 退出码 -> HttpError 的映射约定（find/stat/sh 脚本侧 exit 2/3/5...，见各处注释）。
function mapListErr(r: { exitCode: number; stderr: string }, path: string): HttpError {
  if (r.exitCode === 2) return notFound(`path not found: ${path}`);
  if (r.exitCode === 3) return new HttpError(400, 'not a directory', 'not_a_directory');
  return new HttpError(500, r.stderr.trim() || `list failed (exit ${r.exitCode})`, 'list_failed');
}

export async function registerFileRoutes(app: FastifyInstance, cfg: Config): Promise<void> {
  // —— 列目录 ——
  // find -H：跟随起始点符号链接（默认不跟随会把链接目录列为空）。GNU findutils（Debian
  // 基座）printf 格式：%y 类型 / %s 字节 / %T@ 浮点 mtime 秒 / %f 文件名（最后字段，
  // split 后 slice(3).join 兼容文件名含 tab）。文件名含换行会撕裂行——解析侧丢弃坏行降级。
  app.get('/api/containers/:id/files', async (req): Promise<FilesView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'p="$1"; [ -e "$p" ] || exit 2; [ -d "$p" ] || exit 3; find -H "$p" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%T@\\t%f\\n"',
        'sh', path,
      ],
      Tty: false,
      timeoutMs: 10_000,
    });
    if (res.exitCode !== 0) throw mapListErr(res, path);

    const entries: FileEntry[] = [];
    for (const line of res.stdout.split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 4) continue; // 换行文件名撕裂的残行，丢弃
      const y = parts[0];
      if (y !== 'd' && y !== 'f' && y !== 'l') continue;
      entries.push({
        name: parts.slice(3).join('\t'),
        type: y === 'd' ? 'dir' : y === 'l' ? 'link' : 'file',
        size: Number(parts[1]) || 0,
        mtime: Number(parts[2]) || 0,
      });
    }
    entries.sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1;
      if (a.type !== 'dir' && b.type === 'dir') return 1;
      return a.name.localeCompare(b.name);
    });
    return { path, parent: parentOf(path), entries };
  });

  // —— 读文件 ——
  // 首行 META <size> <mtime>（%s.%N 浮点秒），其后 base64（coreutils 76 列换行，Buffer
  // 解码容忍空白）。binary 判定：含 \0 或非法 UTF-8（GBK 等）——非 UTF-8 文本若照常解码，
  // 编辑保存会有损往返毁文件，故一律按二进制只读。
  app.get('/api/containers/:id/file', async (req): Promise<FileView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        `f="$1"; [ -e "$f" ] || exit 2; [ -f "$f" ] || exit 3; sz=$(stat -c %s "$f") || exit 4; [ "$sz" -le ${MAX_BYTES} ] || exit 5; printf "META %s " "$sz"; date -r "$f" +%s.%N; printf "\\n"; base64 "$f"`,
        'sh', path,
      ],
      Tty: false,
      timeoutMs: 20_000,
    });
    if (res.exitCode === 2) throw notFound(`file not found: ${path}`);
    if (res.exitCode === 3) throw new HttpError(400, 'not a regular file', 'not_a_file');
    if (res.exitCode === 5)
      throw new HttpError(413, `file too large (limit ${MAX_BYTES} bytes)`, 'too_large');
    if (res.exitCode !== 0)
      throw new HttpError(500, res.stderr.trim() || `read failed (exit ${res.exitCode})`, 'read_failed');

    const lines = res.stdout.split('\n');
    const meta = (lines[0] || '').split(' ');
    const size = Number(meta[1]) || 0;
    const mtime = Number(meta[2]) || 0;
    const buf = Buffer.from(lines.slice(1).join('\n'), 'base64');
    const { binary, content } = classifyContent(buf);
    return { path, name, size, mtime, binary, ...(binary ? {} : { content }) };
  });

  // —— 写文件 ——
  // baseMtime 乐观锁：写入前 stat 对比读时的 mtime，不一致 -> 409（TOCTOU best-effort，
  // 竞态窗口极小）。写入走 execFeed（stdin cat > file）：无 argv 长度限制、二进制安全。
  app.put(
    '/api/containers/:id/file',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req): Promise<{ ok: true; mtime?: number }> => {
      const r = await resolveRunning(cfg, (req.params as { id: string }).id);
      const body = (req.body as { path?: unknown; content?: unknown; baseMtime?: unknown }) || {};
      const path = cleanPath(body.path);
      if (typeof body.content !== 'string') throw badRequest('content (string) required');
      const content = body.content;
      if (content.length > MAX_BYTES)
        throw new HttpError(413, `content too large (limit ${MAX_BYTES} bytes)`, 'too_large');
      const hasBaseMtime = typeof body.baseMtime === 'number' && body.baseMtime > 0;
      const baseMtime = hasBaseMtime ? (body.baseMtime as number) : undefined;

      // mtime 冲突检测（有 baseMtime 才做）。
      if (baseMtime !== undefined) {
        const st = await execRun(cfg, r.id, {
          Cmd: [
            'sh', '-c',
            'f="$1"; [ -e "$f" ] || exit 2; [ -f "$f" ] || exit 3; date -r "$f" +%s.%N',
            'sh', path,
          ],
          Tty: false,
          timeoutMs: 8_000,
        });
        if (st.exitCode !== 0) {
          // 文件被删/被换成目录：读完再写会丢对方改动，按冲突处理让用户自行决定。
          if (st.exitCode === 2 || st.exitCode === 3) {
            throw conflict('文件已被删除或不是普通文件，请重载');
          }
          throw new HttpError(500, st.stderr.trim() || 'stat failed', 'stat_failed');
        }
        if (Number(st.stdout.trim()) !== baseMtime) {
          throw conflict('文件在编辑期间被修改（mtime 不一致），请重载或覆盖');
        }
      }

      const wr = await execFeed(
        cfg,
        r.id,
        {
          // 写入前 mkdir -p 父目录（${1%/*} 取 dirname，根下为空串回退 /）：保存不存在的
          // 文件时隐式建目录（编辑器「不存在=新建」语义）。cleanPath 已保证绝对路径无 \0。
          Cmd: [
            'sh', '-c',
            'd="${1%/*}"; [ -n "$d" ] || d=/; mkdir -p "$d" && cat > "$1"',
            'sh', path,
          ],
          User: '1000:1000',
          Tty: false,
          timeoutMs: 30_000,
        },
        Buffer.from(content, 'utf8'),
      );
      if (wr.exitCode !== 0) {
        // 典型：目标归 root / 目录只读。dev(1000) 视角，不提权（沙箱语义）。
        throw new HttpError(
          400,
          wr.stderr.trim() || `write failed (exit ${wr.exitCode})`,
          'write_failed',
        );
      }

      // 返回新 mtime（best-effort：失败不影响保存成功语义）。
      const st = await execRun(cfg, r.id, {
        Cmd: ['sh', '-c', 'f="$1"; date -r "$f" +%s.%N 2>/dev/null', 'sh', path],
        Tty: false,
        timeoutMs: 8_000,
      });
      const mtime = st.exitCode === 0 ? Number(st.stdout.trim()) || undefined : undefined;
      return { ok: true, ...(mtime !== undefined ? { mtime } : {}) };
    },
  );

  // —— 新建文件/目录 ——
  // exit 9 = 已存在（409）；mkdir 不用 -p：父目录就是面板当前列出的目录、必存在，
  // -p 会把笔误路径悄悄建出来。dev(1000) 视角执行，权限不足走非 0 -> 400。
  app.post('/api/containers/:id/fs/create', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; type?: unknown }) || {};
    const path = cleanPath(body.path);
    const type = body.type === 'dir' ? 'dir' : body.type === 'file' ? 'file' : undefined;
    if (!type) throw badRequest('type must be "file" or "dir"');
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        // 注意 { ;} 分组：[ dir ] && mkdir || :> 在 mkdir 失败时会误落到 :>。
        '[ -e "$1" ] && exit 9; { [ "$2" = dir ] && mkdir "$1"; } || : > "$1"',
        'sh', path, type,
      ],
      Tty: false,
      timeoutMs: 8_000,
    });
    if (res.exitCode === 9) throw conflict('同名文件或目录已存在');
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `create failed (exit ${res.exitCode})`, 'create_failed');
    return { ok: true };
  });

  // —— 重命名 ——
  // 只换最后一段（name 不能含 /）：目标 = 父目录 + 新名。mv 前查重（exit 9 -> 409），
  // 防 mv 静默覆盖同名文件。符号链接用 mv 本体（默认不跟随）。
  app.post('/api/containers/:id/fs/rename', async (req): Promise<{ ok: true; to: string }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const name = body.name;
    if (typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..' || name.length > 255) {
      throw badRequest('invalid name');
    }
    const parent = parentOf(path);
    const to = parent === '/' ? `/${name}` : `${parent}/${name}`;
    const res = await execRun(cfg, r.id, {
      Cmd: ['sh', '-c', '[ -e "$2" ] && exit 9; mv -- "$1" "$2"', 'sh', path, to],
      Tty: false,
      timeoutMs: 8_000,
    });
    if (res.exitCode === 9) throw conflict('同名文件或目录已存在');
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `rename failed (exit ${res.exitCode})`, 'rename_failed');
    return { ok: true, to };
  });

  // —— 删除 ——
  // rm -r --：文件/目录/链接通吃，无回收站（调用方负责二次确认）。
  app.post('/api/containers/:id/fs/delete', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await execRun(cfg, r.id, {
      Cmd: ['sh', '-c', '[ -e "$1" ] || exit 9; rm -r -- "$1"', 'sh', path],
      Tty: false,
      timeoutMs: 30_000,
    });
    if (res.exitCode === 9) throw notFound(`path not found: ${path}`);
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `delete failed (exit ${res.exitCode})`, 'delete_failed');
    return { ok: true };
  });

  // —— 终端 pane 当前目录 ——
  // 文件面板跟随终端 cwd 的数据源。tmux list-panes 查会话活跃 pane 的 pane_current_path。
  // 不用 display-message：它对「server 侧无 attach client 上下文」的会话返回空串（实测），
  // list-panes 直接查 session 结构没有这个问题。`=` 前缀精确匹配必须保留：tmux -t 默认按
  // 前缀匹配，不带 = 会串到同容器其它 termId 的会话（terminal.ts reap 一节有踩坑记录）。
  app.get('/api/containers/:id/cwd', async (req): Promise<{ cwd: string }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'tmux list-panes -t "$1" -F "#{pane_active} #{pane_current_path}" 2>/dev/null | sed -n "s/^1 //p"',
        'sh', `=${sessionName(r.id, termId)}`,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 5_000,
    });
    if (res.exitCode !== 0) throw notFound('terminal session not found');
    const cwd = res.stdout.trim();
    if (!cwd || !cwd.startsWith('/')) throw notFound('terminal session not found');
    return { cwd };
  });
}
