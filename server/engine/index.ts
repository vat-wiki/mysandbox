// engine 入口：消费方唯一 import 点。getEngine 按 cfg.engine 分流实现
// （lxc = Linux unprivileged LXC；wsl2 = Windows WSL2，见 docs/wsl2-migration.md）。
// 业务层不直接 import 具体实现——历史上 status/base/network 三处违例已经修掉，别再开新口子。
import type { Config } from '../config.js';
import type { Engine } from './types.js';
import { lxcEngine } from './lxc.js';
import { wsl2Engine } from './wsl2.js';

export type {
  Engine,
  EngineCaps,
  ExecOpts,
  ExecResult,
  ExecStream,
  ContainerInfo,
  ContainerView,
  ContainerPort,
  EngineEvent,
  EventSubscription,
  CreateSpec,
  CreateSource,
  BaseAction,
  BaseActionOpts,
  BaseProgress,
  BaseStatus,
} from './types.js';
export { lxcEngine, wsl2Engine };

export function getEngine(cfg: Config): Engine {
  return cfg.engine === 'wsl2' ? wsl2Engine : lxcEngine;
}

// 便捷转发：消费方按名直接用。
// checkEngine（cli.ts 启动检查）查引擎运行环境（LXC: systemd user manager + lxc 命令；
// wsl2: Windows + wsl.exe）。
export function checkEngine(cfg: Config) {
  return getEngine(cfg).status(cfg);
}
export async function listManaged(cfg: Config) {
  return getEngine(cfg).listManaged(cfg);
}
export async function inspectContainer(cfg: Config, id: string) {
  return getEngine(cfg).inspect(cfg, id);
}
export async function startContainer(cfg: Config, id: string) {
  return getEngine(cfg).start(cfg, id);
}
export async function stopContainer(cfg: Config, id: string, t = 5) {
  return getEngine(cfg).stop(cfg, id, t);
}
export async function restartContainer(cfg: Config, id: string, t = 5) {
  return getEngine(cfg).restart(cfg, id, t);
}
export async function renameContainer(cfg: Config, id: string, name: string) {
  return getEngine(cfg).rename(cfg, id, name);
}
export async function removeContainer(cfg: Config, id: string, opts: { force?: boolean } = {}) {
  return getEngine(cfg).remove(cfg, id, opts);
}
export async function execRun(cfg: Config, id: string, opts: import('./types.js').ExecOpts) {
  return getEngine(cfg).execRun(cfg, id, opts);
}
export async function execFeed(
  cfg: Config,
  id: string,
  opts: import('./types.js').ExecOpts,
  input: Buffer,
) {
  return getEngine(cfg).execFeed(cfg, id, opts, input);
}
export async function assignedIps(cfg: Config) {
  return getEngine(cfg).assignedIps(cfg);
}
// hosts-sync 的读-改-写：直读容器 rootfs 的 /etc/hosts。
export function rootfsPath(cfg: Config, name: string): string | null {
  return getEngine(cfg).rootfsPath(cfg, name);
}
// 新容器 hosts 的源头（模板 rootfs），预览与宿主源创建对照用。
export async function readTemplateHosts(cfg: Config): Promise<string | null> {
  return getEngine(cfg).readTemplateHosts(cfg);
}
// terminal.ts 的 PTY 流（LXC: lxc-attach + script；wsl2: node-pty ConPTY）。
export async function execStream(cfg: Config, id: string, opts: import('./types.js').ExecOpts) {
  return getEngine(cfg).execStream(cfg, id, opts);
}
// files.ts 的二进制流式 exec（下载路由）。
export function execSpawn(cfg: Config, id: string, opts: import('./types.js').ExecOpts) {
  return getEngine(cfg).execSpawn(cfg, id, opts);
}
// hosts-sync.ts 的事件订阅（LXC: lxc-monitor；wsl2: --list --running 轮询 diff）。
export async function subscribeEvents(
  cfg: Config,
  onEvent: (ev: import('./types.js').EngineEvent) => void,
) {
  return getEngine(cfg).subscribeEvents(cfg, onEvent);
}
