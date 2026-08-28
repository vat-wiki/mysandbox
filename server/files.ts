// 容器文件浏览/编辑 REST 路由（浏览 + 编辑 + 新建/重命名/删除）。
// 全部走 execRun（find -printf 列目录、base64 读、stdin cat > 写），对 managed 与
// adopted 容器一视同仁（adopted 无 dataRoot 挂载，宿主 fs 直读方案对它不成立）。
//
// 安全边界：容器即沙箱（终端 exec 本就任意命令），故不做 .. 防护；路径校验只保证
// 「绝对路径、无 \0、长度合理」让 exec 不被怪输入玩坏。
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { execRun, execFeed } from './engine/index.js';
import { resolve, requireControlled } from './routes.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { TERMID_RE, sessionName } from './terminal.js';
import {
  parsePorcelainZ,
  mapGitExit,
  type GitStatusView,
  type GitDiffView,
  type GitDiffSide,
} from './gitpanel.js';

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

  // —— 终端路径链接解析（Ctrl+点击打开）——
  // 前端 tokenizer 只认得出「像路径的 token」（可相对、可带字面 ~），权威解析在这：
  // 单次 exec 拿 pane cwd（同 /cwd 路由，必须 list-panes 不能 display-message）+ 展开 +
  // readlink -m 归一 + 类型探测。与 cleanPath 的唯一差异：本端点接受相对路径与 ~
  // （container-cli 的脚本不做 ~ 展开——shell 传参前已展开；这里收到的是前端字面 token，
  // 必须自己补 ~/ ~ 两个 case；User 1000:1000 时 attachArgs 注入 HOME=/home/dev，与会话
  // shell 一致）。输出协议「d|f|m <abs>\n」：d=目录 f=文件 m=不存在（前端按 file 走新建态）。
  app.get('/api/containers/:id/resolve', async (req): Promise<{ path: string; kind: 'dir' | 'file' | 'missing' }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const raw = q.path;
    // 拒 \0 / \n：防输出协议被撕裂；长度上限对齐 cleanPath。raw 只经 argv 位置传入不内插。
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\n') || raw.length > 4096) {
      throw badRequest('invalid path');
    }
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        [
          'p="$1"; s="$2"',
          'cwd=$(tmux list-panes -t "$s" -F "#{pane_active} #{pane_current_path}" 2>/dev/null | sed -n "s/^1 //p")',
          '[ -n "$cwd" ] || exit 2',
          'case "$p" in',
          '  "") p="$cwd" ;;',
          '  "~") p="$HOME" ;;',
          // ${p#~/} 里的模式 ~ 在 dash/bash 均匹配不上（实测），必须引号字面量模式 ${p#"~/"}。
          '  "~/"*) p="$HOME/${p#"~/"}" ;;',
          '  /*) ;;',
          '  *) p="$cwd/$p" ;;',
          'esac',
          'q=$(readlink -m -- "$p" 2>/dev/null) && p="$q"',
          'if [ -d "$p" ]; then printf "d %s\\n" "$p"',
          'elif [ -e "$p" ]; then printf "f %s\\n" "$p"',
          'else printf "m %s\\n" "$p"; fi',
        ].join('\n'),
        'sh', raw, `=${sessionName(r.id, termId)}`,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 8_000,
    });
    if (res.exitCode === 2) throw notFound('terminal session not found');
    if (res.exitCode !== 0)
      throw new HttpError(500, res.stderr.trim() || `resolve failed (exit ${res.exitCode})`, 'resolve_failed');
    const first = res.stdout.split('\n')[0] ?? '';
    const kind = first[0] === 'd' ? 'dir' : first[0] === 'f' ? 'file' : 'missing';
    const abs = first.slice(2);
    if (!abs.startsWith('/')) throw new HttpError(500, 'bad resolve output', 'resolve_failed');
    return { path: abs, kind };
  });

  // —— git 仓库状态（面板「Git 变更」区块数据源）——
  // 协议：首行 toplevel（rev-parse --show-toplevel 打印的规范绝对路径，git 自身保证不含
  // 换行，按首个 \n 切分安全），其后整段是 porcelain -z 的 NUL 流。非仓库是正常态不是
  // 错误：exit 7 -> {repo:false} 200 返回，前端整块隐藏。--no-optional-locks 让只读
  // status 不写 index 锁（多客户端轮询不打架，git 2.22+）。timeoutMs 略大于前端 10s。
  app.get('/api/containers/:id/git/status', async (req): Promise<GitStatusView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; printf "%s\\n" "$t"; git --no-optional-locks -C "$t" status --porcelain=v1 -z --branch',
        'sh', path,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 15_000,
    });
    if (res.exitCode === 7) return { repo: false };
    const err = mapGitExit(res, 'status');
    if (err) throw err;

    const nl = res.stdout.indexOf('\n');
    const toplevel = res.stdout.slice(0, nl); // 空串/异常形状按非仓库兜底
    if (nl < 0 || !toplevel.startsWith('/')) return { repo: false };
    return { repo: true, toplevel, ...parsePorcelainZ(res.stdout.slice(nl + 1)) };
  });

  // —— git 变更对比（HEAD 版本 vs 工作区，Monaco diff 视图数据源）——
  // 单次 exec 完成双侧探测 + base64 输出（避免双请求竞态）。协议：
  //   FLAGS <unborn> <bflag> <wflag> <bsize> <wsz>\n @@BASE@@\n<b64> @@WORK@@\n<b64>
  //   flag：n = 不存在（HEAD 无此路径 / 工作区已删）、b/B = 可读/超限、w/W 同理；
  //   超限与不存在都不流内容（局部降级由 Node 侧组装，不抛 413 断掉整个视图）。
  //   标记用 @@ 包裹：@ 不在 base64 字母表（A-Za-z0-9+/）内，indexOf 不会撞进内容里
  //   产生假标记（裸 "WORK\n" 理论上可由 base64 行尾拼出，属静默损坏）。
  // exit 8 = 工作区/HEAD 路径不在 toplevel 下（400）。R 条目的旧路径由前端经 headPath
  // 传入（默认等于 path）。MAX_BYTES 沿用文件读上限（同一常量，语义一致：可对比的内容
  // 与可编辑的内容同量级）。
  app.get('/api/containers/:id/git/diff', async (req): Promise<GitDiffView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const headPath = q.headPath ? cleanPath(q.headPath, 'headPath') : path;
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        [
          'w="$1"; h="$2"',
          't=$(git -C "${w%/*}" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          // ${VAR#"$t"/} 引号展开防路径内特殊字符被当模式
          'case "$w" in "$t"|"$t"/*) wr=${w#"$t"}; wr=${wr#/} ;; *) exit 8 ;; esac',
          'case "$h" in "$t"|"$t"/*) hr=${h#"$t"}; hr=${hr#/} ;; *) exit 8 ;; esac',
          'unb=0; git -C "$t" rev-parse -q --verify HEAD >/dev/null 2>&1 || unb=1',
          'bsize=""; [ "$unb" = 0 ] && bsize=$(git -C "$t" cat-file -s "HEAD:$hr" 2>/dev/null) || :',
          'wsz=""; [ -f "$w" ] && wsz=$(stat -c %s "$w")',
          'bf=n; [ -n "$bsize" ] && { [ "$bsize" -le ' + MAX_BYTES + ' ] && bf=b || bf=B; }',
          'wf=n; [ -n "$wsz" ] && { [ "$wsz" -le ' + MAX_BYTES + ' ] && wf=w || wf=W; }',
          'printf "FLAGS %s %s %s %s %s\\n" "$unb" "$bf" "$wf" "${bsize:-0}" "${wsz:-0}"',
          'printf "@@BASE@@\\n"; [ "$bf" = b ] && git -C "$t" show "HEAD:$hr" | base64 || :',
          'printf "@@WORK@@\\n"; [ "$wf" = w ] && base64 "$w" || :',
        ].join('\n'),
        'sh', path, headPath,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 30_000,
    });
    if (res.exitCode === 7) return { repo: false, toplevel: '', file: path, base: {}, work: {} };
    const err = mapGitExit(res, 'diff');
    if (err) throw err;

    return parseDiffProto(res.stdout, path, headPath);
  });
}

// diff 脚本输出协议 -> GitDiffView（宿主侧 hostFiles.ts 复用同一解析）。
// FLAGS 行后两段 @@BASE@@/@@WORK@@ 各接 base64。binary 判定复用 classifyContent（单源）。
export function parseDiffProto(stdout: string, path: string, headPath: string): GitDiffView {
  const nl = stdout.indexOf('\n');
  const flags = (nl >= 0 ? stdout.slice(0, nl) : '').split(' ');
  const [, unb, bf, wf, bsizeS, wszS] = flags;
  const body = nl >= 0 ? stdout.slice(nl + 1) : '';
  const M_BASE = '@@BASE@@\n';
  const M_WORK = '@@WORK@@\n';
  const bBase = body.indexOf(M_BASE);
  const bWork = body.indexOf(M_WORK);
  const mkSide = (
    flag: string | undefined,
    sizeS: string | undefined,
    b64: string,
    absent: GitDiffSide['absent'],
  ): GitDiffSide => {
    const size = Number(sizeS) || 0;
    if (flag === 'B' || flag === 'W') return { absent: 'too_large', size };
    if (flag === 'n') return { absent, ...(absent ? {} : { size }) };
    const buf = Buffer.from(b64, 'base64');
    const { binary, content } = classifyContent(buf);
    return { ...(binary ? { binary: true } : { content }), size };
  };
  const base = mkSide(bf, bsizeS, bBase >= 0 ? body.slice(bBase + M_BASE.length, bWork) : '', 'no_head_path');
  const work = mkSide(wf, wszS, bWork >= 0 ? body.slice(bWork + M_WORK.length) : '', 'deleted');
  return {
    repo: true,
    toplevel: '',
    file: path,
    ...(headPath !== path ? { headFile: headPath } : {}),
    base: unb === '1' ? { absent: 'unborn' } : base,
    work,
  };
}
