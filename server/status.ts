// CLI 子命令 `mysandbox status`：宿主上全部 mysandbox 资产的总览扫描。
//
// 动机：管理边界靠结构化标志（LXC config 标记行、docker label、命名前缀），但标志散在
// 各处，排查「mysandbox 在这台机器上到底留下了什么」要跑五六条命令。这里把每类对象的
// 标志扫一遍，一条命令给出全景——每行都能对回一个可独立验证的外部命令。
//
// 只读、各段独立降级：引擎挂了不影响 docker 段，docker 挂了不影响 LXC 段。不要求服务在跑
// （与 base/open 子命令一致，直接扫宿主状态而非走 HTTP）。
//
// 结构：collect* 先把各段收成结构化数据（内部降级、不抛），再按 --json 与否渲染成
// JSON（StatusReport，脚本/容器内 AI agent 吃）或人读文本。敏感值（token、服务
// env/密码）不进任何输出——status 是资产清单，不是凭据查看器（凭据走 web API）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import type { Config } from './config.js';
import { STATE_FILE } from './config.js';
import { getEngine, listManaged } from './engine/index.js';
import type { ContainerView } from './engine/index.js';
import { lxcPath, configPath, configValue } from './engine/lxc.js';
import { HOST_SOCKET } from './hostTerminal.js';
import { dockerStatus, listServiceContainers, listManagedVolumes, rowLabels } from './docker.js';
import { getAllMeta, getAllServiceMeta, adoptedContainerNames } from './state.js';
import { getVersion } from './version.js';

const execFileAsync = promisify(execFile);

// —— 结构化报告（--json 输出形状）——
// containers 复用 ContainerView（与 /api/containers 同形）。adoptedExternal 是文本版
// 「adopted(外部)」的机器可读版：ContainerView.adopted 实际是「sidecar 登记过」——
// 自建容器也是 true，真「外部纳入」只看 sidecar 的 adopted。
export interface StatusContainer extends ContainerView {
  adoptedExternal: boolean;
}

export interface StatusReport {
  version: string;
  generatedAt: string;
  lxcPath: string;
  engine: { name: string; reachable: boolean; version?: string; apiVersion?: string; error?: string };
  // 引擎不可达 = null（容器段依赖 lxc-*）；空数组 = 真没有。
  containers: StatusContainer[] | null;
  template: { name: string; exists: boolean; ip: string | null };
  docker: {
    reachable: boolean;
    version?: string;
    error?: string;
    // env/凭据刻意不进 status（见文件头）。
    services: {
      name: string;
      state: string;
      preset: string;
      image: string;
      ip?: string;
      ports?: number[];
      displayName?: string;
      volume: string | null;
    }[];
    volumes: string[];
    orphanVolumes: string[];
  };
  hostTerminal: { socket: string; sessions: string[]; error?: string };
  units: { items: { unit: string; state: string; description: string }[]; error?: string };
  sidecar: { path: string; counts: Record<string, number>; error?: string };
}

// —— 收集层：每段独立降级，不抛 ——

async function collectContainers(cfg: Config): Promise<StatusContainer[] | null> {
  try {
    const [list, meta] = await Promise.all([listManaged(cfg), getAllMeta()]);
    return list.map((c) => ({ ...c, adoptedExternal: !!meta[c.name]?.adopted }));
  } catch {
    return null;
  }
}

// 模板（基座）单独一段：它带标记但被 listManaged 排除（基座不出现在容器列表）。
async function collectTemplate(cfg: Config): Promise<StatusReport['template']> {
  let content: string | null = null;
  try {
    content = await readFile(configPath(cfg.lxc.template), 'utf8');
  } catch {
    /* 模板不存在 */
  }
  const ip = content
    ? (configValue(content, 'lxc.net.0.ipv4.address') || '').split('/')[0] || null
    : null;
  return { name: cfg.lxc.template, exists: content != null, ip };
}

// docker 服务层：label 过滤的服务容器 + label 过滤的卷。孤儿卷 = 有 label 但 meta 里没有
// 登记（删服务不勾「删数据」留下的，无 UI 入口可清——提示手工 docker volume rm）。
async function collectServices(): Promise<StatusReport['docker']> {
  const d = await dockerStatus();
  if (!d.reachable) {
    return { reachable: false, error: d.error, services: [], volumes: [], orphanVolumes: [] };
  }
  const meta = await getAllServiceMeta();
  const [rows, volumes] = await Promise.all([
    listServiceContainers(adoptedContainerNames(meta)),
    listManagedVolumes().catch(() => [] as { name: string }[]),
  ]);
  const services = rows.map((row) => {
    const name = row.Names.split(',')[0].replace(/^\//, '');
    const m = meta[name];
    return {
      name,
      state: row.State,
      preset: rowLabels(row)['mysandbox.service-preset'] ?? m?.preset ?? '?',
      image: row.Image,
      ip: m?.ip,
      ports: m?.ports,
      displayName: m?.displayName,
      volume: m?.volume ?? null,
    };
  });
  const registered = new Set(Object.values(meta).map((m) => m.volume).filter(Boolean));
  const orphanVolumes = volumes.filter((v) => !registered.has(v.name)).map((v) => v.name);
  return {
    reachable: true,
    version: d.version,
    services,
    volumes: volumes.map((v) => v.name),
    orphanVolumes,
  };
}

// 宿主终端会话：专用 socket 上的全部 tmux 会话。服务没跑时会话也可能在（tmux 与服务解耦
// 就是这个设计），所以这里只报「有哪些」，不猜服务状态。
async function collectHostTerminal(): Promise<StatusReport['hostTerminal']> {
  try {
    const r = await execFileAsync(
      'tmux', ['-L', HOST_SOCKET, 'list-sessions', '-F', '#{session_name}'],
      { timeout: 3_000 },
    );
    return {
      socket: HOST_SOCKET,
      sessions: r.stdout.split('\n').map((l) => l.trim()).filter(Boolean),
    };
  } catch (e) {
    return { socket: HOST_SOCKET, sessions: [], error: String(e) };
  }
}

// systemd 瞬态单元：mysandbox-* 前缀是 lxc-start（service）与宿主 tmux server（scope）的
// 标志。systemctl --user list-units 的输出本身就是权威扫描。
async function collectUnits(): Promise<StatusReport['units']> {
  try {
    const { stdout } = await execFileAsync(
      'systemctl', ['--user', 'list-units', 'mysandbox-*', '--all', '--no-legend', '--plain'],
      { timeout: 5_000 },
    );
    const items = stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((line) => {
        const cols = line.trim().split(/\s+/);
        return { unit: cols[0] ?? '', state: cols[3] ?? '', description: cols.slice(4).join(' ') };
      });
    return { items };
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

// sidecar 与配置文件的存在性（只数 key，不打印内容——token/env 值不出现在输出里）。
async function collectSidecar(): Promise<StatusReport['sidecar']> {
  try {
    const s = JSON.parse(await readFile(STATE_FILE, 'utf8')) as Record<string, unknown>;
    const counts: Record<string, number> = {};
    for (const [k, v] of Object.entries(s)) counts[k] = Object.keys(v as object).length;
    return { path: STATE_FILE, counts };
  } catch (e) {
    return { path: STATE_FILE, counts: {}, error: String(e) };
  }
}

export async function collectStatusReport(cfg: Config): Promise<StatusReport> {
  const engine = getEngine(cfg);
  const d = await engine.status(cfg);
  const [containers, template, docker, hostTerminal, units, sidecar] = await Promise.all([
    d.reachable ? collectContainers(cfg) : Promise.resolve(null),
    collectTemplate(cfg),
    collectServices(),
    collectHostTerminal(),
    collectUnits(),
    collectSidecar(),
  ]);
  return {
    version: getVersion(),
    generatedAt: new Date().toISOString(),
    lxcPath: lxcPath(),
    engine: {
      name: engine.name,
      reachable: d.reachable,
      version: d.version,
      apiVersion: d.apiVersion,
      error: d.error,
    },
    containers,
    template,
    docker,
    hostTerminal,
    units,
    sidecar,
  };
}

// —— 文本渲染：每行对回一个可独立验证的外部命令（人排查用）——

function renderText(r: StatusReport): void {
  process.stdout.write(`mysandbox ${r.version} 总览  (${r.lxcPath})\n`);
  process.stdout.write(
    `引擎: ${r.engine.name} ${r.engine.reachable ? r.engine.version ?? '' : `不可达 — ${r.engine.error}`}\n`,
  );

  // 与 listManaged 同口径：每容器一行（名字 | 状态 | IP | 身份）。IP 停机读 config 静态值。
  process.stdout.write(`\n容器（LXC，config 标记 MYSANDBOX_MANAGED=true）\n`);
  if (r.containers == null) {
    process.stdout.write(`  引擎不可达，扫不出\n`);
  } else if (r.containers.length === 0) {
    process.stdout.write(`  （无）\n`);
  } else {
    for (const c of r.containers) {
      const bits = [c.status.padEnd(9), (c.ip ?? '无 IP').padEnd(14)];
      if (c.adoptedExternal) bits.push('adopted(外部)');
      if (!c.managed) bits.push('仅桥匹配');
      if (c.displayName && c.displayName !== c.name) bits.push(`"${c.displayName}"`);
      process.stdout.write(`  ${c.name.padEnd(20)} ${bits.join(' ')}\n`);
    }
  }
  process.stdout.write(`  扫描: grep -l MYSANDBOX_MANAGED ${r.lxcPath}/*/config\n`);

  if (r.template.exists) {
    process.stdout.write(
      `\n基座模板（带标记但不列进容器）: ${r.template.name}  ${r.template.ip ?? '无 IP'}\n`,
    );
  } else {
    process.stdout.write(`\n基座模板: ${r.template.name} 不存在（mysandbox base status 看详情）\n`);
  }

  process.stdout.write(`\ndocker 服务层（label mysandbox.managed-by=mysandbox）\n`);
  if (!r.docker.reachable) {
    process.stdout.write(`  docker 不可达: ${r.docker.error}\n`);
  } else {
    process.stdout.write(`  docker ${r.docker.version}\n`);
    if (r.docker.services.length === 0) {
      process.stdout.write(`  服务: （无）\n`);
    } else {
      for (const s of r.docker.services) {
        process.stdout.write(
          `  ${s.name.padEnd(20)} ${s.state.padEnd(10)} ${s.preset.padEnd(10)} ${s.ip ?? ''}\n`,
        );
      }
      process.stdout.write(
        `  扫描: docker ps -a --filter label=mysandbox.managed-by=mysandbox\n`,
      );
    }
    if (r.docker.volumes.length > 0) {
      process.stdout.write(`  数据卷: ${r.docker.volumes.join(', ')}\n`);
    }
    if (r.docker.orphanVolumes.length > 0) {
      process.stdout.write(
        `  ⚠ 孤儿卷（服务已删、数据保留，无 UI 入口）: ${r.docker.orphanVolumes.join(', ')}\n` +
          `    清理: docker volume rm <名>\n`,
      );
    }
  }

  process.stdout.write(`\n宿主终端（tmux -L ${r.hostTerminal.socket}）\n`);
  if (r.hostTerminal.sessions.length > 0) {
    for (const name of r.hostTerminal.sessions) process.stdout.write(`  ${name}\n`);
  } else {
    process.stdout.write(`  （无会话 / server 未起）\n`);
  }

  process.stdout.write(`\nsystemd 瞬态单元（systemctl --user list-units 'mysandbox-*'）\n`);
  if (r.units.error != null) {
    process.stdout.write(`  systemctl 不可用（不在 user manager 环境？）\n`);
  } else if (r.units.items.length === 0) {
    process.stdout.write(`  （无）\n`);
  } else {
    for (const u of r.units.items) {
      process.stdout.write(`  ${u.unit.padEnd(32)} ${u.state.padEnd(8)} ${u.description}\n`);
    }
  }

  process.stdout.write(`\nsidecar / 配置\n`);
  const counts = Object.entries(r.sidecar.counts).map(([k, v]) => `${k}=${v}`).join(' ');
  process.stdout.write(
    `  ${r.sidecar.path}（0600）  ${counts || (r.sidecar.error != null ? '无' : '空')}\n`,
  );
  process.stdout.write(`  容器内终端会话: 各容器 /tmp 下 mysandbox-<短id>-<termId>（tmux ls 可见）\n`);
}

// 入口：一次收集，文本/JSON 双渲染。
export async function runStatusCommand(cfg: Config, opts?: { json?: boolean }): Promise<void> {
  const r = await collectStatusReport(cfg);
  if (opts?.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  renderText(r);
}
