// 容器内 mysandbox 命令：宿主直接往容器 home 写脚本（不动镜像/模板、不 exec——容器停着
// 也能写）。宿主侧 home 路径由引擎给出
// lxc=<lxcpath>/<name>/rootfs/home/dev，D1 uid 直通所以同样可直写），落盘即容器内
// ~/.local/bin/mysandbox，PATH 第一项。
//
// 子命令：
//   mysandbox [open] [路径] —— web 终端里打印 OSC 7677，前端捕获后定位文件面板/编辑器；
//     非 web 环境只打一行中文提示，不污染终端。
//   mysandbox exec / targets —— 跨容器命令互通（peer API，server/peer.ts）：转发给
//     peer-exec.mjs（node 客户端，地址与凭据在 peer.json）。
//
// 种子语义：**内容变了就覆盖**（server-owned 自更新）——脚本升级、peer 换端口/轮 token
// 都随宿主启动扫描/建容器刷新，不依赖重建容器。用户手改会被下次覆盖，这是刻意的。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { getEngine } from './engine/index.js';
import { getAllMeta } from './state.js';
import { log } from './logger.js';
import { peerSeedInfo, type PeerSeedInfo } from './peer.js';

// 容器内路径（= 宿主侧 home 目录 + 此相对路径）。
export const CONTAINER_CLI_PATH = '/home/dev/.local/bin/mysandbox';

// POSIX sh：zsh/bash 都能跑；只依赖 printf/readlink/[ ]。
// 注意：这是要写进容器的脚本文本，与仓库本身的 TS 代码无关。
export const CONTAINER_CLI_SCRIPT = `#!/bin/sh
# mysandbox 容器内命令（宿主 mysandbox 种子写入，内容变更会自动覆盖——勿手改）。
usage() { echo "用法: mysandbox [open] [路径]  # 不带参数 = 当前目录"; \\
  echo "      mysandbox exec [--cwd DIR] [--timeout SEC] [--user U] <目标> -- 命令..."; \\
  echo "      mysandbox targets                       # 列出目标（host/c:容器/s:服务）"; }
case "\${1:-}" in -h|--help|help) usage; exit 0 ;; esac
# exec / targets 转发 node 客户端（地址与凭据在 peer.json，宿主 mysandbox 负责刷新）。
case "\${1:-}" in
  exec|targets) exec node "\${HOME:-/home/dev}/.config/mysandbox/peer-exec.mjs" "$@" ;;
esac
[ $# -le 2 ] || { usage >&2; exit 1; }
p="\${1:-}"
[ "$p" = "open" ] && p="\${2:-}"   # 兼容肌肉记忆：mysandbox open [路径]
[ $# -le 1 ] || { case "$1" in open) ;; *) usage >&2; exit 1 ;; esac; }
# 路径规整：空 = $PWD；相对 -> $PWD/xx；readlink -m 消 ../ 与符号链接（不存在也合法）。
case "$p" in "") p="$PWD" ;; /*) ;; *) p="$PWD/$p" ;; esac
q=$(readlink -m -- "$p" 2>/dev/null) && p="$q"   # readlink 不可用时保留原值
# web 环境探测：tmux 路径查 server 全局环境（exec 的 Env 到不了 tmux server 起的 shell，
# terminal.ts 每次 attach 前 set-environment -g 注入、运行时 show-environment -g 可查）；
# 非 tmux 回退路径（一次性 shell）看进程自身环境，那里 exec Env 有效。
web=0
if [ -n "$TMUX" ] && command -v tmux >/dev/null 2>&1; then
  [ "$(tmux show-environment -g MYSANDBOX_WEB 2>/dev/null)" = "MYSANDBOX_WEB=1" ] && web=1
fi
[ "$MYSANDBOX_WEB" = "1" ] && web=1
if [ "$web" != "1" ]; then
  echo "当前不在 mysandbox web 终端中：请在网页终端里运行，或在宿主侧用 'mysandbox open'。"
  exit 0
fi
# tmux 会吞掉不认识的 OSC，必须走 DCS passthrough（ESC 加倍、内层 OSC 用 BEL 结尾）；
# terminal.ts 每次 attach 前 set -s allow-passthrough on 放行。非 tmux 直接打裸 OSC。
if [ -n "$TMUX" ]; then
  printf '\\033Ptmux;\\033\\033]7677;open;%s\\007\\033\\\\' "$p"
else
  printf '\\033]7677;open;%s\\007' "$p"
fi
exit 0
`;

// peer-exec.mjs：容器内 peer API 客户端（node；容器契约保证 node 就位，curl 不在契约里）。
// 纯 ESM、不用模板字符串/反斜杠转义——这段是嵌在上面的 TS 模板字面量里的源码文本。
export const PEER_EXEC_SCRIPT = `#!/usr/bin/env node
// mysandbox peer 客户端（宿主 mysandbox 种子写入，内容变更会自动覆盖——勿手改）。
import { readFileSync } from 'node:fs';
import http from 'node:http';

const NL = String.fromCharCode(10);
const home = process.env.HOME || '/home/dev';
const cfgPath = home + '/.config/mysandbox/peer.json';
let peer;
try {
  peer = JSON.parse(readFileSync(cfgPath, 'utf8'));
} catch {
  process.stderr.write('mysandbox: 读不到 ' + cfgPath + '（宿主 mysandbox 未运行或 peer 未启用？）' + NL);
  process.exit(2);
}

function usage() {
  process.stderr.write(
    '用法: mysandbox exec [--cwd DIR] [--timeout SEC] [--user U] <目标> -- 命令...' + NL +
    '      mysandbox targets' + NL +
    '目标: host | c:<容器名> | s:<服务名> | <容器名>' + NL);
}

function request(method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(peer.url); } catch { reject(new Error('peer.json 的 url 无效: ' + peer.url)); return; }
    const data = body == null ? null : JSON.stringify(body);
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path,
      method,
      headers: Object.assign(
        { 'x-peer-token': peer.token || '' },
        data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode + ' ' + text.slice(0, 300))); return; }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error('响应不是 JSON: ' + text.slice(0, 300))); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}

function connFail(e) {
  process.stderr.write('mysandbox: 连不上 peer API（' + peer.url + '）: ' + (e && e.message ? e.message : e) + NL);
  process.exit(2);
}

const args = process.argv.slice(2);
const sub = args[0];

if (sub === 'targets') {
  request('GET', '/targets', null, 10000).then((t) => {
    process.stdout.write('host' + NL);
    for (const c of t.containers || []) {
      process.stdout.write('c:' + c.name + '  ' + (c.ip || '-') + (c.running ? '' : '  (已停止)') + NL);
    }
    for (const s of t.services || []) {
      process.stdout.write('s:' + s.name + '  ' + s.image + (s.running ? '' : '  (已停止)') + NL);
    }
  }).catch(connFail);
} else if (sub === 'exec') {
  let target = null;
  let cwd = null;
  let user = null;
  let timeoutSec = 60;
  const cmd = [];
  let onlyCmd = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (onlyCmd) { cmd.push(a); continue; }
    if (a === '--') { onlyCmd = true; continue; }
    if (a === '--cwd') { cwd = args[++i]; continue; }
    if (a === '--timeout') { timeoutSec = Number(args[++i]); continue; }
    if (a === '--user') { user = args[++i]; continue; }
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    if (a.lastIndexOf('--', 0) === 0) { process.stderr.write('mysandbox: 未知选项 ' + a + NL); usage(); process.exit(2); }
    if (target == null) { target = a; continue; }
    cmd.push(a);   // 目标后的裸参数宽容进命令（-- 可选）
  }
  if (target == null || cmd.length === 0) { usage(); process.exit(2); }
  const timeoutMs = Math.max(1, timeoutSec) * 1000;
  request('POST', '/exec', { target: target, cmd: cmd, cwd: cwd, timeoutMs: timeoutMs, user: user }, timeoutMs + 30000)
    .then((r) => {
      if (!r.ok) {
        if (r.error) process.stderr.write('mysandbox: ' + r.error + NL);
        if (r.stderr) process.stderr.write(r.stderr);
        process.exit(typeof r.exitCode === 'number' && r.exitCode > 0 ? r.exitCode : 1);
      }
      if (r.stdout) process.stdout.write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      process.exit(r.exitCode === -1 ? 1 : (r.exitCode || 0));
    })
    .catch(connFail);
} else {
  usage();
  process.exit(2);
}
`;

// 内容没变就不写（避免无谓落盘）；变了覆盖（自更新）。
function writeIfChanged(target: string, content: string, mode: number): void {
  try {
    if (readFileSync(target, 'utf8') === content) return;
  } catch {
    // 不存在：落到下面的 writeFileSync。
  }
  writeFileSync(target, content, { mode });
}

// 幂等种子（内容变就覆盖，与「缺才写」的老语义不同——peer exec 依赖自更新把新脚本/
// 新 peer.json 刷进存量容器）。失败记日志不抛——种子失败不阻塞建容器/启动。
export function seedContainerCli(home: string, peer?: PeerSeedInfo): void {
  const bin = join(home, '.local/bin');
  const conf = join(home, '.config/mysandbox');
  try {
    mkdirSync(bin, { recursive: true, mode: 0o755 });
    writeIfChanged(join(bin, 'mysandbox'), CONTAINER_CLI_SCRIPT, 0o755);
    mkdirSync(conf, { recursive: true, mode: 0o700 });
    writeIfChanged(join(conf, 'peer-exec.mjs'), PEER_EXEC_SCRIPT, 0o755);
    if (peer) writeIfChanged(join(conf, 'peer.json'), JSON.stringify(peer), 0o600);
  } catch (e) {
    log.warn({ home, err: String(e) }, 'container cli seed failed');
  }
}

// 启动扫描：给 sidecar 已知、且宿主侧 home 可见的存量容器补种子（幂等，自更新）。
// adopted 的外部容器若宿主写不进它的 home——超出范围，文档已注明。
// LXC 侧所有受管理容器的 home 都在 rootfs 内、必然可见。
export async function sweepContainerCli(cfg: Config): Promise<void> {
  let names: string[] = [];
  try {
    names = Object.keys(await getAllMeta());
  } catch {
    return; // state.json 读不了就算了，不影响起服务
  }
  const engine = getEngine(cfg);
  const peer = peerSeedInfo(cfg);
  for (const name of names) {
    const home = engine.hostHomePath(cfg, name);
    if (home && existsSync(home)) seedContainerCli(home, peer);
  }
}
