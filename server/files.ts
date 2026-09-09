// 容器文件浏览/编辑 REST 路由（浏览 + 编辑 + 新建/重命名/删除）。
// 全部走 execRun（find -printf 列目录、base64 读、stdin cat > 写），对 managed 与
// adopted 容器一视同仁（adopted 无 dataRoot 挂载，宿主 fs 直读方案对它不成立）。
//
// 安全边界：容器即沙箱（终端 exec 本就任意命令），故不做 .. 防护；路径校验只保证
// 「绝对路径、无 \0、长度合理」让 exec 不被怪输入玩坏。
import type { FastifyInstance } from 'fastify';
import type { Readable } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { lstat, mkdir, rename, rm, stat } from 'node:fs/promises';
import type { Config } from './config.js';
import { execRun, execFeed, execSpawn, rootfsPath } from './engine/index.js';
import { resolve, requireControlled } from './routes.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { listServiceContainers } from './docker.js';
import { TERMID_RE, sessionName } from './terminal.js';
import {
  parsePorcelainZ,
  parseBranchList,
  parseRemoteBranches,
  parseWorktreeListZ,
  mapGitExit,
  assertBranchName,
  assertWorktreeDir,
  type GitStatusView,
  type GitDiffView,
  type GitDiffSide,
  type GitBranchesView,
  type GitWorktreesView,
} from './gitpanel.js';

// 读/写一致的内容上限：超限返回 413（PUT 的路由级 bodyLimit 放得更宽，因 JSON 转义最坏
// 膨胀 ~6x：2MB 内容 -> ~12MB body，留余量到 16MB）。hostFiles.ts 复用同一上限。
export const MAX_BYTES = 2 * 1024 * 1024;

const execFileAsync = promisify(execFile);

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
  // 该目录在宿主机上的实际路径。容器 = rootfs 前缀直拼（D1 uid 直通，宿主可直读直写）；
  // 引擎无法映射（理论上不发生）为 null。宿主面板 = path 本身（hostFiles 回同样语义）。
  hostPath: string | null;
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

// 列目录脚本（本文件与服务端点 serviceFiles.ts 共用单源）。输出协议：每行
// type\tsize\tmtime\tname（%y 类型 / %s 字节 / mtime 秒 / 文件名最后字段，split 后
// slice(3).join 兼容文件名含 tab；含换行的名字会撕裂行，解析侧丢弃残行降级）。
// 双分支：GNU find -printf 单进程最快（Debian 基座容器/模板恒走这里）；busybox
// （alpine 系服务镜像、adopt 的外来容器）find 无 -printf，先探测、失败落 shell 兜底——
// find -print0 NUL 流 + read -d ''（busybox ash 支持）逐条 stat，%s/%Y busybox stat
// 都有（对 symlink 是 lstat 语义，与 GNU printf 一致）；非 d/f/l 条目（fifo 等）跳过，
// 与解析侧丢弃 %y=p/s/b/c 对齐。mtime：GNU %T@ 浮点秒、busybox %Y 整秒，Number() 通吃。
export const LIST_SCRIPT = [
  'p="$1"',
  '[ -e "$p" ] || exit 2',
  '[ -d "$p" ] || exit 3',
  'if find -H "$p" -maxdepth 0 -printf "\\n" >/dev/null 2>&1; then',
  '  exec find -H "$p" -mindepth 1 -maxdepth 1 -printf "%y\\t%s\\t%T@\\t%f\\n"',
  'fi',
  'find -H "$p" -mindepth 1 -maxdepth 1 -print0 | while IFS= read -r -d "" f; do',
  '  if [ -L "$f" ]; then y=l',
  '  elif [ -d "$f" ]; then y=d',
  '  elif [ -f "$f" ]; then y=f',
  '  else continue; fi',
  '  sz=$(stat -c %s -- "$f" 2>/dev/null) || continue',
  '  mt=$(stat -c %Y -- "$f" 2>/dev/null) || continue',
  '  printf "%s\\t%s\\t%s\\t%s\\n" "$y" "$sz" "$mt" "${f##*/}"',
  'done',
].join('\n');

// 取文件 mtime 的秒值（读/写两端乐观锁用）。GNU date -r FILE 支持纳秒（%N）；busybox
// 1.37 的 date -r 能跑但 %N 出空（尾部悬点，Number() 不受影响），更老的 busybox -r 是
// 「转换 epoch 秒」语义、对路径必败——统一 2>/dev/null || stat -c %Y 兜底（两家 stat
// 都支持 %Y）。
export const MTIME_SNIPPET = 'date -r "$f" +%s.%N 2>/dev/null || stat -c %Y "$f" 2>/dev/null';

// 宿主面板哨兵：与 web/src/lib/api.ts 的 HOST_ID 一致（复制粘贴双端统一在此端点解析）。
const HOST_ID = '__host__';

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

// Content-Disposition：ASCII 兜底 filename（引号/反斜杠与非 ASCII 一律打码，防头注入/坏头）+
// RFC 5987 filename*（原样 UTF-8 名，现代浏览器优先用它）。hostFiles.ts 复用。
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

// 下载流的「首块数据就绪」与「进程收尾」竞速。进程先退 = 一个字节都没产出（如 tar 对
// 整体不可读的目录秒退），此时还能干净回 4xx/5xx，不让浏览器落一个空文件；数据先到 =
// 流已开跑，之后 tar 对个别不可读条目的报错只能随流终止（浏览器拿到截断包，与「边下
// 边打包」的现实一致）。返回 null = 调用方直接发流；否则拿到收尾结果自行映射错误。
// stdout 会被 pause（防 send 挂管前数据流失），fastify 接管后 pipe 自动恢复流动。
// hostFiles.ts 复用（宿主侧 tar 下载同款语义）。
export async function streamProbe(
  stdout: Readable,
  done: Promise<{ exitCode: number; stderr: string }>,
): Promise<{ exitCode: number; stderr: string } | null> {
  stdout.pause();
  let settled = false;
  const gotData = new Promise<null>((resolve) => {
    const onData = () => {
      // readableLength 0 的 'readable' 是 EOF 时的空唤醒（如 cat 空文件），不算数据——
      // 让 done 定夺：exit 0 = 合法空输出照发；非 0 = 干净报错。
      if (stdout.readableLength > 0 && !settled) {
        settled = true;
        stdout.off('readable', onData);
        resolve(null);
      }
    };
    stdout.on('readable', onData);
    // 迟到的流错误（对端断开等）不吞会崩进程；按无数据处理让 done 收场。
    stdout.on('error', () => {
      if (!settled) {
        settled = true;
        stdout.off('readable', onData);
        resolve(null);
      }
    });
  });
  return Promise.race([done, gotData]);
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
  // find -H：跟随起始点符号链接（默认不跟随会把链接目录列为空）。脚本单源 LIST_SCRIPT
  // （文件头有协议与 busybox 兜底说明），serviceFiles.ts 同用。
  app.get('/api/containers/:id/files', async (req): Promise<FilesView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await execRun(cfg, r.id, {
      Cmd: ['sh', '-c', LIST_SCRIPT, 'sh', path],
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
    const rootfs = rootfsPath(cfg, r.id);
    return { path, parent: parentOf(path), entries, hostPath: rootfs ? rootfs + path : null };
  });

  // —— 读文件 ——
  // 首行 META <size> <mtime>（mtime 经 MTIME_SNIPPET：GNU 浮点秒，busybox 退整秒），
  // 其后 base64（coreutils 76 列换行，Buffer 解码容忍空白）。binary 判定：含 \0 或
  // 非法 UTF-8（GBK 等）——非 UTF-8 文本若照常解码，编辑保存会有损往返毁文件，故一律
  // 按二进制只读。
  app.get('/api/containers/:id/file', async (req): Promise<FileView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        `f="$1"; [ -e "$f" ] || exit 2; [ -f "$f" ] || exit 3; sz=$(stat -c %s "$f") || exit 4; [ "$sz" -le ${MAX_BYTES} ] || exit 5; printf "META %s " "$sz"; ${MTIME_SNIPPET}; printf "\\n"; base64 "$f"`,
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

  // —— 下载（文件/目录，流式）——
  // 文件 = cat 直通；目录 = tar -C 父目录 -czf -（名字不含 /，无路径注入面）。经 execSpawn
  // 二进制流直通 HTTP（execStream 经 script 的 PTY 会 \n→\r\n 毁流，不可用；execRun 整包
  // 收 utf8 字符串大文件既慢又坏内容）。探测（stat）与产出之间有竞态窗口（文件刚被删）：
  // 首块数据前的非 0 退出经 streamProbe 干净回 4xx/5xx；已发流后的 tar 局部报错随流终止。
  // 以 dev(1000) 身份执行，与列目录同视角（看得见才下得动）。
  app.get('/api/containers/:id/download', async (req, reply) => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!name) throw badRequest('cannot download /');
    const st = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        // -d/-f 都跟随尾 symlink：链接到文件/目录按目标下载（与 openLink 的语义一致）；
        // 断链/特殊文件落 exit 2。stat 取尺寸（Content-Length 给浏览器进度条）。
        'f="$1"; if [ -d "$f" ]; then echo dir; elif [ -f "$f" ]; then stat -c "file %s" -- "$f" || exit 2; else exit 2; fi',
        'sh', path,
      ],
      Tty: false,
      timeoutMs: 10_000,
    });
    if (st.exitCode !== 0) throw mapListErr(st, path);
    const [kind, sizeS] = st.stdout.trim().split(' ');
    const isDir = kind === 'dir';
    // parentOf 对根级条目回 null：tar -C / 即可（名字不含 /，无注入面）。
    const parent = parentOf(path) ?? '/';
    const h = execSpawn(
      cfg,
      r.id,
      isDir
        ? { Cmd: ['tar', '-C', parent, '-czf', '-', '--', name], User: '1000:1000', Tty: false }
        : { Cmd: ['cat', '--', path], User: '1000:1000', Tty: false },
    );
    reply.header('content-type', isDir ? 'application/gzip' : 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(isDir ? `${name}.tar.gz` : name));
    if (!isDir && Number(sizeS) > 0) reply.header('content-length', String(Number(sizeS)));
    // 客户端中途断开：kill 子进程（socket 断开本身也会让 tar/cat 撞 SIGPIPE，双保险）。
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) h.kill();
    });
    const guard = await streamProbe(h.stdout, h.done);
    if (guard && guard.exitCode !== 0) {
      throw new HttpError(
        400,
        guard.stderr.trim() || `download failed (exit ${guard.exitCode})`,
        'download_failed',
      );
    }
    return reply.send(h.stdout);
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
            `f="$1"; [ -e "$f" ] || exit 2; [ -f "$f" ] || exit 3; ${MTIME_SNIPPET}`,
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
        Cmd: ['sh', '-c', `f="$1"; ${MTIME_SNIPPET}`, 'sh', path],
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

  // —— 重命名 / 移动 ——
  // name 只换最后一段（不能含 /）；可选 toDir = 目标目录（缺省 = 原父目录，即纯改名；
  // 文件面板拖拽移动传它，目标 = toDir + name）。mv 前查重（exit 9 -> 409），防 mv
  // 静默覆盖同名文件。符号链接用 mv 本体（默认不跟随）。目录拖进自身/子孙（自嵌套）
  // 在 JS 侧前置拒绝——coreutils mv 也会拒，但报错晚且文案差；hostFiles 的 rename(2)
  // 对自嵌套的 errno 因内核而异，统一挡在校验层。
  app.post('/api/containers/:id/fs/rename', async (req): Promise<{ ok: true; to: string }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; name?: unknown; toDir?: unknown }) || {};
    const path = cleanPath(body.path);
    const name = body.name;
    if (typeof name !== 'string' || !name || name.includes('/') || name === '.' || name === '..' || name.length > 255) {
      throw badRequest('invalid name');
    }
    const toDir = body.toDir === undefined ? (parentOf(path) ?? '/') : cleanPath(body.toDir, 'toDir');
    if (toDir === path || toDir.startsWith(`${path}/`)) throw badRequest('不能把目录移动到它自己（或其子目录）里');
    const to = toDir === '/' ? `/${name}` : `${toDir}/${name}`;
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

  // —— 跨面板复制粘贴（容器↔宿主↔容器↔服务，文件/目录通用）——
  // 双侧统一解析成 Side 再组 tar 管道：宿主/容器（'__host__' 与 LXC 容器）宿主实址直拼、
  // tar 在宿主跑；服务（'s:' 前缀，web 侧 api.ts filesBase 约定）容器内路径，tar 经
  // docker exec 流式进出。为什么用 tar 而不是 fs.cp：tar 打包不跟随符号链接，链接字符串
  // 原样进包、解到目的端后语义正确；包内 uid 由解包侧 --no-same-owner 落为执行用户。
  // 宿主侧解包到兄弟临时目录、成功后 rename 落位（失败清理不留半拷，落位瞬时）；服务侧
  // 同构：容器内 /tmp 临时目录 + 容器内 mv（mkdir -p 兜 /tmp 必在）。服务侧必须运行中
  // （docker exec 前提）；容器侧不要求运行中（rootfs 直操作）但必须受控。无进度上报
  // （本地管道秒级，大目录由前端 toast.promise 兜住观感），10min watchdog 硬顶防悬挂。
  app.post('/api/files/copy', async (req): Promise<{ ok: true }> => {
    const body = (req.body as Record<string, unknown>) || {};
    const srcC = typeof body.srcContainer === 'string' ? body.srcContainer : '';
    const dstC = typeof body.dstContainer === 'string' ? body.dstContainer : '';
    const srcPath = cleanPath(body.srcPath, 'srcPath');
    const dstPath = cleanPath(body.dstPath, 'dstPath');
    if (!srcC || !dstC) throw badRequest('srcContainer and dstContainer are required');
    if (srcPath === '/') throw badRequest('cannot copy /');

    // 服务侧探测/操作小助手（docker exec，数组参数无 shell 注入面；受管边界 = label
    // 过滤的 listServiceContainers，非 mysandbox 容器结构性查不到）。
    async function svcTest(sname: string, script: string, p: string): Promise<boolean> {
      try {
        await execFileAsync('docker', ['exec', sname, 'sh', '-c', script, 'sh', p], { timeout: 8_000 });
        return true;
      } catch {
        return false;
      }
    }
    async function svcRow(sname: string): Promise<boolean> {
      const rows = await listServiceContainers();
      return rows.some((r) => r.Names.split(',')[0].replace(/^\//, '') === sname);
    }

    type Side = { kind: 'host'; path: string } | { kind: 'docker'; name: string; path: string };
    async function locate(id: string, p: string): Promise<Side> {
      if (id === HOST_ID) return { kind: 'host', path: p };
      if (id.startsWith('s:')) {
        const sname = id.slice(2);
        if (!(await svcRow(sname))) throw notFound(`service "${sname}" not found`);
        return { kind: 'docker', name: sname, path: p };
      }
      const r = await resolve(cfg, id); // 存在性校验：容器名来自列表，仍防直调 API 的注入名
      requireControlled(r);
      const rootfs = rootfsPath(cfg, r.id);
      if (!rootfs) throw badRequest(`cannot map container ${id} to a host path`);
      return { kind: 'host', path: rootfs + p };
    }
    const [src, dst] = await Promise.all([locate(srcC, srcPath), locate(dstC, dstPath)]);

    const srcName = src.path.slice(src.path.lastIndexOf('/') + 1);
    const dstName = dst.path.slice(dst.path.lastIndexOf('/') + 1);
    if (!srcName || srcName === '.' || srcName === '..' || !dstName || dstName === '.' || dstName === '..') {
      throw badRequest('cannot copy / or dot paths');
    }
    // 源存在（不跟随——断链也原样复制）；目标不存在；不能拷进自身内部（tar 边读边写会
    // 自噬）。预检到落位有 TOCTOU 窗口（best-effort），落位前再查一次把窗口压到最小。
    const srcExists =
      src.kind === 'host'
        ? await lstat(src.path).then(
            () => true,
            () => false,
          )
        : await svcTest(src.name, '[ -e "$1" ] || [ -L "$1" ]', src.path);
    if (!srcExists) throw notFound(`source not found: ${srcPath}`);
    const dstFree =
      dst.kind === 'host'
        ? await lstat(dst.path).then(
            () => false,
            (e) => {
              if (e instanceof HttpError) throw e;
              return true;
            },
          )
        : !(await svcTest(dst.name, '[ -e "$1" ] || [ -L "$1" ]', dst.path));
    if (!dstFree) throw conflict('同名文件或目录已存在');
    // 自噬检查只在同一 fs 内有意义（跨 fs 永不成立）
    if (
      (src.kind === 'host' && dst.kind === 'host' && (dst.path === src.path || dst.path.startsWith(`${src.path}/`))) ||
      (src.kind === 'docker' && dst.kind === 'docker' && src.name === dst.name &&
        (dst.path === src.path || dst.path.startsWith(`${src.path}/`)))
    ) {
      throw badRequest('cannot copy into itself');
    }
    const dstParent = dst.path.slice(0, dst.path.lastIndexOf('/')) || '/';
    const dstParentOk =
      dst.kind === 'host'
        ? await stat(dstParent).then(
            (s) => s.isDirectory(),
            () => false,
          )
        : await svcTest(dst.name, '[ -d "$1" ]', dstParent);
    if (!dstParentOk) throw notFound(`destination directory not found: ${dstPath}`);

    // 临时目录 + pack/unpack 进程：宿主侧落 dst 兄弟目录；服务侧落容器内 /tmp。
    const tmpHost = join(dstParent, `.mysandbox-copy-${randomUUID().slice(0, 8)}`);
    const tmp = dst.kind === 'host' ? tmpHost : '/tmp/.mysandbox-copy-' + randomUUID().slice(0, 8);
    if (dst.kind === 'host') await mkdir(tmp);
    const srcParent = src.path.slice(0, src.path.lastIndexOf('/')) || '/';
    const packArgv =
      src.kind === 'host'
        ? ['tar', '-C', srcParent, '-cf', '-', '--', srcName]
        : ['docker', 'exec', src.name, 'tar', '-C', srcParent, '-cf', '-', '--', srcName];
    const unpackArgv =
      dst.kind === 'host'
        ? ['tar', '-x', '-C', tmp, '--no-same-owner']
        : [
            'docker', 'exec', '-i', dst.name, 'sh', '-c',
            'mkdir -p "$1" && tar -x -C "$1" --no-same-owner', 'sh', tmp,
          ];
    const kids: ChildProcess[] = [];
    const errs: string[] = [];
    try {
      const pack = spawn(packArgv[0], packArgv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      const unpack = spawn(unpackArgv[0], unpackArgv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
      for (const [c, tag] of [
        [pack, 'pack'],
        [unpack, 'unpack'],
      ] as const) {
        kids.push(c);
        c.stderr?.on('data', (d: Buffer) => errs.push(`${tag}: ${d}`));
        c.on('error', (e) => errs.push(`${tag}: ${e.message}\n`)); // spawn 失败（tar 不存在等）
      }
      pack.stdout.pipe(unpack.stdin);
      // 客户端中途断开也照常完成（复制已启动就落完）：不挂 reply 事件。watchdog 兜悬挂。
      const closed = (c: ChildProcess) =>
        new Promise<number>((res) => c.on('close', (code) => res(code ?? -1)));
      const watchdog = setTimeout(() => kids.forEach((k) => k.kill('SIGKILL')), 10 * 60_000);
      const [packCode, unpackCode] = await Promise.all([closed(pack), closed(unpack)]);
      clearTimeout(watchdog);
      if (packCode !== 0 || unpackCode !== 0) {
        const detail = errs.join('').trim().slice(0, 500);
        throw new HttpError(
          400,
          detail || `copy failed (pack ${packCode}, unpack ${unpackCode})`,
          'copy_failed',
        );
      }
      // 落位前复查冲突（压 TOCTOU 窗口）；rename 对已存在目录会 ENOTEMPTY、对文件会覆盖
      // ——复查覆盖掉文件场景的竞态窗口。
      const dstStillFree =
        dst.kind === 'host'
          ? await lstat(dst.path).then(
              () => false,
              () => true,
            )
          : !(await svcTest(dst.name, '[ -e "$1" ] || [ -L "$1" ]', dst.path));
      if (!dstStillFree) throw conflict('同名文件或目录已存在');
      if (dst.kind === 'host') {
        await rename(join(tmp, srcName), dst.path);
        // 落位后临时目录只剩空壳（包内唯一顶层条目已移走），一并清掉——失败路径在 catch 里清。
        await rm(tmp, { recursive: true, force: true }).catch(() => {});
      } else {
        const fin = await execFileAsync(
          'docker',
          ['exec', dst.name, 'sh', '-c', 'mv -- "$1" "$2" && rm -rf -- "$3"', 'sh', join(tmp, srcName), dst.path, tmp],
          { timeout: 30_000 },
        ).catch((e) => {
          throw new HttpError(
            400,
            String((e as { stderr?: string }).stderr ?? e).trim().slice(0, 500) || 'copy finalize failed',
            'copy_failed',
          );
        });
        void fin;
      }
      return { ok: true };
    } catch (e) {
      if (dst.kind === 'host') await rm(tmp, { recursive: true, force: true }).catch(() => {});
      else await execFileAsync('docker', ['exec', dst.name, 'rm', '-rf', '--', tmp], { timeout: 8_000 }).catch(() => {});
      throw e;
    }
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
        // --untracked-files=all：untracked 目录展开成逐个文件，列表不出现「目录」条目
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; printf "%s\\n" "$t"; git --no-optional-locks -C "$t" status --porcelain=v1 -z --branch --untracked-files=all',
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

  // —— git 分支列表 / 切换（面板「Git 变更」dock 的分支菜单数据源与动作）——
  // branches 协议：首行 toplevel，其后是 branch --list --format='%(HEAD)…' 的逐行输出
  //（当前分支带 * 前缀），再一个 '@' 分隔行 + branch -r 的远端短名逐行输出。本地段各行
  // 恒以 * / 空格开头（%(HEAD) 固定输出），首个不匹配的行即 '@' 分隔，切分无歧义。
  // 分支名不含换行，按行切分安全。切换用 git switch——它只做分支操作、不碰工作区路径
  //（checkout 会把同名文件误当还原目标）；-c 创建时不能带 --（实测 git 2.43 会把 --
  // 当 start-point 报「无效引用」），名字已过 assertBranchName 的 - 开头防线。远端模式
  // 传全短名（origin/feat-x），节点侧剥出本地名后 -c --track 检出。有未提交变更时由
  // git 自行裁决（不冲突就携带过去，冲突报 stderr 原话）。
  // exit 7 = 非仓库 / exit 9 = 分支名不合法（脚本侧防线，与 assertBranchName 双保险）。
  app.get('/api/containers/:id/git/branches', async (req): Promise<GitBranchesView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        // --no-optional-locks：只读操作不写 index 锁（与 status 端点同理由）
        [
          'p="$1"',
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          'printf "%s\\n" "$t"',
          'git --no-optional-locks -C "$t" branch --list --format="%(HEAD)%(refname:short)"',
          'printf "@\\n"',
          'git --no-optional-locks -C "$t" branch -r --list --format="%(refname:short)"',
        ].join('\n'),
        'sh', path,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 15_000,
    });
    if (res.exitCode === 7) return { repo: false };
    const err = mapGitExit(res, 'branches');
    if (err) throw err;

    const nl = res.stdout.indexOf('\n');
    const toplevel = res.stdout.slice(0, nl); // 空串/异常形状按非仓库兜底
    if (nl < 0 || !toplevel.startsWith('/')) return { repo: false };
    const lines = res.stdout.slice(nl + 1).split('\n');
    const sep = lines.findIndex((l) => l !== '' && l[0] !== '*' && l[0] !== ' ');
    const local = parseBranchList((sep < 0 ? lines : lines.slice(0, sep)).join('\n'));
    const remotes = sep < 0 ? [] : parseRemoteBranches(lines.slice(sep + 1).join('\n'));
    return { repo: true, toplevel, ...local, remotes };
  });

  app.post('/api/containers/:id/git/checkout', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; name?: unknown; create?: unknown; remote?: unknown }) || {};
    const path = cleanPath(body.path);
    const name = assertBranchName(body.name);
    // remote 模式：name 是远端短名（origin/feat-x），本地名取第一段 '/' 之后（分支名可含
    // '/'，只剥远端段）；本地名同样过 - 开头防线
    const local = body.remote ? assertBranchName(name.slice(name.indexOf('/') + 1)) : '';
    const guard = "case \"$n\" in ''|-*) exit 9 ;; esac";
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        body.remote
          ? [
              'p="$1"; n="$2"; l="$3"',
              guard,
              "case \"$l\" in ''|-*) exit 9 ;; esac",
              't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
              'exec git -C "$t" switch -c "$l" --track "$n"',
            ].join('\n')
          : [
              'p="$1"; n="$2"; c="$3"',
              guard,
              't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
              'if [ "$c" = 1 ]; then exec git -C "$t" switch -c "$n"; fi',
              'exec git -C "$t" switch -- "$n"',
            ].join('\n'),
        'sh', path, name, ...(body.remote ? [local] : [body.create ? '1' : '0']),
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 15_000,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('分支名不合法');
    const err = mapGitExit(res, '分支切换');
    if (err) throw err;
    return { ok: true };
  });

  // —— fetch / pull / push（远端三件套，作用于 path 所在仓库；pull 恒 --ff-only，分叉
  // 交给 git 报错由用户去终端处理，一键不干有损的合并；push 无上游且恰好一个远端时
  // 自动 -u 建跟踪，多远端不猜）。fetch 涉及网络，两侧超时都放宽到 120s。——
  const GIT_NET_TIMEOUT = 120_000;

  app.post('/api/containers/:id/git/fetch', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; exec git -C "$t" fetch --all --prune',
        'sh', path,
      ],
      User: '1000:1000', Tty: false, timeoutMs: GIT_NET_TIMEOUT,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    const err = mapGitExit(res, 'fetch');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/containers/:id/git/pull', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; exec git -C "$t" pull --ff-only',
        'sh', path,
      ],
      User: '1000:1000', Tty: false, timeoutMs: GIT_NET_TIMEOUT,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    const err = mapGitExit(res, 'pull');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/containers/:id/git/push', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        [
          'p="$1"',
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          // 有上游直推；无上游且恰好一个远端时 -u 建跟踪推（HEAD 携带当前分支名），
          // 多远端/裸仓库不猜，exit 10 由路由层转成人话
          'if git -C "$t" rev-parse --abbrev-ref --symbolic-full-name \'@{u}\' >/dev/null 2>&1; then exec git -C "$t" push; fi',
          'n=$(git -C "$t" remote | wc -l); [ "$n" = 1 ] || exit 10',
          'r=$(git -C "$t" remote); exec git -C "$t" push -u "$r" HEAD',
        ].join('\n'),
        'sh', path,
      ],
      User: '1000:1000', Tty: false, timeoutMs: GIT_NET_TIMEOUT,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 10) throw badRequest('当前分支没有上游且远端不止一个，请在终端手动推送');
    const err = mapGitExit(res, 'push');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/containers/:id/git/branch-delete', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const name = assertBranchName(body.name);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        [
          'p="$1"; n="$2"',
          "case \"$n\" in ''|-*) exit 9 ;; esac",
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          // -d 安全删：未合并的分支 git 自行拒绝，报 stderr 原话
          'exec git -C "$t" branch -d "$n"',
        ].join('\n'),
        'sh', path, name,
      ],
      User: '1000:1000', Tty: false, timeoutMs: 15_000,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('分支名不合法');
    const err = mapGitExit(res, '删除分支');
    if (err) throw err;
    return { ok: true };
  });

  // —— git worktree 管理（dock 的 worktree popover 数据源与动作，与分支菜单平级入口）——
  // worktree 与分支是两个维度：分支菜单改「当前工作树的状态」，这里管「工作树本体」。
  // list 协议：首行 toplevel，其后是 worktree list --porcelain -z 的 NUL 流（解析单源
  // gitpanel.ts parseWorktreeListZ）。--no-optional-locks：只读不写锁（同 status 端点）。
  // add 三模式由前端 quick-pick 输入判定（与分支菜单同一心智）：branch = 检出既有本地分支；
  // remote = 从远端短名建本地跟踪分支（-b <local> --track，local 由本侧剥出，与 checkout
  // 端点同法）；new = -b 新建分支（起点恒 HEAD，不猜）。remove 普通删除被 git 拒（dirty/
  // locked）时 stderr 原话回前端，由前端二次提供 force 重试——本侧只透传 force 参数。
  // 自定义退出码：7 非仓库 / 9 名字不合法 / 11 目标目录落在现有 worktree 内部（嵌套
  // worktree 前置拦截，比 git 自身的模糊报错可读）。
  app.get('/api/containers/:id/git/worktrees', async (req): Promise<GitWorktreesView> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; printf "%s\\n" "$t"; git --no-optional-locks -C "$t" worktree list --porcelain -z',
        'sh', path,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 15_000,
    });
    if (res.exitCode === 7) return { repo: false };
    const err = mapGitExit(res, 'worktree list');
    if (err) throw err;
    const nl = res.stdout.indexOf('\n');
    const toplevel = res.stdout.slice(0, nl);
    if (nl < 0 || !toplevel.startsWith('/')) return { repo: false };
    return { repo: true, toplevel, worktrees: parseWorktreeListZ(res.stdout.slice(nl + 1)) };
  });

  app.post('/api/containers/:id/git/worktree-add', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; dir?: unknown; mode?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const dir = assertWorktreeDir(body.dir);
    const mode = body.mode;
    if (mode !== 'branch' && mode !== 'new' && mode !== 'remote') throw badRequest('mode 不合法');
    const name = assertBranchName(body.name);
    // remote 模式：name 是远端短名（origin/feat-x），本地名取第一段 '/' 之后（与 checkout 同法）
    const local = mode === 'remote' ? assertBranchName(name.slice(name.indexOf('/') + 1)) : '';
    const guard = "case \"$d\" in ''|-*) exit 9 ;; esac";
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        [
          'p="$1"; d="$2"; m="$3"; n="$4"; l="$5"',
          guard,
          "case \"$m\" in branch|new|remote) ;; *) exit 9 ;; esac",
          "case \"$n\" in ''|-*) exit 9 ;; esac",
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          // 嵌套拦截：新 worktree 不能建在任何现有工作树内部（含主树自身），git 的报错
          // 对这种场景不直观，提前给可读错误
          'case "$d" in "$t"|"$t"/*) exit 11 ;; esac',
          'if [ "$m" = branch ]; then exec git -C "$t" worktree add "$d" "$n"; fi',
          'if [ "$m" = remote ]; then exec git -C "$t" worktree add -b "$l" --track "$d" "$n"; fi',
          'exec git -C "$t" worktree add -b "$n" "$d"',
        ].join('\n'),
        'sh', path, dir, mode, name, local,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 30_000,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('worktree 路径或分支名不合法');
    if (res.exitCode === 11) throw badRequest('目标目录在现有工作树内部，请选仓库外的目录');
    const err = mapGitExit(res, '创建 worktree');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/containers/:id/git/worktree-remove', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown; dir?: unknown; force?: unknown }) || {};
    const path = cleanPath(body.path);
    const dir = assertWorktreeDir(body.dir);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        [
          'p="$1"; d="$2"; f="$3"',
          "case \"$d\" in ''|-*) exit 9 ;; esac",
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          'if [ "$f" = 1 ]; then exec git -C "$t" worktree remove --force "$d"; fi',
          'exec git -C "$t" worktree remove "$d"',
        ].join('\n'),
        'sh', path, dir, body.force ? '1' : '0',
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 30_000,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('worktree 路径不合法');
    const err = mapGitExit(res, '移除 worktree');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/containers/:id/git/worktree-prune', async (req): Promise<{ ok: true }> => {
    const r = await resolveRunning(cfg, (req.params as { id: string }).id);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await execRun(cfg, r.id, {
      Cmd: [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; exec git -C "$t" worktree prune',
        'sh', path,
      ],
      User: '1000:1000',
      Tty: false,
      timeoutMs: 15_000,
    });
    if (res.exitCode === 7) throw badRequest('目标目录不在 git 仓库内');
    const err = mapGitExit(res, '清理 worktree');
    if (err) throw err;
    return { ok: true };
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
