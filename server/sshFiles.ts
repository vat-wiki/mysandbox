// SSH 文件端点：远程主机（sshTerminal.ts 的 targets）的文件浏览/编辑/fs 操作，与系统容器
// （files.ts）、宿主（hostFiles.ts）、docker 服务（serviceFiles.ts）四足鼎立。前端对 ssh
// 终端组的文件请求带 'ssh:' 前缀（组 containerId = 'ssh:'+目标名，api.ts filesBase 切到
// /api/ssh/<name>/*，约定与 HOST_ID / 's:' 哨兵同源）。
//
// 实现全部走 ssh（sshChannel.ts 基元，BatchMode 快败）：参数来自 HTTP 请求，argv 由通道层
// 真转义单引号包裹（ssh 把 argv 拼成命令串交远端登录 shell 解析）。脚本大多与 files.ts /
// serviceFiles.ts 同源复制、退出码约定逐条对齐（2=不存在 3=非目录/非文件 4=stat 失败
// 5=超限 9=已存在 7=非仓库 127=无 git）；列目录/mtime 单源复用 files.ts 的 LIST_SCRIPT /
// MTIME_SNIPPET（GNU/busybox 双分支——远端是 alpine 也通）。远端 OS 门槛：非 Linux
//（macOS/BSD 的 stat -c 缺失会静默列空）由 requireRemoteLinux 明确拒绝。
//
// cwd 与容器侧同构成立：ssh 会话本体在**远端** tmux（专用 socket，sshTerminal.ts
// SSH_SOCKET），pane_current_path 就是远端真实路径——list-panes 直查即得，无需服务侧的
// 进程标记扫描（那是 docker exec 客户端跑在宿主 tmux 里的特有问题）。
//
// 定位：文件面板是 SSH 主机「终端的延伸」里刻意保留的例外（全量对齐：fs 操作 + git 套件
// + 跨面板复制）；OSC 深链/活动扫描/批量操作仍然不进（远端无 mysandbox 种子，边界见
// sshTerminal.ts 文件头）。
import type { FastifyInstance } from 'fastify';
import { getSshTargets, type SshTarget } from './state.js';
import { HttpError, notFound, conflict, badRequest } from './errors.js';
import { TERMID_RE } from './terminal.js';
import { SSH_NAME_RE, SSH_SOCKET, sshSessionName } from './sshTerminal.js';
import { sshExec, sshFeed, sshSpawn, requireRemoteLinux } from './sshChannel.js';
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

// 前置：目标名过 SSH_NAME_RE（与 WS query 同一防线）+ state.json 查目标（404）。
async function requireTarget(name: string): Promise<SshTarget> {
  if (!SSH_NAME_RE.test(name)) throw badRequest('invalid target name');
  const t = (await getSshTargets()).find((x) => x.name === name);
  if (!t) throw notFound(`ssh target "${name}" not found`);
  return t;
}

// 列表错误映射（files.ts mapListErr 同款退出码约定）。
function mapListErr(r: { exitCode: number; stderr: string }, path: string): HttpError {
  if (r.exitCode === 2) return notFound(`path not found: ${path}`);
  if (r.exitCode === 3) return new HttpError(400, 'not a directory', 'not_a_directory');
  return new HttpError(500, r.stderr.trim() || `list failed (exit ${r.exitCode})`, 'list_failed');
}

// 会话活跃 pane 的当前目录（远端 tmux 直查，输出「1 <path>」取活跃行——与 sshTerminal.ts
// 分屏 cwd 继承的查询同形状）。exitCode 1 = 会话不存在。
async function remotePaneCwd(t: SshTarget, termId: string): Promise<string | null> {
  const r = await sshExec(
    t,
    ['tmux', '-L', SSH_SOCKET, 'list-panes', '-t', `=${sshSessionName(termId)}:`, '-F', '#{pane_active} #{pane_current_path}'],
    10_000,
  );
  if (r.exitCode !== 0) return null;
  const line = r.stdout.split('\n').map((l) => l.trim()).find((l) => l.startsWith('1 '));
  const cwd = line?.slice(2) ?? '';
  return cwd.startsWith('/') ? cwd : null;
}

export function registerSshFileRoutes(app: FastifyInstance): void {
  // —— 终端 pane（远端 tmux 会话）当前目录 ——
  app.get('/api/ssh/:name/cwd', async (req): Promise<{ cwd: string }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const cwd = await remotePaneCwd(t, termId);
    if (!cwd) throw notFound('terminal session not found');
    return { cwd };
  });

  // —— 列目录 ——（脚本单源 files.ts LIST_SCRIPT（busybox 兜底）；hostPath 恒 null：
  // 远端 fs 不在本机，前端对 null 隐藏「复制实际路径」，同服务组。）
  app.get('/api/ssh/:name/files', async (req) => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await sshExec(t, ['sh', '-c', LIST_SCRIPT, 'sh', path], 10_000);
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
  app.get('/api/ssh/:name/file', async (req) => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const fname = path.slice(path.lastIndexOf('/') + 1);
    const res = await sshExec(
      t,
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
    '/api/ssh/:name/file',
    { bodyLimit: 16 * 1024 * 1024 },
    async (req): Promise<{ ok: true; mtime?: number }> => {
      const t = await requireTarget((req.params as { name: string }).name);
      await requireRemoteLinux(t);
      const body = (req.body as { path?: unknown; content?: unknown; baseMtime?: unknown }) || {};
      const path = cleanPath(body.path);
      if (typeof body.content !== 'string') throw badRequest('content (string) required');
      const content = body.content;
      if (content.length > MAX_BYTES)
        throw new HttpError(413, `content too large (limit ${MAX_BYTES} bytes)`, 'too_large');
      const hasBaseMtime = typeof body.baseMtime === 'number' && body.baseMtime > 0;
      const baseMtime = hasBaseMtime ? (body.baseMtime as number) : undefined;

      if (baseMtime !== undefined) {
        const st = await sshExec(
          t,
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

      const wr = await sshFeed(
        t,
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
      const st = await sshExec(
        t,
        ['sh', '-c', `f="$1"; ${MTIME_SNIPPET}`, 'sh', path],
        8_000,
      );
      const mtime = st.exitCode === 0 ? Number(st.stdout.trim()) || undefined : undefined;
      return { ok: true, ...(mtime !== undefined ? { mtime } : {}) };
    },
  );

  // —— 下载（文件/目录，流式；tar/cat 直通与 files.ts / serviceFiles.ts 同源）——
  app.get('/api/ssh/:name/download', async (req, reply) => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const fname = path.slice(path.lastIndexOf('/') + 1);
    if (!fname) throw badRequest('cannot download /');
    const st = await sshExec(
      t,
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
      ? sshSpawn(t, ['tar', '-C', parent, '-czf', '-', '--', fname])
      : sshSpawn(t, ['cat', '--', path]);
    reply.header('content-type', isDir ? 'application/gzip' : 'application/octet-stream');
    reply.header('content-disposition', contentDisposition(isDir ? `${fname}.tar.gz` : fname));
    if (!isDir && Number(sizeS) > 0) reply.header('content-length', String(Number(sizeS)));
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) h.kill();
    });
    // stderr 收进来：ssh 传输错误（连接断/认证失败）只有这里有人话。
    let es = '';
    h.stderr?.on('data', (d: Buffer) => { es += d.toString('utf8'); });
    const done = new Promise<{ exitCode: number; stderr: string }>((res) =>
      h.on('close', (code) => res({ exitCode: code ?? -1, stderr: es })),
    );
    h.on('error', () => { /* spawn 失败：done 以 -1 收场 */ });
    const guard = await streamProbe(h.stdout, done);
    if (guard && guard.exitCode !== 0) {
      throw new HttpError(400, guard.stderr.trim() || `download failed (exit ${guard.exitCode})`, 'download_failed');
    }
    return reply.send(h.stdout);
  });

  // —— 新建 / 重命名 / 删除 ——（脚本与退出码约定同 files.ts）
  app.post('/api/ssh/:name/fs/create', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown; type?: unknown }) || {};
    const path = cleanPath(body.path);
    const type = body.type === 'dir' ? 'dir' : body.type === 'file' ? 'file' : undefined;
    if (!type) throw badRequest('type must be "file" or "dir"');
    const res = await sshExec(
      t,
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
  app.post('/api/ssh/:name/fs/rename', async (req): Promise<{ ok: true; to: string }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown; name?: unknown; toDir?: unknown }) || {};
    const path = cleanPath(body.path);
    const nname = body.name;
    if (typeof nname !== 'string' || !nname || nname.includes('/') || nname === '.' || nname === '..' || nname.length > 255) {
      throw badRequest('invalid name');
    }
    const toDir = body.toDir === undefined ? (parentOf(path) ?? '/') : cleanPath(body.toDir, 'toDir');
    if (toDir === path || toDir.startsWith(`${path}/`)) throw badRequest('不能把目录移动到它自己（或其子目录）里');
    const to = toDir === '/' ? `/${nname}` : `${toDir}/${nname}`;
    const res = await sshExec(
      t,
      ['sh', '-c', '[ -e "$2" ] && exit 9; mv -- "$1" "$2"', 'sh', path, to],
      8_000,
    );
    if (res.exitCode === 9) throw conflict('同名文件或目录已存在');
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `rename failed (exit ${res.exitCode})`, 'rename_failed');
    return { ok: true, to };
  });

  app.post('/api/ssh/:name/fs/delete', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await sshExec(
      t,
      ['sh', '-c', '[ -e "$1" ] || exit 9; rm -r -- "$1"', 'sh', path],
      30_000,
    );
    if (res.exitCode === 9) throw notFound(`path not found: ${path}`);
    if (res.exitCode !== 0)
      throw new HttpError(400, res.stderr.trim() || `delete failed (exit ${res.exitCode})`, 'delete_failed');
    return { ok: true };
  });

  // —— 终端路径链接解析（Ctrl+点击）——
  // cwd 源与 /cwd 同（远端 tmux 直查）；~ 展开用远端登录用户的 $HOME（与会话 shell 一致）。
  // readlink -m 失败（busybox 等无 -m）容忍降级。
  app.get('/api/ssh/:name/resolve', async (req): Promise<{ path: string; kind: 'dir' | 'file' | 'missing' }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const termId = q.termId || '';
    if (!TERMID_RE.test(termId)) throw badRequest('invalid termId');
    const raw = q.path;
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || raw.includes('\n') || raw.length > 4096) {
      throw badRequest('invalid path');
    }
    const script = [
      'p="$1"; s="$2"',
      // = 前缀精确匹配（tmux -t 默认前缀匹配，files.ts 容器侧同防线）
      `cwd=$(tmux -L ${SSH_SOCKET} list-panes -t "=$s:" -F '#{pane_active} #{pane_current_path}' 2>/dev/null | sed -n 's/^1 //p')`,
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
    const res = await sshExec(t, ['sh', '-c', script, 'sh', raw, sshSessionName(termId)], 8_000);
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
  // 与 files.ts / hostFiles.ts / serviceFiles.ts 同款套件：脚本逐条同源（ssh 运输），解析
  // 单源 gitpanel.ts。远端没 git 的可辨识形态是 127（command not found），按非仓库返回
  //（dock 整块隐藏，与「没仓库」同语义）。
  app.get('/api/ssh/:name/git/status', async (req): Promise<GitStatusView> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await sshExec(
      t,
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
  app.get('/api/ssh/:name/git/diff', async (req): Promise<GitDiffView> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const headPath = q.headPath ? cleanPath(q.headPath, 'headPath') : path;
    const res = await sshExec(
      t,
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
  app.get('/api/ssh/:name/git/branches', async (req): Promise<GitBranchesView> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/checkout', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown; name?: unknown; create?: unknown; remote?: unknown }) || {};
    const path = cleanPath(body.path);
    const bname = assertBranchName(body.name);
    const local = body.remote ? assertBranchName(bname.slice(bname.indexOf('/') + 1)) : '';
    const guard = "case \"$n\" in ''|-*) exit 9 ;; esac";
    const res = await sshExec(
      t,
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

  // —— 撤销变更（脚本与 files.ts 同一形状；127 = 远端没 git 按非仓库回）——
  // 三种目标互斥：file（+可选 oldFile）/ dir（目录下全部）/ all（整个工作区）。详版注释
  // 见 files.ts 同名端点。
  app.post('/api/ssh/:name/git/restore', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
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
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/fetch', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/pull', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/push', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/branch-delete', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const bname = assertBranchName(body.name);
    const res = await sshExec(
      t,
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
  app.get('/api/ssh/:name/git/worktrees', async (req): Promise<GitWorktreesView> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const q = (req.query as Record<string, string | undefined>) || {};
    const path = cleanPath(q.path);
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/worktree-add', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown; dir?: unknown; mode?: unknown; name?: unknown }) || {};
    const path = cleanPath(body.path);
    const dir = assertWorktreeDir(body.dir);
    const mode = body.mode;
    if (mode !== 'branch' && mode !== 'new' && mode !== 'remote') throw badRequest('mode 不合法');
    const bname = assertBranchName(body.name);
    const local = mode === 'remote' ? assertBranchName(bname.slice(bname.indexOf('/') + 1)) : '';
    const guard = "case \"$d\" in ''|-*) exit 9 ;; esac";
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/worktree-remove', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown; dir?: unknown; force?: unknown }) || {};
    const path = cleanPath(body.path);
    const dir = assertWorktreeDir(body.dir);
    const res = await sshExec(
      t,
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

  app.post('/api/ssh/:name/git/worktree-prune', async (req): Promise<{ ok: true }> => {
    const t = await requireTarget((req.params as { name: string }).name);
    await requireRemoteLinux(t);
    const body = (req.body as { path?: unknown }) || {};
    const path = cleanPath(body.path);
    const res = await sshExec(
      t,
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
