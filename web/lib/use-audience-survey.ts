"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { AudienceSurvey } from "./api-types";
import { dismissalKey } from "./survey";

/* The audience's copy of the post-event survey.
 *
 * Read on mount and again whenever the room's surveyRevision moves (the server's
 * "survey-changed" nudge), so a launch reaches everyone without polling. Failures keep the
 * last good copy: a survey is never worth an error banner in somebody's webinar. */
export function useAudienceSurvey(
  slug: string,
  joinKey: string | undefined,
  revision: number,
  enabled: boolean,
): {
  data: AudienceSurvey | null;
  loaded: boolean;
  replace: (next: AudienceSurvey) => void;
} {
  const [data, setData] = useState<AudienceSurvey | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const ctl = new AbortController();
    api
      .audienceSurvey(slug, joinKey, ctl.signal)
      .then((next) => setData(next))
      .catch(() => undefined)
      .finally(() => {
        if (!ctl.signal.aborted) setLoaded(true);
      });
    return () => ctl.abort();
  }, [slug, joinKey, revision, enabled]);

  const replace = useCallback((next: AudienceSurvey) => setData(next), []);
  return { data, loaded, replace };
}

/* "Offered at the door" is remembered for the tab, so the ended screen and the leave screen
 * do not ask the same person twice in a row, while a relaunch (a new dismissal key) asks
 * again. sessionStorage, not local: a new visit is a new chance. */
const storeKey = (slug: string) => `survey-offered:${slug}`;

export function wasOffered(slug: string, data: AudienceSurvey | null): boolean {
  const key = dismissalKey(data?.survey);
  if (!key || typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(storeKey(slug)) === key;
  } catch {
    return false;
  }
}

export function markOffered(slug: string, data: AudienceSurvey | null): void {
  const key = dismissalKey(data?.survey);
  if (!key || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storeKey(slug), key);
  } catch {
    // Private mode: the worst case is being asked once more.
  }
}
