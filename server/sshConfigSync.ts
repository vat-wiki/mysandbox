// 容器 SSH config 同步：把受管容器的静态 IP 落成 `~/.ssh/config.d/mysandbox` 的
// Host 别名块（`sb-<容器名>`），给 VS Code Remote-SSH 与 ssh CLI 即开即连。
//
// 设计对齐 hosts-sync 的「宿主进程算内容、幂等写」：
// - IP 是容器 config 里的静态配置（停机也在），受管集合只在 create/delete/adopt/rename
//   变化——在这些点 fire-and-forget 调 syncSshConfig() 即可，无需事件订阅或轮询。
// - 生成文件整文件重写（同 hosts 尾块的语义），头部注明勿手改。
// - ~/.ssh/config 只在缺 Include 时补一行（锚点注释包裹，幂等）；用户自己的 config
//   内容零接触。VS Code Remote-SSH 走本机 ssh 的 config 解析，Include 同样生效。
//
// 外部机器（笔记本等）访问：容器网段只在宿主可达——拷走生成的 mysandbox 文件，
// 在自己的 ~/.ssh/config 里加一段 `Host sb-*` + `ProxyJump <宿主>` 即可（SSH 的
// 多跳对 VS Code 透明）。
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { listManaged } from './engine/index.js';
import type { Config } from './config.js';
import { log } from './logger.js';

const sshDir = () => join(homedir(), '.ssh');
const confDir = () => join(sshDir(), 'config.d');
const managedFile = () => join(confDir(), 'mysandbox');

// Host 别名前缀：带前缀避免与用户已有 ssh 别名/真实主机名撞车。
export const sshAliasPrefix = 'sb-';

function renderBlocks(views: { name: string; ip: string | null }[]): string {
  const lines = [
    '# mysandbox 生成（server/sshConfigSync.ts）——受管容器静态 IP → Host 别名。',
    '# 容器集合/地址变化时整文件重写，勿手改（手改内容会被下一次同步冲掉）。',
    '# 外部机器访问：容器网段只在宿主可达，拷走本文件并在自己的 ~/.ssh/config 加',
    '#   Host sb-*',
    '#     ProxyJump <宿主>',
    '#',
  ];
  for (const v of views) {
    if (!v.ip) continue;
    lines.push(`Host ${sshAliasPrefix}${v.name}`, `  HostName ${v.ip}`, '  User dev', '');
  }
  return lines.join('\n');
}

export async function syncSshConfig(cfg: Config): Promise<{ count: number }> {
  try {
    const views = await listManaged(cfg);
    const content = renderBlocks(views);
    await mkdir(confDir(), { recursive: true });
    await writeFile(managedFile(), content, { mode: 0o600 });

    // ~/.ssh/config 缺 Include 则补（锚点注释幂等）；文件不存在就建一份最小 config。
    // ⚠️ Include 必须在**第一个 Host 块之前**——本机 OpenSSH 9.6 实测：放在任何 Host
    // 块之后（哪怕紧跟 option 行）整段不解析（-G 复核复现）。所以插在文件头而非追加尾部。
    const main = join(sshDir(), 'config');
    if (!existsSync(main)) {
      await mkdir(sshDir(), { recursive: true });
      await writeFile(main, `${INCLUDE_BLOCK}\n`, { mode: 0o600 });
    } else {
      const cur = await readFile(main, 'utf8');
      // 只有位于第一个 Host 块**之前**的 Include 才算数（尾部的实测不生效）。
      const lines = cur.split('\n');
      const firstHost = lines.findIndex((l) => /^Host\s/.test(l));
      const includeIdx = lines.findIndex((l) => /^\s*Include\s+\S*config\.d\//.test(l));
      const usable = includeIdx !== -1 && (firstHost === -1 || includeIdx < firstHost);
      if (!usable) {
        // 剥掉失效位置的 Include 行与历史锚点块（含旧版本只写注释没写 Include 的残缺态）
        // 再在头部重放。
        const body = lines
          .filter((l) => !l.includes(ANCHOR_BEGIN) && !l.includes(ANCHOR_END) && !/^\s*Include\s+\S*config\.d\//.test(l))
          .join('\n');
        await writeFile(main, `${INCLUDE_BLOCK}\n${body}`);
      }
    }
    const count = content.split('\n').filter((l) => l.startsWith('Host ')).length;
    log.debug({ count }, 'ssh config synced');
    return { count };
  } catch (e) {
    // 尽力而为：ssh config 同步失败不影响容器生命周期动作本身。
    log.warn({ err: (e as Error).message }, 'ssh config sync failed');
    return { count: 0 };
  }
}

const ANCHOR_BEGIN = '# >>> mysandbox >>> 容器 SSH 别名（sb-*，生成文件见 ~/.ssh/config.d/mysandbox）';
const ANCHOR_END = '# <<< mysandbox <<<';
const INCLUDE_BLOCK = `${ANCHOR_BEGIN}\nInclude ~/.ssh/config.d/*\n${ANCHOR_END}`;
