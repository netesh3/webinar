import { DisconnectReason } from "livekit-client";
import type { LostReason } from "./recovery";

/** Why a room connection closed, in the terms the reconnect ladder (lib/recovery.ts) decides
 *  on. Null is the person leaving on their own. Shared by the live room and the simulive
 *  audience room, so a network drop is never mistaken for the session ending. */
export function classifyDisconnect(reason?: DisconnectReason): LostReason | null {
  switch (reason) {
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
    case DisconnectReason.SERVER_SHUTDOWN:
      return "ended";
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "removed";
    // The same join key opened in a second tab. Saying so beats the two tabs
    // silently fighting over one identity.
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "duplicate";
    case DisconnectReason.SIGNAL_CLOSE:
    case DisconnectReason.STATE_MISMATCH:
      return "lost";
    case DisconnectReason.CLIENT_INITIATED:
    case undefined:
      return null;
    default:
      return "lost";
  }
}

/** What a room does with livekit's Disconnected event. */
export type DisconnectVerdict = "ignore" | "left" | LostReason;

/**
 * One decision for both rooms, from what this page knows rather than from the reason alone:
 *
 *   connecting  room.connect() is in flight. A failed connect emits Disconnected before its
 *               promise rejects, and the caller's catch owns that failure — handling it here
 *               too spent two attempts per failure and, on a first join, started the ladder
 *               behind the failure screen.
 *   leaving     the page asked to leave (Leave was pressed). The only disconnect that is the
 *               person leaving: livekit also says CLIENT_INITIATED for its own disconnects
 *               (Chrome freezing a background tab, pagehide), and nothing at all when its
 *               reconnect gives up after a network loss. Both of those are the network.
 *   over        the session has ended (or is being ended): the closing is the point.
 */
export function disconnectVerdict(o: {
  reason?: DisconnectReason;
  connecting: boolean;
  leaving: boolean;
  over?: boolean;
}): DisconnectVerdict {
  if (o.connecting) return "ignore";
  if (o.leaving) return "left";
  if (o.over) return "ended";
  return classifyDisconnect(o.reason) ?? "lost";
}
