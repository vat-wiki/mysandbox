// hosts 组合的纯函数库 + 宿主 /etc/hosts 读取。
// 新模型（全局 hosts 已删）：模板容器的 /etc/hosts 是新容器 hosts 的源头（克隆原样复制），
// mysandbox 对已落地容器只拥有尾部服务块——见 hosts-sync.ts 的读-改-写。
import { readFile } from 'node:fs/promises';

const HOST_ETC_HOSTS = '/etc/hosts';

// 实时读宿主 /etc/hosts；读失败（沙箱无文件/EACCES）返回空串，由调用方提示。
export async function readHostHosts(): Promise<string> {
  try {
    return await readFile(HOST_ETC_HOSTS, 'utf8');
  } catch {
    return '';
  }
}

// —— docker 服务块（服务发现：容器内 `psql -h <服务名>` 的通路） ——
// 服务行是**派生数据**（源头是 docker 里 running 的服务容器），不落任何 sidecar——落盘会
// 污染用户资产、造成双事实源。组合发生在写容器 /etc/hosts 的每条路径上（hosts-sync 的
// 读-改-写 + lifecycle 显式覆写），内容现算。

export const SERVICES_BLOCK_BEGIN = '# --- mysandbox services（自动生成，勿手改） ---';

// 服务行（`<ip> <服务名>`，按名排序保证稳定输出——内容相同即跳过，顺序抖动会击穿 skip）。
export function serviceBlockLines(endpoints: { name: string; ip: string }[]): string[] {
  return [...endpoints]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => `${e.ip} ${e.name}`);
}

// 用户内容 + 服务块 → 最终写进容器的 hosts。幂等（同输入同输出）；svcLines 为空时
// 原样返回 base（天然兼容「无服务不动容器」）。
export function composeHostsContent(base: string, svcLines: string[]): string {
  if (svcLines.length === 0) return base;
  const head = base.trimEnd();
  const sep = head ? (head.endsWith(SERVICES_BLOCK_BEGIN) ? '' : '\n\n') : '';
  return `${head}${sep}${SERVICES_BLOCK_BEGIN}\n${svcLines.join('\n')}\n`;
}

// 从 SERVICES_BLOCK_BEGIN 行起截断（块总在尾部）。读-改-写路径用它剥旧块——
// base 是用户资产（模板继承/宿主源/批量覆写的结果），mysandbox 无权动。
export function stripServicesBlock(content: string): string {
  const idx = content.indexOf(SERVICES_BLOCK_BEGIN);
  if (idx < 0) return content;
  // 吃掉块前面的空行，base 保持干净尾部
  return content.slice(0, idx).trimEnd();
}
