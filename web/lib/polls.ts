"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Poll } from "./api-types";

/* The audience's copy of the polls.
 *
 * Lives at the room level rather than inside the panel, because a poll the host has
 * just launched must reach people who are not looking at the panel — which is what the
 * pop-up is for. The panel and the pop-up therefore read one list.
 *
 * There is no timer. The audience is shown no tally, so there is nothing that changes
 * between one host action and the next: the server announces open, close and delete on
 * the data channel and this re-reads. That is the difference from the host's copy,
 * which does poll, because a running count is exactly what a presenter is watching.
 *
 * `revision` is the announcement. A counter rather than the poll itself, because the
 * host's copy of a poll carries the tally and the correct answers and this one must
 * not — so each side fetches its own.
 */
export function useAudiencePolls(
  slug: string,
  joinKey: string | undefined,
  revision: number,
  enabled: boolean,
) {
  const [list, setList] = useState<Poll[] | null>(null);
  // Guards against a slow response overlapping the next announcement.
  const inFlight = useRef(false);

  const reload = useCallback(() => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    api
      .polls(slug, joinKey)
      .then(setList)
      // Left as-is on failure rather than blanked: an open poll already on screen is
      // more useful than an error where it used to be, and the next announcement
      // retries. The panel surfaces a message of its own.
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
  }, [enabled, slug, joinKey]);

  useEffect(reload, [reload, revision]);

  const replace = useCallback((poll: Poll) => {
    setList((current) => (current ?? []).map((p) => (p.id === poll.id ? poll : p)));
  }, []);

  return { list, reload, replace };
}

/** The poll the audience should be answering right now, if there is one.
 *
 *  Open, and not already answered. A closed poll is history and an answered one is
 *  done, and re-presenting either as a modal would be a pop-up that will not go away. */
export function activePoll(list: Poll[] | null): Poll | null {
  return (list ?? []).find((p) => p.state === "open" && p.myChoice < 0) ?? null;
}
