"use client";

import { RoomEvent, type Room } from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Poll } from "./api-types";
import { coalescingReader } from "./poll-view";

export { activePoll } from "./poll-view";

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
 *
 * Three more things re-read, because each is a way to miss an announcement:
 *
 *   pollsEnabled  The server answers an empty list while polls are off, and turning
 *                 them on is a controls change, not a polls change — nothing is
 *                 announced. Without this, a poll launched before the switch never
 *                 reaches the attendees at all.
 *   a reconnect   A nudge sent while the data channel was down is simply gone.
 *   the tab coming back
 *                 A phone that backgrounded the page can sleep through one.
 */
export function useAudiencePolls(
  slug: string,
  joinKey: string | undefined,
  revision: number,
  enabled: boolean,
  pollsEnabled: boolean,
  room?: Room | null,
) {
  const [list, setList] = useState<Poll[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!enabled) return;
    try {
      setList(await api.polls(slug, joinKey));
      setError(null);
    } catch (err) {
      // Left as-is on failure rather than blanked: an open poll already on screen
      // is more useful than an error where it used to be, and the next
      // announcement retries.
      setError(err instanceof Error ? err.message : "Could not load the polls.");
    }
  }, [enabled, slug, joinKey]);
  const request = useCoalescingReader(read);

  const reload = request;

  useEffect(() => {
    request();
  }, [request, read, revision, pollsEnabled]);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVisible);
    room?.on(RoomEvent.Reconnected, request);
    // The room's own retry ladder rebuilds the connection with connect(), which emits
    // Connected rather than Reconnected — a nudge sent during that gap is gone too.
    room?.on(RoomEvent.Connected, request);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      room?.off(RoomEvent.Reconnected, request);
      room?.off(RoomEvent.Connected, request);
    };
  }, [request, enabled, room]);

  const replace = useCallback((poll: Poll) => {
    setList((current) => (current ?? []).map((p) => (p.id === poll.id ? poll : p)));
  }, []);

  return { list, error, reload, replace };
}

/** A stable `request()` that runs `run` through a coalescingReader: never two reads
 *  at once, and never a request dropped. `run` may change between renders (a new
 *  slug); the next read uses the latest one. */
export function useCoalescingReader(run: () => Promise<void>): () => void {
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const readerRef = useRef<ReturnType<typeof coalescingReader> | null>(null);
  return useCallback(() => {
    readerRef.current ??= coalescingReader(() => runRef.current());
    readerRef.current.request();
  }, []);
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
