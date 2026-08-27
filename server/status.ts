// CLI 子命令 `mysandbox status`：宿主上全部 mysandbox 资产的总览扫描。
//
// 动机：管理边界靠结构化标志（LXC config 标记行、docker label、命名前缀），但标志散在
// 各处，排查「mysandbox 在这台机器上到底留下了什么」要跑五六条命令。这里把每类对象的
// 标志扫一遍，一条命令给出全景——每行都能对回一个可独立验证的外部命令。
//
// 只读、各段独立降级：引擎挂了不影响 docker 段，docker 挂了不影响 LXC 段。不要求服务在跑
// （与 base/open 子命令一致，直接扫宿主状态而非走 HTTP）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { STATE_FILE } from './config.js';
import { getEngine, listManaged } from './engine/index.js';
import { lxcPath, configPath, configValue } from './engine/lxc.js';
import { HOST_SOCKET } from './hostTerminal.js';
import { dockerStatus, listServiceContainers, listManagedVolumes } from './docker.js';
import { getAllMeta, getAllServiceMeta } from './state.js';
import { getVersion } from './version.js';

const execFileAsync = promisify(execFile);

// 与 listManaged 同口径：每容器一行（名字 | 状态 | IP | 身份）。IP 停机读 config 静态值。
// 身份用 sidecar 真值（ContainerView.adopted 实际是「sidecar 登记过」——自建容器也是 true，
// 直接用会把自建容器标成 adopted 误导排查）。
async function scanContainers(cfg: Config): Promise<void> {
  const [list, meta] = await Promise.all([listManaged(cfg), getAllMeta()]);
  process.stdout.write(`\n容器（LXC，config 标记 MYSANDBOX_MANAGED=true）\n`);
  if (list.length === 0) {
    process.stdout.write(`  （无）\n`);
    return;
  }
  for (const c of list) {
    const m = meta[c.name];
    const bits = [c.status.padEnd(9), (c.ip ?? '无 IP').padEnd(14)];
    if (m?.adopted) bits.push('adopted(外部)');
    if (!c.managed) bits.push('仅桥匹配');
    if (c.displayName && c.displayName !== c.name) bits.push(`"${c.displayName}"`);
    process.stdout.write(`  ${c.name.padEnd(20)} ${bits.join(' ')}\n`);
  }
  process.stdout.write(`  扫描: grep -l MYSANDBOX_MANAGED ${lxcPath()}/*/config\n`);
}

// 模板（基座）单独一行：它带标记但被 listManaged 排除（基座不出现在容器列表）。
async function scanTemplate(cfg: Config): Promise<void> {
  const p = configPath(cfg.lxc.template);
  let content: string | null = null;
  try {
    content = await readFile(p, 'utf8');
  } catch {
    /* 模板不存在 */
  }
  if (content == null) {
    process.stdout.write(`\n基座模板: ${cfg.lxc.template} 不存在（mysandbox base status 看详情）\n`);
    return;
  }
  const ip = (configValue(content, 'lxc.net.0.ipv4.address') || '').split('/')[0] || '无 IP';
  process.stdout.write(`\n基座模板（带标记但不列进容器）: ${cfg.lxc.template}  ${ip}\n`);
}

// docker 服务层：label 过滤的服务容器 + label 过滤的卷。孤儿卷 = 有 label 但 meta 里没有
// 登记（删服务不勾「删数据」留下的，无 UI 入口可清——提示手工 docker volume rm）。
async function scanServices(cfg: Config): Promise<void> {
  process.stdout.write(`\ndocker 服务层（label mysandbox.managed-by=mysandbox）\n`);
  const d = await dockerStatus();
  if (!d.reachable) {
    process.stdout.write(`  docker 不可达: ${d.error}\n`);
    return;
  }
  process.stdout.write(`  docker ${d.version}\n`);
  const rows = await listServiceContainers();
  const meta = await getAllServiceMeta();
  if (rows.length === 0) {
    process.stdout.write(`  服务: （无）\n`);
  } else {
    for (const row of rows) {
      const name = row.Names.split(',')[0].replace(/^\//, '');
      const preset = row.Labels['mysandbox.service-preset'] ?? meta[name]?.preset ?? '?';
      const ip = meta[name]?.ip ?? '';
      process.stdout.write(
        `  ${name.padEnd(20)} ${row.State.padEnd(10)} ${preset.padEnd(10)} ${ip}\n`,
      );
    }
    process.stdout.write(`  扫描: docker ps -a --filter label=mysandbox.managed-by=mysandbox\n`);
  }
  const volumes = await listManagedVolumes().catch(() => [] as { name: string }[]);
  const registered = new Set(Object.values(meta).map((m) => m.volume).filter(Boolean));
  const orphans = volumes.filter((v) => !registered.has(v.name));
  if (volumes.length > 0) {
    process.stdout.write(`  数据卷: ${volumes.map((v) => v.name).join(', ')}\n`);
  }
  if (orphans.length > 0) {
    process.stdout.write(
      `  ⚠ 孤儿卷（服务已删、数据保留，无 UI 入口）: ${orphans.map((v) => v.name).join(', ')}\n` +
        `    清理: docker volume rm <名>\n`,
    );
  }
}

// 宿主终端会话：专用 socket 上的全部 tmux 会话。服务没跑时会话也可能在（tmux 与服务解耦
// 就是这个设计），所以这里只报「有哪些」，不猜服务状态。
async function scanHostTerminal(): Promise<void> {
  process.stdout.write(`\n宿主终端（tmux -L ${HOST_SOCKET}）\n`);
  let out: string;
  try {
    const r = await execFileAsync('tmux', ['-L', HOST_SOCKET, 'list-sessions', '-F', '#{session_name}'], {
      timeout: 3_000,
    });
    out = r.stdout;
  } catch {
    process.stdout.write(`  （无会话 / server 未起）\n`);
    return;
  }
  for (const line of out.split('\n')) {
    const name = line.trim();
    if (name) process.stdout.write(`  ${name}\n`);
  }
}

// systemd 瞬态单元：mysandbox-* 前缀是 lxc-start（service）与宿主 tmux server（scope）的
// 标志。systemctl --user list-units 的输出本身就是权威扫描。
async function scanUnits(): Promise<void> {
  process.stdout.write(`\nsystemd 瞬态单元（systemctl --user list-units 'mysandbox-*'）\n`);
  try {
    const { stdout } = await execFileAsync(
      'systemctl', ['--user', 'list-units', 'mysandbox-*', '--all', '--no-legend', '--plain'],
      { timeout: 5_000 },
    );
    const lines = stdout.split('\n').filter((l) => l.trim());
    if (lines.length === 0) {
      process.stdout.write(`  （无）\n`);
      return;
    }
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      const unit = cols[0] ?? '';
      const state = cols[3] ?? '';
      const desc = cols.slice(4).join(' ');
      process.stdout.write(`  ${unit.padEnd(32)} ${state.padEnd(8)} ${desc}\n`);
    }
  } catch {
    process.stdout.write(`  systemctl 不可用（不在 user manager 环境？）\n`);
  }
}

// sidecar 与配置文件的存在性（不打印内容——token/env 值不出现在输出里）。
async function scanSidecar(): Promise<void> {
  process.stdout.write(`\nsidecar / 配置\n`);
  let state = '';
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Record<string, unknown>;
    const counts = Object.entries(s)
      .map(([k, v]) => `${k}=${Object.keys(v as object).length}`)
      .join(' ');
    state = counts || '空';
  } catch {
    state = '无';
  }
  process.stdout.write(`  ${STATE_FILE}（0600）  ${state}\n`);
  process.stdout.write(`  容器内终端会话: 各容器 /tmp 下 mysandbox-<短id>-<termId>（tmux ls 可见）\n`);
}

export async function runStatusCommand(cfg: Config): Promise<void> {
  const engine = getEngine(cfg);
  const d = await engine.status(cfg);
  process.stdout.write(`mysandbox ${getVersion()} 总览  (${lxcPath()})\n`);
  process.stdout.write(`引擎: ${engine.name} ${d.reachable ? d.version ?? '' : `不可达 — ${d.error}`}\n`);
  if (!d.reachable) return; // 引擎不可达时容器段扫不出，其余段照常（下面各自降级）

  await scanContainers(cfg);
  await scanTemplate(cfg);
  await scanServices(cfg);
  await scanHostTerminal();
  await scanUnits();
  await scanSidecar();
}
