/* Getting back into the room after a refresh, or after reopening the link.
 *
 * The browser half of it. The server decides whether somebody MAY go back in (the rejoin
 * check, and the same gates as any join — see api/internal/api/rejoin.go); this decides
 * whether to TRY, and how their microphone and camera were.
 *
 * Presence is "this browser was in this webinar's room at <time>", refreshed by a heartbeat
 * while the room is open. It lives in localStorage, because reopening the link is a new tab
 * and a new tab has an empty sessionStorage. Pressing Leave, being removed and the webinar
 * ending all write `left`, and a left record never auto-rejoins: somebody who meant to go must
 * not be dragged back in by opening the page again.
 *
 * Media state is per webinar too. sessionStorage first, which is exactly "this tab, across a
 * refresh"; localStorage as the fallback for a reopened link, honoured only inside the same
 * window as presence. Device ids, the background and the speaker are already remembered for
 * every webinar by lib/media.ts and the Room is built from them, so they are not repeated here.
 *
 * Nothing here is a credential. The join key stays where it was; the guest fallback is the
 * server's httpOnly cookie, which no script can read.
 */

/** How long after the last sign of life a refresh or a reopened link goes straight back in. */
export const REJOIN_WINDOW_MS = 30 * 60_000;

/** How often an open room refreshes its presence. Well inside the window. */
export const PRESENCE_HEARTBEAT_MS = 30_000;

export type RejoinRole = "attendee" | "stage";

/* Which door a room was opened through decides what a stage role means.
 *
 * The stage door (/host/<slug>/room) is a scheduled host or panelist: they stay on WebRTC for
 * the whole session. The attendee door with a stage role is somebody the host promoted who
 * came back while on the stage — a reload, or Leave then Join — and a demotion must send them
 * to the audience view again, as for a promotion made in the same page. Read off the role
 * alone, the second looked like the first (instant-webinar-7494, 2026-10-22). */
export function isScheduledPresenter(door: RejoinRole, role: string): boolean {
  return door === "stage" && (role === "host" || role === "panelist");
}

/** True for an attendee who opens the room already on the stage. */
export function opensPromoted(door: RejoinRole, role: string): boolean {
  return door === "attendee" && role === "panelist";
}

export type Presence = {
  slug: string;
  /** Milliseconds since the epoch, the last time the room was seen open. */
  at: number;
  role: RejoinRole;
  /** Set when the person left on purpose, was removed, or the session ended. */
  left?: boolean;
};

export type SavedMedia = {
  mic: boolean;
  camera: boolean;
  /** Whether a screen share was running. Never restarted by itself — a browser will not
   *  allow it without a click, and it would be a surprise if it could. */
  sharing: boolean;
  at: number;
};

/** The storage this file needs, so the tests can hand it a Map. */
export type KV = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PRESENCE_PREFIX = "webcast.rejoin.v1.";
const MEDIA_PREFIX = "webcast.rejoin-media.v1.";

/** The decision: go straight back into the room, or show the page as normal. */
export function shouldAutoRejoin(p: Presence | null, slug: string, now: number): boolean {
  if (!p || p.slug !== slug || p.left) return false;
  // A clock that went backwards a little is a clock, not a reason to say no. A record
  // from the future by more than that is not trusted.
  if (p.at - now > 60_000) return false;
  return now - p.at <= REJOIN_WINDOW_MS;
}

function parse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function local(): KV | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function session(): KV | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function write(kv: KV | null, key: string, value: unknown): void {
  if (!kv) return;
  try {
    kv.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage loses a convenience, not the session.
  }
}

export function readPresence(slug: string, kv: KV | null = local()): Presence | null {
  if (!kv) return null;
  try {
    const p = parse<Presence>(kv.getItem(PRESENCE_PREFIX + slug));
    return p && typeof p.at === "number" && typeof p.slug === "string" ? p : null;
  } catch {
    return null;
  }
}

export function recordPresence(
  slug: string,
  role: RejoinRole,
  now: number = Date.now(),
  kv: KV | null = local(),
): void {
  write(kv, PRESENCE_PREFIX + slug, { slug, at: now, role } satisfies Presence);
}

/** Leave, removal, the end: this browser must not put them back by itself. */
export function markLeft(
  slug: string,
  now: number = Date.now(),
  kv: KV | null = local(),
  sessionKv: KV | null = session(),
): void {
  const prev = readPresence(slug, kv);
  write(kv, PRESENCE_PREFIX + slug, {
    slug,
    at: now,
    role: prev?.role ?? "attendee",
    left: true,
  } satisfies Presence);
  for (const store of [kv, sessionKv]) {
    try {
      store?.removeItem(MEDIA_PREFIX + slug);
    } catch {
      // As above.
    }
  }
}

export function saveMedia(
  slug: string,
  state: Omit<SavedMedia, "at">,
  now: number = Date.now(),
  kv: KV | null = local(),
  sessionKv: KV | null = session(),
): void {
  const value: SavedMedia = { ...state, at: now };
  write(sessionKv, MEDIA_PREFIX + slug, value);
  write(kv, MEDIA_PREFIX + slug, value);
}

/** This tab's own record if it has one (a refresh), else the browser's if it is recent
 *  (a reopened link). Null means nothing to restore: use the normal defaults. */
export function loadMedia(
  slug: string,
  now: number = Date.now(),
  kv: KV | null = local(),
  sessionKv: KV | null = session(),
): SavedMedia | null {
  const valid = (m: SavedMedia | null) =>
    m && typeof m.mic === "boolean" && typeof m.camera === "boolean" ? m : null;
  try {
    const mine = valid(parse<SavedMedia>(sessionKv?.getItem(MEDIA_PREFIX + slug) ?? null));
    if (mine) return mine;
    const shared = valid(parse<SavedMedia>(kv?.getItem(MEDIA_PREFIX + slug) ?? null));
    if (shared && now - shared.at <= REJOIN_WINDOW_MS) return shared;
  } catch {
    // Unreadable storage is the same as nothing stored.
  }
  return null;
}

/** What a publisher re-enters with on an automatic rejoin. A host-enforced mute wins over
 *  what they had: a reload must never be a way round "prevent self-unmute". */
export function rejoinEntry(
  saved: SavedMedia | null,
  hostMuted: boolean,
): { micEnabled: boolean; cameraEnabled: boolean } {
  return {
    micEnabled: Boolean(saved?.mic) && !hostMuted,
    cameraEnabled: Boolean(saved?.camera),
  };
}

// ---- how this page was reached ---------------------------------------------------------

/** How long after a page load a "reload" still describes how the room was reached. The
 *  navigation type is fixed for the life of the document, so without this a client-side
 *  trip to the landing page and back, minutes later, would still read as a refresh. */
const RELOAD_FRESH_MS = 10_000;

const INTENT_PREFIX = "webcast.rejoin-intent.v1.";

/** The landing page found a live session to go back to and is sending this tab to the
 *  room. A timestamp rather than a take-once flag, so a double render reads it twice. */
export function setRejoinIntent(
  slug: string,
  now: number = Date.now(),
  kv: KV | null = session(),
): void {
  write(kv, INTENT_PREFIX + slug, now);
}

export function hasRejoinIntent(slug: string, now: number, kv: KV | null = session()): boolean {
  try {
    const at = parse<number>(kv?.getItem(INTENT_PREFIX + slug) ?? null);
    return typeof at === "number" && now - at >= -1_000 && now - at <= RELOAD_FRESH_MS;
  } catch {
    return false;
  }
}

function wasReload(): boolean {
  try {
    if (typeof performance === "undefined") return false;
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return nav?.type === "reload" && performance.now() <= RELOAD_FRESH_MS;
  } catch {
    return false;
  }
}

/** What the room page should do on arrival.
 *
 *  rejoin — a refresh, or the landing page's redirect, inside the window: straight back in
 *           with the saved state, and the join is marked automatic so the server refuses it
 *           for somebody the host removed.
 *  left   — a refresh after leaving on purpose (or being removed, or the end): do not put
 *           them back by themselves; offer a button.
 *  normal — everything else, which is exactly what the room did before any of this. */
export type Arrival = "rejoin" | "left" | "normal";

export function decideArrival(
  p: Presence | null,
  slug: string,
  automatic: boolean,
  now: number,
): Arrival {
  if (!automatic || !p || p.slug !== slug) return "normal";
  if (p.left) return now - p.at <= REJOIN_WINDOW_MS ? "left" : "normal";
  return shouldAutoRejoin(p, slug, now) ? "rejoin" : "normal";
}

/** decideArrival with this browser's own storage and navigation. "normal" on the server. */
export function detectArrival(slug: string, now: number = Date.now()): Arrival {
  if (typeof window === "undefined") return "normal";
  const automatic = wasReload() || hasRejoinIntent(slug, now);
  return decideArrival(readPresence(slug), slug, automatic, now);
}
