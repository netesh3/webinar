"use client";

/* The realtime source for an edge viewer: server-sent events instead of LiveKit.
 *
 * An edge viewer never connects to LiveKit, so their room is a Room that stays disconnected.
 * This hook replays the event stream (GET /api/webinars/{slug}/events) onto that Room's own
 * emitter, as the events a connected room would raise:
 *
 *   packet   -> RoomEvent.DataReceived on the `webcast` topic, byte for byte the packet the
 *               stage receives, so chat, Q&A, polls, raised hands and stage invites go
 *               through the same parsing in lib/realtime.ts.
 *   meta     -> RoomEvent.RoomMetadataChanged with the metadata string (useSessionControls
 *               reads it from the event).
 *   connect,
 *   refetch  -> RoomEvent.Connected, which every backlog reader already treats as "you may
 *               have missed something, read it again" (useRoomHistory, useAudiencePolls).
 *
 * That is the whole abstraction: the shared hooks take a Room either way and never know which
 * source fed it. The few things only an edge room does — go to the stage, go back, be
 * removed, get a fresh token — arrive as callbacks. */

import { useEffect, useRef, useState } from "react";
import { RoomEvent, type Room } from "livekit-client";
import { api } from "./api";
import { routeEdgeEvent } from "./edge-route";
import { DATA_TOPIC } from "./realtime";

export type EdgeStreamState = "connecting" | "open" | "retrying";

export function useEdgeEvents({
  room,
  slug,
  token,
  identity,
  onPromoted,
  onDemoted,
  onRemoved,
  onExpired,
}: {
  room: Room;
  slug: string;
  token: string;
  identity: string;
  onPromoted: () => void;
  onDemoted?: () => void;
  onRemoved: () => void;
  /** The stream refused the token (expired, or the webinar changed). Join again for a new one. */
  onExpired: () => void;
}): EdgeStreamState {
  const [state, setState] = useState<EdgeStreamState>("connecting");
  const handlers = useRef({ onPromoted, onDemoted, onRemoved, onExpired });
  useEffect(() => {
    handlers.current = { onPromoted, onDemoted, onRemoved, onExpired };
  }, [onPromoted, onDemoted, onRemoved, onExpired]);

  useEffect(() => {
    if (!token) return;
    const encoder = new TextEncoder();
    let source: EventSource | null = null;
    let closed = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const emit = (kind: string, data: string) => {
      const action = routeEdgeEvent(kind, data, identity);
      switch (action.type) {
        case "packet":
          room.emit(RoomEvent.DataReceived, encoder.encode(action.data), undefined, undefined, DATA_TOPIC);
          break;
        case "meta":
          room.emit(RoomEvent.RoomMetadataChanged, action.data);
          break;
        case "refetch":
          room.emit(RoomEvent.Connected);
          break;
        case "promoted":
          handlers.current.onPromoted();
          break;
        case "demoted":
          handlers.current.onDemoted?.();
          break;
        case "removed":
          closed = true;
          source?.close();
          handlers.current.onRemoved();
          break;
        default:
          break;
      }
    };

    const open = () => {
      if (closed) return;
      const es = new EventSource(api.edgeEventsUrl(slug, token), { withCredentials: true });
      source = es;
      es.onopen = () => {
        failures = 0;
        setState("open");
        // A (re)connect may have missed events: read the backlogs again.
        room.emit(RoomEvent.Connected);
      };
      for (const kind of ["packet", "meta", "refetch"]) {
        es.addEventListener(kind, (ev) => emit(kind, (ev as MessageEvent<string>).data));
      }
      // The server ends a stream before Cloud Run would; the browser reconnects on its own.
      es.addEventListener("reconnect", () => setState("retrying"));
      es.onerror = () => {
        if (closed) return;
        setState("retrying");
        // CLOSED means the server answered with an error (401/403/409) rather than dropping:
        // EventSource will not retry that by itself, so ask for a new credential.
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          failures += 1;
          if (failures >= 2) {
            handlers.current.onExpired();
            return;
          }
          retry = setTimeout(open, 2000);
        }
      };
    };

    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [room, slug, token, identity]);

  return state;
}

/** The server's clock offset (ms), sampled a few times on mount. 0 until measured. */
export function useServerClockOffset(enabled: boolean): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      const { clockOffset } = await import("./server-clock");
      const samples = [];
      for (let i = 0; i < 5 && !cancelled; i++) {
        const sentAt = Date.now();
        try {
          const { now } = await api.serverTime();
          samples.push({ sentAt, receivedAt: Date.now(), serverNow: now });
        } catch {
          // A missed sample narrows nothing; keep the rest.
        }
      }
      if (!cancelled) setOffset(clockOffset(samples));
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return offset;
}
