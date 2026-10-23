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
