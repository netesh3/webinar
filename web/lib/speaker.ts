/* Who gets the green border.
 *
 * Exactly one participant at a time, or nobody. Separate from the layout on purpose: the
 * stage's order is decided by lib/layout.ts and never by audio, so highlighting somebody
 * changes a colour and moves nothing. That separation is the whole design — see the note on
 * `sortTiles`.
 *
 * The problem this solves is that voice activity is not a stable signal. A microphone crosses
 * the speaking threshold on a cough, on a chair moving, on the first consonant of a word and
 * again on the gap before the next one. Rendering that raw produces a border that strobes
 * between three people while one person talks, which is worse than no border at all: it draws
 * the eye to motion that carries no information.
 *
 * So the raw signal is held before it is believed. A new speaker has to stay the loudest for
 * SWITCH_MS before the border moves, and silence has to last CLEAR_MS before the border goes
 * out. Both thresholds are asymmetric on purpose, and the reason is in the constants.
 *
 * Pure and dependency-free so it can be tested against a clock we control. Timing logic that
 * can only be checked by watching a live call is timing logic nobody checks.
 */

/** What the border is on, plus the bookkeeping needed to decide when to move it. */
export type Highlight = {
  /** The identity currently wearing the border, or null for nobody. This is the only field
   *  anything outside this file should read. */
  readonly current: string | null;
  /** The most recent loudest-speaker reading, believed or not. */
  readonly candidate: string | null;
  /** When `candidate` first read this way, in ms on the same clock as `now`. */
  readonly changedAt: number;
};

export const NO_HIGHLIGHT: Highlight = { current: null, candidate: null, changedAt: 0 };

/* How long a new speaker must hold the floor before the border moves to them.
 *
 * 450 ms is about the length of a short word. Long enough that "mm", a cough and a knock on
 * the desk never take the border off the person actually presenting; short enough that a real
 * handover feels immediate — by the time somebody has said "so, the next slide" the border has
 * already moved.
 */
export const SWITCH_MS = 450;

/* And how long silence must last before the border goes out entirely.
 *
 * Deliberately much longer than SWITCH_MS. Speech is full of gaps: between sentences, while
 * changing slides, while thinking. Every one of those gaps drops the speaking flag, and a
 * symmetric threshold would make the border blink through a single paragraph. 1.5 s is longer
 * than the pauses inside continuous speech and shorter than a real handover.
 *
 * It clears rather than staying on the last speaker for ever, because a border left on
 * somebody who stopped talking two minutes ago is a lie about who is presenting.
 */
export const CLEAR_MS = 1_500;

/**
 * nextHighlight folds one reading of "who is loudest" into the state.
 *
 * `loudest` is the top of the SFU's active-speaker list, or null when nobody is speaking.
 * `now` is a millisecond clock; `Date.now()` is fine.
 *
 * The state machine is three lines of logic and one property worth stating plainly: a reading
 * that disagrees with the border only starts a timer, and any change in the reading — including
 * a change back to whoever already holds the border — restarts it. So somebody interjecting for
 * 200 ms and stopping leaves the border exactly where it was, with no pending move, which is
 * why one held threshold is enough and there is no queue of candidates to reason about.
 *
 * `current` is what the UI reads. `candidate` and `changedAt` are internal bookkeeping, and the
 * hook that drives this keeps the whole thing in a ref so that a reading which does not move
 * the border does not re-render anything at all.
 */
export function nextHighlight(state: Highlight, loudest: string | null, now: number): Highlight {
  // A different reading than last time: note it, restart the clock, decide nothing.
  if (loudest !== state.candidate) {
    return { current: state.current, candidate: loudest, changedAt: now };
  }

  // The same reading as last time, and it already agrees with the border.
  if (loudest === state.current) return state;

  // The same reading as last time and it disagrees — has it held long enough?
  const wait = loudest === null ? CLEAR_MS : SWITCH_MS;
  if (now - state.changedAt < wait) return state;

  return { current: loudest, candidate: loudest, changedAt: now };
}

/**
 * When to look again, in ms, or null if there is nothing pending.
 *
 * The readings arrive as events, and an event only fires when the SFU's list changes. That is
 * not enough on its own: "B has been loudest for 450 ms" is a fact about the passage of time,
 * not about a new event, so without a timer a handover would sit un-promoted until the next
 * unrelated change happened to wake us up. This says how long that timer should be — the
 * remaining wait, and never zero, so a caller cannot spin.
 */
export function pendingDelay(state: Highlight, now: number): number | null {
  if (state.candidate === state.current) return null;
  const wait = state.candidate === null ? CLEAR_MS : SWITCH_MS;
  const remaining = wait - (now - state.changedAt);
  return remaining > 0 ? remaining : 1;
}

/**
 * Whether this participant should be wearing the border.
 *
 * A function rather than an equality check at the call site so the rule stays in one place:
 * a screen share never lights up, however loudly its owner is talking. The share is content,
 * not a person, and ringing a slide deck every time the presenter speaks is exactly the
 * flicker this file exists to remove.
 */
export function isHighlighted(
  highlight: string | null,
  identity: string,
  isScreenShare: boolean,
): boolean {
  return !isScreenShare && highlight !== null && highlight === identity;
}
