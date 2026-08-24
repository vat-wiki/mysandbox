// 全局 hosts 配置的单一事实源（routes + lifecycle 都 import）。
// 仿 state.ts 的 load/persist 拆分：自定义内容存 XDG data 目录下的纯文本 sidecar 文件
// （hosts.txt），存什么就用什么、无转义层。宿主 /etc/hosts 按需实时读取（不缓存）。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './config.js';

export const HOSTS_FILE = join(STATE_DIR, 'hosts.txt');
const HOST_ETC_HOSTS = '/etc/hosts';

// 读自定义 hosts 内容；文件不存在/读失败返回 null（视为未定制）。
export async function getCustomHostsContent(): Promise<string | null> {
  if (!existsSync(HOSTS_FILE)) return null;
  try {
    return await readFile(HOSTS_FILE, 'utf8');
  } catch {
    return null;
  }
}

// 持久化自定义 hosts 内容（0600，与 state.json 同敏感度）。
export async function setCustomHostsContent(s: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(HOSTS_FILE, s, { mode: 0o600 });
}

// 实时读宿主 /etc/hosts；读失败（沙箱无文件/EACCES）返回空串，由调用方据 hostError 提示。
export async function readHostHosts(): Promise<string> {
  try {
    return await readFile(HOST_ETC_HOSTS, 'utf8');
  } catch {
    return '';
  }
}

// 把传统 /etc/hosts 文本解析成 Docker ExtraHosts（["hostname:ip", ...]）。
// 传统行 `IP HOSTNAME [ALIAS...]`，ExtraHosts 格式 host 在前；alias 各发一条；跳过 loopback/localhost
// （Docker 自己注入）。绝不抛——容器创建不能被畸形 hosts 行阻断；未解析行进 skipped[] 供日志。
export function parseExtraHosts(s: string): { extraHosts: string[]; skipped: string[] } {
  const extraHosts: string[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) {
      skipped.push(line);
      continue;
    }
    const ip = tokens[0];
    // loopback/localhost：Docker 始终自注入，重复是噪音
    if (ip.startsWith('127.') || ip === '::1' || ip.startsWith('::1%')) {
      continue;
    }
    for (const name of tokens.slice(1)) {
      if (name === 'localhost' || name === 'ip6-localhost' || name === 'ip6-loopback') continue;
      const entry = `${name}:${ip}`;
      if (!seen.has(entry)) {
        seen.add(entry);
        extraHosts.push(entry);
      }
    }
  }
  return { extraHosts, skipped };
}
