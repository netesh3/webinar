/* Where a recording goes, decided before it starts.
 *
 * Pure on purpose — no React, no window — so the decisions that are easy to get
 * subtly wrong are pinned by lib/record-target.test.mts rather than by clicking:
 *
 *   - which targets this browser + instance can actually use, and why not,
 *   - what each destination says in the compact Record menu,
 *   - how the menu's arrow keys move.
 *
 * There is no remembered choice any more: Record always opens the small
 * destination menu and one click there starts. `clearLegacyRememberedTarget`
 * removes what an older build may have stored so it can never resurface.
 *
 * The capture pipelines themselves live in lib/recorder.ts (cloud, composited)
 * and lib/screen-recorder.ts + lib/local-recording.ts (this computer).
 */

export type RecordTarget = "cloud" | "local";

export const RECORD_TARGETS: readonly RecordTarget[] = ["cloud", "local"];

export type TargetAvailability = {
  available: boolean;
  /** Why not, in words a host can act on. Null when available or pending. */
  reason: string | null;
  /** Not known yet (the instance config is still loading). Not available, but
   *  not to be presented as unavailable either. */
  pending?: boolean;
};

export type RecordAvailability = Record<RecordTarget, TargetAvailability>;

/** Whether the instance has cloud recording: AppConfig.cloudRecordingEnabled
 *  once the config has arrived, "checking" while it is still loading, and
 *  "unknown" when it could not be fetched at all. */
export type CloudSetting = boolean | "checking" | "unknown";

export type RecordCapabilities = {
  cloudEnabled: CloudSetting;
  /** AppConfig.recordingMode === "egress": the server records, the browser does nothing. */
  isEgress: boolean;
  /** lib/recorder.ts canRecord(): this browser can composite + encode the stage. */
  canComposite: boolean;
  /** lib/local-recording.ts canRecordLocally(): File System Access (showSaveFilePicker). */
  canSaveLocally: boolean;
  /** lib/screen-recorder.ts canRecordScreen(): getDisplayMedia + MediaRecorder. */
  canCaptureScreen: boolean;
};

export function recordAvailability(caps: RecordCapabilities): RecordAvailability {
  let cloud: TargetAvailability;
  if (caps.cloudEnabled === "checking") {
    // isEgress also comes from the config, so which pipeline Cloud would use is
    // not known yet either — wait rather than guess.
    cloud = { available: false, reason: null, pending: true };
  } else if (caps.cloudEnabled === "unknown") {
    cloud = { available: false, reason: "Couldn't check cloud recording. Reload to try again." };
  } else if (!caps.cloudEnabled) {
    cloud = { available: false, reason: "Cloud recording isn't turned on for this server." };
  } else if (!caps.isEgress && !caps.canComposite) {
    // Client mode composites the stage in this tab, so the browser has to be able to.
    cloud = { available: false, reason: "This browser can't record the session. Try Chrome, Edge or Safari." };
  } else {
    cloud = { available: true, reason: null };
  }

  // Screen capture and saving straight to disk are both Chrome/Edge-on-desktop
  // features in practice, so one short reason covers either missing.
  const localReason =
    caps.canCaptureScreen && caps.canSaveLocally ? null : "Needs Chrome or Edge on a computer.";

  return {
    cloud,
    local: { available: localReason === null, reason: localReason },
  };
}

export function anyTargetAvailable(availability: RecordAvailability): boolean {
  return RECORD_TARGETS.some((t) => availability[t].available);
}

// ------------------------------------------------------------------ storage

/** Where "Remember my choice" used to live. Read by nothing now. */
export const LEGACY_REMEMBER_KEY = "webcast.record-target.v1";

type StorageLike = Pick<Storage, "removeItem">;

/** Drops a choice remembered by an older build. Storage can be missing or
 *  throw (Safari private mode, blocked cookies); neither is worth surfacing. */
export function clearLegacyRememberedTarget(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(LEGACY_REMEMBER_KEY);
  } catch {
    // ignore — see above
  }
}

// -------------------------------------------------------------------- copy

export function targetLabel(target: RecordTarget): string {
  return target === "cloud" ? "Cloud" : "This computer";
}

/** The menu item's title. */
export function menuTitle(target: RecordTarget): string {
  return target === "cloud" ? "Record to the Cloud" : "Record on this Computer";
}

/** The one-line subline under a menu item: what happens, or why it can't. */
export function menuSubline(
  target: RecordTarget,
  availability: TargetAvailability,
  keepDays: number,
): string {
  if (availability.pending) return "Checking if cloud recording is on…";
  if (!availability.available) return availability.reason ?? "Not available here.";
  if (target === "local") return "Saved as a local file. Attendees aren't notified.";
  return keepDays > 0
    ? `Stored for ${keepDays} days. Download a copy if you need it longer.`
    : "Saved to your recordings list.";
}

/** The short destination tag — used in the Stop button's label. The pill
 *  itself shows only "REC · time"; see recordingDetail for its tooltip. */
export function recordingTag(target: RecordTarget | null): string {
  return target === "local" ? "Local" : "Cloud";
}

/** The pill's tooltip and accessible name: where it is going, how long, and —
 *  for a local file only, where the number is the file on disk — how big.
 *  Takes preformatted strings so it stays free of lib/format's locale bits. */
export function recordingDetail(
  target: RecordTarget | null,
  elapsed: string | null,
  size: string | null,
): string {
  const parts = [target === "local" ? "Recording to this computer" : "Recording to the cloud"];
  if (elapsed) parts.push(elapsed);
  if (target === "local" && size) parts.push(size);
  return parts.join(" · ");
}

// -------------------------------------------------------------- menu keys

/** Which item a menu opens focused on: the first usable one, else the first
 *  (so a disabled item's reason is still read out), else none. */
export function initialMenuIndex(enabled: readonly boolean[]): number {
  if (enabled.length === 0) return -1;
  const i = enabled.indexOf(true);
  return i === -1 ? 0 : i;
}

/** Arrow / Home / End movement in the menu. Wraps, and — as the ARIA menu
 *  pattern recommends — lands on disabled items too, so their reason can be
 *  heard; activating one does nothing. */
export function moveMenuIndex(
  current: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
  count: number,
): number {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (current < 0) return key === "ArrowDown" ? 0 : count - 1;
  const step = key === "ArrowDown" ? 1 : -1;
  return (current + step + count) % count;
}
