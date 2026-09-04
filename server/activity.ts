// 终端输出活动监测：「agent 干完活/等输入时提醒我」的服务端底座（routes.ts 的
// /api/terminal-activity 出快照，前端轮询做提醒决策）。
//
// 为什么在服务端扫 tmux：用户切去别的 tab 干别的事后，会话要么已隐藏（WS 断 = 纯
// detach，前端收不到任何流）、要么虽 attach 但没人看；只有 tmux 自己知道「屏幕还在
// 不在动」。这里周期扫全部运行中容器 + 宿主专用 socket 的 mysandbox 会话，对每个
// 会话取两个信号：
//   - 尾部输出 hash（capture-pane 最后 ~40 行 + 当前屏的 md5）：spinner 重绘、整屏
//     TUI 重绘、滚动全都体现为内容变化；agent 干活时恒在重绘、停手时静止。
//   - history_size 总和：兜住「输出比扫描间隔还短就结束」的瞬时 burst（tail hash
//     可能两次采样都没赶上变化），也不受历史封顶影响。
// 任一变化 = 有输出。输出后安静超过 cfg.terminal.quietSeconds 且此前确实出现过输出，
// 判 quiet；从未有过输出的会话（空 prompt 摆着）恒 active，不进提醒流。
//
// 「用户在不在看」刻意不由服务端判：可见 tab 是 v-show 常驻（WS 恒 attach），tmux
// 的 session_attached 在这里 ≠ 用户在看。谁看谁不看由前端拿自己的激活 tab / 文档
// 可见性 / 离开时刻去关联（见 web lib/terminalActivity.ts 与 ContainerList）。
//
// 状态不持久化（同 jobs.ts 的取舍）：进程重启即丢，重启窗口内错过一次提醒的代价
// 远小于维护落盘状态；首轮扫描只建基线，不产生提醒。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from './config.js';
import { listManaged, execRun } from './engine/index.js';
import { HOST_SOCKET } from './hostTerminal.js';

const execFileAsync = promisify(execFile);

// 轮询节奏：5s 一拍。单拍没扫完就跳过下一拍，不堆并发。
const POLL_MS = 5_000;
// 单次扫描超时；失败按「该源本拍无数据」降级——保留旧状态，不误清不误建基线。
const SCAN_TIMEOUT_MS = 8_000;

export interface TermActivityView {
  kind: 'host' | 'container';
  containerId?: string;
  termId: string;
  // quiet = 出现过输出且已安静超过阈值；active = 其余（含从未有过输出的空会话）。
  state: 'active' | 'quiet';
  // 距最近一次检测到输出的秒数（quiet 时即安静时长）。
  quietSeconds: number;
}

// 每会话的观测状态。key = `${kind}|${containerId}|${termId}`。
interface Entry {
  hash: string; // 尾部输出 md5（上一拍）
  size: number; // history_size 总和（上一拍）
  lastOutputAt: number; // 最近一次检测到输出的时刻
  seenOutput: boolean; // 观测期内是否出现过输出（空会话永不判 quiet）
}

const entries = new Map<string, Entry>();
let cfgRef: Config | null = null;
let quietWindowMs = 15_000;

interface ScanRow {
  name: string; // tmux 会话名（mysandbox-<短id>-<termId> / mysandbox-host-<termId>）
  hash: string;
  size: number;
}

// —— 扫描脚本（POSIX sh，容器/宿主共用，仅 tmux 命令前缀与会话名过滤模式不同）——
// 逐会话输出 name|hash|size。会话名按 mysandbox 新旧前缀过滤，用户自建的 tmux 会话
// 不掺和。tmux target 一律 `=名:` 精确匹配（3.4 的 target 歧义教训，见 terminal.ts）；
// md5 只取前 8 位，做变化检测足够。
function scanScript(pattern: string, tmux: string): string {
  return [
    `rows=$(${tmux} list-sessions -F '#{session_name}' 2>/dev/null) || exit 0`,
    'for name in $rows; do',
    `  case "$name" in ${pattern}) ;; *) continue;; esac`,
    "  h=''; z=0",
    `  for pl in $(${tmux} list-panes -t "=$name:" -F '#{pane_id}|#{history_size}' 2>/dev/null); do`,
    '    p=${pl%%|*}; n=${pl##*|}',
    `    h="$h$(${tmux} capture-pane -p -t "$p" -S -40 2>/dev/null)"`,
    '    z=$((z + n))',
    '  done',
    `  printf '%s|%s|%s\\n' "$name" "$(printf %s "$h" | md5sum | cut -c1-8)" "$z"`,
    'done',
  ].join('\n');
}

function parseScan(out: string): ScanRow[] {
  const rows: ScanRow[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [name, hash, size] = line.split('|');
    if (!name || !hash) continue;
    rows.push({ name, hash, size: Number(size) || 0 });
  }
  return rows;
}

// case 模式里的 glob 元字符按单字符通配处理（adopted 容器名不受 NAME_RE 约束）。
function globSafe(s: string): string {
  return s.replace(/[*?[\]\\]/g, '?');
}

async function scanContainer(cfg: Config, id: string): Promise<ScanRow[]> {
  const short = globSafe(id.slice(0, 8));
  const r = await execRun(cfg, id, {
    Cmd: ['sh', '-c', scanScript(`mysandbox-${short}-*|ms-${short}-*`, 'tmux')],
    User: '1000:1000',
    Tty: false,
    timeoutMs: SCAN_TIMEOUT_MS,
  });
  // exitCode != 0 只可能是 exec 链路异常（tmux 缺失/无 server 的情形脚本已 exit 0）：
  // 视为扫描失败让调用方保留旧状态，而不是当「0 会话」清空。
  if (r.exitCode !== 0) throw new Error(`activity scan exit ${r.exitCode}`);
  return parseScan(r.stdout);
}

async function scanHost(): Promise<ScanRow[]> {
  // 失败直接抛：调用方按「宿主源本拍失败」保留旧状态。
  const { stdout } = await execFileAsync(
    'sh',
    ['-c', scanScript('mysandbox-host-*|h-*', `tmux -L ${HOST_SOCKET}`)],
    { timeout: SCAN_TIMEOUT_MS },
  );
  return parseScan(stdout);
}

// 会话名 -> termId。与 listContainerSessions / listHostSessions 同构：
// 容器侧短 id 定长锚定（容器名可能含 -，termId 是带 - 的 UUID，靠短 id 定长消歧）。
function termIdOf(kind: 'host' | 'container', id: string, name: string): string | null {
  if (kind === 'host') {
    const m = /^(?:mysandbox-host|h)-([A-Za-z0-9_-]{4,64})$/.exec(name);
    return m ? m[1] : null;
  }
  const short = globSafe(id.slice(0, 8));
  const m = new RegExp(`^(?:mysandbox|ms)-${short}-([A-Za-z0-9_-]{4,64})$`).exec(name);
  return m ? m[1] : null;
}

const keyOf = (kind: 'host' | 'container', cid: string, termId: string): string =>
  `${kind}|${cid}|${termId}`;

function applyScan(key: string, row: ScanRow, now: number): void {
  const prev = entries.get(key);
  if (!prev) {
    // 首见只建基线：seenOutput=false，永远不会立刻判 quiet（首拉/重启不补发提醒）。
    entries.set(key, { hash: row.hash, size: row.size, lastOutputAt: now, seenOutput: false });
    return;
  }
  if (row.hash !== prev.hash || row.size !== prev.size) {
    prev.lastOutputAt = now;
    prev.seenOutput = true;
  }
  prev.hash = row.hash;
  prev.size = row.size;
}

async function tick(): Promise<void> {
  const cfg = cfgRef;
  if (!cfg) return;
  const now = Date.now();

  // 运行中容器清单。engine 挂了按空处理：本拍容器侧不更新、也不清理（保旧状态）。
  let running: string[] = [];
  try {
    const views = await listManaged(cfg);
    running = views.filter((v) => v.state === 'running').map((v) => v.id);
  } catch {
    /* engine 不可用：容器侧跳过本拍 */
  }

  type Source =
    | { kind: 'container'; id: string; rows: ScanRow[] }
    | { kind: 'host'; id: string; rows: ScanRow[] };
  const settled = await Promise.allSettled([
    ...running.map((id) =>
      scanContainer(cfg, id).then((rows): Source => ({ kind: 'container', id, rows })),
    ),
    scanHost().then((rows): Source => ({ kind: 'host', id: '', rows })),
  ]);

  const seen = new Set<string>();
  const scannedContainers = new Set<string>();
  let scannedHost = false;
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue; // 单源失败：该源旧状态原样保留
    const s = r.value;
    if (s.kind === 'host') scannedHost = true;
    else scannedContainers.add(s.id);
    for (const row of s.rows) {
      const termId = termIdOf(s.kind === 'host' ? 'host' : 'container', s.id, row.name);
      if (!termId) continue;
      const key = keyOf(s.kind === 'host' ? 'host' : 'container', s.id, termId);
      seen.add(key);
      applyScan(key, row, now);
    }
  }

  // 清理：本拍没见过的 key——容器已不在运行清单 = 会话随容器消亡，直接清；
  // 容器还在但本拍扫描失败 / 宿主扫描失败 = 瞬时抖动，保留状态别误重置基线。
  for (const key of [...entries.keys()]) {
    if (seen.has(key)) continue;
    const [kind, cid] = key.split('|');
    if (kind === 'host') {
      if (scannedHost) entries.delete(key);
    } else if (!running.includes(cid)) {
      entries.delete(key);
    }
  }
}

let started = false;

// 启动周期扫描（幂等；buildServer 装配时调一次）。
export function startActivityPoller(cfg: Config): void {
  if (started) return;
  started = true;
  cfgRef = cfg;
  quietWindowMs = Math.max(3, cfg.terminal.quietSeconds) * 1000;
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void tick()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  }, POLL_MS);
  timer.unref(); // 不阻止进程退出
}

// 当前快照（routes.ts 的 GET /api/terminal-activity）。
export function terminalActivity(): TermActivityView[] {
  const now = Date.now();
  const out: TermActivityView[] = [];
  for (const [key, e] of entries) {
    const [kind, cid, termId] = key.split('|');
    const quietMs = now - e.lastOutputAt;
    const quiet = e.seenOutput && quietMs >= quietWindowMs;
    out.push({
      kind: kind as 'host' | 'container',
      containerId: cid || undefined,
      termId,
      state: quiet ? 'quiet' : 'active',
      quietSeconds: Math.floor(quietMs / 1000),
    });
  }
  return out;
}
