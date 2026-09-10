"use client";

import { useEffect, useRef } from "react";

/* How loud this microphone is, right now.
 *
 * Two callers want it and they want it differently, which is the whole reason this is a module
 * rather than an effect copied twice:
 *
 *   the pre-join screen  a NUMBER, to draw a bar and to publish an aria value. Nothing else is
 *                        on that screen, so React state per frame is affordable.
 *   the control bar      a moving indicator on the mic button while a webinar is running, with
 *                        video decoding in the same tab. React state per frame is NOT
 *                        affordable there — sixty re-renders a second of the control bar, and
 *                        everything it contains, to move one green bar.
 *
 * So the measuring lives here and the two consumers differ only in what they do with the value.
 *
 * WHY NOT the values LiveKit already publishes. `participant.audioLevel` and the active-speaker
 * events arrive roughly twice a second and are deliberately smoothed, which is right for
 * deciding who holds the floor (see lib/speaker.ts) and useless as a level meter: saying
 * "hello hello" would move it once. A meter has to follow the envelope of speech, which means
 * measuring the track directly.
 *
 * It also answers a question nothing else can: a microphone that opens successfully and
 * delivers pure silence — muted in hardware, or the wrong input — looks identical to a working
 * one until somebody tells you they cannot hear you.
 */

/** Ordinary speech peaks around 0.2 RMS, so this puts it mid-meter instead of at 5%. */
const GAIN = 5;

/**
 * measureMicLevel drives `onLevel` with a 0..1 loudness for as long as it runs.
 *
 * Framework-free and imperative on purpose: the React-shaped wrapper is below, and the pre-join
 * screen wants the raw thing. Returns a stop function; calling it releases the AudioContext.
 *
 * A no-op returning a no-op when there is no track or no Web Audio — the meter is a nicety and
 * must never be the reason a webinar fails to start.
 */
export function measureMicLevel(
  track: MediaStreamTrack | null | undefined,
  onLevel: (level: number) => void,
): () => void {
  if (!track) return () => {};

  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    return () => {};
  }

  const source = context.createMediaStreamSource(new MediaStream([track]));
  const analyser = context.createAnalyser();
  /* 512 is two things at once: enough samples that the RMS is steady rather than jittering on
   * individual waveform peaks, and small enough that the maths is nothing. There is no FFT
   * here — getFloatTimeDomainData is the raw waveform. */
  analyser.fftSize = 512;
  /* Deliberately NOT connected to context.destination. Routing a microphone to the speakers is
   * a feedback loop, not a preview. */
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let raf = 0;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(samples);
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
    onLevel(Math.min(1, Math.sqrt(sumSquares / samples.length) * GAIN));
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    try {
      source.disconnect();
      void context.close();
    } catch {
      // Already torn down by a device change; nothing to do.
    }
  };
}

/**
 * useMicMeter returns a ref to put on an element that should show the level.
 *
 * The element's `--mic-level` custom property is written every frame, from 0 to 1, and the
 * component styles itself off that. Nothing re-renders: the write goes straight to the DOM
 * node's inline style, so React never learns the level changed.
 *
 * That indirection is the point. The obvious version — `useState` in the control bar — would
 * re-render the bar and every button in it sixty times a second, in a tab that is also
 * decoding video. Driving a custom property that a `transform` reads keeps the whole thing on
 * the compositor: no React, no layout, no repaint of anything around it.
 *
 * `enabled` false parks the meter at zero rather than leaving it wherever it stopped — a muted
 * microphone showing a frozen half-full bar is a lie about whether anybody can hear you.
 */
export function useMicMeter<T extends HTMLElement>(
  track: MediaStreamTrack | null | undefined,
  enabled: boolean,
): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!enabled || !track) {
      el.style.setProperty("--mic-level", "0");
      return;
    }
    const stop = measureMicLevel(track, (level) => {
      /* Quantised to two decimals before it reaches the DOM. The ear cannot tell 0.412 from
       * 0.418 and neither can a 40-pixel button, but writing a new string every frame for the
       * difference makes the browser recompute style every frame for nothing. */
      el.style.setProperty("--mic-level", level.toFixed(2));
    });
    return () => {
      stop();
      el.style.setProperty("--mic-level", "0");
    };
  }, [track, enabled]);

  return ref;
}
