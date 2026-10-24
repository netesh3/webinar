/* The backup-codec watchdog: a camera that says it is sending and is not.
 *
 * An AV1 camera carries a VP8 backup (codec-policy.ts). When a subscriber that cannot take
 * AV1 arrives, livekit-server regresses the track: the AV1 sender's layers are switched off
 * (dynacast) and livekit-client starts a second sender, on a clone of the camera track, for
 * VP8. Every subscriber is then watching that second sender. If it never produces a frame —
 * the clone of a processed track that stopProcessor or a processor restart has since ended
 * (livekit-client updates the backup only in setProcessor and restartTrack), an encoder that
 * did not start — the room sees a black tile while the presenter's preview looks perfect.
 * On 2026-10-24 that was a minute of nothing in an edge webinar's mix, ended only by the
 * presenter turning the camera off and on.
 *
 * This is the automatic version of that toggle. Every sample (network.ts, ADAPT.sampleMs) the
 * camera's senders are read: which have an encoding switched on, and how many frames each has
 * sent. When some encoding is on, the camera is not muted, and NO switched-on sender has sent
 * a frame for STALL_MS, the camera is republished as plain VP8 (no backup, so no regression
 * left to go wrong), once per track.
 *
 * Only for a camera with a backup sender, i.e. after the codec changed under it: a VP8-only
 * camera that sends nothing has a problem a republish does not fix (a dead device).
 *
 * The decision is pure (stallStep), so it is tested under node.
 */

/** No frames from any switched-on sender for this long = stalled. */
export const STALL_MS = 3000;

export type SenderSample = {
  /** Stable per sender for the life of the track (the codec name does). */
  id: string;
  /** Any encoding of this sender has active !== false. */
  active: boolean;
  /** Sum of framesSent over this sender's outbound-rtp; null = not readable. */
  framesSent: number | null;
};

export type StallSample = {
  now: number;
  /** The track is muted, or its source has no frames to give (MediaStreamTrack.muted). */
  muted: boolean;
  senders: readonly SenderSample[];
};

export type StallState = {
  frames: Record<string, number>;
  /** When a switched-on sender was last seen making progress (or the first sample with one
   *  on); null = none is on. */
  lastProgress: number | null;
  /** The watchdog fired for this track already; it does not fire twice. */
  fired: boolean;
};

export function initialStall(): StallState {
  return { frames: {}, lastProgress: null, fired: false };
}

export function stallStep(state: StallState, sample: StallSample): { state: StallState; stalled: boolean } {
  const frames: Record<string, number> = {};
  for (const s of sample.senders) if (s.framesSent !== null) frames[s.id] = s.framesSent;

  const active = sample.senders.filter((s) => s.active);
  // Muted, or nobody is asking for any layer (dynacast paused them all): nothing is owed.
  if (sample.muted || active.length === 0) {
    return { state: { frames, lastProgress: null, fired: state.fired }, stalled: false };
  }
  /* Progress: a switched-on sender sent a frame since the last sample. A sender seen for the
   * first time, or whose count cannot be read, gets the benefit of the doubt — a new encoder
   * is given its first full window before it can be called stuck. */
  const progressing = active.some((s) => {
    if (s.framesSent === null) return true;
    const before = state.frames[s.id];
    return before === undefined || s.framesSent > before;
  });
  if (progressing || state.lastProgress === null) {
    return { state: { frames, lastProgress: sample.now, fired: state.fired }, stalled: false };
  }
  const stalled = !state.fired && sample.now - state.lastProgress >= STALL_MS;
  return { state: { frames, lastProgress: state.lastProgress, fired: state.fired || stalled }, stalled };
}

/* ------------------------------------------------------------------ runtime */

/** Reads one sender for stallStep. Never throws. */
export async function sampleSender(id: string, sender: RTCRtpSender | undefined): Promise<SenderSample> {
  if (!sender) return { id, active: false, framesSent: null };
  let active = false;
  try {
    const encodings = sender.getParameters().encodings ?? [];
    active = sender.track !== null && encodings.some((e) => e.active !== false);
  } catch {
    active = false;
  }
  let framesSent: number | null = null;
  try {
    const report = await sender.getStats();
    let sum = 0;
    let seen = false;
    report.forEach((s: { type?: string; kind?: string; framesSent?: number }) => {
      if (s.type === "outbound-rtp" && typeof s.framesSent === "number") {
        sum += s.framesSent;
        seen = true;
      }
    });
    framesSent = seen ? sum : null;
  } catch {
    framesSent = null;
  }
  return { id, active, framesSent };
}
