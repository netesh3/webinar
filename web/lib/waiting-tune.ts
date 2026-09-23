import { useCallback, useSyncExternalStore } from "react";

/* A tune for the "waiting for the host" screen — see WaitingForStage in stage.tsx.
 *
 * lib/chat-notify.ts's sound cue already proved the shape this needed: a preference
 * remembered per browser, and playback that never leaves this browser either. An
 * attendee sitting in "waiting for the host" is not receiving anything from the SFU —
 * there is no host audio yet to be early for — so there is nothing to stream and no
 * other attendee's copy to keep in sync. Every tab loops its own four notes on its
 * own clock, and stops the moment ITS OWN connection sees a published track.
 *
 * Synthesised with oscillators rather than a loaded file, same reasoning as the chat
 * cue: no asset to fetch or decode, and nothing an autoplay policy can block that the
 * attendee's own Join click hasn't already cleared for the rest of the page's life.
 */

/* On by default, and remembered once somebody changes it — one preference per
 * browser, exactly like the chat cue's. There is no equivalent risk to guard against
 * here: this never plays for whoever is presenting (WaitingForStage shows a host or
 * panelist their own camera preview instead, never this card), so unlike the chat
 * cue there is nobody it could accidentally broadcast a laptop noise to.
 */
const TUNE_KEY = "webcast.waitingTune.v1";

const tuneListeners = new Set<() => void>();
/** Cached so the snapshot is referentially stable, which useSyncExternalStore requires. */
let tuneEnabled: boolean | null = null;

function readTunePreference(): boolean {
  if (tuneEnabled !== null) return tuneEnabled;
  try {
    tuneEnabled = window.localStorage.getItem(TUNE_KEY) !== "off";
  } catch {
    // Private browsing. The preference lasts the tab.
    tuneEnabled = true;
  }
  return tuneEnabled;
}

function subscribeTune(listener: () => void): () => void {
  tuneListeners.add(listener);
  return () => tuneListeners.delete(listener);
}

function tuneOnServer(): boolean {
  return false;
}

/** Just the preference — read here (Settings) and in stage.tsx, which is the only
 *  place that actually starts or stops playback. Kept separate from that playback,
 *  the same way useChatSound is separate from playChatCue, so this hook can be used
 *  anywhere the toggle needs to appear without also spinning up an AudioContext. */
export function useWaitingTune(): {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
} {
  const enabled = useSyncExternalStore(subscribeTune, readTunePreference, tuneOnServer);
  const setEnabled = useCallback((on: boolean) => {
    tuneEnabled = on;
    try {
      window.localStorage.setItem(TUNE_KEY, on ? "on" : "off");
    } catch {
      // As above.
    }
    for (const listener of tuneListeners) listener();
  }, []);
  return { enabled, setEnabled };
}

// ------------------------------------------------------------------ playback

/** A soft C-major arpeggio: four notes, each left to ring like a bell rather than
 *  cut off. Offsets in seconds from the start of one phrase. */
const NOTES: readonly (readonly [frequency: number, offset: number])[] = [
  [523.25, 0], // C5
  [659.25, 0.28], // E5
  [783.99, 0.56], // G5
  [1046.5, 0.84], // C6
];
/** A touch of the octave and the fifth above the fundamental — enough to sound like
 *  a struck note instead of a lab-tone sine wave, without turning it into a chord. */
const OVERTONES: readonly (readonly [multiple: number, level: number])[] = [
  [1, 1],
  [2, 0.15],
  [3, 0.05],
];
const NOTE_ATTACK = 0.008;
const NOTE_DECAY = 1.1;
const NOTE_PEAK = 0.07;
/** Rest between one phrase ending and the next beginning — long enough that this
 *  reads as an occasional chime somebody notices once in a while, not a loop
 *  somebody notices looping. */
const PHRASE_GAP = 1.6;
const CYCLE_SECONDS = NOTES[NOTES.length - 1]![1] + NOTE_ATTACK + NOTE_DECAY + PHRASE_GAP;

function scheduleNote(
  ctx: AudioContext,
  master: GainNode,
  frequency: number,
  at: number,
): void {
  // One envelope per note — they overlap in time (the next note starts while the
  // last is still decaying), so each needs its own attack/decay rather than sharing
  // one shape the way the chat cue's two notes do.
  const envelope = ctx.createGain();
  envelope.connect(master);
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.linearRampToValueAtTime(NOTE_PEAK, at + NOTE_ATTACK);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_ATTACK + NOTE_DECAY);

  for (const [multiple, level] of OVERTONES) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = frequency * multiple;
    const overtone = ctx.createGain();
    overtone.gain.value = level;
    osc.connect(overtone);
    overtone.connect(envelope);
    osc.start(at);
    osc.stop(at + NOTE_ATTACK + NOTE_DECAY + 0.05);
  }
}

/** One context per run, not a shared module-level one like the chat cue's — this has
 *  a start and a stop rather than firing once, and closing the context on stop frees
 *  the output device instead of leaving it open for a webinar's entire duration. */
class TunePlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.timer !== null) return; // already running
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      // As in playChatCue: a refusal here is swallowed, not queued. The attendee's own
      // Join click is the gesture browsers are looking for, so this is normally a
      // no-op, but a tune that starts minutes later out of context would be worse than
      // one that never started.
      void ctx.resume().catch(() => {});
      this.scheduleCycle();
    } catch {
      // No output device, or a context the browser refused to create.
    }
  }

  private scheduleCycle(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const at = ctx.currentTime + 0.05;
    for (const [frequency, offset] of NOTES) {
      scheduleNote(ctx, master, frequency, at + offset);
    }
    this.timer = setTimeout(() => this.scheduleCycle(), CYCLE_SECONDS * 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    this.ctx = null;
    this.master = null;
    try {
      const now = ctx.currentTime;
      master.gain.setValueAtTime(master.gain.value, now);
      // A quick fade rather than cutting the current note off square, which would
      // click. Any note already ringing decays on its own envelope regardless.
      master.gain.linearRampToValueAtTime(0.0001, now + 0.25);
    } catch {
      // Ignore — there is nothing left to fade.
    }
    setTimeout(() => void ctx.close().catch(() => {}), 400);
  }
}

let player: TunePlayer | null = null;

/** Starts the loop. A no-op if it is already running — see stage.tsx, the only
 *  caller, for why that matters. */
export function startWaitingTune(): void {
  if (typeof window === "undefined") return;
  player ??= new TunePlayer();
  player.start();
}

/** Fades out and releases the audio context. Safe to call even when nothing is
 *  playing. */
export function stopWaitingTune(): void {
  player?.stop();
}
