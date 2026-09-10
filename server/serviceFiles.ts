// 服务文件端点：docker 服务容器（应用容器）的文件浏览/编辑/fs 操作，与系统容器
// （files.ts）、宿主（hostFiles.ts）三足鼎立。前端对服务组的文件请求带 's:' 前缀
// （api.ts filesBase 切到 /api/services/<name>/*，约定与 termSessionKey 的 s: 同源）。
//
// 实现全部走 docker exec：`execFile('docker', ['exec', name, 'sh', '-c', <脚本>, 'sh', <argv...>])`
// 数组参数无 shell 注入面。脚本大多与 files.ts 同源复制、退出码约定逐条对齐
// （2=不存在 3=非目录/非文件 4=stat 失败 5=超限 9=已存在）；列目录/mtime 单源复用
// files.ts 的 LIST_SCRIPT / MTIME_SNIPPET——服务镜像是 alpine 系时是 busybox，find 无
// -printf、老版 date -r 语义不同（脚本内有探测兜底，实测 myapikey alpine 全通）。
//
// cwd 与容器侧的关键差异：服务终端的 tmux 在宿主（hostTerminal.ts 的 svc 会话），
// pane 跑的是 docker exec **客户端**——pane_current_path 是宿主路径，不是容器内 cwd。
// 改用进程标记：建会话时 `docker exec -e MYSANDBOX_TERM=<termId>` 注入唯一标记，查询时
// 进容器扫 /proc/*/environ，取「带标记且父进程不带标记」的直启进程（= exec 的那个 shell；
// 子进程继承标记但父进程也带标记，被排除）读 /proc/<pid>/cwd。老会话无标记 -> 404 ->
// 前端占位，重开服务终端 tab（新会话）即恢复。
//
// git 套件与容器/宿主同款全量（status/diff/branches/checkout/fetch/pull/push/branch-delete/
// worktrees×4，脚本同源、解析单源 gitpanel.ts）；镜像没 git（127）按非仓库返回，dock 整块隐藏。
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { listServiceContainers } from './docker.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { TERMID_RE } from './terminal.js';
import { getServiceMeta } from './state.js';
import {
  MAX_BYTES,
  LIST_SCRIPT,
  MTIME_SNIPPET,
  classifyContent,
  cleanPath,
  contentDisposition,
  parentOf,
  parseDiffProto,
  streamProbe,
} from './files.js';
import {
  parsePorcelainZ,
  parseBranchList,
  parseRemoteBranches,
  parseWorktreeListZ,
  mapGitExit,
  assertBranchName,
  assertGitRelPath,
  assertWorktreeDir,
  type GitStatusView,
  type GitDiffView,
  type GitBranchesView,
  type GitWorktreesView,
} from './gitpanel.js';

const execFileAsync = promisify(execFile);

// 与 services.ts 创建侧的 NAME_RE 同规则（服务名的唯一权威形态）。
const NAME_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
// 收编容器名（与 services.ts ADOPT_NAME_RE 同规则）：比 NAME_RE 宽出的 `_` 是 compose 惯例。
const ADOPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

// —— docker exec 基元 ——

// 收尾型 exec（整包收 utf8 串，脚本输出量可控：列表/读文件上限 2MB base64 ~2.7MB）。
// 超时按 504 上抛（daemon 卡死不该伪装成容器内错误）；非 0 退出按 exec 结果返回。
async function svcExec(
  name: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('docker', ['exec', name, ...args], {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
    if (err.killed) throw new HttpError(504, 'docker exec timeout', 'exec_timeout');
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

// stdin 喂入型 exec（写文件；-i 关闭 stdin 即 EOF，容器内 cat > file 收尾）。
function svcFeed(
  name: string,
  args: string[],
  input: Buffer,
  timeoutMs: number,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const c = spawn('docker', ['exec', '-i', name, ...args], { stdio: ['pipe', 'ignore', 'pipe'] });
    const errs: Buffer[] = [];
    let settled = false;
    const done = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, stderr: Buffer.concat(errs).toString('utf8') });
    };
    const timer = setTimeout(() => {
      try { c.kill('SIGKILL'); } catch { /* noop */ }
      done(-1);
    }, timeoutMs);
    c.stderr?.on('data', (d: Buffer) => errs.push(d));
    c.on('error', (e) => {
      settled = true;
      clearTimeout(timer);
      rejectPromise(e);
    });
    c.on('close', (code) => done(code ?? -1));
    c.stdin?.on('error', () => { /* 写入撞 EPIPE：退出码说话 */ });
    c.stdin?.end(input);
  });
}

// —— 前置检查 ——

// 受管服务查找：listServiceContainers 双源（label 集 ∪ 收编名集，收编凭证在 adopted
// meta——非 mysandbox 且未收编的容器即使同名也结构性进不来）。返回 null = 404。
async function lookupService(name: string): Promise<{ running: boolean } | null> {
  const adopted = !!(await getServiceMeta(name))?.adopted;
  const rows = await listServiceContainers(adopted ? [name] : []);
  const row = rows.find((r) => r.Names.split(',')[0].replace(/^\//, '') === name);
  return row ? { running: row.State === 'running' } : null;
}

async function requireServiceRunning(name: string): Promise<void> {
  // 收编容器名允许 `_`（compose 惯例），仅以 adopted meta 为凭证放宽。
  if (!NAME_RE.test(name) && !((await getServiceMeta(name))?.adopted && ADOPT_NAME_RE.test(name))) {
    throw badRequest('invalid service name');
  }
  const svc = await lookupService(name);
  if (!svc) throw notFound(`service "${name}" not found`);
  if (!svc.running) throw conflict('service not running');
}

// 列表错误映射（files.ts mapListErr 同款退出码约定）。
function mapListErr(r: { exitCode: number; stderr: string }, path: string): HttpError {
  if (r.exitCode === 2) return notFound(`path not found: ${path}`);
  if (r.exitCode === 3) return new HttpError(400, 'not a directory', 'not_a_directory');
  return new HttpError(500, r.stderr.trim() || `list failed (exit ${r.exitCode})`, 'list_failed');
}

// 会话 shell 的容器内 cwd 扫描（arg = 持 termId 的位置参数名；exit 2 = 无带标记会话进程）。
// stderr 一律丢弃：非本用户/不可 dump 进程的 /proc/*/environ 读不动是常态（实测 postgres
// 主进程就是）。
const cwdScan = (arg: string) => [
  `m="MYSANDBOX_TERM=$${arg}"`,
  'for e in /proc/[0-9]*/environ; do',
  '  [ -r "$e" ] || continue',
  '  tr "\\0" "\\n" < "$e" 2>/dev/null | grep -Fqx "$m" || continue',
  '  p=${e#/proc/}; p=${p%/environ}',
  '  pp=$(grep "^PPid:" /proc/$p/status 2>/dev/null | tr -dc 0-9)',
  '  if [ -n "$pp" ]; then',
  '    tr "\\0" "\\n" < /proc/$pp/environ 2>/dev/null | grep -Fqx "$m" && continue',
  '  fi',
  '  readlink /proc/$p/cwd',
  '  exit 0',
  'done',
  'exit 2',
].join('\n');
const CWD_SCAN = cwdScan('1');

export function registerServiceFileRoutes(app: FastifyInstance): void {
  // —— 终端 pane（= exec 的那个 shell）容器内当前目录 ——
  app.get('/api/services/:name/cwd', async (req): Promise<{ cwd: string }> => {
    const name = (req.params as { name: string }).name;
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    await requireServiceRunning(name);
    const res = await svcExec(name, ['sh', '-c', CWD_SCAN, 'sh', termId], 5_000);
    if (res.exitCode !== 0) throw notFound('terminal session not found');
    const cwd = res.stdout.trim();
    if (!cwd || !cwd.startsWith('/')) throw notFound('terminal session not found');
    return { cwd };
  });

  // —— 列目录 ——（脚本单源 files.ts LIST_SCRIPT（busybox 兜底，文件头有协议说明）；
  // hostPath 恒 null：docker 容器 fs 没有稳定的宿主实址（overlayfs 挂载点随驱动/快照漂移），
  // 前端对 null 本就隐藏「复制实际路径」）
  app.get('/api/services/:name/files', async (req) => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await svcExec(name, ['sh', '-c', LIST_SCRIPT, 'sh', path], 10_000);
    if (res.exitCode !== 0) throw mapListErr(res, path);
    const entries = [];
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
    return { path, parent: parentOf(path), entries, hostPath: null };
  });

  // —— 读文件 ——（META+base64 协议与 files.ts 同源）
  app.get('/api/services/:name/file', async (req) => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const fname = path.slice(path.lastIndexOf('/') + 1);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        `f="$1"; [ -e "$f" ] || exit 2; [ -f "$f" ] || exit 3; sz=$(stat -c %s "$f") || exit 4; [ "$sz" -le ${MAX_BYTES} ] || exit 5; printf "META %s " "$sz"; ${MTIME_SNIPPET}; printf "\\n"; base64 "$f"`,
        'sh', path,
      ],
      20_000,
    );
    if (res.exitCode === 2) throw notFound(`file not found: ${path}`);
    if (res.exitCode === 3) throw new HttpError(400, 'not a regular file', 'not_a_file');
    if (res.exitCode === 5)
      throw new HttpError(413, `file too large (limit ${MAX_BYTES} bytes)`, 'too_large');
    if (res.exitCode !== 0)
      throw new HttpError(500, res.stderr.trim() || `read failed (exit ${res.exitCode})`, 'read_failed');
    const lines = res.stdout.split('\n');
    const meta = (lines[0] || '').split(' ');
    const buf = Buffer.from(lines.slice(1).join('\n'), 'base64');
    const { binary, content } = classifyContent(buf);
    return {
      path,
      name: fname,
      size: Number(meta[1]) || 0,
      mtime: Number(meta[2]) || 0,
      binary,
      ...(binary ? {} : { content }),
    };
  });

  // —— 写文件 ——（baseMtime 乐观锁 + stdin cat > 写，语义同 files.ts）
  app.put(
    '/api/services/:name/file',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req): Promise<{ ok: true; mtime?: number }> => {
      const name = (req.params as { name: string }).name;
      await requireServiceRunning(name);
      const body = (req.body as { path?: unknown; content?: unknown; baseMtime?: unknown }) || {};
      const path = cleanPath(body.path);
      if (typeof body.content !== 'string') throw badRequest('content (string) required');
      const content = body.content;
      if (content.length > MAX_BYTES)
        throw new HttpError(413, `content too large (limit ${MAX_BYTES} bytes)`, 'too_large');
      const hasBaseMtime = typeof body.baseMtime === 'number' && body.baseMtime > 0;
      const baseMtime = hasBaseMtime ? (body.baseMtime as number) : undefined;

      if (baseMtime !== undefined) {
        const st = await svcExec(
          name,
          ['sh', '-c', `f="$1"; [ -e "$f" ] || exit 2; [ -f "$f" ] || exit 3; ${MTIME_SNIPPET}`, 'sh', path],
          8_000,
        );
        if (st.exitCode === 2 || st.exitCode === 3) {
          throw conflict('文件已被删除或不是普通文件，请重载');
        }
        if (st.exitCode !== 0) {
          throw new HttpError(500, st.stderr.trim() || 'stat failed', 'stat_failed');
        }
        if (Number(st.stdout.trim()) !== baseMtime) {
          throw conflict('文件在编辑期间被修改（mtime 不一致），请重载或覆盖');
        }
      }

      const wr = await svcFeed(
        name,
        [
          'sh', '-c',
          // 与 files.ts 同款：${1%/*} 取 dirname（根下为空串回退 /），隐式建父目录。
          'd="${1%/*}"; [ -n "$d" ] || d=/; mkdir -p "$d" && cat > "$1"',
          'sh', path,
        ],
        Buffer.from(content, 'utf8'),
        30_000,
      );
      if (wr.exitCode !== 0) {
        throw new HttpError(400, wr.stderr.trim() || `write failed (exit ${wr.exitCode})`, 'write_failed');
      }
      const st = await svcExec(
        name,
        ['sh', '-c', `f="$1"; ${MTIME_SNIPPET}`, 'sh', path],
        8_000,
      );
      const mtime = st.exitCode === 0 ? Number(st.stdout.trim()) || undefined : undefined;
      return { ok: true, ...(mtime !== undefined ? { mtime } : {}) };
    },
  );

  // —— 下载（文件/目录，流式；tar/cat 直通与 files.ts 同源）——
  app.get('/api/services/:name/download', async (req, reply) => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const fname = path.slice(path.lastIndexOf('/') + 1);
    if (!fname) throw badRequest('cannot download /');
    const st = await svcExec(
      name,
      [
        'sh', '-c',
        'f="$1"; if [ -d "$f" ]; then echo dir; elif [ -f "$f" ]; then stat -c "file %s" -- "$f" || exit 2; else exit 2; fi',
        'sh', path,
      ],
      10_000,
    );
    if (st.exitCode !== 0) throw mapListErr(st, path);
    const [kind, sizeS] = st.stdout.trim().split(' ');
    const isDir = kind === 'dir';
    const parent = parentOf(path) ?? '/';
    const h = isDir
      ? spawn('docker', ['exec', name, 'tar', '-C', parent, '-czf', '-', '--', fname], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn('docker', ['exec', name, 'cat', '--', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    reply.header('content-type', isDir ? 'application/gzip' : 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(isDir ? `${fname}.tar.gz` : fname));
    if (!isDir && Number(sizeS) > 0) reply.header('content-length', String(Number(sizeS)));
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) h.kill();
    });
    const done = new Promise<{ exitCode: number; stderr: string }>((res) =>
      h.on('close', (code) => res({ exitCode: code ?? -1, stderr: '' })),
    );
    h.stderr?.on('data', () => { /* 错误经退出码映射 */ });
    h.on('error', () => { /* spawn 失败：done 以 -1 收场 */ });
    const guard = await streamProbe(h.stdout, done);
    if (guard && guard.exitCode !== 0) {
      throw new HttpError(400, guard.stderr.trim() || `download failed (exit ${guard.exitCode})`, 'download_failed');
    }
    return reply.send(h.stdout);
  });

  // —— 新建 / 重命名 / 删除 ——（脚本与退出码约定同 files.ts）
  app.post('/api/services/:name/fs/create', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; type?: unknown }) || {};
    const path = cleanPath(body.path);
    const type = body.type === 'dir' ? 'dir' : body.type === 'file' ? 'file' : undefined;
    if (!type) throw badRequest('type must be "file" or "dir"');
    const res = await svcExec(
      name,
      ['sh', '-c', '[ -e "$1" ] && exit 9; { [ "$2" = dir ] && mkdir "$1"; } || : > "$1"', 'sh', path, type],
      8_000,
    );
    if (res.exitCode === 9) throw conflict('同名文件或目录已存在');
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `create failed (exit ${res.exitCode})`, 'create_failed');
    return { ok: true };
  });

  // 重命名 / 移动（toDir 可选 = 目标目录，缺省 = 原父目录纯改名；自嵌套前置拒绝，
  // 语义同 files.ts 容器侧）。
  app.post('/api/services/:name/fs/rename', async (req): Promise<{ ok: true; to: string }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; name?: unknown; toDir?: unknown }) || {};
    const path = cleanPath(body.path);
    const nname = body.name;
    if (typeof nname !== 'string' || !nname || nname.includes('/') || nname === '.' || nname === '..' || nname.length > 255) {
      throw badRequest('invalid name');
    }
    const toDir = body.toDir === undefined ? (parentOf(path) ?? '/') : cleanPath(body.toDir, 'toDir');
    if (toDir === path || toDir.startsWith(`${path}/`)) throw badRequest('不能把目录移动到它自己（或其子目录）里');
    const to = toDir === '/' ? `/${nname}` : `${toDir}/${nname}`;
    const res = await svcExec(
      name,
      ['sh', '-c', '[ -e "$2" ] && exit 9; mv -- "$1" "$2"', 'sh', path, to],
      8_000,
    );
    if (res.exitCode === 9) throw conflict('同名文件或目录已存在');
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `rename failed (exit ${res.exitCode})`, 'rename_failed');
    return { ok: true, to };
  });

  app.post('/api/services/:name/fs/delete', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await svcExec(
      name,
      ['sh', '-c', '[ -e "$1" ] || exit 9; rm -r -- "$1"', 'sh', path],
      30_000,
    );
    if (res.exitCode === 9) throw notFound(`path not found: ${path}`);
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `delete failed (exit ${res.exitCode})`, 'delete_failed');
    return { ok: true };
  });

  // —— 终端路径链接解析（Ctrl+点击）——
  // cwd 源与 /cwd 同（进程标记扫描）；~ 展开用 exec 默认用户的 $HOME（docker exec 继承
  // 镜像 USER 的家目录，与会话 shell 一致）。readlink -m 失败（busybox 等无 -m）容忍降级。
  app.get('/api/services/:name/resolve', async (req): Promise<{ path: string; kind: 'dir' | 'file' | 'missing' }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const raw = q.path;
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\n') || raw.length > 4096) {
      throw badRequest('invalid path');
    }
    const script = [
      'p="$1"',
      `cwd=$(${cwdScan('2')})`,
      '[ -n "$cwd" ] || exit 2',
      'case "$p" in',
      '  "") p="$cwd" ;;',
      '  "~") p="$HOME" ;;',
      '  "~/"*) p="$HOME/${p#"~/"}" ;;',
      '  /*) ;;',
      '  *) p="$cwd/$p" ;;',
      'esac',
      'q=$(readlink -m -- "$p" 2>/dev/null) && p="$q"',
      'if [ -d "$p" ]; then printf "d %s\\n" "$p"',
      'elif [ -e "$p" ]; then printf "f %s\\n" "$p"',
      'else printf "m %s\\n" "$p"; fi',
    ].join('\n');
    const res = await svcExec(name, ['sh', '-c', script, 'sh', raw, termId], 8_000);
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
  // 与 files.ts / hostFiles.ts 同款套件：脚本逐条同源（docker exec 运输），解析单源
  // gitpanel.ts。镜像没 git 时 rev-parse exit 127 -> mapGitExit 报错？——否：git 不存在
  // 的可辨识形态是 127（command not found），按非仓库返回（dock 整块隐藏，与「没仓库」
  // 同语义，不给用户报一堆红字）。git 镜像内的仓库照常全套可用。
  app.get('/api/services/:name/git/status', async (req): Promise<GitStatusView> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        // --untracked-files=all：untracked 目录展开成逐个文件，列表不出现「目录」条目
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; printf "%s\\n" "$t"; git --no-optional-locks -C "$t" status --porcelain=v1 -z --branch --untracked-files=all',
        'sh', path,
      ],
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) return { repo: false };
    const err = mapGitExit(res, 'status');
    if (err) throw err;
    const nl = res.stdout.indexOf('\n');
    const toplevel = res.stdout.slice(0, nl); // 空串/异常形状按非仓库兜底
    if (nl < 0 || !toplevel.startsWith('/')) return { repo: false };
    return { repo: true, toplevel, ...parsePorcelainZ(res.stdout.slice(nl + 1)) };
  });

  // —— git 变更对比（HEAD 版本 vs 工作区，Monaco diff 视图数据源；协议同 files.ts）——
  app.get('/api/services/:name/git/diff', async (req): Promise<GitDiffView> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const headPath = q.headPath ? cleanPath(q.headPath, 'headPath') : path;
    const res = await svcExec(
      name,
      [
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
      30_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) return { repo: false, toplevel: '', file: path, base: {}, work: {} };
    const err = mapGitExit(res, 'diff');
    if (err) throw err;
    return parseDiffProto(res.stdout, path, headPath);
  });

  // —— git 分支列表 / 切换（协议与 files.ts 同源）——
  app.get('/api/services/:name/git/branches', async (req): Promise<GitBranchesView> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
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
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) return { repo: false };
    const err = mapGitExit(res, 'branches');
    if (err) throw err;
    const nl = res.stdout.indexOf('\n');
    const toplevel = res.stdout.slice(0, nl);
    if (nl < 0 || !toplevel.startsWith('/')) return { repo: false };
    const lines = res.stdout.slice(nl + 1).split('\n');
    const sep = lines.findIndex((l) => l !== '' && l[0] !== '*' && l[0] !== ' ');
    const local = parseBranchList((sep < 0 ? lines : lines.slice(0, sep)).join('\n'));
    const remotes = sep < 0 ? [] : parseRemoteBranches(lines.slice(sep + 1).join('\n'));
    return { repo: true, toplevel, ...local, remotes };
  });

  app.post('/api/services/:name/git/checkout', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; name?: unknown; create?: unknown; remote?: unknown }) || {};
    const path = cleanPath(body.path);
    const bname = assertBranchName(body.name);
    const local = body.remote ? assertBranchName(bname.slice(bname.indexOf('/') + 1)) : '';
    const guard = "case \"$n\" in ''|-*) exit 9 ;; esac";
    const res = await svcExec(
      name,
      [
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
        'sh', path, bname, ...(body.remote ? [local] : [body.create ? '1' : '0']),
      ],
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('分支名不合法');
    const err = mapGitExit(res, '分支切换');
    if (err) throw err;
    return { ok: true };
  });

  // —— 撤销变更（脚本与 files.ts 同一形状；127 = 镜像没 git 按非仓库回）——
  // 三种目标互斥：file（+可选 oldFile）/ dir（目录下全部）/ all（整个工作区）。详版注释
  // 见 files.ts 同名端点。
  app.post('/api/services/:name/git/restore', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; file?: unknown; oldFile?: unknown; dir?: unknown; all?: unknown }) || {};
    const path = cleanPath(body.path);
    const all = body.all === true;
    const file = body.file == null ? '' : assertGitRelPath(body.file);
    const dir = body.dir == null ? '' : assertGitRelPath(body.dir, 'dir');
    const oldFile = body.oldFile == null ? '' : assertGitRelPath(body.oldFile, 'oldFile');
    if ((all ? 1 : 0) + (file ? 1 : 0) + (dir ? 1 : 0) !== 1) throw badRequest('file / dir / all 三选一');
    if (oldFile && !file) throw badRequest('oldFile 仅随 file 使用');
    const fileSh = [
      'p="$1"; f="$2"; o="$3"',
      't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
      'r1() {',
      '  if git -C "$t" cat-file -e "HEAD:$1" 2>/dev/null; then',
      '    git -C "$t" checkout -q HEAD -- ":(literal)$1" || exit 20',
      '  else',
      '    git -C "$t" reset -q HEAD -- ":(literal)$1" 2>/dev/null',
      '    rm -f -- "$t/$1"',
      '  fi',
      '}',
      'r1 "$f"',
      '[ -n "$o" ] && r1 "$o"',
      'exit 0',
    ].join('\n');
    const dirSh = [
      'p="$1"; d="$2"',
      't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
      'if git -C "$t" rev-parse -q --verify HEAD >/dev/null 2>&1; then',
      '  git -C "$t" reset -q HEAD -- ":(literal)$d" 2>/dev/null',
      '  if [ -n "$(git -C "$t" ls-files -- ":(literal)$d" | head -n 1)" ]; then',
      '    git -C "$t" checkout -q HEAD -- ":(literal)$d" || exit 20',
      '  fi',
      'else',
      '  git -C "$t" read-tree --empty || exit 20',
      'fi',
      'git -C "$t" clean -q -f -d -- ":(literal)$d" || exit 21',
      'exit 0',
    ].join('\n');
    const allSh = [
      'p="$1"',
      't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
      'if git -C "$t" rev-parse -q --verify HEAD >/dev/null 2>&1; then',
      '  git -C "$t" reset -q --hard HEAD || exit 20',
      'else',
      '  git -C "$t" read-tree --empty || exit 20',
      'fi',
      'git -C "$t" clean -q -f -d || exit 21',
      'exit 0',
    ].join('\n');
    const res = await svcExec(
      name,
      [
        'sh', '-c', all ? allSh : dir ? dirSh : fileSh,
        'sh', path, ...(all ? [] : dir ? [dir] : [file, oldFile]),
      ],
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 20) throw badRequest(res.stderr.trim() || '撤销变更失败（git checkout 失败）');
    if (res.exitCode === 21) throw badRequest(res.stderr.trim() || '撤销变更失败（清理未跟踪文件出错）');
    const err = mapGitExit(res, '撤销变更');
    if (err) throw err;
    return { ok: true };
  });

  // —— fetch / pull / push（远端三件套；pull 恒 --ff-only，push 无上游且恰好一个远端时
  // 自动 -u。fetch/pull/push 涉及网络，超时放宽 120s，与 files.ts 同）——
  const GIT_NET_TIMEOUT = 120_000;

  app.post('/api/services/:name/git/fetch', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; exec git -C "$t" fetch --all --prune',
        'sh', path,
      ],
      GIT_NET_TIMEOUT,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    const err = mapGitExit(res, 'fetch');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/services/:name/git/pull', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; exec git -C "$t" pull --ff-only',
        'sh', path,
      ],
      GIT_NET_TIMEOUT,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    const err = mapGitExit(res, 'pull');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/services/:name/git/push', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        [
          'p="$1"',
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          'if git -C "$t" rev-parse --abbrev-ref --symbolic-full-name \'@{u}\' >/dev/null 2>&1; then exec git -C "$t" push; fi',
          'n=$(git -C "$t" remote | wc -l); [ "$n" = 1 ] || exit 10',
          'r=$(git -C "$t" remote); exec git -C "$t" push -u "$r" HEAD',
        ].join('\n'),
        'sh', path,
      ],
      GIT_NET_TIMEOUT,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 10) throw badRequest('当前分支没有上游且远端不止一个，请在终端手动推送');
    const err = mapGitExit(res, 'push');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/services/:name/git/branch-delete', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const bname = assertBranchName(body.name);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        [
          'p="$1"; n="$2"',
          "case \"$n\" in ''|-*) exit 9 ;; esac",
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          // -d 安全删：未合并的分支 git 自行拒绝，报 stderr 原话
          'exec git -C "$t" branch -d "$n"',
        ].join('\n'),
        'sh', path, bname,
      ],
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('分支名不合法');
    const err = mapGitExit(res, '删除分支');
    if (err) throw err;
    return { ok: true };
  });

  // —— git worktree 管理（协议与退出码同 files.ts：7 非仓库 / 9 名字不合法 / 11 嵌套）——
  app.get('/api/services/:name/git/worktrees', async (req): Promise<GitWorktreesView> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; printf "%s\\n" "$t"; git --no-optional-locks -C "$t" worktree list --porcelain -z',
        'sh', path,
      ],
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) return { repo: false };
    const err = mapGitExit(res, 'worktree list');
    if (err) throw err;
    const nl = res.stdout.indexOf('\n');
    const toplevel = res.stdout.slice(0, nl);
    if (nl < 0 || !toplevel.startsWith('/')) return { repo: false };
    return { repo: true, toplevel, worktrees: parseWorktreeListZ(res.stdout.slice(nl + 1)) };
  });

  app.post('/api/services/:name/git/worktree-add', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; dir?: unknown; mode?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const dir = assertWorktreeDir(body.dir);
    const mode = body.mode;
    if (mode !== 'branch' && mode !== 'new' && mode !== 'remote') throw badRequest('mode 不合法');
    const bname = assertBranchName(body.name);
    const local = mode === 'remote' ? assertBranchName(bname.slice(bname.indexOf('/') + 1)) : '';
    const guard = "case \"$d\" in ''|-*) exit 9 ;; esac";
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        [
          'p="$1"; d="$2"; m="$3"; n="$4"; l="$5"',
          guard,
          "case \"$m\" in branch|new|remote) ;; *) exit 9 ;; esac",
          "case \"$n\" in ''|-*) exit 9 ;; esac",
          't=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7',
          // 嵌套拦截：新 worktree 不能建在任何现有工作树内部（含主树自身）
          'case "$d" in "$t"|"$t"/*) exit 11 ;; esac',
          'if [ "$m" = branch ]; then exec git -C "$t" worktree add "$d" "$n"; fi',
          'if [ "$m" = remote ]; then exec git -C "$t" worktree add -b "$l" --track "$d" "$n"; fi',
          'exec git -C "$t" worktree add -b "$n" "$d"',
        ].join('\n'),
        'sh', path, dir, mode, bname, local,
      ],
      30_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('worktree 路径或分支名不合法');
    if (res.exitCode === 11) throw badRequest('目标目录在现有工作树内部，请选仓库外的目录');
    const err = mapGitExit(res, '创建 worktree');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/services/:name/git/worktree-remove', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown; dir?: unknown; force?: unknown }) || {};
    const path = cleanPath(body.path);
    const dir = assertWorktreeDir(body.dir);
    const res = await svcExec(
      name,
      [
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
      30_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    if (res.exitCode === 9) throw badRequest('worktree 路径不合法');
    const err = mapGitExit(res, '移除 worktree');
    if (err) throw err;
    return { ok: true };
  });

  app.post('/api/services/:name/git/worktree-prune', async (req): Promise<{ ok: true }> => {
    const name = (req.params as { name: string }).name;
    await requireServiceRunning(name);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await svcExec(
      name,
      [
        'sh', '-c',
        'p="$1"; t=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null) || exit 7; exec git -C "$t" worktree prune',
        'sh', path,
      ],
      15_000,
    );
    if (res.exitCode === 7 || res.exitCode === 127) throw badRequest('目标目录不在 git 仓库内');
    const err = mapGitExit(res, '清理 worktree');
    if (err) throw err;
    return { ok: true };
  });
}
