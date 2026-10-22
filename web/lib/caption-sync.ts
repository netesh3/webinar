/* Live captions: interim lines, and keeping them in step with an edge viewer's video.
 *
 * The server caption agent (deploy/captions) sends two kinds of "caption" packet for one
 * utterance, sharing an `id`: interim (`partial`) text every second or so while the speaker
 * is mid-line, then the final line, which replaces them. acceptCaption decides whether an
 * incoming packet may take the screen — a partial that arrives after its own final (or for a
 * line already finalised) must not put the rougher text back.
 *
 * An edge (LL-HLS) viewer's video is seconds behind the room, but their captions arrive at
 * room speed. Shown on arrival they would land before the words are heard; edgeHoldMs is how
 * long to hold a line so it appears as the video reaches the end of the speech it covers:
 * the player's measured distance behind live, plus what that measurement cannot see (the
 * composite egress, encode and packaging ahead of the playlist), minus how old the speech
 * already was when the packet was sent (`lagMs`, stamped by the agent or the API).
 *
 * Pure, apart from the tiny store the edge player writes its delay into, so it is testable
 * under plain Node (caption-sync.test.mts). */

export type CaptionLine = {
  identity: string;
  text: string;
  /** Local receive time, ms. The overlay's own stale timer measures from here. */
  at: number;
  /** Shared by a line's partials and its final. Absent from on-device captions. */
  id?: string;
  partial?: boolean;
  /** How old the end of the speech was when the packet left the server, ms. */
  lagMs?: number;
};

/** How many finalised ids are remembered to keep their late partials off the screen. */
export const FINALISED_MEMORY = 32;

export function acceptCaption(
  current: CaptionLine | null,
  incoming: CaptionLine,
  finalised: readonly string[],
): boolean {
  if (!incoming.partial) return true;
  if (!incoming.id) return true;
  if (finalised.includes(incoming.id)) return false;
  // The same line's final is already showing.
  if (current && current.id === incoming.id && !current.partial) return false;
  return true;
}

/** The finalised ids after `line` has arrived (newest last, bounded). */
export function rememberFinal(finalised: readonly string[], line: CaptionLine): readonly string[] {
  if (line.partial || !line.id || finalised.includes(line.id)) return finalised;
  const next = [...finalised, line.id];
  return next.length > FINALISED_MEMORY ? next.slice(next.length - FINALISED_MEMORY) : next;
}

/** What hls.latency (the distance to the playlist's live edge) does not include: the
 *  composite egress rendering the room, its encoder and the packager. An estimate (the
 *  docs put glass-to-glass at ~2.5 s where the readout says ~2–3 s); check it against
 *  EDGE_DEBUG_CLOCK (docs/edge-delivery.md) and tune. */
export const EDGE_INGEST_MS = 500;
/** lagMs for a packet without one (an on-device caption): about a decode's worth. */
export const DEFAULT_LAG_MS = 1000;
/** Never hold a line longer than this, whatever the player says (a stalled player can
 *  read tens of seconds behind; a caption that late is no use to anybody). */
export const MAX_HOLD_MS = 10_000;

export function edgeHoldMs(videoDelaySec: number | null, lagMs: number | undefined): number {
  if (videoDelaySec == null || !Number.isFinite(videoDelaySec) || videoDelaySec <= 0) return 0;
  const lag = typeof lagMs === "number" && Number.isFinite(lagMs) && lagMs >= 0 ? lagMs : DEFAULT_LAG_MS;
  const hold = Math.round(videoDelaySec * 1000 + EDGE_INGEST_MS - lag);
  return Math.min(MAX_HOLD_MS, Math.max(0, hold));
}

/* The edge player's current delay behind live, seconds, for the caption overlay. A module
 * store rather than context, because the player and the overlay are siblings in the edge
 * room and this is the only thing they share. Null outside an edge room, or before the
 * player has measured: captions then show on arrival, as they always did. */
let edgeDelaySec: number | null = null;
const listeners = new Set<() => void>();

export function setEdgeVideoDelay(seconds: number | null): void {
  // Quarter-second steps: the player re-measures every second and a caption hold does not
  // need finer, nor every subscriber re-rendering on the third decimal.
  const next = seconds == null || !Number.isFinite(seconds) || seconds <= 0 ? null : Math.round(seconds * 4) / 4;
  if (next === edgeDelaySec) return;
  edgeDelaySec = next;
  for (const l of listeners) l();
}

export function getEdgeVideoDelay(): number | null {
  return edgeDelaySec;
}

export function subscribeEdgeVideoDelay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
