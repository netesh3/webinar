/* Who must not RECEIVE AV1.
 *
 * codec-policy.ts decides who publishes AV1; every AV1 publish carries a VP8 (camera) or H264
 * (share) backup. Which of the two a subscriber gets is decided by the subscriber's own SDP:
 * livekit-server binds each down track to the codec the subscriber negotiated
 * (sfu/downtrack.go Bind → OnCodecNegotiated), and when that is not the primary,
 * SubscribedTrack.OnCodecNegotiated picks the backup receiver (DetermineReceiver) and asks the
 * publisher to start sending it. That is how Safari, which offers no AV1, already gets VP8.
 *
 * So a subscriber that cannot afford AV1 decode just leaves AV1 out of its receive codecs:
 * RTCRtpTransceiver.setCodecPreferences on every receive-only video transceiver, applied right
 * before each createOffer / createAnswer (livekit-client negotiates in both directions, and
 * offers receive placeholders in single-peer-connection mode).
 *
 *   recorder   the egress template (edge mix, recordings): a headless Chrome on a 4-vCPU box
 *              decoding every stage tile in software. Always excluded.
 *   weak       ≤ 4 logical cores; or a phone whose AV1 decode MediaCapabilities does not call
 *              supported + smooth + power-efficient (software dav1d on a phone is battery and
 *              heat); or any device that reports AV1 decode unsupported / not smooth.
 *   others     keep AV1 — that is where the downlink saving lands.
 *
 * The decision is pure (receiveAv1Verdict, tested); the rest installs it.
 */

export type ReceiveRole = "recorder" | "participant";

export type ReceiveInputs = {
  role: ReceiveRole;
  /** The session host's "AV1 video (beta)" switch. Off: participants are left alone entirely
   *  (nothing publishes AV1, and no RTCPeerConnection patch is installed). The recorder
   *  excludes AV1 regardless — it only narrows what the recorder accepts. */
  sessionAv1?: boolean;
  ua: string;
  /** navigator.hardwareConcurrency; 0 = unknown. */
  cores: number;
  /** MediaCapabilities.decodingInfo({type: "webrtc", video/AV1 1080p30}); null = unknown. */
  decoding: { supported: boolean; smooth: boolean; powerEfficient: boolean } | null;
};

export type ReceiveVerdict = { excludeAv1: boolean; reason: string };

/** A subscriber with this many logical cores or fewer never receives AV1. */
export const RECEIVE_AV1_MAX_WEAK_CORES = 4;

export function receiveAv1Verdict(p: ReceiveInputs): ReceiveVerdict {
  if (p.role === "recorder") return { excludeAv1: true, reason: "recorder" };
  if (!p.sessionAv1) return { excludeAv1: false, reason: "beta-off" };
  if (p.cores > 0 && p.cores <= RECEIVE_AV1_MAX_WEAK_CORES) {
    return { excludeAv1: true, reason: `cores-${p.cores}` };
  }
  const phone = /android|iphone|ipad|ipod|mobile/i.test(p.ua);
  if (p.decoding && (!p.decoding.supported || !p.decoding.smooth)) {
    return { excludeAv1: true, reason: "decode-unsupported" };
  }
  if (phone && !p.decoding?.powerEfficient) {
    // Unknown counts as "no": until the probe says hardware, a phone gets the backup.
    return { excludeAv1: true, reason: p.decoding ? "mobile-sw-decode" : "mobile-unknown" };
  }
  return { excludeAv1: false, reason: "ok" };
}

/** The receive codec list with AV1 removed (rtx/red/fec kept). Pure, for the test. */
export function withoutAv1<T extends { mimeType: string }>(codecs: readonly T[]): T[] {
  return codecs.filter((c) => c.mimeType.toLowerCase() !== "video/av1");
}

/* ------------------------------------------------------------------ runtime */

let excludeAv1 = false;
let installed = false;
const filtered = new WeakSet<RTCRtpTransceiver>();

function receiveCodecs(): RTCRtpCodec[] | null {
  try {
    const caps = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null;
    return caps ? caps.codecs : null;
  } catch {
    return null;
  }
}

/* Receive-only video transceivers lose AV1; one that has since started sending (a reused
 * placeholder) gets the browser's defaults back, so a publish is never narrowed by this. */
function applyTo(pc: RTCPeerConnection): void {
  const all = receiveCodecs();
  if (!all) return;
  const narrowed = withoutAv1(all);
  if (narrowed.length === all.length) return;
  for (const t of pc.getTransceivers()) {
    if (t.receiver.track?.kind !== "video" || typeof t.setCodecPreferences !== "function") continue;
    const receiveOnly = t.direction === "recvonly" && !t.sender.track;
    try {
      if (excludeAv1 && receiveOnly) {
        t.setCodecPreferences(narrowed);
        filtered.add(t);
      } else if (filtered.has(t)) {
        t.setCodecPreferences([]);
        filtered.delete(t);
      }
    } catch {
      // A browser that rejects the list negotiates as before: AV1 may arrive, nothing breaks.
    }
  }
}

function install(): void {
  if (installed || typeof RTCPeerConnection === "undefined") return;
  installed = true;
  const proto = RTCPeerConnection.prototype;
  const offer = proto.createOffer;
  const answer = proto.createAnswer;
  // Both overloads (legacy callbacks and promise) pass straight through.
  proto.createOffer = function (this: RTCPeerConnection, ...args: unknown[]) {
    applyTo(this);
    return (offer as (...a: unknown[]) => Promise<RTCSessionDescriptionInit>).apply(this, args);
  } as typeof proto.createOffer;
  proto.createAnswer = function (this: RTCPeerConnection, ...args: unknown[]) {
    applyTo(this);
    return (answer as (...a: unknown[]) => Promise<RTCSessionDescriptionInit>).apply(this, args);
  } as typeof proto.createAnswer;
}

/** Sets the policy for this page; must run before the Room connects. The RTCPeerConnection
 *  patch is installed only the first time something is excluded — a page that never excludes
 *  AV1 (every session without the beta switch) is never patched. */
export function setReceiveAv1Excluded(exclude: boolean): void {
  excludeAv1 = exclude;
  if (exclude) install();
}

/* Decide and install for this page. Synchronous first answer (decoding unknown: phones excluded),
 * then refined by decodingInfo for any LATER negotiation — a phone with hardware AV1 decode gets
 * it on the next subscription. Returns the final verdict. Without the session's beta switch a
 * participant is left alone (no probe, no patch). */
export function primeReceivePolicy(role: ReceiveRole, sessionAv1 = false): Promise<ReceiveVerdict> {
  if (typeof navigator === "undefined") return Promise.resolve({ excludeAv1: false, reason: "server" });
  const base = { role, sessionAv1, ua: navigator.userAgent ?? "", cores: navigator.hardwareConcurrency ?? 0 };
  const first = receiveAv1Verdict({ ...base, decoding: null });
  setReceiveAv1Excluded(first.excludeAv1);
  if (role === "recorder" || !sessionAv1 || !navigator.mediaCapabilities?.decodingInfo) return Promise.resolve(first);
  return navigator.mediaCapabilities
    .decodingInfo({
      type: "webrtc",
      video: { contentType: "video/AV1", width: 1920, height: 1080, bitrate: 2_240_000, framerate: 30 },
    } as MediaDecodingConfiguration)
    .then((info) => {
      const v = receiveAv1Verdict({
        ...base,
        decoding: { supported: info.supported, smooth: info.smooth, powerEfficient: info.powerEfficient },
      });
      setReceiveAv1Excluded(v.excludeAv1);
      return v;
    })
    .catch(() => first);
}
