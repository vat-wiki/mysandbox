// 终端复用器抽象：业务层只描述「会话要做什么」，不直接拼 tmux 命令。
// 当前实现是 tmux；将来换 Rust mux 时，新增一个实现即可，容器/宿主/SSH 三侧无需改业务逻辑。
//
// transport 接收**完整 argv**（含程序名与 socket 前缀），由各接入面负责自己的启动方式：
// 宿主直起 tmux、容器经 lxc-attach、SSH 经远端 shell。argv 不经过本地 shell，避免转义分叉。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface MuxResult {
  ok: boolean;
  stdout: string;
  err?: string;
}

export type MuxTransport = (argv: string[], timeoutMs?: number) => Promise<MuxResult>;

// 会话列表的两行格式（主行 + pane title）。放在这里让三侧共用同一份 tmux format。
export const LIST_FMT = '#{session_name}|#{session_attached}|#{session_created}|#{pane_current_path}\n#{pane_title}';

function errText(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr || err.message || '').split('\n')[0]?.slice(0, 200) ?? '';
}

// 宿主进程直起 tmux。socket 由 Multiplexer 的前缀参数决定（宿主用专用 socket）。
export const hostTransport: MuxTransport = async (argv, timeoutMs = 5_000): Promise<MuxResult> => {
  try {
    const { stdout } = await execFileAsync(argv[0], argv.slice(1), {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stdout: '', err: errText(e) };
  }
};

// 业务层依赖的接口。换实现（例如 Rust mux）时只换实例，调用方不动。
export interface Multiplexer {
  command(args: string[]): string[];
  run(args: string[], timeoutMs?: number): Promise<MuxResult>;
  target(name: string, pane?: boolean): string;
  hasSession(name: string, timeoutMs?: number): Promise<boolean>;
  hasServer(timeoutMs?: number): Promise<boolean>;
  listSessions(fmt: string, timeoutMs?: number): Promise<MuxResult>;
  listPanes(name: string, fmt: string, timeoutMs?: number): Promise<MuxResult>;
  activePaneValue(name: string, fmt: string, timeoutMs?: number): Promise<string>;
  paneCwd(name: string, timeoutMs?: number): Promise<string>;
  paneTitle(name: string, timeoutMs?: number): Promise<string>;
  capturePane(name: string, delta: boolean, timeoutMs?: number): Promise<{ ok: boolean; text: string }>;
  killSession(name: string, timeoutMs?: number): Promise<boolean>;
  renameSession(from: string, to: string, timeoutMs?: number): Promise<boolean>;
  setMouse(mode: 'off' | 'on', timeoutMs?: number): Promise<boolean>;
}

export class TmuxMultiplexer implements Multiplexer {
  constructor(
    private readonly bin: string,
    private readonly transport: MuxTransport,
    private readonly prefix: string[] = [],
  ) {}

  /** 完整的本地 argv（含程序名），供需要自行接管的启动路径使用。 */
  command(args: string[]): string[] {
    return [this.bin, ...this.prefix, ...args];
  }

  /** 原始命令入口：设置项等后端专属操作也经此收口。 */
  run(args: string[], timeoutMs = 5_000): Promise<MuxResult> {
    return this.transport(this.command(args), timeoutMs);
  }

  /** tmux target：`=名` 精确会话；带冒号时再精确到默认窗口。 */
  target(name: string, pane = false): string {
    return `=${name}${pane ? ':' : ''}`;
  }

  async hasSession(name: string, timeoutMs = 5_000): Promise<boolean> {
    return (await this.run(['has-session', '-t', this.target(name)], timeoutMs)).ok;
  }

  async hasServer(timeoutMs = 5_000): Promise<boolean> {
    return (await this.listSessions('#{session_name}', timeoutMs)).ok;
  }

  listSessions(fmt: string, timeoutMs = 5_000): Promise<MuxResult> {
    return this.run(['list-sessions', '-F', fmt], timeoutMs);
  }

  listPanes(name: string, fmt: string, timeoutMs = 5_000): Promise<MuxResult> {
    return this.run(['list-panes', '-t', this.target(name, true), '-F', fmt], timeoutMs);
  }

  /** 当前活跃 pane 的一个格式字段；会话不在/无 pane 时返回空串。 */
  async activePaneValue(name: string, fmt: string, timeoutMs = 5_000): Promise<string> {
    const r = await this.listPanes(name, fmt, timeoutMs);
    if (!r.ok) return '';
    const line = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('1 '));
    return line ? line.slice(2) : '';
  }

  async paneCwd(name: string, timeoutMs = 5_000): Promise<string> {
    return (await this.activePaneValue(name, '#{pane_active} #{pane_current_path}', timeoutMs)).trim();
  }

  async paneTitle(name: string, timeoutMs = 5_000): Promise<string> {
    return (await this.activePaneValue(name, '#{pane_active} #{pane_title}', timeoutMs)).trim();
  }

  /**
   * 历史回填。delta=物理行、含当前屏、只取 2000 行（重连增量）；否则全量逻辑行、不含当前屏。
   * -e 保留 SGR，前端 xterm 直接消化。target 带冒号（capture-pane 的 window 解析坑）。
   */
  async capturePane(name: string, delta: boolean, timeoutMs = 10_000): Promise<{ ok: boolean; text: string }> {
    const args = delta
      ? ['capture-pane', '-p', '-e', '-t', this.target(name, true), '-S', '-2000']
      : ['capture-pane', '-p', '-e', '-J', '-t', this.target(name, true), '-S', '-10000', '-E', '-1'];
    const r = await this.run(args, timeoutMs);
    return { ok: r.ok, text: r.stdout.trim() };
  }

  async killSession(name: string, timeoutMs = 5_000): Promise<boolean> {
    return (await this.run(['kill-session', '-t', this.target(name)], timeoutMs)).ok;
  }

  async renameSession(from: string, to: string, timeoutMs = 5_000): Promise<boolean> {
    return (await this.run(['rename-session', '-t', this.target(from), to], timeoutMs)).ok;
  }

  /** 全局鼠标归属：off = xterm.js 接管；on = tmux/TUI 内建滚动接管。 */
  async setMouse(mode: 'off' | 'on', timeoutMs = 5_000): Promise<boolean> {
    return (await this.run(['set', '-g', 'mouse', mode], timeoutMs)).ok;
  }
}
