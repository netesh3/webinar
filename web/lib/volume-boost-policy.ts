/* The attendee volume boost: the decisions that can be checked without a browser.
 * lib/volume-boost.ts is the Web Audio half; this file has no imports so
 * lib/volume-boost-policy.test.mts can load it. The same split as lib/recovery.ts.
 *
 * Why a boost needs its own audio path at all. Remote audio plays through <audio>
 * elements (RoomAudioRenderer), and an element's volume stops at 1.0 — setting more
 * throws. So above 100% the room's audio is also fed through a gain stage and a limiter in
 * an AudioContext, and the elements are turned down to 0 while that runs. Down, not muted:
 * RoomAudioRenderer's `muted` unsubscribes the track at the server, and Chrome only feeds a
 * remote WebRTC stream into Web Audio while an element is still playing it.
 *
 * At 100% none of this exists: no context, no graph, and the elements play exactly as they
 * always have. Every rule below is about never making that worse.
 */

/** 100%: no boost, nothing created. */
export const BOOST_MIN = 1;
/** 200% (+6 dB). Enough for a quiet host on laptop speakers; past it a limiter is doing
 *  most of the work and speech starts to sound squashed. */
export const BOOST_MAX = 2;
export const BOOST_STEP = 0.1;
/** How far over full scale the limiter's curve reaches: the most the gain can add. */
export const BOOST_HEADROOM = BOOST_MAX;

/** A slider value made safe: a number between BOOST_MIN and BOOST_MAX on the step grid. */
export function clampBoost(v: number): number {
  if (!Number.isFinite(v)) return BOOST_MIN;
  const stepped = Math.round(v / BOOST_STEP) * BOOST_STEP;
  return Math.min(BOOST_MAX, Math.max(BOOST_MIN, Math.round(stepped * 100) / 100));
}

/** iPhone, iPod or iPad — including an iPad that asks for the desktop site and says
 *  "Macintosh". There, audio played through Web Audio follows the ring/silent switch, while
 *  an <audio> element does not: a boost would silence somebody with the switch on. */
export function isIOSLike(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Why the boost cannot be offered here, or null when it can. */
export type BoostBlocker =
  | "publisher" // has a microphone: Web Audio output may escape echo cancellation
  | "ios" // see isIOSLike
  | "lock-screen" // the Android lock-screen experiment owns the element volume
  | "speaker" // a chosen speaker this browser's AudioContext cannot play to
  | "unsupported" // no AudioContext, or no way to check the boost is working
  | "failed"; // tried in this session and the audio did not come through

export function boostBlocker(o: {
  publisher: boolean;
  ios: boolean;
  lockScreen: boolean;
  /** A specific output device is chosen (not the system default). */
  speakerChosen: boolean;
  /** AudioContext.setSinkId exists. */
  contextSinkSupported: boolean;
  /** AudioContext, and RTCRtpReceiver.getSynchronizationSources for the watchdog. */
  supported: boolean;
  failed: boolean;
}): BoostBlocker | null {
  if (o.publisher) return "publisher";
  if (o.ios) return "ios";
  if (!o.supported) return "unsupported";
  if (o.failed) return "failed";
  if (o.lockScreen) return "lock-screen";
  if (o.speakerChosen && !o.contextSinkSupported) return "speaker";
  return null;
}

/** What the settings panel says instead of the slider. Null: say nothing, hide it. */
export function boostBlockerText(b: BoostBlocker): string | null {
  switch (b) {
    case "ios":
      return "Use your device's volume buttons — this browser doesn't let a page boost volume safely.";
    case "speaker":
      return "Volume boost works with the system default speaker in this browser. Choose “System default” above to use it.";
    case "failed":
      return "Volume boost didn't work in this browser, so normal playback is back on.";
    case "unsupported":
      return "This browser can't boost volume. Use your device's volume controls.";
    case "publisher":
    case "lock-screen":
      return null;
  }
}

/* The watchdog. The boost's whole risk is silence: the elements turned down to 0 while the
 * graph receives nothing (a browser that does not feed remote WebRTC into Web Audio, a
 * context that stopped). The network says when somebody is speaking — the RTP audio level
 * of each received stream — so the graph's own input can be checked against it, and silence
 * is only blamed on the boost when there was speech to hear. */

/** RTP audioLevel (linear 0..1, per RFC 6464 as browsers report it) that counts as speech. */
export const SPEECH_RTP_LEVEL = 0.02;
/** Graph input RMS below this is nothing at all. */
export const GRAPH_SILENT_RMS = 1e-5;
/** Consecutive checks with speech on the network and nothing in the graph before giving up. */
export const STALLED_CHECKS = 3;

export type BoostHealth = { stalled: number; verdict: "ok" | "failed" };
export const HEALTHY: BoostHealth = { stalled: 0, verdict: "ok" };

export function judgeBoost(prev: BoostHealth, rtpLevel: number | null, graphRms: number): BoostHealth {
  if (prev.verdict === "failed") return prev;
  // No speech on the network, or no reading: nothing to judge by.
  if (rtpLevel === null || !(rtpLevel > SPEECH_RTP_LEVEL)) return prev;
  if (graphRms > GRAPH_SILENT_RMS) return HEALTHY;
  const stalled = prev.stalled + 1;
  return { stalled, verdict: stalled >= STALLED_CHECKS ? "failed" : "ok" };
}

/** The volume RoomAudioRenderer is given. undefined until the boost has ever run, so a
 *  person who never touches it gets exactly today's behaviour; 1 after that, because the
 *  renderer only applies a volume it is given — leaving it undefined after a 0 would leave
 *  the room silent. */
export function rendererVolume(o: { active: boolean; everActive: boolean }): number | undefined {
  if (o.active) return 0;
  return o.everActive ? 1 : undefined;
}
