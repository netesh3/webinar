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
 * removed, get a fresh token — arrive as callbacks.
 *
 * Attendance rides beside the stream rather than on it. Behind the CDN neither end of a
 * stream means the viewer came or went (a closed tab kept its stream open on the server for
 * 25 minutes), so the hook beats every EDGE_BEAT_MS while mounted and says goodbye with a
 * beacon when the page goes away; leaveEdge is the same goodbye for the Leave button. */

import { useEffect, useRef, useState } from "react";
import { RoomEvent, type Room } from "livekit-client";
import { api } from "./api";
import { EDGE_MAX_REFRESHES, edgeRetryDelay, edgeStreamFailure, routeEdgeEvent } from "./edge-route";
import { DATA_TOPIC } from "./realtime";

export type EdgeStreamState = "connecting" | "open" | "retrying";

/** How often the browser tells the server it is still watching (api: store.edgeVisitStale). */
export const EDGE_BEAT_MS = 30_000;

/** Tells the server this viewer has left, so their visit ends now rather than at a stale beat. */
export function leaveEdge(slug: string, token: string) {
  if (!token) return;
  const url = api.edgeLeaveUrl(slug, token);
  // A beacon survives the page unloading; a fetch with keepalive is the fallback.
  if (typeof navigator !== "undefined" && navigator.sendBeacon?.(url)) return;
  void fetch(url, { method: "POST", keepalive: true }).catch(() => {});
}

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
  /** The stream refused the token (401). Join again for a new one, as an automatic join
   *  (rejoin=1), so the server refuses it for a viewer the host removed. */
  onExpired: () => void;
}): EdgeStreamState {
  const [state, setState] = useState<EdgeStreamState>("connecting");
  const handlers = useRef({ onPromoted, onDemoted, onRemoved, onExpired });
  useEffect(() => {
    handlers.current = { onPromoted, onDemoted, onRemoved, onExpired };
  }, [onPromoted, onDemoted, onRemoved, onExpired]);
  // Fresh joins asked for since a stream last opened. Outlives the token, which each join changes.
  const refreshes = useRef(0);

  useEffect(() => {
    if (!token) return;
    const encoder = new TextEncoder();
    let source: EventSource | null = null;
    let closed = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Terminal: the host removed this viewer. Nothing reconnects or joins again after it.
    const removedNow = () => {
      if (closed) return;
      closed = true;
      clearTimeout(retry);
      clearInterval(beats);
      source?.close();
      handlers.current.onRemoved();
    };

    const beat = () => {
      if (closed) return;
      void fetch(api.edgeBeatUrl(slug, token), { method: "POST", keepalive: true })
        .then((res) => {
          // The beat is refused for a removed viewer too: the stream may not have noticed yet.
          if (edgeStreamFailure(res.status) === "removed") removedNow();
        })
        .catch(() => {});
    };
    const beats = setInterval(beat, EDGE_BEAT_MS);
    // A background tab's timers are throttled; say so the moment it is looked at again.
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    // pagehide rather than unload: it fires on mobile, and for a page going into the
    // back-forward cache, which pageshow then brings back with a beat.
    const onPageHide = () => leaveEdge(slug, token);
    const onPageShow = (ev: PageTransitionEvent) => {
      if (ev.persisted) beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);

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
          removedNow();
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
        refreshes.current = 0;
        setState("open");
        // A (re)connect may have missed events: read the backlogs again.
        room.emit(RoomEvent.Connected);
      };
      for (const kind of ["packet", "meta", "refetch"]) {
        es.addEventListener(kind, (ev) => emit(kind, (ev as MessageEvent<string>).data));
      }
      /* The server ends a stream before Cloud Run would. Reopened here rather than left to
       * EventSource: through the CDN the end of the response did not always reach the
       * browser, which then sat on a dead stream and heard nothing more of the session. The
       * jitter spreads an audience that connected together. */
      es.addEventListener("reconnect", () => {
        setState("retrying");
        es.close();
        clearTimeout(retry);
        retry = setTimeout(open, 500 + Math.random() * 1500);
      });
      es.onerror = () => {
        if (closed) return;
        setState("retrying");
        /* CLOSED means the server answered with an error rather than dropping, and EventSource
         * will not retry that by itself. It cannot say which error either, so the same URL is
         * asked once with fetch (edgeStreamFailure): a removal stops here for good, a bad
         * token asks for a fresh join, anything else retries with backoff. */
        if (es.readyState === EventSource.CLOSED) {
          es.close();
          failures += 1;
          void probe().then((status) => {
            if (closed) return;
            const why = edgeStreamFailure(status);
            if (why === "removed") {
              removedNow();
              return;
            }
            clearTimeout(retry);
            if (why === "expired" && refreshes.current < EDGE_MAX_REFRESHES) {
              refreshes.current += 1;
              retry = setTimeout(() => {
                if (!closed) handlers.current.onExpired();
              }, edgeRetryDelay(refreshes.current));
              return;
            }
            retry = setTimeout(open, edgeRetryDelay(failures));
          });
        }
      };
    };

    // The stream's status, read once with fetch and abandoned as soon as the headers arrive.
    const probe = async (): Promise<number | null> => {
      const ctl = new AbortController();
      try {
        const res = await fetch(api.edgeEventsUrl(slug, token), {
          credentials: "include",
          signal: ctl.signal,
          cache: "no-store",
        });
        return res.status;
      } catch {
        return null;
      } finally {
        ctl.abort();
      }
    };

    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(beats);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
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
