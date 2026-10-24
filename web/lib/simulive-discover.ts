/* Making simulive findable: the "Simulive" create option's recording picker, the card on an
 * ended session's Results that offers to run it again, and the "What's a Simulive?" copy.
 *
 * Pure, so it is tested on its own (simulive-discover.test.mts). Which recording can be a
 * simulive is simulive-create.ts's rule; this file only orders and picks from it. */

import type { Recording, Webinar } from "./api-types.ts";
import { simuliveAllowed } from "./host-features.ts";
import { simuliveEligible } from "./simulive-create.ts";

/** The "Simulive" create option: the recording picker, which then opens the schedule form. */
export const SIMULIVE_PICKER_HREF = "/host/new/simulive";

/** The picker's list: every ready recording across the host's sessions, newest first, each
 *  once. The library endpoint already answers in that order; sorting again keeps the picker
 *  right if a caller merges lists, and a recording without a readable date goes last. */
export function simuliveLibrary<
  R extends Pick<Recording, "id" | "status" | "sizeBytes" | "createdAt">,
>(list: readonly R[] | null | undefined): R[] {
  const seen = new Set<string>();
  const out: R[] = [];
  for (const rec of list ?? []) {
    if (!simuliveEligible(rec) || seen.has(rec.id)) continue;
    seen.add(rec.id);
    out.push(rec);
  }
  const at = (r: R) => {
    const t = Date.parse(r.createdAt);
    return Number.isFinite(t) ? t : -Infinity;
  };
  return out
    .map((r, i) => ({ r, i, t: at(r) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map((x) => x.r);
}

/** A video the host uploaded (no webinar, no original session) rather than a recording. */
export function isUploadedVideo(rec: Pick<Recording, "source"> | null | undefined): boolean {
  return rec?.source === "upload";
}

/** After an upload: the new video first in the picker, once. */
export function withUploaded<R extends Pick<Recording, "id">>(list: readonly R[] | null | undefined, rec: R): R[] {
  return [rec, ...(list ?? []).filter((r) => r.id !== rec.id)];
}

/** The take a thumbnail shows: the first stored part, or the recording itself. */
export function firstPlayablePart(rec: Pick<Recording, "id" | "parts">): string {
  return rec.parts?.find((p) => p.status === "ready" && p.sizeBytes > 0)?.id ?? rec.id;
}

/** The recording the Results card offers to replay, or null when there is no card: the
 *  session is over, the account has the simulive switch, it is the viewer's own (the server only schedules a host's own
 *  recordings), it is not itself a simulive (a simulive is never recorded), and it has a
 *  ready recording. The newest one, since that is the one the host just made. */
export function autopilotRecording<
  R extends Pick<Recording, "id" | "status" | "sizeBytes" | "createdAt">,
>(
  webinar: Pick<Webinar, "status" | "kind"> & { host: Pick<Webinar["host"], "id"> },
  recordings: readonly R[] | null | undefined,
  viewer: { id: string; canHost: boolean; features?: readonly string[] | null } | null | undefined,
): R | null {
  if (webinar.status !== "ended" || webinar.kind === "simulive") return null;
  if (!viewer?.canHost || viewer.id !== webinar.host.id) return null;
  // The account's simulive switch (Admin -> Accounts): the server refuses a simulive without it.
  if (!simuliveAllowed(viewer)) return null;
  return simuliveLibrary(recordings)[0] ?? null;
}

/* Dismissing the Results card is per session and per browser: a host who closed it on one
 * session still sees it on the next one they run. */

/** The bit of Storage this needs, so a test can hand in a Map. */
export type KeyStore = Pick<Storage, "getItem" | "setItem">;

export function autopilotDismissKey(slug: string): string {
  return `simulive-autopilot-dismissed:${slug}`;
}

export function isAutopilotDismissed(store: KeyStore | null | undefined, slug: string): boolean {
  if (!store || !slug) return false;
  try {
    return store.getItem(autopilotDismissKey(slug)) === "1";
  } catch {
    // Private mode or storage switched off: show the card.
    return false;
  }
}

export function dismissAutopilot(store: KeyStore | null | undefined, slug: string): void {
  if (!store || !slug) return;
  try {
    store.setItem(autopilotDismissKey(slug), "1");
  } catch {
    // Nowhere to remember it; closing still hides it for this visit.
  }
}

/** One line of "What's a Simulive?". `onRequest` marks the part that needs replay_engage on an
 *  account that lacks it. */
export type ExplainerPoint = { text: string; onRequest: boolean };

export function simuliveExplainer(hasReplayEngage: boolean): ExplainerPoint[] {
  return [
    { text: "Plays your recording at a time you pick, like a live webinar.", onRequest: false },
    { text: "People register and join as usual, and chat with each other live.", onRequest: false },
    {
      text: "The original chat, Q&A and polls replay at the moments they happened.",
      onRequest: !hasReplayEngage,
    },
    {
      text: "Drop in any time to answer questions. Your camera is never added, and the session is never re-recorded.",
      onRequest: false,
    },
  ];
}
