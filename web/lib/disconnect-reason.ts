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
 *   leaving     the page asked to leave (Leave was pressed). Checked first: Leave pressed while
 *               a connect is in flight must end as leaving whatever that connect does. It is
 *               the only disconnect that is the person leaving — livekit also says
 *               CLIENT_INITIATED for its own disconnects (pagehide, beforeunload), and nothing
 *               at all when its reconnect gives up after a network loss. Those are the network.
 *   established  this effect instance's own connect() has succeeded. Until it has, the event
 *               is not about a connection this instance owns: a failed connect emits
 *               Disconnected before its promise rejects (the caller's catch owns that), and
 *               the previous instance's cleanup disconnect usually lands here too, as
 *               CLIENT_INITIATED, while the new instance is still fetching a credential — a
 *               stage reconnect read that as a network drop and looped into "Connection
 *               lost". Not always: useSequentialRoomConnectDisconnect runs queued operations
 *               one at a time but newest first (it pops), so when both are queued before it
 *               runs, the new connect goes first and the old disconnect then reads as "lost".
 *               That costs one extra reconnect, not a loop: the retry finds the room already
 *               down, and its own cleanup disconnect is a no-op.
 *   over        the session has ended (or is being ended): the closing is the point.
 */
export function disconnectVerdict(o: {
  reason?: DisconnectReason;
  established: boolean;
  leaving: boolean;
  over?: boolean;
}): DisconnectVerdict {
  if (o.leaving) return "left";
  if (!o.established) return "ignore";
  if (o.over) return "ended";
  return classifyDisconnect(o.reason) ?? "lost";
}
