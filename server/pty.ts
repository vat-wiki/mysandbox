// node-pty 的统一入口（Windows 走 ConPTY，Linux/macOS 走 forkpty）。
//
// 为什么集中在这：wsl2 引擎的容器终端流（engine/wsl2.ts 的 execStream）与**宿主终端**
// （server/hostTerminal.ts 的 Windows 分支）都要它，而加载逻辑有三处讲究，各自维护
// 一份没意义：
//   - node-pty 是 optionalDependencies：无工具链（没装 VS Build Tools / python）的机器
//     会装不上，不能让它在 import 期就把整个服务拖死；
//   - 原生模块，只能 require 不能 import（ESM 下用 createRequire 兜）；
//   - 缺了要报人话错误：调用点在 WS 建链时 catch 住给前端文案，其余功能不受牵连。
import { createRequire } from 'node:module';
import { platform } from 'node:os';

// 只声明用到的那部分 API（node-pty 自身没自带 typings，装了才补 ——没了照样能编译）。
export interface PtyTerm {
  write(data: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      // Windows 专用：用 node-pty 自带的 conpty.dll 替代系统 ConPTY（见 spawnPty 注释）。
      useConptyDll?: boolean;
    },
  ): PtyTerm;
}

let ptyMod: PtyModule | null = null;
let ptyError: string | null = null;

function load(): PtyModule {
  if (ptyMod) return ptyMod;
  if (ptyError) throw new Error(ptyError);
  try {
    const req = createRequire(import.meta.url);
    ptyMod = req('node-pty') as PtyModule;
    return ptyMod;
  } catch {
    ptyError =
      'node-pty is not installed (npm install node-pty); terminal requires it, other features work without it';
    throw new Error(ptyError);
  }
}

// 可用吗（不抛版）：静态能力探测/降级判断用，别在终端热路径上靠抛异常做分支。
export function ptyAvailable(): boolean {
  try {
    load();
    return true;
  } catch {
    return false;
  }
}

// —— Windows  runner 下的「关终端 -> 服务退出」传导链（2026-09-20 实测）——
// node-pty 在 Windows ConPTY 模式下 kill() 会 fork `conpty_console_list_agent` 去枚举
// 控制台进程树；该 agent 靠 AttachConsole 工作，**没有可附加控制台时必崩**
// （隐藏窗口的计划任务拉起的服务正是这种上下文）：
//   node_modules/node-pty/lib/conpty_console_list_agent.js:13  Error: AttachConsole failed
// 它是被 fork 出来的、共享本进程的 stdout/stderr fd，于是这句崩溃栈写进了**服务自己的
// stderr**；Windows 侧 runner（scripts/win/mysandbox.ps1 的 run）用 `*>&1 | Out-File`
// 收所有流且 `$ErrorActionPreference='Stop'`，收到原生 stderr 就判定 node 失败并关掉
// 管道写端；服务下一次写 stdout/stderr 拿到 EPIPE，无人处理 -> 未捕获错误 -> 进程退出。
// 净效果就是「关掉一个终端 tab，整个 mysandbox 就被重启一次」（runner 日志里成对出现
// `run failed: …conpty_console_list_agent.js:13` + `run exit rc=1`）。
// 真正的 killing-the-service 那一环不是 fork agent 崩，而是**管道破裂没人拦**：
// 服务日志早已双写到 journald + 按天文件（logger.ts），stdout 碎了不该带崩主进程。
// 所以在起服务前给两条标准流挂 error 忽略器——断了就断，别拖着业务陪葬。
export function guardStdio(): void {
  for (const s of [process.stdout, process.stderr]) {
    if (s && !s.listenerCount('error')) s.on('error', () => { /* stdout/stderr 断开：忽略 */ });
  }
}

// 开一个 PTY。file/args 由调用方保证干净（常量或白名单校验过的片段）。
//
// ⚠️ Windows 上刻意用 node-pty 自带的 conpty.dll（`useConptyDll: true`）而不是系统 ConPTY：
// 系统 ConPTY 那条路的 kill() 会 fork `conpty_console_list_agent` 枚举控制台进程树，
// 而它在「没有被可附加的控制台」的上下文里必崩（AttachConsole failed，见 guardStdio 上方
// 那段实测）——它的 stderr 共享本进程 fd，于是每关一次终端就在服务的标准流里甩一段崩溃栈，
// Windows 侧 runner 据此判定服务失败、连带重启。dll 模式走 native kill，**不 fork**。
// ⚠️「实测 dll 模式在本机 Windows 10.0.26100 可正常出流/收输入/resize」待补——先拉起验证。
// dll 模式走 native kill，**不 fork**，这条崩溃链就从根上断了（dll 不可用时再退回默认）。
export function spawnPty(
  file: string,
  args: string[],
  opts: { cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
): PtyTerm {
  return load().spawn(file, args, {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd: opts.cwd,
    env: opts.env,
    ...(platform() === 'win32' ? { useConptyDll: true } : {}),
  });
}
