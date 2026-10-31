/* The incoming-call ringtone and buzz (31 Oct 2026, calling). Browser only.
 *
 * The tone is synthesised with WebAudio from lib/calls.ts ringSchedule (no audio file). A
 * browser that has not had a tap on the page yet may keep the AudioContext suspended; the card
 * still shows and the OS notification still rings, so a silent tab is a degraded ring rather
 * than a missed one. Only one tab of the account rings out loud: the first to take the Web Lock.
 *
 * The desktop app (apps/desktop) is told too, through window.webinarlivDesktop.ringAttention,
 * so the window flashes and the dock bounces while the call rings. */

import { RING_GAIN, RING_PERIOD_S, RING_VIBRATION, ringSchedule } from "./calls";

type DesktopAttention = { ringAttention?: (on: boolean) => void };

function desktop(): DesktopAttention | undefined {
  return (window as unknown as { webinarlivDesktop?: DesktopAttention }).webinarlivDesktop;
}

/** Starts ringing; the returned function stops it. Safe to call stop more than once. */
export function startRinging(): () => void {
  let stopped = false;
  let ctx: AudioContext | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let releaseLock: (() => void) | null = null;

  const playPeriod = () => {
    if (!ctx || ctx.state === "closed") return;
    const t0 = ctx.currentTime + 0.05;
    for (const tone of ringSchedule()) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, t0 + tone.at);
      gain.gain.linearRampToValueAtTime(RING_GAIN, t0 + tone.at + 0.02);
      gain.gain.setValueAtTime(RING_GAIN, t0 + tone.at + tone.duration - 0.03);
      gain.gain.linearRampToValueAtTime(0, t0 + tone.at + tone.duration);
      gain.connect(ctx.destination);
      for (const f of tone.freqs) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = f;
        osc.connect(gain);
        osc.start(t0 + tone.at);
        osc.stop(t0 + tone.at + tone.duration + 0.01);
      }
    }
    if (typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(RING_VIBRATION);
      } catch {
        // Not allowed without a gesture in some browsers: the tone and the card still ring.
      }
    }
  };

  const ringOut = () => {
    if (stopped) return;
    try {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctor) {
        ctx = new Ctor();
        void ctx.resume().catch(() => {});
      }
    } catch {
      ctx = null;
    }
    playPeriod();
    timer = setInterval(playPeriod, RING_PERIOD_S * 1000);
  };

  // One ringing tab per account: the Web Lock holder rings, the others only show the card.
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (locks?.request) {
    void locks
      .request("webinarliv-ringtone", { ifAvailable: true }, (lock) => {
        if (!lock || stopped) return undefined;
        ringOut();
        return new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      })
      .catch(() => ringOut());
  } else {
    ringOut();
  }
  desktop()?.ringAttention?.(true);

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (ctx) void ctx.close().catch(() => {});
    if (typeof navigator.vibrate === "function") {
      try {
        navigator.vibrate(0);
      } catch {
        // ignore
      }
    }
    releaseLock?.();
    desktop()?.ringAttention?.(false);
  };
}
