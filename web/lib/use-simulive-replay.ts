"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { ReplayItem } from "./api-types";
import type { ChatMessage, Question } from "./realtime";
import {
  interleave,
  replayMessages,
  sharedPositionMs,
  steadyAnchor,
  visibleCount,
} from "./simulive-replay";

/* How often the timeline is read again while the session runs: the host may hide an item
 * mid-session. The server lets a browser keep it a minute, so this mostly costs nothing. */
const REFRESH_MS = 90_000;

/* The simulive engagement replay for one room (see lib/simulive-replay.ts for the rules).
 *
 * `video` is the player's element: its currentTime is the position everything is scheduled
 * against. Without one (not mounted yet), the shared clock from `startedAt` stands in.
 * Returns the room's chat and questions with the replayed items folded in; with `enabled`
 * false, or before the timeline arrives, exactly what it was given.
 */
export function useSimuliveReplay({
  slug,
  joinKey,
  enabled,
  video,
  startedAt,
  chat,
  questions,
}: {
  slug: string;
  joinKey?: string;
  enabled: boolean;
  video: HTMLVideoElement | null;
  startedAt: string | null;
  chat: ChatMessage[];
  questions: Question[];
}): { chat: ChatMessage[]; questions: Question[] } {
  const [items, setItems] = useState<ReplayItem[]>([]);
  const [count, setCount] = useState(0);
  const [anchor, setAnchor] = useState<number | null>(null);

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
    if (!enabled || items.length === 0) return;
    const tick = () => {
      const now = Date.now();
      const pos = video && video.readyState > 0 ? video.currentTime * 1000 : sharedPositionMs(startedAt, now);
      if (pos == null) return;
      setCount(visibleCount(items, pos));
      setAnchor((prev) => steadyAnchor(prev, now, pos));
    };
    tick();
    // timeupdate fires a few times a second while playing; the interval covers a player
    // that is not mounted yet, and a paused one after a seek.
    const id = setInterval(tick, 1000);
    video?.addEventListener("timeupdate", tick);
    video?.addEventListener("seeked", tick);
    return () => {
      clearInterval(id);
      video?.removeEventListener("timeupdate", tick);
      video?.removeEventListener("seeked", tick);
    };
  }, [enabled, items, video, startedAt]);

  return useMemo(() => {
    if (!enabled || count === 0 || anchor == null) return { chat, questions };
    const replayed = replayMessages(items, count, anchor);
    return {
      chat: interleave(chat, replayed.chat),
      questions: [...questions, ...replayed.questions],
    };
  }, [enabled, items, count, anchor, chat, questions]);
}
