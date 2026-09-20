// wsl.exe 真实输出探针：钉死 docs/wsl2-migration.md「开放验证点」#7（UTF-16 解码）与
// 零发行版时的退出码/输出形态，并顺带验 #1（--vhd 旗标支持探测）。
// 与引擎完全同路径：execFile + encoding:'buffer' + engine 的 decodeWsl。
//
// 用法（Windows 上跑；前置：npm run build:server）：
//     node scripts/wsl2-windows-probe.mjs
// 结果同时打到屏幕并落盘（脚本同目录 *.log，已在 .gitignore 内）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeWsl } from '../dist/server/engine/wsl2.js';

// 日志落在脚本同目录（绝对路径）——这样从任何 cwd 调用都能找到。
const LOG = fileURLToPath(new URL('./wsl2-windows-probe.log', import.meta.url));
const ef = promisify(execFile);

writeFileSync(LOG, `wsl.exe 探针  ${new Date().toISOString()}\nplatform=${process.platform} node=${process.version}\n`);
function out(s) {
  process.stdout.write(s + '\n');
  appendFileSync(LOG, s + '\n');
}

function hex(buf, n = 48) {
  return buf.subarray(0, n).toString('hex').replace(/(..)/g, '$1 ').trim();
}

const CAP = 300;
const clip = (s) => (s.length > CAP ? s.slice(0, CAP) + ` …[+${s.length - CAP} 字符]` : s);

function report(stdout, stderr, code) {
  out(`  exit=${code}`);
  out(`  stdout ${stdout.length}B  raw: ${hex(stdout)}`);
  const hasBom = stdout.length >= 2 && stdout[0] === 0xff && stdout[1] === 0xfe;
  out(`  有 BOM(FF FE): ${hasBom}`);
  const dec = decodeWsl(stdout);
  const raw = stdout.toString('utf8');
  out(`  decodeWsl → ${JSON.stringify(clip(dec))}`);
  out(`  裸 utf8   → ${JSON.stringify(clip(raw))}`);
  out(`  与裸 utf8 不同: ${dec !== raw}`);
  if (stderr.length) {
    out(`  stderr ${stderr.length}B raw: ${hex(stderr)}`);
    out(`  decodeWsl(stderr) → ${JSON.stringify(clip(decodeWsl(stderr)))}`);
  } else {
    out('  stderr 空');
  }
}

async function probe(label, args) {
  out(`\n── ${label}  (wsl.exe ${args.join(' ')}) ──`);
  try {
    const { stdout, stderr } = await ef('wsl.exe', args, {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'buffer',
    });
    report(stdout, stderr, 0);
  } catch (e) {
    if (e.stdout || e.stderr) report(e.stdout ?? Buffer.alloc(0), e.stderr ?? Buffer.alloc(0), e.code ?? -1);
    else out(`  spawn/执行失败：code=${e.code} message=${e.message}`);
  }
}

await probe('版本（D7 主样本）', ['--version']);
await probe('--help（#1 --vhd 支持探测）', ['--help']);
await probe('已注册发行版（--quiet）', ['--list', '--quiet']);
await probe('运行中发行版（--running）', ['--list', '--running']);
await probe('表格形态（--verbose）', ['--list', '--verbose']);

out(`\n日志已写入 ${LOG}`);
