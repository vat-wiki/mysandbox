// wsl2 引擎端到端验证：用一个真实发行版（Alpine rootfs 包）走完整生命周期。
// 逐条覆盖 docs/wsl2-migration.md 的开放验证点：
//   #1 --vhd 支持（clone 走 vhd 快路径）
//   #2 --import 对 installDir 的要求
//   #3 9P：\\wsl.localhost 直读直写 + 创建文件属主/权限
//   #4 --exec argv 直传完整性（含空格/引号）
//   #5 execSpawn 管道 stdout 是否字节直通（tar 下载的命门）
//   #6 PTY：execStream 是否拿到输出
//   #7 UTF-16 解码（已单独验过，这里顺带跑 status）
// 用法（Windows 上跑；前置：npm run build:server + 一个已导入的基座包）：
//     node scripts/wsl2-lifecycle-probe.mjs <base-tarball-path>
// 结果同时打到屏幕并落盘（脚本同目录 *.log，已在 .gitignore 内）。
import { writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../dist/server/config.js';
import { getEngine } from '../dist/server/engine/index.js';

const LOG = fileURLToPath(new URL('./wsl2-lifecycle-probe.log', import.meta.url));
writeFileSync(LOG, `wsl2 生命周期验证  ${new Date().toISOString()}\n`);
function out(s) {
  process.stdout.write(s + '\n');
  appendFileSync(LOG, s + '\n');
}
let failed = 0;
function check(name, cond, extra = '') {
  out(`${cond ? '  ok  ' : 'FAIL  '}${name}${cond ? '' : '   ' + extra}`);
  if (!cond) failed++;
}

const archive = process.argv[2];
if (!archive) {
  out('用法: node scripts/wsl2-lifecycle-probe.mjs <base-tarball-path>');
  process.exit(1);
}

const { config } = await loadConfig();
const engine = getEngine(config);
const TEMPLATE = config.wsl.template;
const NAME = 'probe-1';
out(`engine=${engine.name}  template=${TEMPLATE}  ipAuthority=${engine.caps.ipAuthority}`);

// —— 0. 起点：干净状态 ——
for (const n of [NAME]) {
  try {
    await engine.remove(config, n, { force: true });
    out(`  (清理了遗留容器 ${n})`);
  } catch {
    /* 本来就没有 */
  }
}
if (await engine.nameExists(config, TEMPLATE)) {
  out(`  (模板 ${TEMPLATE} 已存在，跳过导入——本轮只验引擎，不重做基座)`);
}

// —— 1. 基座：从包导入模板（#2 installDir 要求）——
out('\n[1] base import（wsl --import 成模板）');
if (await engine.nameExists(config, TEMPLATE)) {
  out('      跳过（已存在）');
} else {
  const t0 = Date.now();
  await engine.runBaseAction(config, 'import', { path: archive }, (e) => e.status && out(`      [base] ${e.status}`));
  out(`      耗时 ${Date.now() - t0}ms`);
}
const bs = await engine.baseStatus(config);
check('baseStatus exists', bs.exists === true, JSON.stringify(bs));
check('baseStatus ready（D10：ready=exists）', bs.ready === true, JSON.stringify(bs));
check('baseName 走接口', engine.baseName(config) === TEMPLATE, engine.baseName(config));
const size = await engine.baseSize(config);
check('baseSize 有值（ext4.vhdx 大小）', typeof size === 'number' && size > 0, String(size));
out(`      baseSize=${size} 字节  detail=${JSON.stringify(bs.detail)}`);

// —— 2. 建容器 = 克隆模板（#1 走 vhd 快路径）——
out('\n[2] create（克隆模板 → 新发行版）');
const t1 = Date.now();
await engine.create(
  config,
  { name: NAME, ip: '10.88.10.20', gitName: 'dev', gitEmail: 'dev@local' },
  (e) => e.status && out(`      [create] ${e.status}`),
);
const cloneMs = Date.now() - t1;
out(`      耗时 ${cloneMs}ms`);
check('容器已注册', await engine.nameExists(config, NAME));
check(
  `克隆走 vhd 快路径（<30s 视为块拷贝；实耗 ${cloneMs}ms）`,
  cloneMs < 30_000,
  `慢路径 tar 全量会明显更久`,
);

// —— 3. 列表 / inspect（D5：运行 IP 现查 hostname -I）——
out('\n[3] listManaged / inspect（IP 权威 = runtime）');
const views = await engine.listManaged(config);
const v = views.find((x) => x.name === NAME);
check('listManaged 看到容器', !!v, JSON.stringify(views));
check('状态 running', v?.state === 'running', JSON.stringify(v));
check('安装簿判定 managed', v?.managed === true, JSON.stringify(v));
// D5 读运行 IP 靠 `hostname -I`。这不是所有发行版都有——BusyBox 的 hostname 就不支持 -I
// （实测 Alpine：「hostname: unrecognized option: I」）。先探能力，再决定这条算不算数。
const hi = await engine.execRun(config, NAME, { Cmd: ['hostname', '-I'], timeoutMs: 30_000 });
if (hi.exitCode === 0) {
  check('运行中读到真实 NAT IP（D5）', !!v?.ip && v.ip !== '10.88.10.20', `ip=${v?.ip}`);
  out(`      真实 IP=${v?.ip}（记账 IP=10.88.10.20）`);
} else {
  out('  SKIP  运行中读到真实 NAT IP —— 本包 hostname 不支持 -I（环境限制，非引擎缺陷；');
  out(`        引擎此时 ip=null 而非回退记账 IP，见补记）  stderr=${JSON.stringify(hi.stderr.trim().split('\n')[0])}`);
}
const info = await engine.inspect(config, NAME);
check('inspect running+managed', info.running === true && info.managed === true, JSON.stringify(info));

// —— 4. exec：argv 直传完整性（#4）+ 输出解码 ——
out('\n[4] execRun（--exec argv 直传 / 含空格引号）');
const r1 = await engine.execRun(config, NAME, { Cmd: ['echo', 'plain-ok'], timeoutMs: 30_000 });
check('基本 exec 输出正确', r1.stdout.trim() === 'plain-ok', JSON.stringify(r1));
const r2 = await engine.execRun(config, NAME, {
  Cmd: ['sh', '-c', 'printf "%s|%s|%s" "$1" "$2" "$3"', 'x', 'a b', 'c"d', "e'f"],
  timeoutMs: 30_000,
});
check('argv 含空格/引号原样到达', r2.stdout === 'a b|c"d|e\'f', JSON.stringify(r2.stdout) + ' ' + JSON.stringify(r2.stderr));
const r3 = await engine.execRun(config, NAME, { Cmd: ['id', '-u'], timeoutMs: 30_000 });
out(`      默认用户 uid=${r3.stdout.trim()}（mapUser 缺省落 dev）`);
const r4 = await engine.execRun(config, NAME, { Cmd: ['id', '-u'], User: 'root', timeoutMs: 30_000 });
check('User=root 映射到 root', r4.stdout.trim() === '0', JSON.stringify(r4.stdout));
const r5 = await engine.execRun(config, NAME, { Cmd: ['sh', '-c', 'pwd'], WorkingDir: '/tmp', timeoutMs: 30_000 });
check('WorkingDir 生效', r5.stdout.trim() === '/tmp', JSON.stringify(r5.stdout));

// —— 5. 9P：宿主直写 rootfs + 属主映射（#3）——
out('\n[5] 9P 宿主侧路径（\\wsl.localhost 直读直写）');
const root = engine.rootfsPath(config, NAME);
check('rootfsPath 非空（Windows 分支）', !!root, String(root));
out(`      rootfsPath=${root}`);
const home = engine.hostHomePath(config, NAME);
check('hostHomePath 非空', !!home, String(home));
const BIN = Buffer.from([0x41, 0x0a, 0x42, 0x0d, 0x0a, 0x43, 0x00, 0x44, 0xff, 0xfe, 0x0a, 0x7f]);
let ninePath = null;
try {
  ninePath = `${root}\\tmp\\msb-bin.dat`;
  writeFileSync(ninePath, BIN);
  check('9P 写入成功', true);
  const back = readFileSync(ninePath);
  check('9P 读回字节一致', Buffer.compare(back, BIN) === 0, `${back.length}B vs ${BIN.length}B`);
} catch (e) {
  check('9P 写入成功', false, String(e));
}
const rOwn = await engine.execRun(config, NAME, { Cmd: ['stat', '-c', '%U:%G %a', '/tmp/msb-bin.dat'], timeoutMs: 30_000 });
out(`      容器内看到的属主/权限: ${rOwn.stdout.trim() || rOwn.stderr.trim()}`);

// —— 6. execSpawn 字节直通（#5，tar 下载的命门）——
out('\n[6] execSpawn 管道 stdout 字节直通（#5 必须钉死）');
{
  const h = engine.execSpawn(config, NAME, { Cmd: ['cat', '/tmp/msb-bin.dat'] });
  const chunks = [];
  h.stdout.on('data', (d) => chunks.push(d));
  const got = await new Promise((resolve) => {
    h.done.then(() => resolve(Buffer.concat(chunks)));
  });
  check(
    'stdout 原始字节一致（未做 CRLF/编码改写）',
    Buffer.compare(got, BIN) === 0,
    `收到 ${got.length}B: ${got.toString('hex')} / 期望 ${BIN.toString('hex')}`,
  );
}

// —— 7. PTY（#6）——
out('\n[7] execStream（node-pty ConPTY，terminal 的底座）');
try {
  const st = await engine.execStream(config, NAME, { Cmd: ['sh', '-c', 'printf "PTY-OK\\n"'], User: 'root' });
  const buf = [];
  st.stream.on('data', (d) => buf.push(d));
  const ended = new Promise((res) => st.stream.on('end', res));
  await Promise.race([ended, new Promise((res) => setTimeout(res, 8000))]);
  const text = Buffer.concat(buf).toString('utf8');
  check('PTY 通道拿到输出', text.includes('PTY-OK'), JSON.stringify(text.slice(0, 200)));
  out(`      原始输出: ${JSON.stringify(text.slice(0, 200))}`);
  st.stream.destroy?.();
} catch (e) {
  check('PTY 通道拿到输出', false, String(e));
}

// —— 8. 幂等 start/stop + 停机显示记账 IP ——
out('\n[8] start/stop 幂等 + 停机 IP 回退记账值');
await engine.start(config, NAME);
await engine.start(config, NAME);
check('重复 start 幂等', true);
await engine.stop(config, NAME);
await engine.stop(config, NAME);
check('重复 stop 幂等', true);
const stopped = await engine.inspect(config, NAME);
check('停机后不 running', stopped.running === false, JSON.stringify(stopped));
check('停机 IP 回退安装簿记账值', stopped.ip === '10.88.10.20', String(stopped.ip));

// —— 9. 删除（D4：连数据一起删）——
out('\n[9] remove（wsl --unregister 连 VHD 一起删）');
await engine.remove(config, NAME, { force: true });
check('名字已释放', !(await engine.nameExists(config, NAME)));
const ips = await engine.assignedIps(config);
check('IP 池记账已回收', !ips.has('10.88.10.20'), JSON.stringify([...ips]));

out(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}   日志: ${LOG}`);
process.exit(failed === 0 ? 0 : 1);
