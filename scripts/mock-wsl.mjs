#!/usr/bin/env node
// wsl.exe 的命令面模拟器：在非 Windows 机器上验证 wsl2 引擎的编排/解析/幂等逻辑。
// 用法：MYSANDBOX_WSL_BIN=/abs/path/to/mock-wsl node ...（配合 MYSANDBOX_MOCK_WSL_STATE
// 指定状态目录，默认 $TMPDIR/mock-wsl-state）。
// 设计文档：docs/wsl2-migration.md「测试策略」。
//
// 覆盖的命令面（wsl2 引擎实际用到的子集）：
//   --version / --help / --list [--quiet|--running|--verbose]
//   --import <名> <目录> <包> [--vhd] / --export <名> <文件> [--vhd]
//   --unregister <名> / --terminate <名>
//   -d <名> [--exec] <命令...>：识别 true / hostname -I / env+sh 包装（脚本收 stdout），
//     其余命令空输出 exit 0（seed 脚本等编排路径只看 exit code）。
// --list 系列按 UTF-16LE 编码输出（带 BOM），用于校验引擎的 decodeWsl 解码器（D7）。
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const STATE = process.env.MYSANDBOX_MOCK_WSL_STATE || join(tmpdir(), 'mock-wsl-state');
const DISTROS = () => (existsSync(join(STATE, 'distros')) ? readdirSync(join(STATE, 'distros')) : []);
const RUNNING_FILE = () => join(STATE, 'running.txt');
const running = () => (existsSync(RUNNING_FILE()) ? readFileSync(RUNNING_FILE(), 'utf8').split('\n').filter(Boolean) : []);
const setRunning = (names) => writeFileSync(RUNNING_FILE(), names.join('\n'));
const u16 = (s) => Buffer.from('﻿' + s, 'utf16le'); // 带 BOM 的 UTF-16LE（真实 wsl.exe 形态）

function die(msg) {
  process.stderr.write(u16(msg).toString('binary'));
  process.exit(1);
}

const argv = process.argv.slice(2);
mkdirSync(join(STATE, 'distros'), { recursive: true });

// —— 管理命令 ——
if (argv[0] === '--version') {
  process.stdout.write(u16('WSL 版本: 5.0.5050.0 (mock)\n内核版本: 9.9.9-1\n'));
  process.exit(0);
}
if (argv[0] === '--help') {
  process.stdout.write(u16('usage: wsl [Options] [--] [CommandLine]\n  --list [ --quiet | --running | --verbose ]\n  --import <Distro> <InstallLocation> <FileName> [--vhd]\n  --export <Distro> <FileName> [--vhd]\n  --unregister <Distro>\n  --terminate <Distro>\n'));
  process.exit(0);
}
if (argv[0] === '--list') {
  const mode = argv[1] || '';
  if (mode === '--quiet') {
    process.stdout.write(u16(DISTROS().map((d) => d + '\n').join('')));
    process.exit(0);
  }
  if (mode === '--running') {
    const r = running();
    if (r.length === 0) die('没有正在运行的分发版。\n');
    process.stdout.write(u16(r.map((d) => d + '\n').join('')));
    process.exit(0);
  }
  if (mode === '--verbose') {
    const r = running();
    const lines = DISTROS().map((d) => `  ${d.padEnd(20)} ${r.includes(d) ? 'Running' : 'Stopped'}   2`);
    process.stdout.write(u16('  NAME                STATE     VERSION\n' + lines.join('\n') + '\n'));
    process.exit(0);
  }
  die('unknown --list mode\n');
}

// --import <名> <目录> <包> [--vhd]：模拟落地（记名字 + 包内容哈希文件）
if (argv[0] === '--import') {
  const [name, dir, file] = argv.slice(1);
  if (!file || !existsSync(file)) die(`wsl --import: archive not found: ${file}\n`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(STATE, 'distros', name), { recursive: true });
  writeFileSync(join(STATE, 'distros', name, 'imported-from'), file);
  process.exit(0);
}
// --export <名> <文件> [--vhd]
if (argv[0] === '--export') {
  const [name, file] = argv.slice(1);
  if (!DISTROS().includes(name)) die(`没有已安装名称为 ${name} 的分发版。\n`);
  writeFileSync(file, `mock-export-of-${name}\n`);
  process.exit(0);
}
if (argv[0] === '--unregister') {
  const name = argv[1];
  if (!DISTROS().includes(name)) die(`没有已安装名称为 ${name} 的分发版。\n`);
  rmSync(join(STATE, 'distros', name), { recursive: true, force: true });
  setRunning(running().filter((n) => n !== name));
  process.exit(0);
}
if (argv[0] === '--terminate') {
  const name = argv[1];
  setRunning(running().filter((n) => n !== name));
  process.exit(0);
}

// —— 执行路径：-d <名> ... --exec ...（也容忍缺 --exec 的 shell 形态）——
if (argv[0] === '-d') {
  const name = argv[1];
  if (!DISTROS().includes(name)) die(`没有已安装名称为 ${name} 的分发版。\n`);
  const rest = argv.slice(2);
  const execIdx = rest.indexOf('--exec');
  const cmd = execIdx >= 0 ? rest.slice(execIdx + 1) : rest.filter((a) => a !== '--');
  // hostname -I：从安装簿 assignedIp 反推（IP 池口径一致），没有就发一个假 NAT 段 IP
  if (cmd[0] === 'hostname') {
    try {
      const book = JSON.parse(readFileSync(join(STATE, '..', 'bookkeeping-override.json'), 'utf8'));
      process.stdout.write((book[name] || '172.20.0.5') + '\n');
    } catch {
      process.stdout.write('172.20.0.5\n');
    }
    process.exit(0);
  }
  // true / env ... sh -c ...：编排路径，只回 exit 0
  if (cmd.length === 0 || cmd[0] === 'true' || cmd[0] === 'env') {
    setRunning([...new Set([...running(), name])]); // --exec 会拉起发行版（真实语义）
    process.exit(0);
  }
  process.exit(0);
}

die(`mock-wsl: unsupported args: ${argv.join(' ')}\n`);
