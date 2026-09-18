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

// ------------------------------------------------------------------ the sound cue

/* A short chime when the pop-up in poll-popup.tsx appears with a new poll.
 *
 * Always on, unlike chat's own cue (lib/chat-notify.ts), which defaults off because
 * a host's laptop making an unarranged noise during their own shared screen is a real
 * problem. Neither half of that applies here: this only ever plays for an attendee
 * (PollPopup renders nothing for the host — see its own comment), so there is no
 * presenter to surprise and no shared-screen audio track for the room to pick it up
 * on. A poll is also a one-off, deliberate ask for attention the host chose to send,
 * not a stream of messages that would turn a per-message chime into noise.
 *
 * Synthesised rather than loaded, same reasoning as playChatCue: no asset to fetch or
 * get wrong on a browser that blocks autoplay before a gesture. A different two-note
 * shape (falling rather than rising) so the two cues do not sound like the same event.
 */
let lastPollCueAt = 0;
let pollCueContext: AudioContext | null = null;

export function playPollCue(): void {
  if (typeof window === "undefined") return;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;

  // One poll cannot chime twice, however the popup's own effects happen to re-run.
  const now = Date.now();
  if (now - lastPollCueAt < 1500) return;
  lastPollCueAt = now;

  try {
    pollCueContext ??= new Ctor();
    const ctx = pollCueContext;
    void ctx.resume().catch(() => {});

    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const start = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.06, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.38);

    for (const [frequency, offset] of [
      [988, 0],
      [740, 0.1],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = frequency;
      osc.connect(gain);
      osc.start(start + offset);
      osc.stop(start + offset + 0.22);
    }
  } catch {
    // No output device, or a context the browser refused to create. The card is
    // the notification; the sound was only ever the optional half of it.
  }
}
