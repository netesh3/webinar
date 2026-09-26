"use client";

import { RoomEvent, type Room } from "livekit-client";
import { useEffect, useRef } from "react";
import { api } from "./api";
import { useCoalescingReader } from "./polls";
import { decodeBacklog, type Realtime } from "./realtime";
import { drainBacklog } from "./room-history";

/* Chat and Q&A history: on joining, and again after every reconnect.
 *
 * Shared by the LiveKit room and the CDN attendee room, which each had their own copy
 * of the chat half and neither had the Q&A half. Three triggers:
 *
 *   mount        A new page — a reload, a new tab — reads the conversation so far and
 *                the Q&A, with this identity's own upvotes. Pure history: it predates
 *                this page, so it raises no badge and no notification card.
 *   Reconnected  LiveKit resumed or rebuilt the connection itself.
 *   Connected    The room's own retry ladder called connect() again after a full
 *                disconnect (webinar-room.tsx's `recovering`), which emits Connected,
 *                not Reconnected.
 *
 * The chat cursor is read through a ref at the moment a sync runs, not captured when
 * the listener was attached: a captured cursor is the one from mount (zero), and every
 * reconnect then re-read the first 300 lines of the session instead of the gap. Reads
 * are coalesced, so a burst of triggers is one request in the air and one after it.
 */
export function useRoomHistory(
  room: Room,
  slug: string,
  joinKey: string | undefined,
  realtime: Pick<Realtime, "chatCursor" | "mergeBacklog" | "mergeQuestions">,
): void {
  const cursor = useRef(realtime.chatCursor);
  useEffect(() => {
    cursor.current = realtime.chatCursor;
  }, [realtime.chatCursor]);

  const { mergeBacklog, mergeQuestions } = realtime;

  const requestChat = useCoalescingReader(async () => {
    try {
      const { messages, deleted } = await drainBacklog(
        (since) => api.chatBacklog(slug, since, joinKey),
        cursor.current,
      );
      if (messages.length || deleted.length) mergeBacklog(decodeBacklog(messages), deleted);
    } catch {
      // Silent: the conversation on screen is more useful than an error where it used to
      // be, and the next reconnect tries again.
    }
  });

  const requestQuestions = useCoalescingReader(async () => {
    try {
      mergeQuestions(await api.roomQuestions(slug, joinKey));
    } catch {
      // As above.
    }
  });

  useEffect(() => {
    const sync = () => {
      requestChat();
      requestQuestions();
    };
    sync();
    room.on(RoomEvent.Reconnected, sync);
    room.on(RoomEvent.Connected, sync);
    return () => {
      room.off(RoomEvent.Reconnected, sync);
      room.off(RoomEvent.Connected, sync);
    };
  }, [room, slug, joinKey, requestChat, requestQuestions]);
}
