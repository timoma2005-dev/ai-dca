// 竞价看板通知用的最小 Service Worker：只负责显示/点击通知，不拦截任何请求（无 fetch 处理）。
// 安卓浏览器不允许页面直接 new Notification()，必须经 registration.showNotification()。
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (list[i].url.indexOf('auction-board') >= 0 && 'focus' in list[i]) return list[i].focus();
    var top = list.filter(function (c) { return 'focus' in c; })[0];
    if (top) return top.focus();
    return self.clients.openWindow ? self.clients.openWindow('/?tab=adminAuction') : null;
  }));
});
