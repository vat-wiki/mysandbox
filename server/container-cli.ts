// 容器内 mysandbox 命令：宿主直接往 dataRoot/<name>/.local/bin/mysandbox 写脚本（不动镜像、
// 不 exec——容器停着也能写，bind mount 下即容器内 ~/.local/bin/mysandbox，PATH 第一项）。
// 在 web 终端里执行时打印 OSC 7677 序列，前端 Terminal.vue 捕获后定位文件面板/打开编辑器；
// 非 web 环境（宿主 docker exec / ssh 直连）只打一行中文提示，不污染终端。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from './config.js';
import { getAllMeta } from './state.js';
import { log } from './logger.js';

// 容器内路径（= 宿主 dataRoot/<name> + 此相对路径）。
export const CONTAINER_CLI_PATH = '/home/dev/.local/bin/mysandbox';

// POSIX sh：zsh/bash 都能跑；只依赖 printf/readlink/[ ]。
// 注意：这是要写进容器的脚本文本，与仓库本身的 TS 代码无关。
export const CONTAINER_CLI_SCRIPT = `#!/bin/sh
# mysandbox 容器内命令：在 web 终端里把当前目录（或指定路径）在浏览器的文件面板中打开。
# 原理：web 终端（terminal.ts）注入了 MYSANDBOX_WEB 标记，这里探测到就打 OSC 7677
# 转义序列，前端捕获后联动打开面板/编辑器。非 web 环境只打提示，不打任何转义序列。
usage() { echo "用法: mysandbox [open] [路径]  # 不带参数 = 当前目录"; }
case "\${1:-}" in -h|--help|help) usage; exit 0 ;; esac
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

// 幂等种子（缺失才写，与 entrypoint.sh 的种子语义一致）：宿主 uid 1000 = 容器 dev，
// bind mount 下直接落盘。失败记日志不抛——种子失败不阻塞建容器/启动。
export function seedContainerCli(dataDir: string): void {
  const bin = join(dataDir, '.local/bin');
  const target = join(bin, 'mysandbox');
  try {
    if (!existsSync(bin)) mkdirSync(bin, { recursive: true, mode: 0o755 });
    if (!existsSync(target)) writeFileSync(target, CONTAINER_CLI_SCRIPT, { mode: 0o755 });
  } catch (e) {
    log.warn({ dataDir, err: String(e) }, 'container cli seed failed');
  }
}

// 启动扫描：给 sidecar 已知、且宿主可见 dataRoot 的存量容器补种子（幂等）。
// adopted 外部容器没有 dataRoot 挂载，宿主写不进它的 home——超出范围，文档已注明。
export async function sweepContainerCli(cfg: Config): Promise<void> {
  let names: string[] = [];
  try {
    names = Object.keys(await getAllMeta());
  } catch {
    return; // state.json 读不了就算了，不影响起服务
  }
  for (const name of names) {
    const home = join(cfg.dataRoot, name);
    if (existsSync(home)) seedContainerCli(home);
  }
}
