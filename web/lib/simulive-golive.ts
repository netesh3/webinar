/* The host team's camera for a simulive's live part (api/internal/api/simulive_host.go).
 *
 * Nothing of the host team's is ever published while the recording plays: their grant has no
 * media (lk.Spec.NoMedia) and the audience sees only the recording. What they may do is get
 * ready — check the camera and microphone in a LOCAL preview, nothing sent — and say how they
 * want to come on when the live part starts:
 *
 *   at the recording's end, with them in the room, the session goes live by itself;
 *   or earlier, with "End replay early and go live" (POST /simulive/go-live).
 *
 * Either way every browser re-joins, and the host's arrives in the ordinary live room. This
 * is the hand-off between the two rooms: the choice made in the simulive room is kept in this
 * tab (sessionStorage), and the live room reads it once, as its entry state — so they walk on
 * with the camera they chose in no clicks, instead of camera and mic off.
 *
 * Pure apart from the storage, which is passed in, so node can test it —
 * simulive-golive.test.mts, run by `make test-web`. */

import type { KV } from "./rejoin.ts";

export type GoLiveChoice = {
  /** Come on with the camera on. */
  camera: boolean;
  /** Come on with the microphone on. */
  mic: boolean;
  /** When it was chosen, so a choice left over from another session is not obeyed. */
  at: number;
};

const PREFIX = "webcast.simulive-golive.v1.";

/** How long a choice stays good: longer than any recording runs, short enough that a tab
 *  reused for another session next week does not walk on with its camera. */
export const GO_LIVE_CHOICE_TTL_MS = 12 * 60 * 60 * 1000;

/** Reads a stored choice. Anything unrecognised, from the future, or stale is no choice. */
export function parseGoLiveChoice(raw: string | null, now: number): GoLiveChoice | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.camera !== "boolean" || typeof o.mic !== "boolean" || typeof o.at !== "number") {
    return null;
  }
  if (o.at - now > 60_000 || now - o.at > GO_LIVE_CHOICE_TTL_MS) return null;
  return { camera: o.camera, mic: o.mic, at: o.at };
}

/** How the live room starts the host's devices. No choice is the old default: both off.
 *  A host mute (mute on entry, for a co-host) still wins over the microphone. */
export function goLiveEntry(
  choice: GoLiveChoice | null,
  hostMuted: boolean,
): { micEnabled: boolean; cameraEnabled: boolean } {
  return {
    cameraEnabled: Boolean(choice?.camera),
    micEnabled: Boolean(choice?.mic) && !hostMuted,
  };
}

/** The line under the go-live control, saying what will happen. */
export function goLiveSummary(choice: Pick<GoLiveChoice, "camera" | "mic"> | null): string {
  if (!choice || (!choice.camera && !choice.mic)) {
    return "When the replay ends you go live with camera and mic off.";
  }
  const parts = [choice.camera ? "camera on" : "camera off", choice.mic ? "mic on" : "mic off"];
  return `When the replay ends you go live with ${parts.join(", ")}.`;
}

function session(): KV | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Keeps the choice for this tab. Best-effort: a browser without storage goes live with both
 *  off, as before. */
export function saveGoLiveChoice(
  slug: string,
  choice: Pick<GoLiveChoice, "camera" | "mic">,
  now: number = Date.now(),
  kv: KV | null = session(),
): void {
  if (!kv) return;
  try {
    kv.setItem(PREFIX + slug, JSON.stringify({ camera: choice.camera, mic: choice.mic, at: now }));
  } catch {
    /* full or blocked */
  }
}

/** Reads the choice without using it up — the simulive room showing what was chosen. */
export function peekGoLiveChoice(
  slug: string,
  now: number = Date.now(),
  kv: KV | null = session(),
): GoLiveChoice | null {
  if (!kv) return null;
  try {
    return parseGoLiveChoice(kv.getItem(PREFIX + slug), now);
  } catch {
    return null;
  }
}

/** Reads the choice and clears it: the live room's entry, once. A later refresh is the
 *  ordinary rejoin, which restores what the room last had. */
export function takeGoLiveChoice(
  slug: string,
  now: number = Date.now(),
  kv: KV | null = session(),
): GoLiveChoice | null {
  const choice = peekGoLiveChoice(slug, now, kv);
  try {
    kv?.removeItem(PREFIX + slug);
  } catch {
    /* blocked */
  }
  return choice;
}
