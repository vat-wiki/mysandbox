// mysandbox 控制台 Service Worker:Web Push 的系统通知落点(server/push.ts)。
// 页面没开/被移动端冻结也照收——这是「agent 干完活」提醒在移动端的真正通道。
// push 载荷:{title, body, tag, focus:{kind, containerId, termId}};点击后带
// ?term=<termSessionKey> 深链打开控制台,或对已开窗口 postMessage 同款语义
// (ContainerList 落到对应组)。纯原生 SW,不走构建(vite public 原样拷贝)。
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title || 'mysandbox', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      renotify: true, // 同 tag 的新事件再震一次(需配 tag 使用,Chrome 支持)
      data: data.focus ? { focus: data.focus } : {},
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const focus = e.notification.data && e.notification.data.focus;
  // key 格式 = web/lib/api.ts termSessionKey(host:/c:/s:/x: 前缀),与 ?term= 深链同源
  const key = focus
    ? focus.kind === 'host'
      ? 'host:' + focus.termId
      : (focus.kind === 'service' ? 's:' : focus.kind === 'ssh' ? 'x:' : 'c:') +
        (focus.containerId || '') +
        ':' +
        focus.termId
    : '';
  const q = key ? '?term=' + encodeURIComponent(key) : '';
  const url = new URL('/' + q, self.location.origin).href;
  e.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const mine = all.filter((c) => c.url.startsWith(self.location.origin));
      if (mine.length) {
        const c = mine[0];
        if (focus) c.postMessage({ type: 'msb-focus-term', focus });
        return c.focus();
      }
      await self.clients.openWindow(url);
    })(),
  );
});
