// 进程内轮询缓存：TTL 复用 + in-flight 去重。给 cwd/listen 这类「多个前端 poller 打
// 同一个 exec」的端点用——文件面板跟随（FilePanel followCheck）与 pane 标题
// （TermLayoutNode pollCwd）错开 1s 各查同一 cwd，/listen 每 5s 每容器一拍，底层都是
// lxc-attach / docker exec / ssh（单发几百 ms）。缓存后同 key 的并发与 TTL 内重复
// 请求收敛为一次真实执行；错误不缓存（下一拍自愈）。key 空间受容器/会话数量约束，
// 上限保护仅防异常增长。
interface Entry {
  at: number;
  value: unknown;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const MAX_KEYS = 512;

export async function withPollCache<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    try {
      const value = await fn();
      // 轻量上限保护：异常增长时整表清掉重来（正常使用远达不到）
      if (cache.size >= MAX_KEYS) cache.clear();
      cache.set(key, { at: Date.now(), value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p as Promise<T>;
}
