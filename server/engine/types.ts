// 引擎抽象：docker 与 lxc 的统一接口（迁移期共存，见 docs/lxc-migration.md）。
// 消费方（routes/terminal/files/batch/hosts-sync/network/cli/lifecycle/image）只 import
// engine/index.js，不感知底层。P3 阶段仅 docker 实现；lxc 实现挂上后按 config 选择/聚合。

import type { Readable, Writable, Duplex } from 'node:stream';
import type { Config } from '../config.js';

// —— exec（批量/文件/终端用）——
export interface ExecOpts {
  Cmd: string[];
  Env?: string[];
  Tty?: boolean;
  User?: string;
  WorkingDir?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// —— inspect 的裁剪视图：消费方实际用到的字段（routes/batch/hosts-sync/lifecycle）。
// 两个引擎都归一到这个形状，避免业务层碰 docker 原始 inspect 的大 JSON。
export interface ContainerInfo {
  id: string;
  name: string;
  running: boolean;
  stateStatus: string; // docker State.Status（running/exited/...）；lxc 映射 RUNNING/STOPPED
  managed: boolean; // 受管理标记：docker=label；lxc=config 标记
  networks: string[]; // 所在网络；lxc 用网桥名对齐
  ports: ContainerPort[];
}

export interface ContainerPort {
  ip?: string;
  privatePort?: number;
  publicPort?: number;
  type: string;
}

// listManaged 的容器视图（routes /api/containers 直接序列化给 web）。
export interface ContainerView {
  id: string;
  name: string;
  displayName?: string;
  status: string;
  state: string;
  image: string;
  ip: string | null;
  networks: string[];
  managed: boolean; // 由 mysandbox 创建（docker label / lxc config 标记）
  adopted: boolean; // sidecar 登记为纳入管理
  description?: string;
  tags?: string[];
  source?: string;
  labels: Record<string, string>;
  ports: ContainerPort[];
  created: number;
  command: string;
}

// —— 终端 PTY 流（terminal.ts 的 docker exec hijack / lxc 的等价物）——
export interface ExecStream {
  stream: Duplex; // stdin 写入、stdout+stderr 合流读出（Tty 单流语义）
  resize(cols: number, rows: number): Promise<void>;
}

// —— 事件订阅（hosts-sync）：容器 start/restart 通知，断流即返回由调用方重连 ——
export interface EngineEvent {
  containerId: string;
  action: string; // 'start' | 'restart'
}

// —— IP 池权威源（network.ts）：当前网内已占 IP（含停掉未删的容器）——
export interface Engine {
  name: 'docker' | 'lxc';

  // 连通性（cli 启动检查 + /api/health-ish）
  status(cfg: Config): Promise<{ reachable: boolean; version?: string; apiVersion?: string; error?: string }>;

  // 列表与生命周期
  listManaged(cfg: import('../config.js').Config): Promise<ContainerView[]>;
  inspect(cfg: import('../config.js').Config, id: string): Promise<ContainerInfo>;
  start(cfg: import('../config.js').Config, id: string): Promise<void>;
  stop(cfg: import('../config.js').Config, id: string, t?: number): Promise<void>;
  restart(cfg: import('../config.js').Config, id: string, t?: number): Promise<void>;
  rename(cfg: import('../config.js').Config, id: string, name: string): Promise<void>;
  remove(cfg: import('../config.js').Config, id: string, opts?: { force?: boolean }): Promise<void>;

  // exec
  execRun(cfg: import('../config.js').Config, id: string, opts: ExecOpts): Promise<ExecResult>;
  execFeed(
    cfg: import('../config.js').Config,
    id: string,
    opts: ExecOpts,
    input: Buffer,
  ): Promise<ExecResult>;
  execStream(cfg: import('../config.js').Config, id: string, opts: ExecOpts): Promise<ExecStream>;

  // 网络与事件
  assignedIps(cfg: import('../config.js').Config): Promise<Set<string>>;
  subscribeEvents(
    cfg: import('../config.js').Config,
    onEvent: (ev: EngineEvent) => void,
  ): Promise<{ close(): void }>;
}

// 类型再导出，消费方从 engine/index 拿全（保持 import 单入口）。
export type { Readable, Writable, Duplex };
