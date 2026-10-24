/* Which publishers encode AV1.
 *
 * AV1 spends about 30% less than VP8 (cameras) or VP9 (screen shares) for the same picture,
 * and on this product the publisher's uplink IS the bottleneck: most presenters are in India
 * sending to an EU or Mumbai SFU, and a camera at 4 Mbps plus a 1080p share is what pushes
 * them into "bandwidth" limitation. So AV1 is used wherever the device can afford it, and the
 * whole difficulty is "can afford": AV1 in a browser is a SOFTWARE encoder almost everywhere
 * (libaom in Chrome; hardware AV1 encode is rare and Chrome mostly does not use it for WebRTC).
 * It costs several times VP8's CPU per frame. A laptop that cannot keep up does not fail
 * loudly: the encoder starts dropping frames and resolution, qualityLimitationReason turns to
 * "cpu", and the presenter's fan comes on.
 *
 * The gate, every condition required:
 *
 *   1. not Safari, not iPhone/iPad, not Firefox. Safari advertises AV1 on some devices and
 *      does not deliver it (livekit-client: "Safari 17 on iPhone14 reports AV1 capability, but
 *      does not actually support it"); every iOS browser is Safari underneath, whatever its UA
 *      says; iPadOS reports a Mac UA with touch points. Firefox cannot publish AV1 SVC/simulcast.
 *      These never publish AV1, whatever any capability API claims.
 *   2. the browser can encode it at all: RTCRtpSender.getCapabilities("video") lists video/AV1.
 *   3. the device says it can do it here: MediaCapabilities.encodingInfo({type: "webrtc"}) for
 *      AV1 at the target size, bitrate and frame rate is supported AND smooth.
 *   4. enough CPU for software encode: 8+ logical cores (the same proxy as the 1080p camera,
 *      canCaptureCamera1080 in network.ts). A power-efficient (hardware) encoder may go below
 *      1080p on 4+ cores. Phones need a power-efficient encoder AND 8 cores AND 6 GB.
 *   5. not demoted this session: the CPU ladder (network.ts, ADAPT.cpu) turns AV1 off when
 *      the encoder runs out of CPU anyway, and that sticks for the tab (sessionStorage) so a
 *      new camera or share does not walk straight back into it.
 *
 * Everyone else keeps today's codecs: VP8 cameras, VP9 (desktop Chromium) or H264 shares.
 *
 * Subscribers that cannot decode AV1 (Safari, iOS, older Android, anything that does not
 * offer it in its SDP) get the backup codec — VP8 for cameras, H264 for shares — which the
 * SFU asks the publisher for (livekit-server backup codec, `backupCodec` in the publish
 * options). Pure apart from probeAv1 at the bottom, so it is tested under node.
 *
 * ---- The room gate, and why AV1 is off by default (incident 2026-10-24) ----
 *
 * Before any of the device gate, the ROOM has to allow it (av1RoomVerdict), and the server
 * decides that: AppConfig.av1Publish, env AV1_PUBLISH on the API — "off" (the default),
 * "meetings" or "on". It is read before the room's first publish, so flipping the env var
 * on the API turns AV1 off for every later join with no web deploy.
 *
 * Why: a backup codec is not a free fallback. livekit-server (pkg/rtc/mediatrack.go,
 * backupCodecPolicy PREFER_REGRESSION, livekit-client's default) REGRESSES the whole track
 * the moment any subscriber negotiates the backup: every subscriber is moved to VP8 / H264
 * and the publisher is asked to start a second, cloned sender for it. The edge mix's egress
 * Chrome never takes AV1 (receive-codecs.ts: the recorder is always excluded), so in an edge
 * webinar EVERY AV1 track regressed within half a second of publishing — the host camera at
 * 15:38:24, each promoted panelist, the host's share — and AV1 bought nothing. And the
 * regression is where it broke: for about a minute the mix (and the panel) had no picture of
 * the host, although the VP8 layers reached the SFU 0.4 s after the AV1 ones, until the host
 * turned the camera off and on (a mute / unmute: every down track resynced on a keyframe).
 * The backup also runs on a CLONE of the camera track taken at that moment
 * (LocalVideoTrack.addSimulcastTrack), which stopProcessor / a processor restart never
 * update — a second way for it to go black. So:
 *
 *   - AV1 is never published in a room with a compositor (edge webinar, a mixed program),
 *     whatever the switch says: it would regress at once.
 *   - the switch is off until the regression path is proven; "meetings" is the first step.
 *   - codec-watchdog.ts catches a camera whose backup stalls anyway (a recording or a Safari
 *     guest joining a meeting later) and republishes it as plain VP8.
 */

import { logCodecDecision } from "./adapt-governor.ts";

export type Av1Kind = "camera" | "share";

/** What the gate is decided on. All of it is read off navigator / RTCRtpSender / MediaCapabilities. */
export type Av1Inputs = {
  ua: string;
  maxTouchPoints: number;
  /** navigator.hardwareConcurrency; 0 = unknown. */
  cores: number;
  /** navigator.deviceMemory in GB (Chromium only, capped at 8); undefined = unknown. */
  deviceMemoryGb?: number;
  /** RTCRtpSender.getCapabilities("video").codecs mimeTypes; null = API missing. */
  senderCodecs: readonly string[] | null;
  /** MediaCapabilities.encodingInfo for AV1 at the target; null = API missing or it threw. */
  encoding: { supported: boolean; smooth: boolean; powerEfficient: boolean } | null;
  /** The size the encoder will run at. */
  height: number;
  /** AV1 was turned off for CPU earlier this session. */
  demoted: boolean;
  /** NEXT_PUBLIC_AV1=0 at build time. */
  disabled?: boolean;
};

export type Av1Verdict = { av1: boolean; reason: string };

/** AppConfig.av1Publish (env AV1_PUBLISH). */
export type Av1PublishMode = "off" | "meetings" | "on";

/** Anything that is not exactly "on" or "meetings" — missing, empty, a typo — is off. */
export function parseAv1PublishMode(value: unknown): Av1PublishMode {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v === "on" || v === "meetings" ? v : "off";
}

/** What decides whether this ROOM may carry AV1 at all. Read off the join response. */
export type Av1RoomInputs = {
  mode: Av1PublishMode;
  /** A meeting room (JoinResponse.meeting). */
  meeting: boolean;
  /** An egress compositor subscribes to every stage track: an edge webinar's mix
   *  (JoinResponse.edgeWebinar) or a mixed program (cdnBroadcast). */
  compositor: boolean;
};

export function av1RoomVerdict(p: Av1RoomInputs): Av1Verdict {
  if (p.mode === "off") return { av1: false, reason: "server-off" };
  // The compositor never decodes AV1, so every AV1 track would regress to its backup at once.
  if (p.compositor) return { av1: false, reason: "room-compositor" };
  if (p.mode === "meetings" && !p.meeting) return { av1: false, reason: "server-meetings-only" };
  return { av1: true, reason: "allowed" };
}

/** Apple WebKit: desktop Safari, every iOS browser, and iPadOS's Mac-shaped UA. Never AV1. */
export function isAppleWebKit(ua: string, maxTouchPoints: number): boolean {
  if (/iphone|ipad|ipod/i.test(ua)) return true;
  // iPadOS 13+ "Request Desktop Website" (the default) reports as a Mac with touch.
  if (/macintosh/i.test(ua) && maxTouchPoints > 1) return true;
  // CriOS / FxiOS / EdgiOS are WebKit too, but they only exist on iOS (caught above).
  return /safari/i.test(ua) && !/chrome|chromium|crios|fxios|edg|android/i.test(ua);
}

export function isMobileUa(ua: string): boolean {
  return /android|mobile/i.test(ua);
}

/** Cores below which a software AV1 encode is not attempted at all. */
export const AV1_MIN_CORES = 8;
/** A hardware (power-efficient) encoder may run sub-1080p AV1 on this many. */
export const AV1_MIN_CORES_HW = 4;
/** Phones: hardware encoder, 8 cores and this much memory, or no AV1. */
export const AV1_MOBILE_MIN_MEMORY_GB = 6;

export function av1Verdict(p: Av1Inputs): Av1Verdict {
  if (p.disabled) return { av1: false, reason: "disabled" };
  if (p.demoted) return { av1: false, reason: "cpu-demoted" };
  if (isAppleWebKit(p.ua, p.maxTouchPoints)) return { av1: false, reason: "safari-ios" };
  if (/firefox|fxios/i.test(p.ua)) return { av1: false, reason: "firefox" };
  if (!p.senderCodecs) return { av1: false, reason: "no-capabilities-api" };
  if (!p.senderCodecs.some((m) => m.toLowerCase() === "video/av1")) {
    return { av1: false, reason: "no-av1-encoder" };
  }
  if (!p.encoding) return { av1: false, reason: "no-media-capabilities" };
  if (!p.encoding.supported) return { av1: false, reason: "encode-unsupported" };
  if (!p.encoding.smooth) return { av1: false, reason: "encode-not-smooth" };
  const cores = p.cores > 0 ? p.cores : 0;
  if (isMobileUa(p.ua)) {
    const memory = p.deviceMemoryGb ?? 0;
    if (!p.encoding.powerEfficient || cores < AV1_MIN_CORES || memory < AV1_MOBILE_MIN_MEMORY_GB) {
      return { av1: false, reason: "mobile-low-end" };
    }
    return { av1: true, reason: "mobile-hw" };
  }
  // 1080p always needs the cores; a hardware encoder may do less on fewer.
  const need = p.encoding.powerEfficient && p.height < 1080 ? AV1_MIN_CORES_HW : AV1_MIN_CORES;
  if (cores < need) return { av1: false, reason: `cores-${cores}<${need}` };
  return { av1: true, reason: p.encoding.powerEfficient ? "hw" : "sw" };
}

/* What the probe asks MediaCapabilities about: the top layer each kind actually encodes,
 * at the AV1 bitrates (network.ts AV1_SAVING applied to the camera / share tops). */
export const AV1_PROBE: Record<Av1Kind, { width: number; height: number; bitrate: number; framerate: number }> = {
  camera: { width: 1920, height: 1080, bitrate: 2_240_000, framerate: 30 },
  share: { width: 1920, height: 1080, bitrate: 1_750_000, framerate: 15 },
};

/* ------------------------------------------------------------------ runtime */

const DEMOTED_KEY = "webcast.av1.demoted";
let demotedMemo: boolean | null = null;
const verdicts = new Map<Av1Kind, Av1Verdict>();
const pending = new Map<Av1Kind, Promise<Av1Verdict>>();

function readDemoted(): boolean {
  if (demotedMemo !== null) return demotedMemo;
  try {
    demotedMemo = typeof sessionStorage !== "undefined" && sessionStorage.getItem(DEMOTED_KEY) === "1";
  } catch {
    demotedMemo = false;
  }
  return demotedMemo;
}

/** The CPU ladder gave up on AV1: no AV1 for any new publish in this tab. */
export function demoteAv1(): void {
  demotedMemo = true;
  verdicts.set("camera", { av1: false, reason: "cpu-demoted" });
  verdicts.set("share", { av1: false, reason: "cpu-demoted" });
  try {
    sessionStorage.setItem(DEMOTED_KEY, "1");
  } catch {
    // Private mode: the in-memory flag still holds for this page.
  }
}

export function av1Demoted(): boolean {
  return readDemoted();
}

/* A build-time veto (NEXT_PUBLIC_AV1=0), on top of the server's switch. The 2026-10-24 hotfix
 * made this default-off; the runtime switch (AV1_PUBLISH, default off, setAv1RoomVerdict
 * below) is now what keeps AV1 off, so a build no longer has to be cut to turn it back on. */
const AV1_DISABLED =
  (typeof process === "undefined" ? undefined : process.env.NEXT_PUBLIC_AV1) === "0";

/* The room gate (av1RoomVerdict), set by the room before it builds its publish defaults.
 * Closed until a room opens it: a page that never asks gets no AV1. */
let roomVerdict: Av1Verdict = { av1: false, reason: "server-off" };

/** Sets this page's room gate; call before the Room's publish defaults are built. */
export function setAv1RoomVerdict(v: Av1Verdict): void {
  roomVerdict = v;
  logCodecDecision("room", v.av1, v.reason);
}

/** The verdict if the probe has finished, else "no" — a publish never waits on it. */
export function av1Now(kind: Av1Kind): Av1Verdict {
  if (AV1_DISABLED) return { av1: false, reason: "disabled" };
  if (!roomVerdict.av1) return roomVerdict;
  if (readDemoted()) return { av1: false, reason: "cpu-demoted" };
  return verdicts.get(kind) ?? { av1: false, reason: "probe-pending" };
}

/** Runs (once per kind) the capability probe; resolves to the verdict and caches it. */
export function probeAv1(kind: Av1Kind): Promise<Av1Verdict> {
  if (verdicts.has(kind)) return Promise.resolve(av1Now(kind));
  const inFlight = pending.get(kind);
  if (inFlight) return inFlight;
  const run = (async (): Promise<Av1Verdict> => {
    if (typeof navigator === "undefined") return { av1: false, reason: "server" };
    let senderCodecs: string[] | null = null;
    try {
      const caps =
        typeof RTCRtpSender !== "undefined" && "getCapabilities" in RTCRtpSender
          ? RTCRtpSender.getCapabilities("video")
          : null;
      senderCodecs = caps ? caps.codecs.map((c) => c.mimeType) : null;
    } catch {
      senderCodecs = null;
    }
    const target = AV1_PROBE[kind];
    let encoding: Av1Inputs["encoding"] = null;
    try {
      const mc = navigator.mediaCapabilities;
      if (mc?.encodingInfo) {
        const info = await mc.encodingInfo({
          type: "webrtc",
          video: { contentType: "video/AV1", ...target },
        } as MediaEncodingConfiguration);
        encoding = { supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient };
      }
    } catch {
      encoding = null;
    }
    return av1Verdict({
      ua: navigator.userAgent ?? "",
      maxTouchPoints: typeof navigator.maxTouchPoints === "number" ? navigator.maxTouchPoints : 0,
      cores: navigator.hardwareConcurrency ?? 0,
      deviceMemoryGb: (navigator as { deviceMemory?: number }).deviceMemory,
      senderCodecs,
      encoding,
      height: target.height,
      demoted: readDemoted(),
      disabled: AV1_DISABLED,
    });
  })().then((v) => {
    logCodecDecision(kind, v.av1, v.reason);
    if (!readDemoted()) verdicts.set(kind, v);
    pending.delete(kind);
    return av1Now(kind);
  });
  pending.set(kind, run);
  return run;
}

/** Start both probes early (the pre-join screen), so the room's first publish has an answer. */
export function primeAv1Probes(): void {
  if (typeof window === "undefined") return;
  void probeAv1("camera");
  void probeAv1("share");
}
