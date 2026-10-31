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
  if (data.kind === "incoming_call" && data.data && typeof data.data === "object") {
    event.waitUntil(onCallPush(data));
    return;
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

// ------------------------------------------------------------------ calls

/* Somebody calling this account into a meeting (31 Oct 2026, docs/calling.md). The push's
 * data is the call event as strings (types.PushPayload.Data): an incoming_call rings, a
 * call_ended with the same tag ("call-<id>") stops it. A tab in front already rings on its
 * own (components/incoming-call.tsx, from the account's event stream), so the worker only
 * tells it, and draws nothing over it. */

/** A path on this site, never another origin (lib/calls.ts isSitePath). */
function sitePath(url) {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
}

async function tellTabs(call) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) client.postMessage({ call });
  return windows;
}

async function closeCallNotifications(tag) {
  const shown = await self.registration.getNotifications({ tag });
  for (const n of shown) n.close();
}

async function onCallPush(data) {
  const call = data.data;
  const tag = data.tag || `call-${call.callId}`;
  const windows = await tellTabs(call);
  const inFront = windows.some((c) => c.focused);
  if (call.type === "call_ended") {
    await closeCallNotifications(tag);
    if (data.title) {
      // Not answered: a missed call stays in the tray.
      return self.registration.showNotification(data.title, {
        body: data.body || "",
        icon: data.icon || "/icons/icon-192.png",
        badge: data.badge || "/icons/badge-96.png",
        tag,
        data: { url: "/", kind: "incoming_call" },
      });
    }
    if (inFront) return undefined;
    // Answered or declined elsewhere. A push must show something, so a quiet line, briefly.
    await self.registration.showNotification("Call ended", { tag, silent: true, data: { url: "/" } });
    await new Promise((r) => setTimeout(r, 3000));
    return closeCallNotifications(tag);
  }
  if (call.type !== "incoming_call" || !sitePath(call.joinUrl)) return undefined;
  const expired = Date.parse(call.expiresAt) <= Date.now();
  if (inFront && !expired) return undefined;
  if (expired) {
    return self.registration.showNotification(`Missed call from ${call.callerName || "someone"}`, {
      body: call.topic || "",
      icon: data.icon || "/icons/icon-192.png",
      tag,
      data: { url: "/" },
    });
  }
  return self.registration.showNotification(data.title || `${call.callerName || "Someone"} is calling`, {
    body: data.body || call.topic || "",
    icon: (call.callerAvatarUrl && call.callerAvatarUrl.startsWith("https://") && call.callerAvatarUrl) || data.icon || "/icons/icon-192.png",
    badge: data.badge || "/icons/badge-96.png",
    tag,
    renotify: true,
    requireInteraction: true,
    vibrate: [400, 200, 400, 200, 400],
    actions: [
      { action: "accept", title: "Accept" },
      { action: "decline", title: "Decline" },
    ],
    data: { url: call.joinUrl, kind: "incoming_call", call },
  });
}

async function focusOrOpen(path) {
  const target = new URL(sitePath(path) ? path : "/", self.location.origin);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).pathname === target.pathname && "focus" in client) return client.focus();
  }
  // A tab of the site is in the background: take it to the call rather than opening another.
  for (const client of windows) {
    if ("navigate" in client && "focus" in client) {
      try {
        const moved = await client.navigate(target.href);
        if (moved) return moved.focus();
      } catch {
        // An uncontrolled tab cannot be navigated from here; open a new one.
      }
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(target.href);
  return undefined;
}

/* Accept (the button, or a tap on the ring itself) answers and opens the meeting; Decline
 * answers and opens nothing. The session cookie goes with the request: the API and the site
 * share an origin in production (web/worker.ts), and next dev proxies /api the same way. */
async function answerCall(call, action) {
  const verb = action === "decline" ? "decline" : "accept";
  let res = null;
  try {
    res = await fetch(`/api/calls/${encodeURIComponent(call.callId)}/${verb}`, {
      method: "POST",
      credentials: "include",
    });
  } catch {
    res = null;
  }
  await tellTabs({ type: "call_ended", callId: call.callId, state: verb === "decline" ? "declined" : "accepted" });
  if (verb === "decline") return undefined;
  if (res && res.ok) {
    let joinUrl = call.joinUrl;
    try {
      const body = await res.json();
      if (sitePath(body.joinUrl)) joinUrl = body.joinUrl;
    } catch {
      // The ring's own link is the same one.
    }
    return focusOrOpen(joinUrl);
  }
  // Over already (hung up, missed), or signed out: open the site, which says so.
  return focusOrOpen("/");
}

self.addEventListener("notificationclick", (event) => {
  const nd = event.notification.data || {};
  if (nd.kind === "incoming_call" && nd.call && nd.call.type === "incoming_call") {
    event.notification.close();
    event.waitUntil(answerCall(nd.call, event.action));
    return;
  }
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
