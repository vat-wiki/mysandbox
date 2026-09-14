// SSH 远程执行通道（文件层专用）：sshFiles.ts 的全部端点与 files.ts 跨面板复制的 ssh 侧
// 共用这里的基元。与 sshTerminal.ts 的 sshRun 的差异：那边的参数是白名单值（termId/常量）、
// 引号手工包裹；这边的参数来自 HTTP 请求（路径可含单引号/空格/中文），统一在 sshExec/
// sshFeed/sshSpawn 内做**真转义**单引号包裹，调用方一律传未包裹的裸 argv。
//
// 权限面：凭据全走宿主 ssh（keys / agent / ~/.ssh/config），与 /ws/host-terminal 同源——
// token 本就等价宿主 leon 用户、可在宿主终端手敲 ssh 到任意目标，文件端点不新增越权。
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { SshTarget } from './state.js';
import { HttpError, badRequest } from './errors.js';
import { SSH_BG_OPTS, sshArgv } from './sshTerminal.js';

const execFileAsync = promisify(execFile);

// 单引号包裹（真转义）：'…' + 内嵌 ' → '\'' 续接。ssh 把 argv 以空格拼成命令串交给
// **远端登录 shell** 解析（sshTerminal.ts 有实测踩坑记录），每个元素都必须裹住。
// 注意与 sshTerminal.ts 的 shq 不同：那边值域过白名单无引号，这边必须转义。
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ssh 传输失败（exit 255）→ 502：连接拒绝/认证失败/host key 未确认各不相同，stderr
// 首行给人话。BatchMode（SSH_BG_OPTS）下密码认证目标也在此快败，不会吊死请求。
export function sshUnreachable(stderr: string): HttpError {
  const first = (stderr || '').split('\n')[0]?.trim().slice(0, 200) ?? '';
  return new HttpError(502, `SSH 目标连接失败${first ? `：${first}` : ''}`, 'ssh_unreachable');
}

// 收尾型远程执行（整包收 utf8 串；脚本输出量可控：读文件上限 2MB base64 ~2.7MB）。
// 超时按 504 上抛；exit 255 = ssh 传输失败（远端命令自身不会用 255）；其余非 0 按结果
// 返回，退出码约定由调用方脚本决定（2=不存在 3=非目录/非文件 9=已存在 7=非仓库 …，
// 与 files.ts / serviceFiles.ts 逐条对齐）。
export async function sshExec(
  t: SshTarget,
  cmd: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('ssh', sshArgv(t, SSH_BG_OPTS, cmd.map(shq)), {
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; stdout?: string; stderr?: string };
    if (err.killed) throw new HttpError(504, 'ssh exec timeout', 'exec_timeout');
    // execFile 非 0 退出时 err.code 是数字退出码（NodeJS.ErrnoException 类型只标了 string，
    // 运行时是 number——ssh 的 255 = 传输失败）
    if (typeof err.code === 'number' && err.code === 255) throw sshUnreachable(String(err.stderr ?? ''));
    return {
      exitCode: typeof err.code === 'number' ? err.code : 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? err.message ?? ''),
    };
  }
}

// stdin 喂入型远程执行（写文件；ssh 带 commands 且无 tty 时 stdin 直通远端命令，
// 关闭 stdin 即远端 EOF，cat > file 收尾）。exit 255 同样映射传输失败。
export function sshFeed(
  t: SshTarget,
  cmd: string[],
  input: Buffer,
  timeoutMs: number,
): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const c = spawn('ssh', sshArgv(t, SSH_BG_OPTS, cmd.map(shq)), { stdio: ['pipe', 'ignore', 'pipe'] });
    const errs: Buffer[] = [];
    let settled = false;
    const done = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(errs).toString('utf8');
      if (exitCode === 255) rejectPromise(sshUnreachable(stderr));
      else resolvePromise({ exitCode, stderr });
    };
    const timer = setTimeout(() => {
      try { c.kill('SIGKILL'); } catch { /* noop */ }
      done(-1);
    }, timeoutMs);
    c.stderr?.on('data', (d: Buffer) => errs.push(d));
    c.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(e);
    });
    c.on('close', (code) => done(code ?? -1));
    c.stdin?.on('error', () => { /* 写入撞 EPIPE：退出码说话 */ });
    c.stdin?.end(input);
  });
}

// 流式型（下载 tar/cat 直通）：返回子进程由调用方接 stdout / 收尾竞速（files.ts
// streamProbe）与 reply.raw close kill，语义与 serviceFiles.ts 的 spawn docker exec 同构。
// stdio tuple ['ignore','pipe','pipe']：stdin 恒 null、stdout/stderr 恒在（类型层面锁定，
// 调用方免 null检查）。
export function sshSpawn(t: SshTarget, cmd: string[]): ChildProcessByStdio<null, Readable, Readable> {
  return spawn('ssh', sshArgv(t, SSH_BG_OPTS, cmd.map(shq)), { stdio: ['ignore', 'pipe', 'pipe'] });
}

// 流式型·stdin 喂入（files.ts 跨面板复制 unpack：pack 的 tar 流经本进程管道进 ssh stdin
// →远端 tar -x）。stdio ['pipe','ignore','pipe']：stdin 管道（tar 流入口）、stdout 丢弃
//（tar -x 无输出）、stderr 管道（错误归因）——返回类型带 Writable，调用方 pipe 不必 null 检查。
export function sshSpawnIn(
  t: SshTarget,
  cmd: string[],
): ChildProcessByStdio<Writable, null, Readable> {
  return spawn('ssh', sshArgv(t, SSH_BG_OPTS, cmd.map(shq)), { stdio: ['pipe', 'ignore', 'pipe'] });
}

// 存在性探测（files.ts 跨面板复制的 ssh 侧预检）：脚本 exit 0 = true。⚠️ 必须显式判
// exitCode——sshExec 对普通非零退出码不抛（只有 255/超时才 throw），只靠 try/catch 会让
// 「探测为假」永远返回 true（与 svcTest 的 execFile reject 语义对齐修正）。连接失败同
// 样归 false，由后续主操作路径给出真错误——与 files.ts svcTest 同语义。
export async function sshTest(t: SshTarget, script: string, p: string): Promise<boolean> {
  try {
    const r = await sshExec(t, ['sh', '-c', script, 'sh', p], 8_000);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

// 远端 OS 门槛：文件脚本按 GNU/busybox 双分支（同 serviceFiles，alpine 实测通），但
// macOS/BSD 的 stat -c 缺失会让列目录**静默列空**——与其给空面板不如明确拒绝。探测一次
// 按目标名缓存（进程生命周期）。
const osCache = new Map<string, boolean>();
export async function requireRemoteLinux(t: SshTarget): Promise<void> {
  const hit = osCache.get(t.name);
  if (hit !== undefined) {
    if (!hit) throw badRequest('该 SSH 目标不是 Linux 主机，文件面板暂不支持');
    return;
  }
  const r = await sshExec(t, ['uname', '-s'], 10_000);
  const isLinux = r.exitCode === 0 && r.stdout.trim() === 'Linux';
  osCache.set(t.name, isLinux);
  if (!isLinux) {
    throw badRequest(`远程主机是 ${r.stdout.trim() || '未知系统'}，文件面板仅支持 Linux 远端`);
  }
}
