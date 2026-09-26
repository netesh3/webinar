import type { Poll, PollInput } from "./api-types";

/* What the Polls panel and the pop-up say about a poll, kept pure.
 *
 * Every rule here is one a live room cannot demonstrate on demand: a tally whose
 * rounded percentages add up to 99, a tie for the lead, a launch announced while the
 * previous read was still in the air, a quiz whose right answer sits after a blank
 * option. So they are tested (poll-view.test.mts) rather than remembered.
 */

export const MAX_OPTIONS = 10;
export const MAX_QUESTION = 300;
export const MAX_OPTION = 120;

/** The poll the audience should be answering right now, if there is one.
 *
 *  Open, and not already answered. A closed poll is history and an answered one is
 *  done, and re-presenting either as a modal would be a pop-up that will not go away. */
export function activePoll(list: Poll[] | null): Poll | null {
  return (list ?? []).find((p) => p.state === "open" && p.myChoice < 0) ?? null;
}

// ------------------------------------------------------------------- results

export type OptionResult = {
  index: number;
  label: string;
  count: number;
  /** Whole-number share of the votes. The rows add up to exactly 100 once anyone
   *  has voted — see sharesOf. */
  percent: number;
  /** Has the most votes. Every option in a tie leads; nobody leads at zero votes. */
  leading: boolean;
  correct: boolean;
  mine: boolean;
};

export type PollResults = {
  /** Whether the caller was sent a tally at all. The audience never is — the
   *  server zeroes it — so "no numbers" and "no votes yet" are different states. */
  hasTally: boolean;
  total: number;
  rows: OptionResult[];
};

export function pollResults(poll: Pick<Poll, "options" | "votes" | "correctOption" | "myChoice">): PollResults {
  const hasTally = poll.votes.length === poll.options.length && poll.options.length > 0;
  const counts = poll.options.map((_, i) => (hasTally ? Math.max(0, poll.votes[i] ?? 0) : 0));
  const total = counts.reduce((a, b) => a + b, 0);
  const shares = sharesOf(counts);
  const top = Math.max(0, ...counts);

  return {
    hasTally,
    total,
    rows: poll.options.map((label, i) => ({
      index: i,
      label,
      count: counts[i],
      percent: shares[i],
      leading: top > 0 && counts[i] === top,
      correct: poll.correctOption === i,
      mine: poll.myChoice === i,
    })),
  };
}

/** Whole percentages that sum to 100 (largest remainder).
 *
 *  Rounding each share on its own turns three equal thirds into 33/33/33 and a
 *  host reading the bars out loud says "ninety-nine percent of you". */
export function sharesOf(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return counts.map(() => 0);

  const exact = counts.map((c) => (c / total) * 100);
  const floors = exact.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);

  // Biggest fractional part first; ties go to the earlier option so the result is
  // stable from one refresh to the next.
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    if (counts[i] === 0) continue;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

// ------------------------------------------------------------------ grouping

export type PollGroups = { live: Poll[]; drafts: Poll[]; closed: Poll[] };

/** The host's list, by what can be done with each: the live one on top, then the
 *  drafts waiting to go, then the finished ones most recent first. */
export function groupPolls(list: Poll[]): PollGroups {
  const live = list.filter((p) => p.state === "open");
  const drafts = list.filter((p) => p.state === "draft");
  const closed = list
    .filter((p) => p.state !== "open" && p.state !== "draft")
    .slice()
    .sort((a, b) => stamp(b.closedAt ?? b.createdAt) - stamp(a.closedAt ?? a.createdAt));
  return { live, drafts, closed };
}

function stamp(at: string | undefined): number {
  const t = at ? Date.parse(at) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

// ------------------------------------------------------------------ composer

export type ComposerDraft = {
  question: string;
  options: string[];
  quiz: boolean;
  /** An index into `options` as typed — blanks included. */
  correct: number;
};

/** The body to send, or the sentence that says why it cannot be sent yet.
 *
 *  The correct answer is chosen against the rows as the host sees them, blanks
 *  included, and the server receives only the filled ones. So the index has to be
 *  re-counted: marking "C" in A / (blank) / C / D is index 2 on screen and index 1
 *  on the wire. Clamping it instead quietly made D the right answer. */
export function buildPollInput(
  draft: ComposerDraft,
): { ok: true; input: PollInput } | { ok: false; reason: string } {
  const question = draft.question.trim();
  const filled: string[] = [];
  let correct = -1;
  draft.options.forEach((o, i) => {
    const text = o.trim();
    if (!text) return;
    if (i === draft.correct) correct = filled.length;
    filled.push(text);
  });

  if (!question) return { ok: false, reason: "Write the question first." };
  if (question.length > MAX_QUESTION) {
    return { ok: false, reason: `Keep the question under ${MAX_QUESTION} characters.` };
  }
  if (filled.length < 2) return { ok: false, reason: "Add at least two options." };
  if (filled.length > MAX_OPTIONS) return { ok: false, reason: `At most ${MAX_OPTIONS} options.` };
  if (filled.some((o) => o.length > MAX_OPTION)) {
    return { ok: false, reason: `Keep each option under ${MAX_OPTION} characters.` };
  }
  const seen = new Set(filled.map((o) => o.toLowerCase()));
  if (seen.size !== filled.length) return { ok: false, reason: "Two options say the same thing." };
  if (draft.quiz && correct < 0) {
    return { ok: false, reason: "Mark the correct answer — it can't be a blank option." };
  }

  return {
    ok: true,
    input: {
      question,
      kind: draft.quiz ? "quiz" : "poll",
      options: filled,
      // Sent only for a quiz: the server refuses a correct answer on a poll.
      ...(draft.quiz ? { correctOption: correct } : {}),
    },
  };
}

/** Where the correct-answer mark goes when a row is removed: with the option it was
 *  on, not whichever one slid into its index. Removing the marked row itself falls
 *  back to the first. */
export function correctAfterRemove(correct: number, removed: number): number {
  if (correct > removed) return correct - 1;
  if (correct === removed) return 0;
  return correct;
}

/** A composer pre-filled from an existing poll, for Edit and Duplicate. */
export function draftFromPoll(poll: Pick<Poll, "question" | "options" | "kind" | "correctOption">): ComposerDraft {
  return {
    question: poll.question,
    options: poll.options.length >= 2 ? [...poll.options] : [...poll.options, "", ""].slice(0, 2),
    quiz: poll.kind === "quiz",
    correct: poll.correctOption >= 0 ? poll.correctOption : 0,
  };
}

// --------------------------------------------------------------- re-reading

/** Serialises reads without losing any.
 *
 *  The old guard was "if a read is in flight, ignore this one", which is correct for
 *  a timer tick and wrong for an announcement: a launch announced while an earlier
 *  read was still in the air was dropped, and that earlier read may have been
 *  answered from before the launch committed. The room then sat with no poll until
 *  the next announcement, which might be the host closing it.
 *
 *  Now a request that arrives mid-read is remembered, and exactly one more read runs
 *  when the current one settles — however many arrived — so the last word is always
 *  a read that started after the last request. */
export function coalescingReader(run: () => Promise<void>): {
  request: () => void;
  /** Whether a read is in the air. For tests. */
  busy: () => boolean;
} {
  let inFlight = false;
  let again = false;

  const start = () => {
    inFlight = true;
    again = false;
    let settled: Promise<void>;
    try {
      settled = Promise.resolve(run());
    } catch (err) {
      settled = Promise.reject(err);
    }
    settled
      .catch(() => {})
      .finally(() => {
        inFlight = false;
        if (again) start();
      });
  };

  return {
    request: () => {
      if (inFlight) {
        again = true;
        return;
      }
      start();
    },
    busy: () => inFlight,
  };
}

// ------------------------------------------------------------------- pop-up

/** Which dismissals still count.
 *
 *  "Answer later" is remembered for the poll that is up. Once that poll stops being
 *  the open one, the dismissal is dropped, so the host re-launching it later — a
 *  second, deliberate ask — reaches the people who waved the first one away. */
export function keepDismissals(dismissed: ReadonlySet<string>, openId: string | null): Set<string> {
  const next = new Set<string>();
  if (openId && dismissed.has(openId)) next.add(openId);
  return next;
}

export const LETTERS = "ABCDEFGHIJ";

export function letterFor(i: number): string {
  return LETTERS[i] ?? String(i + 1);
}
