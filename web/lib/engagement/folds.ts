/* Which Engagement sections a host has folded away.
 *
 * Remembered in this browser, across webinars: a coach who never reads Reactions should not
 * have to fold it on every webinar. Overview is never foldable — it is the answer to "how did
 * it go?" and the reason the tab is open. Everything starts open, so nothing is hidden from
 * someone who has not chosen to hide it. */

import type { SectionId } from "./sections.ts";

export const FOLDABLE: readonly SectionId[] = [
  "attendance",
  "activity",
  "attendees",
  "chat",
  "qa",
  "polls",
  "reactions",
  "survey",
  "follow-up",
];

const KEY = "engagement.folded";
const EMPTY: readonly SectionId[] = [];

/** Parses the stored value, keeping only ids that are still foldable. */
export function parseFolded(raw: string | null): readonly SectionId[] {
  if (!raw) return EMPTY;
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return EMPTY;
    const ids = FOLDABLE.filter((id) => v.includes(id));
    return ids.length ? ids : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function toggled(folded: readonly SectionId[], id: SectionId, fold: boolean): readonly SectionId[] {
  if (!FOLDABLE.includes(id) || folded.includes(id) === fold) return folded;
  return fold ? FOLDABLE.filter((f) => f === id || folded.includes(f)) : folded.filter((f) => f !== id);
}

// A tiny external store, so every section reads the same list without a provider and the
// server render (nothing folded) never disagrees with the first client render.
let cache: { raw: string | null; ids: readonly SectionId[] } | null = null;
const listeners = new Set<() => void>();

function read(): readonly SectionId[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    // Storage blocked (private mode, embedded frame): folding still works for this visit.
    return cache?.ids ?? EMPTY;
  }
  if (!cache || cache.raw !== raw) cache = { raw, ids: parseFolded(raw) };
  return cache.ids;
}

function write(ids: readonly SectionId[]) {
  const raw = JSON.stringify(ids);
  cache = { raw, ids };
  try {
    window.localStorage.setItem(KEY, raw);
  } catch {
    // Kept in memory only.
  }
  listeners.forEach((l) => l());
}

export const foldStore = {
  subscribe(l: () => void) {
    listeners.add(l);
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) l();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener("storage", onStorage);
    };
  },
  get: read,
  server: (): readonly SectionId[] => EMPTY,
  set(id: SectionId, fold: boolean) {
    const next = toggled(read(), id, fold);
    if (next !== read()) write(next);
  },
  all(fold: boolean) {
    write(fold ? FOLDABLE : EMPTY);
  },
};
