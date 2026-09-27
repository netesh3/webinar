/* Where a recording goes, decided before it starts.
 *
 * Pure on purpose — no React, no window — so the decisions that are easy to get
 * subtly wrong are pinned by lib/record-target.test.mts rather than by clicking:
 *
 *   - which targets this browser + instance can actually use, and why not,
 *   - what the main Record button does (stop / start directly / ask),
 *   - how a remembered choice survives storage (a stale or hand-edited value, or
 *     a target that has since become unavailable, must fall back to asking —
 *     never start a recording somewhere the host did not pick).
 *
 * The capture pipelines themselves live in lib/recorder.ts (cloud, composited)
 * and lib/screen-recorder.ts + lib/local-recording.ts (this computer).
 */

export type RecordTarget = "cloud" | "local";

export const RECORD_TARGETS: readonly RecordTarget[] = ["cloud", "local"];

export type TargetAvailability = {
  available: boolean;
  /** Why not, in words a host can act on. Null when available. */
  reason: string | null;
};

export type RecordAvailability = Record<RecordTarget, TargetAvailability>;

export type RecordCapabilities = {
  /** AppConfig.cloudRecordingEnabled — the instance has recording storage. */
  cloudEnabled: boolean;
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
  let cloudReason: string | null = null;
  if (!caps.cloudEnabled) {
    cloudReason = "Cloud recording isn't turned on for this server.";
  } else if (!caps.isEgress && !caps.canComposite) {
    // Client mode composites the stage in this tab, so the browser has to be able to.
    cloudReason = "This browser can't record the session. Try a current Chrome, Edge or Safari.";
  }

  let localReason: string | null = null;
  if (!caps.canCaptureScreen) {
    localReason = "This browser can't capture your screen. Use Chrome or Edge on a computer.";
  } else if (!caps.canSaveLocally) {
    localReason = "Saving straight to disk needs Chrome or Edge on a computer.";
  }

  return {
    cloud: { available: cloudReason === null, reason: cloudReason },
    local: { available: localReason === null, reason: localReason },
  };
}

export function anyTargetAvailable(availability: RecordAvailability): boolean {
  return RECORD_TARGETS.some((t) => availability[t].available);
}

export function parseRecordTarget(raw: unknown): RecordTarget | null {
  return raw === "cloud" || raw === "local" ? raw : null;
}

export type MainClickAction =
  | { kind: "stop" }
  | { kind: "start"; target: RecordTarget }
  | { kind: "choose"; initial: RecordTarget | null };

/** What pressing the main Record button does.
 *
 *  Recording → stop, always, with no popup: stopping must be one click.
 *  A remembered target that is still available → start there directly.
 *  Otherwise → ask, pre-selecting the remembered/last target if usable, else the
 *  first available one. With nothing available the chooser still opens (both
 *  options disabled, each with its reason) — a button that silently does nothing
 *  is worse than one that says why. */
export function resolveMainClick(input: {
  recording: boolean;
  remembered: RecordTarget | null;
  lastUsed?: RecordTarget | null;
  availability: RecordAvailability;
}): MainClickAction {
  if (input.recording) return { kind: "stop" };
  const { remembered, availability } = input;
  if (remembered && availability[remembered].available) {
    return { kind: "start", target: remembered };
  }
  return {
    kind: "choose",
    initial: initialSelection(remembered ?? input.lastUsed ?? null, availability),
  };
}

/** Which option the chooser opens with selected. */
export function initialSelection(
  preferred: RecordTarget | null,
  availability: RecordAvailability,
): RecordTarget | null {
  if (preferred && availability[preferred].available) return preferred;
  return RECORD_TARGETS.find((t) => availability[t].available) ?? null;
}

// ------------------------------------------------------------------ storage

export const REMEMBER_KEY = "webcast.record-target.v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The remembered target, or null. Storage can throw (Safari private mode,
 *  blocked cookies) and can hold anything — both read as "not remembered". */
export function readRememberedTarget(storage: StorageLike | null | undefined): RecordTarget | null {
  if (!storage) return null;
  try {
    return parseRecordTarget(storage.getItem(REMEMBER_KEY));
  } catch {
    return null;
  }
}

/** Remembers `target`, or forgets when null. Failing to persist is not an
 *  error worth surfacing — the host is simply asked again next time. */
export function writeRememberedTarget(
  storage: StorageLike | null | undefined,
  target: RecordTarget | null,
): void {
  if (!storage) return;
  try {
    if (target) storage.setItem(REMEMBER_KEY, target);
    else storage.removeItem(REMEMBER_KEY);
  } catch {
    // ignore — see above
  }
}

// -------------------------------------------------------------------- copy

export function targetLabel(target: RecordTarget): string {
  return target === "cloud" ? "Cloud" : "This computer";
}

/** The main button's tooltip while idle. */
export function recordButtonTitle(remembered: RecordTarget | null, availability: RecordAvailability): string {
  if (remembered && availability[remembered].available) {
    return remembered === "cloud" ? "Record to the Cloud" : "Record on this computer";
  }
  return "Record — choose where to save";
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
