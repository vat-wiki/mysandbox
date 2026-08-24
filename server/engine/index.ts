// engine 入口：消费方唯一 import 点，按 cfg.engine 选 docker / lxc 实现。
// image.ts 仍用 getDocker 直调 dockerode——那是 docker 引擎的**基座实现**（镜像 build/pull/push），
// 由 dockerEngine.runBaseAction 转发过去；LXC 侧对应物是 engine/template.ts 的模板容器。
import type { Config } from '../config.js';
import type { Engine } from './types.js';
import { dockerEngine, getDocker, MANAGED_LABEL } from './docker.js';
import { lxcEngine } from './lxc.js';

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
  BaseAction,
  BaseActionOpts,
  BaseProgress,
  BaseStatus,
} from './types.js';
export { dockerEngine, getDocker, MANAGED_LABEL, lxcEngine };

// 当前引擎（cfg.engine 决定，默认 docker）。
export function getEngine(cfg: Config): Engine {
  return cfg.engine === 'lxc' ? lxcEngine : dockerEngine;
}

// 便捷转发：消费方按名直接用，与原 docker.ts 的函数签名一致。
// 名字仍叫 checkDocker（cli.ts 启动检查），查的是当前引擎的连通性。
export function checkDocker(cfg: Config) {
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
// terminal.ts 的 PTY 流（exec hijack + resize）。engine 抽象前 terminal.ts 内联这段。
export async function execStream(cfg: Config, id: string, opts: import('./types.js').ExecOpts) {
  return getEngine(cfg).execStream(cfg, id, opts);
}
// hosts-sync.ts 的事件订阅（docker events / 将来 lxc monitor）。
export async function subscribeEvents(
  cfg: Config,
  onEvent: (ev: import('./types.js').EngineEvent) => void,
) {
  return getEngine(cfg).subscribeEvents(cfg, onEvent);
}
