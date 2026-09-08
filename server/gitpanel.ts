// git 面板（FilePanel 内嵌「Git 变更」区块）的共享纯函数层：类型 + porcelain -z 解析 +
// 错误映射。容器侧（files.ts，经 execRun 在容器内跑 sh 脚本）与宿主侧（hostFiles.ts，
// 经 node:child_process 跑 git）两侧的解析语义在此单源，对齐 cleanPath/classifyContent
// 放 files.ts 被两侧复用的先例。
//
// 容器内脚本侧的自定义退出码约定（两侧一致，见 files.ts / hostFiles.ts 注释）：
//   exit 7 = 非仓库（正常态，组装 {repo:false} 以 200 返回，不报错）
//   exit 8 = 请求路径不在仓库内（400 bad_request）
import { HttpError, badRequest } from './errors.js';

export interface GitChange {
  file: string; // 相对 toplevel 的 posix 相对路径；两侧 status 均 -uall 展开 untracked 目录，恒为单个文件（不出现尾 / 的目录条目）
  x: string; // porcelain 第 1 列（index 态）
  y: string; // porcelain 第 2 列（worktree 态）
  oldFile?: string; // 仅 R/C 条目：改名/拷贝前旧路径（-z 下跟在记录后的独立字段）
}

export interface GitStatusView {
  repo: boolean;
  toplevel?: string;
  branch?: string | null; // detached HEAD 时 null
  label?: string; // 展示串：分支名 / '(detached)' / 'main（尚无提交）'
  unborn?: boolean; // 仓库存在但没有任何提交
  ahead?: number;
  behind?: number;
  changes?: GitChange[];
  truncated?: boolean; // 变更条目超过 MAX_CHANGES 截断
}

export interface GitDiffSide {
  absent?: 'unborn' | 'no_head_path' | 'deleted' | 'too_large';
  binary?: boolean;
  content?: string;
  size?: number;
}

export interface GitDiffView {
  repo: boolean; // 防御位，正常恒 true（rev-parse 失败时路由层早退 {repo:false}）
  toplevel: string;
  file: string; // 工作区侧绝对路径
  headFile?: string; // 左侧对应的绝对路径（R 条目 = 旧路径），供标题展示
  base: GitDiffSide; // 左 = HEAD 版本
  work: GitDiffSide; // 右 = 工作区
}

// 分支列表视图（GET git/branches）。只列本地 + 远端分支——远程跟踪分支点击即检出为
// 本地跟踪分支（switch -c --track），除此之外的远程管理（fetch/prune/push）属复杂操作，
// 面板分支菜单刻意只做「切换 / 新建 / 检出远端」。
export interface GitBranchesView {
  repo: boolean;
  toplevel?: string;
  current?: string | null; // 当前分支；detached HEAD 或空仓库（无提交）为 null
  branches?: string[]; // 本地分支名（当前分支排最前，其余按 git 自身的字母序）
  remotes?: string[]; // 远端分支短名原始列表（仅剔 origin/HEAD）；「本地已有对应者不重复
  // 展示」的过滤在前端做——远端段即使没有待检出条目也要渲染（fetch 入口挂在段标题上）
}
export const MAX_CHANGES = 1000;

// 解析 `git status --porcelain=v1 -z --branch` 的输出（不含 toplevel 行——那是容器侧
// 脚本协议自己拼的首行，由调用方先剥掉）。
//
// -z 格式要点（实测确认；--untracked-files=all 下 untracked 逐文件列出，无目录条目）：
//   ## master^@ M k.txt^@R  new.txt^@old.txt^@?? u/a.txt^@?? u/b.txt^@?? untracked.txt^@
// - 全部字段以 NUL 分隔（含分支行），文件名含换行天然免疫（这正是选 -z 的理由）；
// - rename/copy 记录是两个字段：「XY newpath」后紧跟裸的 oldpath——解析时遇到 X∈{R,C}
//   要把下一个不匹配记录形状的 token 当 oldPath 消费掉；
// - 分支行三种形态：`## master...origin/master [ahead 1, behind 2]`、`## HEAD (no branch)`、
//   `## No commits yet on master`（unborn）。
export function parsePorcelainZ(out: string): Omit<GitStatusView, 'repo' | 'toplevel'> {
  const view: Omit<GitStatusView, 'repo' | 'toplevel'> = {};
  const toks = out.split('\0').filter((t) => t !== '');
  const changes: GitChange[] = [];
  let expectOldPath = false;

  for (const tok of toks) {
    if (expectOldPath) {
      // 上一条是 R/C 记录：本 token 是它的 oldPath 裸字段
      const last = changes[changes.length - 1];
      if (last) last.oldFile = tok;
      expectOldPath = false;
      continue;
    }
    if (tok.startsWith('## ')) {
      parseBranchLine(tok.slice(3), view);
      continue;
    }
    // 变更记录：「XY path」——状态列除了字母还可为空格（如「 M」= 仅工作区改动、未暂存），
    // 字符类必须含空格，否则未暂存条目全部被当残段丢弃。
    const m = /^([A-Z?! ])([A-Z?! ]) (.+)$/.exec(tok);
    if (!m) continue; // 无法识别的残段，静默丢弃
    const [x, y, file] = [m[1], m[2], m[3]];
    if (x === '!' || y === '!') continue; // ignored 条目不关心
    const c: GitChange = { file, x: x.trim() || '?', y: y.trim() || '?' };
    changes.push(c);
    if (x === 'R' || x === 'C') expectOldPath = true;
  }

  if (view.branch === undefined && view.unborn !== true) view.branch = null; // 无分支行 = detached 或异常
  if (changes.length > 0) {
    view.changes = changes.slice(0, MAX_CHANGES);
    if (changes.length > MAX_CHANGES) view.truncated = true;
  }
  return view;
}

// 分支行解析：填充 branch/label/unborn/ahead/behind。
function parseBranchLine(s: string, view: Omit<GitStatusView, 'repo' | 'toplevel'>): void {
  // `No commits yet on master` -> unborn
  const un = /^No commits yet on (.+)$/.exec(s);
  if (un) {
    view.unborn = true;
    view.branch = un[1];
    view.label = `${un[1]}（尚无提交）`;
    return;
  }
  // `HEAD (no branch)` -> detached
  if (/^HEAD \(no branch\)/.test(s)) {
    view.branch = null;
    view.label = '(detached)';
    return;
  }
  // `master...origin/master [ahead 1, behind 2]`：省略号后是 upstream，方括号是跟踪信息
  const head = s.split('...')[0].split(' ')[0];
  view.branch = head || null;
  const ab = /\[ahead (\d+)(?:, behind (\d+))?\]|\[behind (\d+)\]|\[gone\]/.exec(s);
  if (ab) {
    if (ab[1]) view.ahead = Number(ab[1]);
    if (ab[2]) view.behind = Number(ab[2]);
    if (ab[3]) view.behind = Number(ab[3]);
  }
  view.label = view.branch
    ? view.branch + (view.ahead ? ` ↑${view.ahead}` : '') + (view.behind ? ` ↓${view.behind}` : '')
    : '(detached)';
}

// 条目展示分类（前端徽章颜色与点击分流的依据）。
export function kindOf(c: GitChange): 'modified' | 'added' | 'deleted' | 'renamed' | 'typechange' | 'unmerged' | 'untracked' {
  if (c.x === '?' && c.y === '?') return 'untracked';
  if (c.x === 'R') return 'renamed';
  if (c.x === 'A' || (c.x === ' ' && c.y === 'A')) return 'added';
  if (c.x === 'D' || (c.x === ' ' && c.y === 'D')) return 'deleted';
  if (c.x === 'T' || (c.x === ' ' && c.y === 'T')) return 'typechange';
  if (c.x === 'U' || c.y === 'U' || c.x === 'A' && c.y === 'A') return 'unmerged';
  return 'modified';
}

// 解析 `git branch --list --format='%(HEAD)%(refname:short)'` 的输出（容器/宿主两侧
// 同一格式）：当前分支行带 * 前缀、其余带空格前缀。分支名不含换行（check-ref-format
// 禁控制字符），按行切分安全；空行跳过。current 为 null = detached 或空仓库。
// %(HEAD) 只输出 * / 空格（worktree 的 + 标记是 git branch 默认输出才有，指定
// --format 后不存在），前缀判定无歧义。
export function parseBranchList(out: string): { current: string | null; branches: string[] } {
  const branches: string[] = [];
  let current: string | null = null;
  for (const l of out.split('\n')) {
    if (l.startsWith('*')) current = l.slice(1);
    else if (l.startsWith(' ')) branches.push(l.slice(1));
  }
  if (current) branches.unshift(current); // 当前分支也进列表（排最前，可点回来）
  return { current, branches };
}

// 解析 `git branch -r --list --format='%(refname:short)'` 输出为远端分支原始列表：
// 剔除 origin/HEAD（git 维护的符号引用不是真分支）与不含 '/' 的残段（远程的 detached
// 态行），其余空行跳过。短名形如 origin/feat-x（分支名可含 '/'，取第一段之后的整体为
// 本地名）；「本地已有对应者」的展示过滤在前端做（见 GitBranchesView.remotes 注释）。
export function parseRemoteBranches(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes('/') && !l.endsWith('/HEAD'));
}

// 分支名入库前校验（容器侧脚本与宿主侧 execFile 共用的第一道防线；git 自身还会做
// check-ref-format 校验，不合规的把 stderr 原话回给前端）。拒绝空名 / 以 - 开头
// （防被 git 当选项吃掉）/ 超长；返回 trim 后的名字。
export function assertBranchName(name: unknown): string {
  const n = String(name ?? '').trim();
  if (!n || n.startsWith('-') || n.length > 200) throw badRequest('分支名不合法');
  return n;
}

// 容器侧脚本退出码 -> HttpError（null = 正常，继续处理 stdout）。
// exit 7（非仓库）由路由层组装 {repo:false}，不走这里。
export function mapGitExit(r: { exitCode: number; stderr: string }, ctx: string): HttpError | null {
  if (r.exitCode === 0) return null;
  if (r.exitCode === 8) return badRequest('path 不在该 git 仓库内');
  // engine 超时约定：exitCode -1 且 stderr 带 [mysandbox: timeout] 标记
  const timedOut = r.exitCode === -1 || r.stderr.includes('[mysandbox: timeout]');
  return new HttpError(
    500,
    (timedOut ? `git ${ctx} 超时` : r.stderr.trim()) || `git ${ctx} failed (exit ${r.exitCode})`,
    timedOut ? 'git_timeout' : 'git_failed',
  );
}

// —— worktree 管理（dock 的 worktree popover 数据源与动作；容器/宿主两侧共用解析）——
// git worktree = 同一仓库的多个并行工作树（共享 .git 对象库）：开 worktree 让某分支独立
// 工作区（AI CLI 并行开发/长任务不占主工作区的标准姿势）。管理面做四件事：list / add /
// remove / prune。lock/unlock 与 detach 检出刻意不做——低频且终端一键可解，面板只读呈现
// locked/prunable 状态不提供操作。

export interface GitWorktree {
  path: string; // worktree 根的绝对路径
  head?: string; // HEAD 短 hash（bare 记录无 HEAD 行）
  branch?: string; // 检出的分支短名（refs/heads/x -> x）；detached/bare 无
  bare?: boolean; // 主 bare 仓库记录（无工作区语义：不可跳转、git 也不允许 remove）
  detached?: boolean; // detached HEAD
  locked?: boolean; // 管理锁（remove 会被 git 拒绝，面板只读呈现 + stderr 原话）
  lockedReason?: string;
  prunable?: boolean; // 目录已消失等（worktree prune 可清掉的失效登记）
  prunableReason?: string;
}

export interface GitWorktreesView {
  repo: boolean;
  toplevel?: string; // 面板路径所在 worktree 的根（rev-parse --show-toplevel，即「当前」）
  worktrees?: GitWorktree[]; // porcelain 原序（git 保证首个恒为主工作树——前端按序号
  // 隐藏主工作树的移除钮，git 对主树 remove 本就会拒绝，这里提前藏掉）
}

// 解析 `git worktree list --porcelain -z`（git ≥2.36，模板/宿主为 2.43）输出：
// -z 下记录间与记录内字段全部 NUL 分隔、空 token 为记录分隔——路径含换行/引号也原样安全，
// 与 status 的 -z 选型同理由。字段行（参数跟在同 token 内，reason 可含空格）：
//   worktree <path> / HEAD <hash> / branch <ref> / bare / detached / locked [reason] / prunable [reason]
export function parseWorktreeListZ(out: string): GitWorktree[] {
  const wts: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const tok of out.split('\0')) {
    if (tok === '') {
      cur = null; // 记录分隔
      continue;
    }
    if (tok.startsWith('worktree ')) {
      cur = { path: tok.slice(9) };
      wts.push(cur);
      continue;
    }
    if (!cur) continue; // 防御：字段先于 worktree 行（git 不这么输出）
    if (tok.startsWith('HEAD ')) cur.head = tok.slice(5);
    else if (tok.startsWith('branch ')) cur.branch = tok.slice(7).replace(/^refs\/heads\//, '');
    else if (tok === 'bare') cur.bare = true;
    else if (tok === 'detached') cur.detached = true;
    else if (tok === 'locked') cur.locked = true;
    else if (tok.startsWith('locked ')) {
      cur.locked = true;
      cur.lockedReason = tok.slice(7);
    } else if (tok === 'prunable') cur.prunable = true;
    else if (tok.startsWith('prunable ')) {
      cur.prunable = true;
      cur.prunableReason = tok.slice(9);
    }
  }
  return wts;
}

// worktree 目标目录校验（add/remove 共用）：绝对路径、拒 \0/超长/- 开头——worktree 的
// <path> 位置参数没有 -- 分隔的可靠惯例，- 开头会被 git 当选项吃掉，必须自己挡。
// 不 import files.ts 的 cleanPath：gitpanel 是被 files/hostFiles 双侧复用的纯函数层，
// 保持对实现模块零依赖（files.ts 反向 import 本文件）。
export function assertWorktreeDir(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('-') || p.includes('\0') || p.length > 4096) {
    throw badRequest('worktree 路径不合法');
  }
  return p.length > 1 ? p.replace(/\/+$/, '') : p; // 去尾斜杠（根除外），与 cleanPath 同规整
}

