"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "@/lib/api";
import type { Registration, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { useSession } from "./providers";

/* Which webinars is this person signed up for?
 *
 * Two answers, because there are two ways to register:
 *
 *   With an account   the registration is a row linked to the account, so it
 *                     follows the person to a new browser and survives a cleared
 *                     cache. Read from /api/me/registrations.
 *
 *   Without one       the join key returned at registration IS the credential —
 *                     the same model as the personal link Zoom emails out. The
 *                     browser holds the keys in localStorage and trades them back
 *                     for the records.
 *
 * Both are merged here so every screen asks one question and gets one answer. The
 * keys are the only client-side state; everything authoritative lives in Postgres.
 */

const KEY = "webcast.joinkeys.v1";

/** slug -> join key, kept alongside the flat key list.
 *
 *  The list alone cannot answer "which key is for this webinar", so the room had to
 *  wait for /registrations/lookup to find out — a full round trip standing between
 *  an attendee clicking Join and the first ICE packet. This index answers it from
 *  memory. It is a cache, not the truth: anything missing from it falls back to the
 *  lookup, which is also what happens for keys stored before it existed. */
const SLUG_INDEX = "webcast.joinkeys.byslug.v1";

function readSlugIndex(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SLUG_INDEX);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writeSlugIndex(next: Record<string, string>): void {
  try {
    localStorage.setItem(SLUG_INDEX, JSON.stringify(next));
  } catch {
    // private browsing / quota — the lookup still works, just slower
  }
}

/** The join key this browser holds for one webinar, synchronously. */
export function joinKeyFor(slug: string): string | null {
  if (typeof window === "undefined") return null;
  const key = readSlugIndex()[slug];
  return typeof key === "string" && key !== "" ? key : null;
}

/** joinKeyFor as a hook, so the render may depend on it.
 *
 *  Going through useSyncExternalStore rather than reading localStorage during render
 *  is what gives the server a defined snapshot (null) instead of a hydration
 *  mismatch — the same reason useShareOrigin is written this way. The snapshot is a
 *  string compared by value, so returning it fresh each call is stable. */
export function useJoinKeyFor(slug: string): string | null {
  return useSyncExternalStore(
    subscribe,
    () => joinKeyFor(slug),
    () => null,
  );
}

function rememberSlug(slug: string, joinKey: string): void {
  writeSlugIndex({ ...readSlugIndex(), [slug]: joinKey });
}

function forgetSlug(joinKey: string): void {
  const index = readSlugIndex();
  for (const [slug, key] of Object.entries(index)) {
    if (key === joinKey) delete index[slug];
  }
  writeSlugIndex(index);
}

let cache: string[] | null = null;
const listeners = new Set<() => void>();

function readKeys(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((k) => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

function getSnapshot(): string[] {
  cache ??= readKeys();
  return cache;
}

/** null on the server: "we don't know yet", so the UI shows a skeleton rather
 *  than briefly claiming you've registered for nothing. */
function getServerSnapshot(): string[] | null {
  return null;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) {
      cache = null;
      listeners.forEach((l) => l());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function writeKeys(next: string[]): void {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // private browsing / quota — keep the in-memory copy
  }
  listeners.forEach((l) => l());
}

export function useJoinKeys() {
  const keys = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const add = useCallback((joinKey: string, slug?: string) => {
    // Slug index FIRST, because writeKeys notifies subscribers and useJoinKeyFor reads the
    // index. The other order leaves a window where a re-render triggered by the key list
    // reads an index that has not been written yet, which is a component that decides there
    // is no key for this webinar and then never hears otherwise.
    if (slug) rememberSlug(slug, joinKey);
    const current = getSnapshot();
    if (!current.includes(joinKey)) writeKeys([...current, joinKey]);
  }, []);

  const remove = useCallback((joinKey: string) => {
    writeKeys(getSnapshot().filter((k) => k !== joinKey));
    forgetSlug(joinKey);
  }, []);

  return { keys, add, remove };
}

/** Resolves the held keys and the signed-in account into one list.
 *
 *  `registrations` is null while the answer is genuinely unknown — during SSR,
 *  hydration, and the first lookup — which is the signal to render a skeleton.
 */
export function useRegistrations() {
  const { keys, add, remove } = useJoinKeys();
  const { account, status } = useSession();
  const [fetched, setFetched] = useState<Registration[] | null>(null);
  /* The webinars behind those registrations, keyed by slug.
   *
   * These arrive free with both responses now, and collecting them is what let the
   * "My webinars" page stop fetching the whole catalogue and filtering it in the
   * browser. That page used to be handed every scheduled webinar on the server —
   * including other hosts' — and render only the caller's. The rows never showed,
   * but the data was in the payload. */
  const [webinars, setWebinars] = useState<Record<string, Webinar>>({});
  // Tagged with the account it belongs to, so a response that lands after a
  // sign-out — or after signing in as somebody else — is recognisable as stale
  // rather than shown as the new person's registrations.
  const [owned, setOwned] = useState<{
    accountId: string;
    rows: Registration[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by retry() to re-run both fetches. A rate-limited or briefly offline
  // attendee needs a way back without reloading the page.
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    // No synchronous setState in here: the empty case is *derived* below, and
    // every write happens in a promise callback.
    if (keys === null || keys.length === 0) return;

    let active = true;
    api
      .lookup(keys)
      .then((rows) => {
        if (!active) return;
        setFetched(rows.map((r) => r.registration));
        setWebinars((prev) => ({
          ...prev,
          ...Object.fromEntries(rows.map((r) => [r.webinar.id, r.webinar])),
        }));
        setError(null);
      })
      .catch((e: unknown) => {
        if (!active) return;
        // Deliberately NOT setFetched([]). A failed lookup is "we don't know",
        // and collapsing it into "you have no registrations" is how a rate-limited
        // or briefly offline attendee gets told they never registered — right at
        // the moment they are trying to get into a webinar they paid attention to.
        setError(
          e instanceof Error ? e.message : "Could not load your registrations.",
        );
      });

    // Ignore a response that resolves after the keys changed.
    return () => {
      active = false;
    };
  }, [keys, attempt]);

  useEffect(() => {
    // Nothing to fetch without an account; the empty case is derived below.
    const accountId = account?.id;
    if (!accountId) return;

    // Local UI preview: mock host has no API session cookie — skip the call
    // so the badge does not spin on 401 noise.
    if (isDevAuthBypassActive()) {
      setOwned({ accountId, rows: [] });
      return;
    }

    let active = true;
    api
      .myRegistrations()
      .then((rows) => {
        if (!active) return;
        setOwned({ accountId, rows: rows.map((r) => r.registration) });
        setWebinars((prev) => ({
          ...prev,
          ...Object.fromEntries(rows.map((r) => [r.webinar.id, r.webinar])),
        }));
      })
      .catch((e: unknown) => {
        // Same reasoning as the join-key lookup: report the failure rather than
        // reporting an empty account.
        if (active) {
          setError(
            e instanceof Error
              ? e.message
              : "Could not load your registrations.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [account?.id, attempt]);

  const registrations = useMemo(() => {
    if (keys === null || status === "loading") return null; // hydrating

    const held = keys.length === 0 ? [] : fetched;
    // No account means the account list is empty, not unknown. With one, it is
    // unknown until a response tagged with THAT account arrives.
    const fromAccount = !account
      ? []
      : owned?.accountId === account.id
        ? owned.rows
        : null;

    // Either source still loading means the answer is not yet known.
    if (held === null || fromAccount === null) return null;

    // The account's copy wins on a collision: it is the one that survives this
    // browser, and a guest key for the same webinar is the same registration.
    const merged = new Map<string, Registration>();
    for (const reg of held) merged.set(reg.webinarId, reg);
    for (const reg of fromAccount) merged.set(reg.webinarId, reg);
    return [...merged.values()];
  }, [keys, fetched, owned, account, status]);

  const isRegistered = useCallback(
    (slug: string) => !!registrations?.some((r) => r.webinarId === slug),
    [registrations],
  );

  const registrationFor = useCallback(
    (slug: string) => registrations?.find((r) => r.webinarId === slug),
    [registrations],
  );

  /** Called after a successful POST /register. Stores the key and adopts the
   *  returned record right away, so the UI updates without a second round trip.
   *  This runs from an event handler, not an effect. */
  const remember = useCallback(
    (reg: Registration) => {
      setFetched((prev) => [
        ...(prev ?? []).filter((r) => r.webinarId !== reg.webinarId),
        reg,
      ]);
      add(reg.joinKey, reg.webinarId);
    },
    [add],
  );

  const forget = useCallback(
    (reg: Registration) => {
      setFetched((prev) =>
        (prev ?? []).filter((r) => r.joinKey !== reg.joinKey),
      );
      remove(reg.joinKey);
    },
    [remove],
  );

  /** The webinar behind a registration, from whichever response carried it. */
  const webinarFor = useCallback((slug: string) => webinars[slug], [webinars]);

  return {
    registrations,
    webinars,
    webinarFor,
    error,
    retry,
    isRegistered,
    registrationFor,
    remember,
    forget,
  };
}
