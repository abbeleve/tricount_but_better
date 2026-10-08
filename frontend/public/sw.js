/*
 * Split's service worker: shows push notifications and brings the app forward
 * when one is tapped.
 *
 * It deliberately has no fetch handler. Nothing is cached, so a deploy can
 * never leave a phone running yesterday's bundle.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

async function windows() {
  return self.clients.matchAll({ type: "window", includeUncontrolled: true });
}

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(message.title || "Split", {
        body: message.body || "",
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        // One entry per notification: a second expense must not replace the first.
        tag: message.id,
        data: { url: message.url || "/notifications" },
      });
      if (typeof message.unread === "number" && self.navigator.setAppBadge) {
        await self.navigator.setAppBadge(message.unread).catch(() => {});
      }
      // An open copy of the app refreshes its badge and balances straight away.
      for (const client of await windows()) client.postMessage({ type: "push" });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin);

  event.waitUntil(
    (async () => {
      const open = (await windows()).find((client) => new URL(client.url).origin === url.origin);
      if (open) {
        // The app routes itself, without a reload.
        open.postMessage({ type: "open", url: url.pathname + url.search });
        return open.focus();
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
