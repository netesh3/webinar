/* When the room may say "Reconnecting…".
 *
 * The LiveKit SDK starts repairing a drop immediately. This file only decides whether
 * to draw the indicator. Host and attendee share it: both views feed the same
 * connection toast (components/room/connection-toast.tsx).
 *
 * Two signals reach that toast, and only one of them means the person has left the room:
 *
 *   signalReconnecting   The signaling websocket is resuming. The peer connection stays
 *                        up, so media and room presence continue. LiveKit does this on a
 *                        ping timeout and when a backgrounded tab loses its socket. It
 *                        is not an outage. Mapping it to "reconnecting" is what put the
 *                        indicator on screen in the middle of a healthy webinar.
 *   reconnecting        A full restart. Remote participants are unwound; media is down.
 *   disconnected        The SDK has given up. The room's own retry ladder (recovering)
 *                        is already running.
 *
 * Connection quality (Poor, Lost, …) is not an input. Poor is a settings readout, not
 * a drop. The joining / waiting banner is not this either: callers only consult the
 * indicator after the first successful connect.
 */

/** How long media and room presence must stay down before "Reconnecting…" is drawn. */
export const RECONNECT_INDICATOR_DELAY_MS = 6_000;

export type RoomLink = "connecting" | "connected" | "reconnecting" | "disconnected";

/** Map a LiveKit ConnectionState string onto the link the toast understands.
 *  `signalReconnecting` stays "connected": the peer connection never left. */
export function linkForRoom(connectionState: string): RoomLink {
  switch (connectionState) {
    case "connected":
    case "signalReconnecting":
      return "connected";
    case "connecting":
      return "connecting";
    case "reconnecting":
      return "reconnecting";
    default:
      return "disconnected";
  }
}

/** True when the connection that carries media and room presence is down.
 *  A non-null `recovering` is the room's retry ladder, which only starts after
 *  LiveKit has already emitted Disconnected — including the gap between attempts,
 *  while the SDK state is briefly "connecting" again. */
export function roomPresenceDown(connectionState: string, recovering: number | null): boolean {
  if (recovering !== null) return true;
  const link = linkForRoom(connectionState);
  return link === "reconnecting" || link === "disconnected";
}

/** Debounces the indicator. A recovery clears the clock; the next drop waits the
 *  full delay again. Blips do not add up. */
export class ReconnectIndicator {
  private downSince: number | null = null;
  private readonly delayMs: number;

  constructor(delayMs = RECONNECT_INDICATOR_DELAY_MS) {
    this.delayMs = delayMs;
  }

  /** `down` is roomPresenceDown for this sample. Returns whether to draw the indicator. */
  update(down: boolean, now: number): boolean {
    if (!down) {
      this.downSince = null;
      return false;
    }
    if (this.downSince === null) this.downSince = now;
    return now - this.downSince >= this.delayMs;
  }

  /** When the indicator will appear if the connection stays down. Null once it is
   *  already visible, or once the connection has recovered. */
  showAt(now: number): number | null {
    if (this.downSince === null) return null;
    const at = this.downSince + this.delayMs;
    return now < at ? at : null;
  }
}
