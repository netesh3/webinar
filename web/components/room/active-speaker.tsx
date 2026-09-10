"use client";

import { useRoomContext } from "@livekit/components-react";
import { RoomEvent, type Participant } from "livekit-client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  NO_HIGHLIGHT,
  nextHighlight,
  pendingDelay,
  type Highlight,
} from "@/lib/speaker";

/* One place in the app that watches voice activity.
 *
 * It used to be every tile: each `ParticipantTile` called `useIsSpeaking(participant)`, so a
 * room with nine faces had nine components re-rendering on every audio-level update, several
 * times a second, whether or not anything they drew had changed. And because each tile decided
 * for itself, several could ring at once — the border stopped meaning "this is who is talking"
 * and started meaning "this microphone is above the threshold".
 *
 * Now the room subscribes once, holds the debounce in a ref, and publishes a single identity
 * through context. Two consequences that matter:
 *
 *   - exactly one tile can be highlighted, because there is one value and tiles compare
 *     against it. Nobody speaking is a real state, spelled null.
 *   - a reading that does not move the border re-renders NOTHING. `setCurrent` is called with
 *     the value it already holds, React bails out, and the tiles never hear about it. That is
 *     the "no unnecessary re-renders on voice activity" requirement, and it is why the state
 *     machine lives in a ref rather than in state: the bookkeeping changes constantly and only
 *     the answer is worth telling anyone.
 *
 * The provider passes `children` straight through, so when the highlight does move React
 * re-renders only the components that read this context, not the subtree. The stage's layout
 * and the <video> elements in it are untouched — which is the point of the whole exercise,
 * because moving a video element is what makes it flash.
 */

const ActiveSpeakerContext = createContext<string | null>(null);

/** The identity wearing the border, or null. Tiles use `isHighlighted` from lib/speaker.ts
 *  rather than comparing directly, so the screen-share rule stays in one place. */
export function useActiveSpeaker(): string | null {
  return useContext(ActiveSpeakerContext);
}

/**
 * loudestOf picks the one participant to consider.
 *
 * The SFU's list is documented as ordered by audio level, but the border is not worth pinning
 * to that: `audioLevel` is on every participant and reading it is unambiguous. Ties break on
 * identity so two microphones at exactly the same level cannot make the border oscillate — a
 * tie is rare, and a coin flip between two of them sixty times a second is not.
 */
function loudestOf(speakers: Participant[]): string | null {
  let best: Participant | null = null;
  for (const p of speakers) {
    if (!best) {
      best = p;
      continue;
    }
    if (p.audioLevel > best.audioLevel) best = p;
    else if (p.audioLevel === best.audioLevel && p.identity < best.identity) best = p;
  }
  return best?.identity ?? null;
}

export function ActiveSpeakerProvider({ children }: { children: React.ReactNode }) {
  const room = useRoomContext();
  const [current, setCurrent] = useState<string | null>(null);

  // The debounce state. A ref, not state: it changes on every reading and almost none of
  // those readings change the answer.
  const machine = useRef<Highlight>(NO_HIGHLIGHT);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    /* Fold in the current reading, publish it if the answer moved, and arm a timer if a
     * change is pending.
     *
     * The timer is not optional. The events only fire when the SFU's list changes, and
     * "B has held the floor for 450 ms" is a statement about elapsed time — without a timer
     * a handover would wait for some unrelated event to wake it up, which in a room where
     * one person is talking steadily might be seconds. */
    const apply = () => {
      const now = Date.now();
      const next = nextHighlight(machine.current, loudestOf(room.activeSpeakers), now);
      machine.current = next;

      // Identical value: React discards the update and no tile re-renders.
      setCurrent(next.current);

      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const delay = pendingDelay(next, now);
      if (delay !== null) timer.current = setTimeout(apply, delay);
    };

    room.on(RoomEvent.ActiveSpeakersChanged, apply);
    /* Also on disconnect: somebody who leaves mid-sentence stops generating readings, so
     * without this the border would stay on a tile that is no longer there. The tile goes
     * with them, so nothing is visibly wrong — but the state would be stale, and the next
     * genuine silence would have to time out before it cleared. */
    room.on(RoomEvent.ParticipantDisconnected, apply);
    apply();

    return () => {
      room.off(RoomEvent.ActiveSpeakersChanged, apply);
      room.off(RoomEvent.ParticipantDisconnected, apply);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [room]);

  return (
    <ActiveSpeakerContext.Provider value={current}>{children}</ActiveSpeakerContext.Provider>
  );
}
