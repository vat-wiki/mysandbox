// engine 入口：消费方唯一 import 点。P3 阶段只有 docker 实现；P4 加 lxc 后
// 这里按 config 选择（或聚合 list）。lifecycle.ts/image.ts 仍用 getDocker/
// MANAGED_LABEL 直调 dockerode（创建/镜像构建是引擎特定路径），由此转发。
import type { Config } from '../config.js';
import type { Engine } from './types.js';
import { dockerEngine, getDocker, MANAGED_LABEL } from './docker.js';
// docker 实现本体在 engine/docker.ts；server/docker.ts 是 P5 删除前的纯转发 shim，
// 无消费方后即删。
export type { Engine, ExecOpts, ExecResult, ExecStream, ContainerInfo, ContainerView, ContainerPort, EngineEvent } from './types.js';
export { dockerEngine, getDocker, MANAGED_LABEL };

// 当前引擎（P3 恒 docker；P4 起由 config 决定）。
export function getEngine(cfg: Config): Engine {
  return dockerEngine;
}

// 便捷转发：消费方按名直接用，与原 docker.ts 的函数签名一致。
export function checkDocker(cfg: Config) {
  return dockerEngine.status(cfg);
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
