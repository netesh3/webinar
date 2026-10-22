"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { ReplayItem } from "./api-types";
import type { ChatMessage, Question } from "./realtime";
import {
  crossesPoll,
  interleave,
  newlyCrossed,
  reactionTaps,
  replayMessages,
  sharedPositionMs,
  steadyAnchor,
  visibleCount,
} from "./simulive-replay";

/* How often the timeline is read again while the session runs: the host may hide an item
 * mid-session. The server lets a browser keep it a minute, so this mostly costs nothing. */
const REFRESH_MS = 90_000;

/* A poll moment re-reads the polls twice: at once, and again a few seconds later, in case this
 * player is a little ahead of the server's clock (which is what opens and closes the poll). */
const POLL_REREAD_MS = 4_000;

/* The simulive engagement replay for one room (see lib/simulive-replay.ts for the rules).
 *
 * `video` is the player's element: its currentTime is the position everything is scheduled
 * against. Without one (not mounted yet), the shared clock from `startedAt` stands in; with
 * no start at all, nothing is scheduled. Returns the room's chat and questions with the
 * replayed ones folded in, and `pollsRevision`, which ticks whenever the video passes a
 * replayed poll's open or close — the room adds it to its own so its Polls re-read. Replayed
 * reactions are floated through `showReaction` as the video passes them.
 */
export function useSimuliveReplay({
  slug,
  joinKey,
  enabled,
  video,
  startedAt,
  chat,
  questions,
  showReaction,
}: {
  slug: string;
  joinKey?: string;
  enabled: boolean;
  video: HTMLVideoElement | null;
  startedAt: string | null;
  chat: ChatMessage[];
  questions: Question[];
  showReaction?: (emoji: string) => void;
}): { chat: ChatMessage[]; questions: Question[]; pollsRevision: number } {
  const [items, setItems] = useState<ReplayItem[]>([]);
  const [count, setCount] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [pollsRevision, setPollsRevision] = useState(0);
  const lastCount = useRef<number | null>(null);
  const react = useRef(showReaction);
  useEffect(() => {
    react.current = showReaction;
  }, [showReaction]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () => {
      api
        .replayTimeline(slug, joinKey)
        .then((tl) => {
          if (!cancelled) setItems(tl.enabled ? (tl.items ?? []) : []);
        })
        .catch(() => {
          // The video plays on without the replay; the next read tries again.
        });
    };
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled, slug, joinKey]);

  useEffect(() => {
    lastCount.current = null;
    if (!enabled || items.length === 0 || !startedAt) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const tick = () => {
      const now = Date.now();
      const pos = video && video.readyState > 0 ? video.currentTime * 1000 : sharedPositionMs(startedAt, now);
      if (pos == null) return;
      const next = visibleCount(items, pos);
      // The first reading is the catch-up: shown, not played.
      const prev = lastCount.current ?? next;
      lastCount.current = next;
      const passed = newlyCrossed(items, prev, next, pos);
      if (crossesPoll(passed)) {
        setPollsRevision((n) => n + 1);
        timers.push(setTimeout(() => setPollsRevision((n) => n + 1), POLL_REREAD_MS));
      }
      for (const it of passed) {
        if (it.kind !== "reaction") continue;
        for (const tap of reactionTaps(it)) {
          timers.push(setTimeout(() => react.current?.(tap.emoji), tap.delayMs));
        }
      }
      setCount(next);
      setAnchor((prevAnchor) => steadyAnchor(prevAnchor, now, pos));
    };
    tick();
    // timeupdate fires a few times a second while playing; the interval covers a player
    // that is not mounted yet, and a paused one after a seek.
    const id = setInterval(tick, 1000);
    video?.addEventListener("timeupdate", tick);
    video?.addEventListener("seeked", tick);
    return () => {
      clearInterval(id);
      timers.forEach(clearTimeout);
      video?.removeEventListener("timeupdate", tick);
      video?.removeEventListener("seeked", tick);
    };
  }, [enabled, items, video, startedAt]);

  return useMemo(() => {
    if (!enabled || count === 0 || anchor == null) return { chat, questions, pollsRevision };
    const replayed = replayMessages(items, count, anchor);
    return {
      chat: interleave(chat, replayed.chat),
      questions: [...questions, ...replayed.questions],
      pollsRevision,
    };
  }, [enabled, items, count, anchor, chat, questions, pollsRevision]);
}
