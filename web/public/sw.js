/* Webinar Liv service worker: Web Push, notification clicks, and an offline page.
 *
 * A static file in public/ on purpose — served from /sw.js so its scope is the whole site,
 * with no-cache headers (public/_headers on Workers, next.config.ts headers() elsewhere) so a
 * new version is picked up on the next navigation. Registered by components/pwa.tsx.
 *
 * What it does NOT do is cache the app. A webinar room is live media, chat and polls; a
 * cached copy of one is a broken room. The only thing stored is /offline.html, shown when a
 * page navigation fails because the network is gone. /api, the rooms and recordings are never
 * intercepted at all.
 */

const CACHE = "webinar-liv-offline-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      // Navigation preload: the network request starts while the worker boots, so having a
      // worker costs a page load nothing.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

/* Paths a navigation is never intercepted on: the API, the live rooms (attendee and host),
 * the recording player, and the worker itself. */
function bypass(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname === "/sw.js" ||
    /^\/webinars\/[^/]+\/room(\/|$)/.test(pathname) ||
    /^\/host\/[^/]+\/room(\/|$)/.test(pathname) ||
    /^\/w\/[^/]+\/recording(\/|$)/.test(pathname) ||
    pathname.startsWith("/recorder-template")
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate" || req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || bypass(url.pathname)) return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(req);
      } catch {
        const cached = await caches.match(OFFLINE_URL);
        return cached || Response.error();
      }
    })(),
  );
});

// ------------------------------------------------------------------ push

/* The payload is types.PushPayload (api/types/push.go): kind, title, body, url, tag,
 * renotify, icon, badge. A push with no readable payload still has to show something —
 * Safari revokes the subscription of a site that receives a push and shows nothing. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Webinar Liv";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/badge-96.png",
    data: { url: data.url || "/", kind: data.kind || "" },
  };
  if (data.tag) {
    options.tag = data.tag;
    // An update to a notification already on screen ("starts in 15 min" → "starting now")
    // buzzes again instead of changing silently. renotify without a tag is an error.
    options.renotify = Boolean(data.renotify);
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/";
  let target;
  try {
    target = new URL(raw, self.location.origin);
  } catch {
    target = new URL("/", self.location.origin);
  }
  // Only ever open this site: a payload is ours, but a URL is still a URL.
  if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      // A tab already on that page: bring it forward rather than opening a second room.
      for (const client of windows) {
        const at = new URL(client.url);
        if (at.pathname === target.pathname && "focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target.href);
      return undefined;
    })(),
  );
});

/* The push service rotated this browser's subscription (Firefox does; others on key loss).
 * Subscribe again with the same options and tell the server which endpoint it replaces, so
 * the account or registration it belonged to carries over. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      let next = event.newSubscription;
      if (!next && old && old.options) {
        next = await self.registration.pushManager.subscribe(old.options);
      }
      if (!next || !old) return;
      const json = next.toJSON();
      await fetch("/api/push/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: json.keys,
          ua: self.navigator.userAgent,
          oldEndpoint: old.endpoint,
        }),
      });
    })(),
  );
});
