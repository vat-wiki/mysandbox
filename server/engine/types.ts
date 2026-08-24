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

// —— 事件订阅（hosts-sync）：容器 start/restart 通知 ——
export interface EngineEvent {
  containerId: string;
  action: string; // 'start' | 'restart'
}

// 订阅句柄。closed 在底层断流时 resolve（docker events 流 end/error、lxc-monitor 进程退出），
// 调用方据此退避重连——比轮询探活准确，也让「谁知道断了」的责任留在引擎侧。
export interface EventSubscription {
  close(): void;
  closed: Promise<void>;
}

// —— 建容器：引擎无关的输入（lifecycle.ts 编排完 IP/hosts/git 后交给引擎）——
// docker 走 createContainer(ContainerCreateOptions)；lxc 走 lxc-copy 克隆模板 + 改写 config。
// 两条路径除了「名字 + IP + 身份」几乎无共同点，所以 create 本身就是引擎特定的。
export interface CreateSpec {
  name: string;
  ip: string;
  gitName: string;
  gitEmail: string;
  role: string;
  // 全局自定义 hosts 解析出的 host:ip 对。docker 走 ExtraHosts（create 时注入）；
  // lxc 无此概念，由 lifecycle 在启动后 exec 写 /etc/hosts（hosts-sync 同一条路径）。
  extraHosts: string[];
  // 端口映射（NAT）。仅 docker 支持；lxc 固定 IP 直连，caps.portMappings=false。
  portMappings?: Record<string, Array<{ HostPort: string; HostIp?: string }>>;
}

// —— 「基座」：新建容器的来源物 ——
// docker 是镜像（cfg.image），lxc 是模板容器（cfg.lxc.template，D3）。两者角色相同、
// 可做的事不同，所以状态归一到 BaseStatus，动作集由 caps.baseActions 声明。
export type BaseAction = 'build' | 'pull' | 'push' | 'export' | 'import' | 'clone';

export interface BaseStatus {
  kind: 'image' | 'template';
  // 基座名（docker=cfg.image；lxc=cfg.lxc.template）
  name: string;
  exists: boolean;
  // 是否可直接用于建容器。docker 下 exists 即可用；LXC 模板必须 STOPPED
  // （lxc-copy 对运行中的源静默失败），所以 exists 与 ready 是两件事。
  ready: boolean;
  // ready=false 时的人话原因（前端直接显示）
  notReady?: string;
  // 制作来源：docker=构建上下文目录；lxc=模板制作脚本路径。定位失败为 null + contextError。
  // 独立于 exists 计算（App 轮询此接口，context 出错不能拖垮基座存在性判断）。
  context?: string | null;
  contextError?: string;
  size?: number; // 字节；LXC 是 rootfs 实际占用（算起来慢，见 template.ts）
  createdAt?: string; // ISO 串
  // 引擎特有的展示项（docker: id/tags；lxc: state/rootfs/来源容器），前端原样列出，
  // 加字段不用改前端类型——基座细节差异不值得为它设计跨引擎结构。
  detail?: Record<string, string>;
}

// —— 引擎能力声明 ——
// 两个引擎的语义差异不是「实现细节」，而是会一路冒到 UI 的产品差异（删数据、重命名、
// 端口映射、基座能做什么）。与其让业务层散落 `cfg.engine === 'lxc'` 判断，不如让引擎
// 自报能力，业务层与 web 按能力分支（/api/health 把这个结构透给前端）。
export interface EngineCaps {
  // 容器数据是否在容器内部（LXC：home 在 rootfs 内，删容器必然连带删数据，
  // docker 时代「删容器保留 data 目录」的选项在 LXC 下不存在）。
  dataInsideContainer: boolean;
  // 是否支持运行中重命名（LXC 无 live rename，必须先停）。
  liveRename: boolean;
  // 是否支持端口映射（LXC 固定 IP 直连，不做 NAT）。
  portMappings: boolean;
  // 基座形态：镜像 or 模板容器（决定前端文案：「镜像」/「模板」）。
  baseKind: 'image' | 'template';
  // 基座支持的动作。/api/base/<action> 用它做准入（不在表里 → 400），
  // 前端也按它渲染按钮，不必自己记哪个引擎能干什么。
  baseActions: BaseAction[];
}

// 基座动作的输入。两个引擎的动作参数交集很小，所以是个宽松的可选集合，
// 由各引擎实现自行取用（未知字段忽略）。
export interface BaseActionOpts {
  // docker build 的 tag / pull-push 的 ref；lxc export-import 的文件路径
  tag?: string;
  ref?: string;
  noCache?: boolean;
  path?: string;
  // clone：把哪个容器固化成模板（lxc 专属）
  from?: string;
  // import / clone 覆盖已存在的基座（默认拒绝，避免误删模板）
  force?: boolean;
}

// 基座动作的进度事件（形状与 sse.ts ProgressEvent 一致，此处独立声明避免 engine 依赖路由层）。
export interface BaseProgress {
  stream?: string;
  status?: string;
  id?: string;
  progress?: string;
  error?: string;
}

// —— IP 池权威源（network.ts）：当前网内已占 IP（含停掉未删的容器）——
export interface Engine {
  name: 'docker' | 'lxc';

  // 能力声明（业务层/web 按此分支，见 EngineCaps）
  caps: EngineCaps;

  // 连通性（cli 启动检查 + /api/health-ish）
  status(cfg: Config): Promise<{ reachable: boolean; version?: string; apiVersion?: string; error?: string }>;

  // 列表与生命周期
  listManaged(cfg: import('../config.js').Config): Promise<ContainerView[]>;
  inspect(cfg: import('../config.js').Config, id: string): Promise<ContainerInfo>;
  // 建容器：IP/hosts/身份由 lifecycle 编排好，这里只负责引擎特定的落地 + 启动。
  // 返回 id（docker 是 64 位 hex，lxc 是容器名）。失败须自行清理半成品。
  create(cfg: import('../config.js').Config, spec: CreateSpec): Promise<{ id: string }>;
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
  ): Promise<EventSubscription>;

  // —— 基座（镜像 / 模板容器）——
  // 状态查询（App 轮询 + CLI status）。**不能因 context 定位失败而抛**：exists 与
  // context 独立计算，见 BaseStatus 注释。
  baseStatus(cfg: import('../config.js').Config): Promise<BaseStatus>;
  // 执行基座动作。caps.baseActions 之外的动作由路由层拒掉，实现里可以只认自己声明的那些。
  // onProgress 逐条推给 SSE / CLI stdout；返回值进 SSE 的 done 帧。
  runBaseAction(
    cfg: import('../config.js').Config,
    action: BaseAction,
    opts: BaseActionOpts,
    onProgress?: (e: BaseProgress) => void,
  ): Promise<Record<string, unknown>>;

  // —— 宿主侧路径与查重（建容器/种子/CLI 推断用）——
  // 容器名是否已被占用（docker 查容器列表；lxc 查 lxc-ls）。建容器前置查重。
  nameExists(cfg: import('../config.js').Config, name: string): Promise<boolean>;
  // 容器内 /home/dev 对应的宿主路径。docker=dataRoot/<name>（bind mount）；
  // lxc=<lxcpath>/<name>/rootfs/home/dev（D1 uid 直通，属主即宿主用户，可直读直写）。
  // 返回 null = 该容器的 home 在宿主侧不可见（如 adopted 的外部 docker 容器）。
  hostHomePath(cfg: import('../config.js').Config, name: string): string | null;
}

// 类型再导出，消费方从 engine/index 拿全（保持 import 单入口）。
export type { Readable, Writable, Duplex };
