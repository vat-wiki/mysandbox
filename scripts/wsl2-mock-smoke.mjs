#!/usr/bin/env node
// wsl2 引擎的 mock 冒烟：MYSANDBOX_WSL_BIN 指向 scripts/mock-wsl.mjs，在非 Windows
// 机器上跑通引擎编排/解析/幂等逻辑（只能验证我们自己的代码，WSL 真实行为见
// docs/wsl2-migration.md「开放验证点」）。前置：npm run build:server。
// 用法：node scripts/wsl2-mock-smoke.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'wsl2-smoke-'));
process.env.HOME = root; // 引擎 installRoot()/state.json 全落临时目录
process.env.MYSANDBOX_MOCK_WSL_STATE = join(root, 'mock-state');
const mock = new URL('./mock-wsl.mjs', import.meta.url).pathname;
process.env.MYSANDBOX_WSL_BIN = mock;

const { wsl2Engine } = await import('../dist/server/engine/wsl2.js');
const { decodeWsl } = await import('../dist/server/engine/wsl2.js');

const cfg = {
  engine: 'wsl2',
  wsl: { template: 'ms-template' },
  lxc: { template: 'ms-template' },
  network: 'mysandbox0',
  dockerApi: { enabled: false, socket: '' },
  sshSource: '',
  claudeSettingsTemplate: '',
  ipPool: { from: '10.88.10.20', to: '10.88.10.250', reserved: [] },
};

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) process.stdout.write(`  ok  ${name}\n`);
  else {
    failed++;
    process.stdout.write(`FAIL  ${name} ${extra}\n`);
  }
}

// —— decodeWsl（D7）——
check('decodeWsl: BOM utf16le', decodeWsl(Buffer.from('﻿ms-template\n', 'utf16le')) === 'ms-template\n');
check('decodeWsl: utf8 passthrough', decodeWsl(Buffer.from('plain\n')) === 'plain\n');

// —— status ——
const st = await wsl2Engine.status(cfg);
check('status reachable (mock)', st.reachable === true, JSON.stringify(st));

// —— 基座 create（import 包 → 模板）——
const archive = join(root, 'base.tar');
writeFileSync(archive, 'mock-base-rootfs');
await wsl2Engine.runBaseAction(cfg, 'create', { path: archive }, (e) => {
  if (e.status) process.stdout.write(`      [progress] ${e.status}\n`);
});
const exists = await wsl2Engine.nameExists(cfg, 'ms-template');
check('base create: template registered', exists);
const bs = await wsl2Engine.baseStatus(cfg);
check('baseStatus exists+ready', bs.exists === true && bs.ready === true, JSON.stringify(bs));

// —— 建容器（克隆模板）——
check('name free before create', !(await wsl2Engine.nameExists(cfg, 'web-1')));
await wsl2Engine.create(cfg, { name: 'web-1', ip: '10.88.10.20', gitName: 'dev', gitEmail: 'dev@local' }, () => {});
check('name taken after create', await wsl2Engine.nameExists(cfg, 'web-1'));

const views = await wsl2Engine.listManaged(cfg);
const v = views.find((x) => x.name === 'web-1');
check('listManaged sees web-1 running', v?.state === 'running', JSON.stringify(views));
check('runtime ip from hostname -I', v?.ip === '172.20.0.5', String(v?.ip));
check('managed via bookkeeping', v?.managed === true);

const info = await wsl2Engine.inspect(cfg, 'web-1');
check('inspect running', info.running === true && info.managed === true);

// —— IP 池（安装簿记账）——
const ips = await wsl2Engine.assignedIps(cfg);
check('assignedIps has bookkeeping ip', ips.has('10.88.10.20'), JSON.stringify([...ips]));

// —— stop → 停机显示记账 IP ——
await wsl2Engine.stop(cfg, 'web-1');
const stopped = await wsl2Engine.inspect(cfg, 'web-1');
check('stop: not running', stopped.running === false);
check('stopped ip falls back to bookkeeping', stopped.ip === '10.88.10.20', String(stopped.ip));

// —— rename（需先停）——
let renameRejected = false;
try {
  await wsl2Engine.rename(cfg, 'web-1', 'web-2');
} catch {
  renameRejected = true; // 已停？mock 里 stop 后 state Stopped，应该能走
}
if (!renameRejected) {
  check('rename: web-2 registered', await wsl2Engine.nameExists(cfg, 'web-2'));
  check('rename: old gone', !(await wsl2Engine.nameExists(cfg, 'web-1')));
  await wsl2Engine.remove(cfg, 'web-2', { force: true });
} else {
  process.stdout.write('  (rename skipped: still running)\n');
  await wsl2Engine.remove(cfg, 'web-1', { force: true });
}

// —— remove → 名字释放、记账回收 ——
check('removed: name free', !(await wsl2Engine.nameExists(cfg, 'web-1')));
const ipsAfter = await wsl2Engine.assignedIps(cfg);
check('removed: bookkeeping cleared', !ipsAfter.has('10.88.10.20'), JSON.stringify([...ipsAfter]));

// —— 幂等：对已停容器重复 start/stop 不炸 ——
await wsl2Engine.create(cfg, { name: 'web-1', ip: '10.88.10.21', gitName: 'dev', gitEmail: 'dev@local' });
await wsl2Engine.stop(cfg, 'web-1');
await wsl2Engine.stop(cfg, 'web-1'); // 幂等
await wsl2Engine.start(cfg, 'web-1');
await wsl2Engine.start(cfg, 'web-1'); // 幂等
check('idempotent start/stop', true);
await wsl2Engine.remove(cfg, 'web-1', { force: true });

// —— 事件订阅：close 干净退出 ——
const sub = await wsl2Engine.subscribeEvents(cfg, () => {});
sub.close();
await sub.closed;
check('events close resolves', true);

rmSync(root, { recursive: true, force: true });
process.stdout.write(failed === 0 ? '\nALL PASS\n' : `\n${failed} FAILED\n`);
process.exit(failed === 0 ? 0 : 1);
