/* The rules every quality change obeys, in one pure state machine.
 *
 * A "governor" holds one level on a ladder (0 = best) and moves it at most one rung at a
 * time, from a stream of samples. The thresholds themselves are data (ADAPT in network.ts);
 * this file is only the timing, which is where adaptation goes wrong:
 *
 *   hold        a step-down trigger has to stay true for its own `forMs` (loss > 5% for 4 s,
 *               or > 15% for 2 s) before it fires. One bad sample is a hiccup.
 *   clean       a step-up needs EVERY clear condition true, continuously, for `cleanMs`
 *               (20–30 s). Any miss restarts the window.
 *   hysteresis  the clear thresholds sit well inside the trigger thresholds (down at 2% loss,
 *               up only under 0.5%), so a link sitting on one number does not thrash.
 *   cool-down   nothing moves within `cooldownMs` of the last move — except a trigger marked
 *               `severe`, because the step up that caused a collapse must be undone at once.
 *   one step    at most one rung per sample, whatever fired.
 *   oscillation `changes` moves inside `windowMs` means the ladder is pumping: no step-ups for
 *               `holdMs`, and only severe triggers may step down meanwhile.
 *   floor       a caller-imposed best level (a camera next to a share stays off its top rung);
 *               a level above the floor is moved down to it at once, outside every rule.
 *
 * A signal that is `undefined` is unknown and has no vote: it never fires a trigger and never
 * blocks a clean window (a distant route with no RTT reading yet must not be stuck low).
 *
 * Pure: no React, no livekit, no clock — `now` is passed in, so a synthetic stat stream
 * can be replayed in a test (adapt-governor.test.mts).
 */

export type Signals = Record<string, number | undefined>;

export type Trigger = {
  signal: string;
  /** Fires when the signal is >= this… */
  atLeast: number;
  /** …continuously for this long. */
  forMs: number;
  /** Bypasses cool-down and the oscillation hold. */
  severe?: boolean;
};

export type Clear = {
  signal: string;
  /** Satisfied when the signal is <= this (or >= `atLeast` instead, for headroom). */
  atMost?: number;
  atLeast?: number;
};

export type GovernorConfig = {
  /** Highest level index (the most degraded rung). */
  maxLevel: number;
  down: readonly Trigger[];
  up: readonly Clear[];
  cleanMs: number;
  cooldownMs: number;
  oscillation: { changes: number; windowMs: number; holdMs: number };
};

export type GovernorState = {
  level: number;
  /** When each trigger first became continuously true; null while false. */
  since: (number | null)[];
  cleanSince: number | null;
  lastChangeAt: number | null;
  changes: number[];
  holdUntil: number;
};

export type Decision = {
  from: number;
  to: number;
  direction: "down" | "up";
  /** Human-readable: "loss 6.2 >= 5 for 4s", "clean 20s", "floor", "oscillation hold". */
  reason: string;
};

export function initialGovernor(cfg: GovernorConfig, level = 0): GovernorState {
  return {
    level,
    since: cfg.down.map(() => null),
    cleanSince: null,
    lastChangeAt: null,
    changes: [],
    holdUntil: 0,
  };
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 2 : 1);
}

function clearHolds(c: Clear, v: number | undefined): boolean {
  if (v === undefined) return true;
  if (c.atMost !== undefined && v > c.atMost) return false;
  if (c.atLeast !== undefined && v < c.atLeast) return false;
  return true;
}

/**
 * One sample in, the next state out, plus the move it made (if any).
 *
 * `floor` is the best level allowed right now (0 = any). The state is not mutated.
 */
export function governorStep(
  cfg: GovernorConfig,
  prev: GovernorState,
  signals: Signals,
  now: number,
  floor = 0,
): { state: GovernorState; decision: Decision | null } {
  const state: GovernorState = {
    ...prev,
    since: cfg.down.map((t, i) => {
      const v = signals[t.signal];
      if (v === undefined || v < t.atLeast) return null;
      return prev.since[i] ?? now;
    }),
    changes: prev.changes.filter((at) => now - at < cfg.oscillation.windowMs),
  };

  const clean = cfg.up.every((c) => clearHolds(c, signals[c.signal]));
  state.cleanSince = clean ? (prev.cleanSince ?? now) : null;

  const move = (to: number, direction: Decision["direction"], reason: string) => {
    const decision: Decision = { from: state.level, to, direction, reason };
    state.level = to;
    state.lastChangeAt = now;
    state.since = state.since.map(() => null);
    state.cleanSince = null;
    state.changes = [...state.changes, now];
    if (state.changes.length >= cfg.oscillation.changes) {
      state.holdUntil = now + cfg.oscillation.holdMs;
      decision.reason += `; oscillation: ${state.changes.length} changes in ${Math.round(cfg.oscillation.windowMs / 1000)}s, holding ${Math.round(cfg.oscillation.holdMs / 1000)}s`;
    }
    return { state, decision };
  };

  // A floor is not a quality judgement, so it is not subject to any of the timing rules.
  const effectiveFloor = Math.min(Math.max(0, floor), cfg.maxLevel);
  if (state.level < effectiveFloor) {
    const decision: Decision = { from: state.level, to: effectiveFloor, direction: "down", reason: "floor" };
    state.level = effectiveFloor;
    state.lastChangeAt = now;
    state.cleanSince = null;
    return { state, decision };
  }

  const cooling = state.lastChangeAt !== null && now - state.lastChangeAt < cfg.cooldownMs;
  const holding = now < state.holdUntil;

  if (state.level < cfg.maxLevel) {
    for (let i = 0; i < cfg.down.length; i++) {
      const t = cfg.down[i];
      const since = state.since[i];
      if (since === null || now - since < t.forMs) continue;
      if ((cooling || holding) && !t.severe) continue;
      const v = signals[t.signal]!;
      return move(
        state.level + 1,
        "down",
        `${t.signal} ${fmt(v)} >= ${fmt(t.atLeast)} for ${Math.round((now - since) / 1000)}s${t.severe ? " (severe)" : ""}`,
      );
    }
  }

  if (
    state.level > effectiveFloor &&
    !cooling &&
    !holding &&
    state.cleanSince !== null &&
    now - state.cleanSince >= cfg.cleanMs
  ) {
    return move(state.level - 1, "up", `clean ${Math.round((now - state.cleanSince) / 1000)}s`);
  }

  return { state, decision: null };
}

/* ------------------------------------------------------------------ CPU signal */

/**
 * The share of the last window each sender's encoder spent CPU-limited, 0..1, max over every
 * outbound-rtp report handed in.
 *
 * qualityLimitationDurations is cumulative seconds per reason, so the window's share is the
 * delta of `cpu` over the delta of all reasons. Where a browser reports only the instantaneous
 * qualityLimitationReason, that sample counts as all-or-nothing. `previous` (keyed by report
 * id) is mutated: it is the window boundary.
 */
export function cpuLimitedShare(reports: readonly Record<string, unknown>[], previous: LimitWindow): number | undefined {
  return limitedShare(reports, previous, "cpu");
}

/** The same for "bandwidth": the encoder held under its target because the pacer / estimator
 *  had no room for it. The phone camera ladder's early signal (ADAPT.phoneCamera, 31 Oct 2026).
 *  Its own `previous`: one window map per reason. */
export function bandwidthLimitedShare(reports: readonly Record<string, unknown>[], previous: LimitWindow): number | undefined {
  return limitedShare(reports, previous, "bandwidth");
}

/** Seconds limited by the tracked reason, and by every reason, per outbound-rtp id. */
export type LimitWindow = Map<string, { limited: number; total: number }>;

function limitedShare(
  reports: readonly Record<string, unknown>[],
  previous: LimitWindow,
  reason: "cpu" | "bandwidth",
): number | undefined {
  let worst: number | undefined;
  for (const r of reports) {
    const id = typeof r.id === "string" ? r.id : String(r.ssrc ?? "");
    const d = r.qualityLimitationDurations as Record<string, number> | undefined;
    let share: number | undefined;
    if (d && typeof d === "object") {
      const limited = typeof d[reason] === "number" ? d[reason] : 0;
      const total = Object.values(d).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
      const before = previous.get(id);
      previous.set(id, { limited, total });
      if (before && total > before.total) share = Math.max(0, Math.min(1, (limited - before.limited) / (total - before.total)));
    } else if (typeof r.qualityLimitationReason === "string") {
      share = r.qualityLimitationReason === reason ? 1 : 0;
    }
    if (share !== undefined && (worst === undefined || share > worst)) worst = share;
  }
  return worst;
}

/* ------------------------------------------------------------------ decision log */

export type AdaptLogEntry = {
  ladder: string;
  from: string;
  to: string;
  direction: "down" | "up";
  reason: string;
  signals: Signals;
};

type Sink = (event: string, payload: Record<string, unknown>) => void;
let sink: Sink | null = null;
/* What was decided before telemetry was listening (the codec probe answers during the
 * pre-join screen). A few entries at most; the oldest go first. */
const early: [string, Record<string, unknown>][] = [];
const EARLY_MAX = 20;

/** telemetry.ts installs the real sink while a room is open (and telemetry is on). */
export function setAdaptSink(next: Sink | null): void {
  sink = next;
  if (!next) return;
  for (const [event, payload] of early.splice(0)) next(event, payload);
}

function emit(event: string, payload: Record<string, unknown>): void {
  if (sink) {
    sink(event, payload);
    return;
  }
  early.push([event, payload]);
  if (early.length > EARLY_MAX) early.shift();
}

/** Every move of every ladder goes through here, with its reason: telemetry "adapt_decision". */
export function logAdapt(entry: AdaptLogEntry): void {
  if (typeof console !== "undefined") {
    console.info(`[adapt] ${entry.ladder} ${entry.from} -> ${entry.to}: ${entry.reason}`);
  }
  emit("adapt_decision", { ...entry });
}

/** The AV1 gate's answer for a kind of track, with why: telemetry "codec_decision". */
export function logCodecDecision(kind: string, av1: boolean, reason: string): void {
  if (typeof console !== "undefined") console.info(`[codec] ${kind}: ${av1 ? "av1" : "default"} (${reason})`);
  emit("codec_decision", { kind, av1, reason });
}
