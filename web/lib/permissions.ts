"use client";

import { RoomEvent, type Participant, type Room, Track } from "livekit-client";
import { useEffect, useRef, useState } from "react";

/* What this participant is allowed to publish, right now.
 *
 * This has to be read from the live connection, not from the join response.
 * Permissions change mid-session: a host promotes an attendee, or allows them to
 * talk, or sends them back to the audience — and the SFU applies that to the
 * existing connection without a rejoin.
 *
 * Deriving `canPublish` from the join response instead was a real bug: the host
 * would allow an attendee to speak, the SFU would grant it, and the attendee's
 * control bar would still show no microphone button — so "unmute the attendee"
 * appeared not to work at all.
 */

export type MediaPermissions = {
  /** Any source at all. False for an ordinary attendee. */
  canPublish: boolean;
  canSpeak: boolean;
  canShareCamera: boolean;
  canShareScreen: boolean;
  /** The host's "allow to speak": a microphone and a camera, but never a
   *  screen share. That is what tells this apart from a full stage seat, so
   *  it is keyed on the screen-share grant rather than on the camera one —
   *  see stageSources on the API side, which grants both mic and camera
   *  together. */
  audioOnly: boolean;
  /** The host took the microphone away. `canSpeak` is false either way, and this
   *  is what separates "you were muted" from "you are in the audience" — a
   *  distinction the permissions cannot express on their own. */
  mutedByHost: boolean;
  /** The host lifted this person out of the audience, rather than their being a
   *  scheduled panelist. Same permissions, and the difference decides whether the
   *  room-wide "panelists may not unmute themselves" switch applies to them — a
   *  promotion is a per-person decision made after that switch was set. */
  promoted: boolean;
};

const NONE: MediaPermissions = {
  canPublish: false,
  canSpeak: false,
  canShareCamera: false,
  canShareScreen: false,
  audioOnly: false,
  mutedByHost: false,
  promoted: false,
};

/** LiveKit's `canPublishSources` is a list of allowed sources, and an EMPTY list
 *  means every source. Getting that backwards would hide the camera button from
 *  every panelist. */
function allows(sources: Track.Source[], source: Track.Source): boolean {
  if (sources.length === 0) return true;
  return sources.includes(source);
}

/** Reads the flags our own API mints into participant metadata. Untrusted input
 *  in principle — it arrives over the wire — so a shape we don't recognise is
 *  treated as "no claim made" rather than allowed to throw. */
function flags(room: Room | null): { mutedByHost: boolean; promoted: boolean } {
  const raw = room?.localParticipant?.metadata;
  if (!raw) return { mutedByHost: false, promoted: false };
  try {
    const meta = JSON.parse(raw) as { mutedByHost?: unknown; promoted?: unknown };
    return { mutedByHost: meta.mutedByHost === true, promoted: meta.promoted === true };
  } catch {
    return { mutedByHost: false, promoted: false };
  }
}

function read(room: Room | null): MediaPermissions {
  const permissions = room?.localParticipant?.permissions;
  const { mutedByHost, promoted } = flags(room);
  if (!permissions?.canPublish) return { ...NONE, mutedByHost, promoted };

  // The permission carries the protobuf enum (numeric); the rest of the client
  // speaks Track.Source (string). sourceFromProto is the sanctioned bridge —
  // comparing the two directly silently matches nothing.
  const sources = (permissions.canPublishSources ?? []).map((s) =>
    Track.sourceFromProto(s),
  );
  const canSpeak = allows(sources, Track.Source.Microphone);
  const canShareCamera = allows(sources, Track.Source.Camera);
  const canShareScreen = allows(sources, Track.Source.ScreenShare);

  return {
    canPublish: true,
    canSpeak,
    canShareCamera,
    canShareScreen,
    audioOnly: canSpeak && !canShareScreen,
    mutedByHost,
    promoted,
  };
}

/**
 * Tracks the local participant's publish permissions as the host changes them.
 *
 * `onChanged` fires only on a real transition, so the caller can tell somebody
 * they have just been given a microphone without also announcing it on every
 * unrelated re-render.
 */
export function useMediaPermissions(
  room: Room | null,
  onChanged?: (next: MediaPermissions, previous: MediaPermissions) => void,
): MediaPermissions {
  const [permissions, setPermissions] = useState<MediaPermissions>(() => read(room));

  // Through a ref so the subscription below does not depend on the callback's
  // identity: re-subscribing on every parent render would reset the baseline and
  // re-announce a change that had already been announced.
  const notify = useRef(onChanged);
  useEffect(() => {
    notify.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    if (!room) return;

    let current = read(room);
    // Deferred out of the effect body: the permissions may already have arrived
    // by the time this runs, and setting state synchronously here would render
    // twice in one commit.
    const frame = requestAnimationFrame(() => setPermissions(current));

    const sync = () => {
      const next = read(room);
      const changed =
        next.canPublish !== current.canPublish ||
        next.canSpeak !== current.canSpeak ||
        next.canShareCamera !== current.canShareCamera ||
        next.canShareScreen !== current.canShareScreen ||
        next.mutedByHost !== current.mutedByHost ||
        next.promoted !== current.promoted;
      if (!changed) return;

      const previous = current;
      current = next;
      setPermissions(next);
      notify.current?.(next, previous);
    };

    room.on(RoomEvent.ParticipantPermissionsChanged, sync);
    // Metadata carries the host-mute flag. It changes in the same server call as
    // the permission, but arrives as its own event, and missing it would leave the
    // participant told they are simply not a speaker.
    room.on(RoomEvent.ParticipantMetadataChanged, sync);
    // Connected and Reconnected matter because the first permissions arrive with
    // the join response, after this hook has already mounted.
    room.on(RoomEvent.Connected, sync);
    room.on(RoomEvent.Reconnected, sync);
    room.on(RoomEvent.LocalTrackPublished, sync);

    return () => {
      cancelAnimationFrame(frame);
      room.off(RoomEvent.ParticipantPermissionsChanged, sync);
      room.off(RoomEvent.ParticipantMetadataChanged, sync);
      room.off(RoomEvent.Connected, sync);
      room.off(RoomEvent.Reconnected, sync);
      room.off(RoomEvent.LocalTrackPublished, sync);
    };
  }, [room]);

  return permissions;
}

/** Live session role from participant metadata, falling back to the join token.
 *
 * Host handoff updates metadata in place; reading only join.role would leave the
 * new host stuck as a panelist in the UI until they rejoined. */
export function useLiveRole(room: Room | null, joinRole: string): string {
  const [role, setRole] = useState(joinRole);

  useEffect(() => {
    setRole(joinRole);
  }, [joinRole]);

  useEffect(() => {
    if (!room) return;

    const read = () => {
      const raw = room.localParticipant?.metadata;
      if (!raw) return;
      try {
        const meta = JSON.parse(raw) as { role?: unknown };
        if (meta.role === "host" || meta.role === "panelist" || meta.role === "attendee") {
          setRole(meta.role);
        }
      } catch {
        /* ignore malformed metadata */
      }
    };

    read();
    const onMeta = (_metadata: string | undefined, participant?: Participant) => {
      if (participant && !participant.isLocal) return;
      read();
    };
    room.on(RoomEvent.ParticipantMetadataChanged, onMeta);
    room.on(RoomEvent.Connected, read);
    room.on(RoomEvent.Reconnected, read);
    return () => {
      room.off(RoomEvent.ParticipantMetadataChanged, onMeta);
      room.off(RoomEvent.Connected, read);
      room.off(RoomEvent.Reconnected, read);
    };
  }, [room]);

  return role;
}
