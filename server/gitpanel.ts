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
  file: string; // 相对 toplevel 的 posix 相对路径；untracked 折叠目录带尾 /
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
export const MAX_CHANGES = 1000;

// 解析 `git status --porcelain=v1 -z --branch` 的输出（不含 toplevel 行——那是容器侧
// 脚本协议自己拼的首行，由调用方先剥掉）。
//
// -z 格式要点（实测确认）：
//   ## master^@ M k.txt^@R  new.txt^@old.txt^@?? udir/^@?? untracked.txt^@
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

