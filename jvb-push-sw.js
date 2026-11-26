'use strict';

const UNREAD_CACHE = 'hope-jvb-unread-v1';
const UNREAD_URL = new URL('./jvb-unread-state', self.location.href).href;
let unreadQueue = Promise.resolve();

function updateUnread(operation) {
  const task = unreadQueue.catch(() => {}).then(async () => {
    const cache = await caches.open(UNREAD_CACHE);
    const stored = await cache.match(UNREAD_URL);
    const unread = stored ? await stored.json() : {};
    operation(unread);
    await cache.put(UNREAD_URL, new Response(JSON.stringify(unread)));
    const count = Object.values(unread).reduce((total, value) => total + value, 0);
    if (count && navigator.setAppBadge) await navigator.setAppBadge(count);
    if (!count && navigator.clearAppBadge) await navigator.clearAppBadge();
  });
  unreadQueue = task;
  return task;
}

function conversationKey(channel, participantId) {
  return channel === 'team' ? 'team' : `direct:${participantId || ''}`;
}

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (_) { }
  const channel = payload.channel === 'direct' ? 'direct' : 'team';
  const participantId = typeof payload.participantId === 'string' ? payload.participantId : '';
  const key = conversationKey(channel, participantId);
  event.waitUntil(Promise.all([
    updateUnread(unread => { unread[key] = (unread[key] || 0) + 1; }).catch(() => {}),
    self.registration.showNotification('Hope JVB', {
      body: 'New JVB message',
      icon: new URL('./apple-touch-icon.png', self.location.href).href,
      tag: `hope-jvb-${key}`,
      data: { channel, participantId },
    }),
  ]));
});

self.addEventListener('message', event => {
  if (!event.data || !event.data.type) return;
  if (event.data.type === 'read-chat') {
    const key = conversationKey(event.data.channel, event.data.participantId);
    event.waitUntil(updateUnread(unread => { delete unread[key]; }));
  } else if (event.data.type === 'clear-unread') {
    event.waitUntil(updateUnread(unread => { Object.keys(unread).forEach(key => delete unread[key]); }));
  }
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const openClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const teamPage = new URL('./jvb.html', self.location.href);
    const existing = openClients.find(client => new URL(client.url).pathname === teamPage.pathname);
    if (existing) {
      existing.postMessage({ type: 'open-chat', channel: data.channel, participantId: data.participantId });
      await existing.focus();
    } else {
      teamPage.searchParams.set('chat', data.channel === 'direct' ? 'direct' : 'team');
      if (data.participantId) teamPage.searchParams.set('participant', data.participantId);
      await self.clients.openWindow(teamPage.href);
    }
  })());
});