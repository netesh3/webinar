/* When a microphone that looks live is not actually carrying sound.
 *
 * The failure this exists to catch, as reported from a webinar of about a hundred people:
 * an attendee is brought on stage, the host's roster says "Live", and nobody — host,
 * panelists or audience — hears a word. The roster cannot tell that apart from somebody
 * who is simply quiet, because a mic is "Live" as soon as it is announced, before a single
 * packet has arrived. The byte counters on the sending and receiving ends can, and that is
 * all this reads.
 *
 * The decision lives here, with no imports, so lib/audio-watch.test.mts can load it; the
 * sampling is in lib/telemetry.ts. See lib/republish.ts for the same split.
 */

/** Unmuted with no bytes moving for this long is a stall. Opus with DTX still sends a
 *  packet every 400 ms through silence, so a quiet speaker never looks like this. */
export const STALL_MS = 12_000;

/** Unmuted, and exactly no energy in the track for this long since being unmuted, is a
 *  dead source: a stopped audio context, a processor that never started, a microphone
 *  muted in hardware. Only judged until the first energy after unmuting — a denoiser can
 *  quantise a very quiet room down to exact zeros, so a speaker who has already been heard
 *  and then pauses must never look like this. */
export const SILENT_MS = 30_000;

export type FlowSample = {
  at: number;
  /** Muted by the person or the host: nothing is owed, so nothing is judged. */
  muted: boolean;
  /** bytesSent or bytesReceived, cumulative. 0 when the stats came back with no RTP stream
   *  at all — nothing has ever been sent or received, which is the worst case, not "no
   *  data". Undefined only when there were no stats to be had. */
  bytes: number | undefined;
  /** totalAudioEnergy, cumulative — sending side only, and not every browser has it. */
  energy?: number | undefined;
};

export type FlowState = {
  bytes?: number;
  energy?: number;
  stalledSince?: number;
  silentSince?: number;
  stalled: boolean;
  silent: boolean;
  /** Energy has moved since the track was last unmuted. See SILENT_MS. */
  heard: boolean;
};

export const INITIAL_FLOW: FlowState = { stalled: false, silent: false, heard: false };

/** What to report about this sample. Each of stalled and silent is reported once, when it
 *  starts; "flowing" once, when whichever was reported ends. */
export type FlowEvent = "stalled" | "silent" | "flowing";

export function watchFlow(
  prev: FlowState,
  sample: FlowSample,
): { next: FlowState; events: FlowEvent[] } {
  const events: FlowEvent[] = [];
  const next: FlowState = { ...prev, bytes: sample.bytes ?? prev.bytes };
  if (sample.energy !== undefined) next.energy = sample.energy;

  if (sample.muted || sample.bytes === undefined) {
    // Nothing owed. Restart the clocks so time spent muted never counts towards a stall,
    // and forget having heard them: a source can die across a mute and an unmute.
    next.stalledSince = undefined;
    next.silentSince = undefined;
    if (sample.muted) next.heard = false;
    return { next, events };
  }

  const moved = prev.bytes !== undefined && sample.bytes > prev.bytes;
  if (prev.bytes === undefined || moved) {
    next.stalledSince = undefined;
  } else {
    next.stalledSince = prev.stalledSince ?? sample.at;
    if (!prev.stalled && sample.at - next.stalledSince >= STALL_MS) {
      next.stalled = true;
      events.push("stalled");
    }
  }

  if (sample.energy !== undefined && prev.energy !== undefined) {
    if (sample.energy > prev.energy) {
      next.silentSince = undefined;
      next.heard = true;
    } else if (!prev.heard) {
      next.silentSince = prev.silentSince ?? sample.at;
      if (!prev.silent && sample.at - next.silentSince >= SILENT_MS) {
        next.silent = true;
        events.push("silent");
      }
    }
  }

  const stallOver = prev.stalled && moved;
  const silenceOver = prev.silent && sample.energy !== undefined && prev.energy !== undefined &&
    sample.energy > prev.energy;
  if (stallOver) next.stalled = false;
  if (silenceOver) next.silent = false;
  if ((stallOver || silenceOver) && !next.stalled && !next.silent) events.push("flowing");

  return { next, events };
}

/* ------------------------------------------------------------------ how loud a voice is
 *
 * "The host's voice is very low," from some listeners. Nothing measured how loud anybody
 * was, so a complaint could not be told apart from one listener's volume knob. WebRTC
 * already keeps the numbers, on the sending side (media-source) and the receiving side
 * (inbound-rtp): its audio level is the peak of each 100 ms, 0..1, and the counters
 * accumulate totalAudioEnergy = Σ level² × seconds over totalSamplesDuration seconds.
 * The decision about them lives here; telemetry.ts samples them. */

/** An interval louder than this had somebody talking in it (dBFS, of 100 ms peaks). */
export const TALKING_DB = -45;

/** A speaker whose talking intervals sit mostly below this is quiet: well under the level
 *  a close microphone with automatic gain control gives. Advisory — the numbers are
 *  reported with it, so the threshold can be judged against real sessions. */
export const QUIET_DB = -26;

/** Talking intervals needed before a summary says anything. */
export const LEVEL_MIN_TALKING = 3;

export type LevelCounters = { energy?: number; duration?: number };

/** The level of the interval between two readings of the cumulative counters, in dBFS.
 *  Undefined when either reading is missing or no audio passed in between. */
export function intervalLevelDb(
  prev: LevelCounters,
  energy: number | undefined,
  duration: number | undefined,
): number | undefined {
  if (
    energy === undefined || duration === undefined ||
    prev.energy === undefined || prev.duration === undefined
  ) {
    return undefined;
  }
  const dEnergy = energy - prev.energy;
  const dSeconds = duration - prev.duration;
  if (!(dSeconds > 0) || dEnergy < 0) return undefined;
  return 10 * Math.log10(Math.max(dEnergy / dSeconds, 1e-12));
}

export type LevelSummary = {
  /** The level they usually talk at: the 75th percentile of the talking intervals. */
  speakingDb: number | null;
  loudestDb: number | null;
  /** How many intervals had them talking. */
  talking: number;
  quiet: boolean;
};

const round1 = (v: number) => Math.round(v * 10) / 10;

export function summarizeLevels(levels: number[]): LevelSummary {
  const talking = levels.filter((l) => l > TALKING_DB).sort((a, b) => a - b);
  if (talking.length === 0) return { speakingDb: null, loudestDb: null, talking: 0, quiet: false };
  const speaking = talking[Math.min(talking.length - 1, Math.floor(talking.length * 0.75))];
  return {
    speakingDb: round1(speaking),
    loudestDb: round1(talking[talking.length - 1]),
    talking: talking.length,
    quiet: talking.length >= LEVEL_MIN_TALKING && speaking < QUIET_DB,
  };
}
