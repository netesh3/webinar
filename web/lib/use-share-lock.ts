"use client";

import { RoomEvent, Track, type Room } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  isPrivileged,
  pickShare,
  shareGate,
  shareStartedAt,
  shouldYield,
  yieldMessage,
  type ShareGate,
} from "./share-lock";

/* The browser half of "one screen share at a time". The rule itself is lib/share-lock.ts;
 * this is the wiring: what everybody else is sharing, what the Share button should do
 * about it, and stopping our own share when somebody else's outranks it.
 *
 * The server half is the LiveKit webhook (api/internal/api/share_lock.go), which mutes
 * the loser of any share that got through anyway: two people in the same instant, or a
 * browser running an old bundle that never checks. */

type RemoteShare = {
  sid: string;
  identity: string;
  name: string;
  privileged: boolean;
  muted: boolean;
  startedAt: number | null;
};

function readRemoteShares(room: Room): RemoteShare[] {
  const out: RemoteShare[] = [];
  for (const participant of room.remoteParticipants.values()) {
    const publication = participant.getTrackPublication(Track.Source.ScreenShare);
    if (!publication) continue;
    out.push({
      sid: publication.trackSid,
      identity: participant.identity,
      name: participant.name || participant.identity,
      privileged: isPrivileged(participant),
      muted: publication.isMuted,
      startedAt: shareStartedAt(publication),
    });
  }
  return out;
}

const sameShares = (a: RemoteShare[], b: RemoteShare[]) =>
  a.length === b.length &&
  a.every(
    (s, i) =>
      s.sid === b[i]!.sid &&
      s.muted === b[i]!.muted &&
      s.privileged === b[i]!.privileged &&
      s.startedAt === b[i]!.startedAt &&
      s.name === b[i]!.name,
  );

/** Every event that can change who is sharing, or whether their share counts. */
const EVENTS = [
  RoomEvent.TrackPublished,
  RoomEvent.TrackUnpublished,
  RoomEvent.TrackMuted,
  RoomEvent.TrackUnmuted,
  RoomEvent.ParticipantConnected,
  RoomEvent.ParticipantDisconnected,
  // Role and co-host live in metadata, and both can change mid-share.
  RoomEvent.ParticipantMetadataChanged,
  RoomEvent.ParticipantNameChanged,
  RoomEvent.LocalTrackPublished,
  RoomEvent.LocalTrackUnpublished,
  RoomEvent.Connected,
  RoomEvent.Reconnected,
] as const;

export type ShareLock = {
  /** Who else is on the stage right now, or null. */
  current: { identity: string; name: string } | null;
  /** What the Share button does: start, offer a takeover, or refuse. */
  gate: ShareGate;
};

export function useShareLock(
  room: Room | null,
  opts: {
    /** Host or co-host. */
    privileged: boolean;
    /** Our own screen or file share is live. */
    sharing: boolean;
    /** Stops our own share, whichever kind it is. */
    stop: () => Promise<void>;
    /** Tells the person why their share just ended. */
    onYield: (message: string) => void;
  },
): ShareLock {
  const [shares, setShares] = useState<RemoteShare[]>([]);
  /** The sids of the remote shares that were live when ours was published. Null while
   *  we are not sharing. A ref, not state: it is a fact about a moment, not something to
   *  render. */
  const atStart = useRef<Set<string> | null>(null);
  /** Our share's mute state as the SFU last told it: true once the server muted it. */
  const [mutedByServer, setMutedByServer] = useState(false);

  useEffect(() => {
    if (!room) return;
    let latest: RemoteShare[] = [];
    const sync = () => {
      const next = readRemoteShares(room);
      if (sameShares(latest, next)) return;
      latest = next;
      setShares(next);
    };
    /* Our own share starting or ending. Recorded here rather than in sync so the snapshot
     * is taken at the moment of the publish, before any re-render. */
    const onLocalPublished = (publication: { source: Track.Source }) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      atStart.current = new Set(
        readRemoteShares(room)
          .filter((s) => !s.muted)
          .map((s) => s.sid),
      );
      setMutedByServer(false);
    };
    const onLocalUnpublished = (publication: { source: Track.Source }) => {
      if (publication.source !== Track.Source.ScreenShare) return;
      atStart.current = null;
      setMutedByServer(false);
    };
    /* The server mutes a share that lost (share_lock.go). Nothing in this app mutes a
     * screen share on purpose, so a muted local share is that, and nothing else. */
    const onMuted = (publication: { source: Track.Source }, participant: { isLocal: boolean }) => {
      if (participant.isLocal && publication.source === Track.Source.ScreenShare) {
        setMutedByServer(true);
      }
    };

    room.on(RoomEvent.LocalTrackPublished, onLocalPublished);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalUnpublished);
    room.on(RoomEvent.TrackMuted, onMuted);
    for (const event of EVENTS) room.on(event, sync);
    // A publish stamp arrives with a participant update, which has no room event of its
    // own when nothing else changed. Cheap: one map walk over the stage, no renders
    // unless something actually changed.
    const poll = window.setInterval(sync, 1000);
    const frame = requestAnimationFrame(sync);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(poll);
      room.off(RoomEvent.LocalTrackPublished, onLocalPublished);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalUnpublished);
      room.off(RoomEvent.TrackMuted, onMuted);
      for (const event of EVENTS) room.off(event, sync);
    };
  }, [room]);

  const winner = pickShare(shares);
  const winnerIdentity = winner?.identity ?? null;
  const winnerName = winner?.name ?? null;
  /* Memoised on the two strings, so the gate keeps its identity across the renders
   * that change nothing and the Share button's callbacks do not churn with it. */
  const current = useMemo(
    () =>
      winnerIdentity !== null ? { identity: winnerIdentity, name: winnerName ?? winnerIdentity } : null,
    [winnerIdentity, winnerName],
  );
  const gate = useMemo(() => shareGate(opts.privileged, current), [opts.privileged, current]);

  /* Stopping our own share when it has lost. Through refs so a new `stop` or `onYield`
   * identity does not re-run the decision, and with a latch so one loss is one stop and
   * one toast however many renders it takes the share to actually end. */
  const stopRef = useRef(opts.stop);
  const yieldRef = useRef(opts.onYield);
  useEffect(() => {
    stopRef.current = opts.stop;
    yieldRef.current = opts.onYield;
  }, [opts.stop, opts.onYield]);
  const stopping = useRef(false);

  const decide = useCallback(() => {
    if (!opts.sharing) {
      stopping.current = false;
      return;
    }
    if (stopping.current) return;
    /* Sharing with no snapshot: this hook mounted after our share was already up (the
     * bar remounted mid-share). Whatever is live now is taken to have been there first,
     * which can only ever keep a host's share, never stop it on a guess. */
    if (!atStart.current) {
      atStart.current = new Set(shares.filter((s) => !s.muted).map((s) => s.sid));
    }
    const seen = atStart.current;
    const why = shouldYield(
      { privileged: opts.privileged, mutedByServer },
      shares.map((s) => ({
        identity: s.identity,
        name: s.name,
        privileged: s.privileged,
        muted: s.muted,
        presentAtStart: seen.has(s.sid),
      })),
    );
    if (!why) return;
    stopping.current = true;
    void stopRef.current().finally(() => yieldRef.current(yieldMessage(why)));
  }, [opts.sharing, opts.privileged, mutedByServer, shares]);

  useEffect(() => {
    decide();
  }, [decide]);

  return { current, gate };
}
