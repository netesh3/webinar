"use client";

/* Staying reachable while the LiveKit connection is down.
 *
 * Chat, questions and raised hands go through POST /say, so an attendee whose connection has
 * not landed (or has dropped, while the SDK and the recovery ladder work at it) can still use
 * them. What they could not do was be seen: the host's Participants panel listed only what
 * LiveKit reports, and a stage invite went out on the data channel they did not have.
 *
 * While the room is not connected this polls POST /api/webinars/{slug}/presence (api:
 * presence.go). Each poll puts them on the host's roster for a minute ("Limited connection"),
 * and its answer is replayed onto the Room as the packets the data channel would have carried
 * — the same trick lib/edge-events.ts uses — so the invite toast, Join stage / Not now and
 * the accept request are the ordinary ones. Once the host has put them on the stage the
 * caller is told, so it can reconnect now for the stage token rather than at its next rung.
 *
 * Edge viewers never use this: their event stream and beats already do all of it. */

import { useEffect, useRef } from "react";
import { ConnectionState, RoomEvent, type Room } from "livekit-client";
import { api } from "./api";
import type { PresenceResponse } from "./api-types";
import { DATA_TOPIC } from "./realtime";
import { presenceInviteStep, presencePacket } from "./presence-step";

/** How long the room has to stay unconnected before the poll starts. A healthy connect takes
 *  about two seconds; this keeps the poll off every ordinary join. */
export const PRESENCE_AFTER_MS = 4_000;

/** How often to poll while unconnected (api: presenceWindow allows a minute). */
export const PRESENCE_POLL_MS = 10_000;

export function usePresenceFallback({
  room,
  slug,
  joinKey,
  identity,
  enabled,
  onStageGranted,
  onStart,
}: {
  room: Room;
  slug: string;
  joinKey?: string;
  identity: string;
  /** An attendee on a standard webinar. Off for the stage, meetings and simulive. */
  enabled: boolean;
  /** The host has put them on the stage: join again for the stage token. */
  onStageGranted: () => void;
  /** The poll started, for telemetry: the connection has been down a while. */
  onStart?: () => void;
}): void {
  const handlers = useRef({ onStageGranted, onStart });
  useEffect(() => {
    handlers.current = { onStageGranted, onStart };
  }, [onStageGranted, onStart]);

  useEffect(() => {
    if (!enabled || !identity) return;
    const encoder = new TextEncoder();
    let wait: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    let shown = false;
    let granted = false;
    let stopped = false;

    const emit = (packet: Record<string, unknown>) => {
      room.emit(RoomEvent.DataReceived, encoder.encode(JSON.stringify(packet)), undefined, undefined, DATA_TOPIC);
    };

    const ask = async () => {
      let res: PresenceResponse;
      try {
        res = await api.presence(slug, { joinKey });
      } catch {
        return; // Best-effort: the next poll, or the connection coming back, covers it.
      }
      if (stopped) return;
      const step = presenceInviteStep(shown, res);
      if (step) {
        emit(presencePacket(step, identity, res, Date.now()));
        shown = step === "show";
      }
      if (res.onStage && !granted) {
        granted = true;
        handlers.current.onStageGranted();
      }
    };

    const stop = () => {
      clearTimeout(wait);
      clearInterval(poll);
      wait = undefined;
      poll = undefined;
    };
    const start = () => {
      if (wait || poll) return;
      wait = setTimeout(() => {
        wait = undefined;
        handlers.current.onStart?.();
        void ask();
        poll = setInterval(() => void ask(), PRESENCE_POLL_MS);
      }, PRESENCE_AFTER_MS);
    };
    const onState = (state: ConnectionState) => {
      if (state === ConnectionState.Connected) {
        // The data channel is back and carries everything from here, including a clear for
        // an invite it never sent: the server sends one whenever an invite closes.
        stop();
        shown = false;
        granted = false;
      } else {
        start();
      }
    };

    room.on(RoomEvent.ConnectionStateChanged, onState);
    onState(room.state);
    return () => {
      stopped = true;
      stop();
      room.off(RoomEvent.ConnectionStateChanged, onState);
    };
  }, [room, slug, joinKey, identity, enabled]);
}
