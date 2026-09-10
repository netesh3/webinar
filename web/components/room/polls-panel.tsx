"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Poll, PollInput } from "@/lib/api-types";
import { Alert, Spinner, Toggle } from "../controls";
import { CheckIcon, PlusIcon, TrashIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* Polls and quizzes.
 *
 * A quiz is a poll with a right answer — same question, same options, same voting,
 * same tally — so there is one panel and one code path, and the difference is a flag.
 *
 * Two views of the same rows, and which one you get is the SERVER's decision:
 *
 *   the host     every question including the drafts, every tally, and the correct
 *                answer to every quiz.
 *   the audience the open poll and the closed ones, a tally only where the host
 *                shared it, and a quiz answer only once voting has ended.
 *
 * That is why there are two endpoints rather than one with a flag on it. The answers
 * to a live quiz must not be sitting in five hundred browsers while the room is still
 * answering, and nothing in this file is trusted to hide them: they are not sent.
 *
 * Opening or closing a poll arrives as a bare nudge on the data channel and every
 * client re-reads its own view — see announcePolls in api/internal/api/polls.go.
 * Votes are not broadcast, because five hundred people answering would be five
 * hundred packets to five hundred recipients; the host's copy re-reads on a timer
 * while a poll is open, which is one request per host.
 */

/** How often the host refreshes an open poll's tally. */
const TALLY_POLL_MS = 4000;
const MAX_OPTIONS = 10;
const MAX_QUESTION = 300;
const MAX_OPTION = 120;

export function PollsPanel() {
  const { isHost } = useRoomUI();
  return isHost ? <HostPolls /> : <AudiencePolls />;
}

/** Reads the polls this caller is entitled to see, and re-reads on the room's nudge.
 *
 *  `refresh` is bumped by the realtime layer when the host opens or closes one, which
 *  is what makes a poll appear in five hundred browsers at once without any of them
 *  polling for it. The timer on top of that is only for the tally of an open poll. */
function usePolls(load: () => Promise<Poll[]>, live: boolean) {
  const [polls, setPolls] = useState<Poll[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { realtime } = useRoomUI();
  // Guards against a slow response overlapping the next tick.
  const inFlight = useRef(false);

  const read = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    load()
      .then((rows) => {
        setPolls(rows);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not load the polls."),
      )
      .finally(() => {
        inFlight.current = false;
      });
  }, [load]);

  // realtime.pollsRevision changes when the server announces a change.
  useEffect(read, [read, realtime.pollsRevision]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(read, TALLY_POLL_MS);
    return () => clearInterval(timer);
  }, [live, read]);

  return { polls, error, reload: read, setPolls };
}

// ------------------------------------------------------------------ audience

/* What an attendee sees: the question, the options, and whether their answer is in.
 *
 * No counts, no percentages, not even how many people have answered. That is not a
 * filter applied here — the server does not send them. A visible tally makes the
 * answers stop being independent, because whoever has not voted yet can see which way
 * the room is going.
 *
 * The list comes from the room rather than from a fetch of its own, so the pop-up and
 * this panel agree and there is one request. Nothing polls: with no tally to refresh,
 * the host's open/close announcement is the only thing that changes anything.
 */
function AudiencePolls() {
  const { controls, permissions, polls } = useRoomUI();
  const [voting, setVoting] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const { slug, joinKey } = useRoomUI();

  async function vote(poll: Poll) {
    const choice = picked[poll.id];
    if (choice === undefined || voting) return;
    setVoting(poll.id);
    setFailed(null);
    try {
      // The server's copy replaces ours, so what appears is what it actually recorded.
      polls.replace(await api.vote(slug, poll.id, { joinKey, choice }));
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Your answer didn't go through.");
    } finally {
      setVoting(null);
    }
  }

  if (!controls.pollsEnabled && !permissions.canPublish) {
    return <Empty>The host hasn&apos;t opened polls for this session.</Empty>;
  }
  if (polls.list === null) {
    return (
      <div className="grid flex-1 place-items-center">
        <Spinner className="size-5 text-ink-3" />
      </div>
    );
  }
  if (polls.list.length === 0) {
    return <Empty>No polls yet. One will appear here when the host opens it.</Empty>;
  }

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {failed && <Alert tone="error">{failed}</Alert>}

      {polls.list.map((poll) => {
        const answered = poll.myChoice >= 0;
        const open = poll.state === "open";

        return (
          <article key={poll.id} className="rounded-xl border border-line p-3">
            <PollHeading poll={poll} />

            {open && !answered ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void vote(poll);
                }}
                className="mt-2.5 space-y-1.5"
              >
                {poll.options.map((option, i) => (
                  <label
                    key={i}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-[13px] text-ink transition-colors has-checked:border-brand has-checked:bg-brand-soft hover:bg-surface-2"
                  >
                    <input
                      type="radio"
                      name={poll.id}
                      className="size-3.5 accent-brand"
                      checked={picked[poll.id] === i}
                      disabled={voting === poll.id}
                      onChange={() => setPicked((c) => ({ ...c, [poll.id]: i }))}
                    />
                    <span className="min-w-0 flex-1 break-words">{option}</span>
                  </label>
                ))}
                <button
                  type="submit"
                  disabled={picked[poll.id] === undefined || voting === poll.id}
                  className="mt-1 inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  {voting === poll.id && <Spinner className="size-3.5" />}
                  Submit
                </button>
              </form>
            ) : (
              <AudienceOutcome poll={poll} answered={answered} />
            )}
          </article>
        );
      })}
    </div>
  );
}

/* After voting, or after a poll closes.
 *
 * The inputs are gone rather than disabled, because there is nothing left to choose:
 * one answer each, and theirs is in. Their own option is read back — the single number
 * the audience is given is which one was theirs.
 */
function AudienceOutcome({ poll, answered }: { poll: Poll; answered: boolean }) {
  return (
    <div className="mt-2.5 space-y-1.5">
      {answered ? (
        <div className="flex items-center gap-1.5 rounded-lg border border-ok/30 bg-ok-soft px-2.5 py-2 text-[12.5px] font-medium text-ok">
          <CheckIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {poll.options[poll.myChoice] ?? "Your answer"}
          </span>
          <span className="shrink-0 text-[11px] font-normal">Recorded</span>
        </div>
      ) : (
        // Closed without answering. The options are still worth showing — the question
        // was asked, and a quiz answer below tells them what it was.
        poll.options.map((option, i) => (
          <div
            key={i}
            className={`rounded-lg border px-2.5 py-1.5 text-[12.5px] ${
              poll.correctOption === i
                ? "border-ok/40 bg-ok-soft font-medium text-ok"
                : "border-line text-ink-2"
            }`}
          >
            <span className="flex items-center gap-1.5">
              {poll.correctOption === i && <CheckIcon className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1 break-words">{option}</span>
            </span>
          </div>
        ))
      )}

      {/* A quiz says whether they were right — that is what a quiz is for, and by the
          time it is closed there is no answer left to influence. */}
      {answered && poll.kind === "quiz" && poll.correctOption >= 0 && (
        <p
          className={`pt-0.5 text-[11.5px] font-medium ${
            poll.correctOption === poll.myChoice ? "text-ok" : "text-warn"
          }`}
        >
          {poll.correctOption === poll.myChoice
            ? "Correct."
            : `The answer was “${poll.options[poll.correctOption]}”.`}
        </p>
      )}
      {poll.kind === "quiz" && poll.state === "open" && poll.correctOption < 0 && (
        <p className="pt-0.5 text-[11.5px] text-ink-3">
          The correct answer is revealed when the host closes voting.
        </p>
      )}
      {poll.state === "open" && answered && (
        <p className="pt-0.5 text-[11.5px] text-ink-3">
          Voting is still open. Results are shown by the host.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------- host

function HostPolls() {
  const { slug } = useRoomUI();
  const { notify } = useToast();
  const load = useCallback(() => api.hostPolls(slug), [slug]);
  const { polls, error, reload } = usePolls(load, true);
  const [busy, setBusy] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const act = useCallback(
    async (id: string, label: string, run: () => Promise<unknown>) => {
      setBusy(id);
      setFailed(null);
      try {
        await run();
        notify(label, "ok");
        reload();
      } catch (err) {
        setFailed(err instanceof Error ? err.message : "That didn't work.");
      } finally {
        setBusy(null);
      }
    },
    [notify, reload],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {error && <Alert tone="error">{error}</Alert>}
        {failed && <Alert tone="error">{failed}</Alert>}

        {polls === null && !error ? (
          <div className="grid place-items-center py-10">
            <Spinner className="size-5 text-ink-3" />
          </div>
        ) : (polls ?? []).length === 0 && !composing ? (
          <p className="py-6 text-center text-[12.5px] leading-relaxed text-ink-3">
            No polls yet.
            <br />
            Write one now and launch it when you&apos;re ready.
          </p>
        ) : (
          (polls ?? []).map((poll) => (
            <article
              key={poll.id}
              className={`rounded-xl border p-3 ${
                poll.state === "open" ? "border-brand-line bg-brand-soft/40" : "border-line"
              }`}
            >
              <PollHeading poll={poll} />
              <Results poll={poll} showTally />

              <div className="mt-2.5 flex items-center gap-1.5">
                {poll.state === "open" ? (
                  <HostAction
                    busy={busy === poll.id}
                    onClick={() =>
                      void act(poll.id, "Voting closed.", () => api.closePoll(slug, poll.id))
                    }
                  >
                    Close voting
                  </HostAction>
                ) : (
                  <HostAction
                    primary
                    busy={busy === poll.id}
                    onClick={() =>
                      void act(
                        poll.id,
                        poll.state === "closed" ? "Reopened." : "Launched — the room can answer now.",
                        () => api.openPoll(slug, poll.id),
                      )
                    }
                  >
                    {poll.state === "closed" ? "Reopen" : "Launch"}
                  </HostAction>
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(poll.id, "Poll deleted.", () => api.deletePoll(slug, poll.id))
                  }
                  aria-label="Delete this poll"
                  title="Delete"
                  className="grid size-7 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-live disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            </article>
          ))
        )}

        {composing && (
          <Composer
            slug={slug}
            onDone={() => {
              setComposing(false);
              reload();
            }}
            onCancel={() => setComposing(false)}
          />
        )}
      </div>

      {!composing && (
        <div className="shrink-0 border-t border-line p-2.5">
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-[13px] font-medium text-white transition-colors hover:bg-brand-hover outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <PlusIcon className="size-4" />
            New poll or quiz
          </button>
        </div>
      )}
    </div>
  );
}

/** The host writing a question.
 *
 *  Two options to start, because a poll with one is not a poll. The correct-answer
 *  picker appears only for a quiz, and it is required — a quiz with no right answer
 *  marks every response wrong, which the server refuses for the same reason. */
function Composer({
  slug,
  onDone,
  onCancel,
}: {
  slug: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [quiz, setQuiz] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = options.map((o) => o.trim()).filter(Boolean);
  const ready = question.trim() !== "" && filled.length >= 2;

  async function save() {
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const body: PollInput = {
        question: question.trim(),
        kind: quiz ? "quiz" : "poll",
        options: filled,
        // Sent only for a quiz: the server refuses a correct answer on a poll,
        // because a poll with a right answer is a quiz that will not admit it.
        ...(quiz ? { correctOption: Math.min(correct, filled.length - 1) } : {}),
      };
      await api.createPoll(slug, body);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="space-y-2.5 rounded-xl border border-brand-line p-3"
    >
      {error && <Alert tone="error">{error}</Alert>}

      <input
        className="field h-9 text-[13px]"
        placeholder="Your question"
        maxLength={MAX_QUESTION}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        aria-label="Question"
        autoFocus
      />

      <div className="space-y-1.5">
        {options.map((option, i) => (
          <div key={i} className="flex items-center gap-1.5">
            {quiz && (
              <input
                type="radio"
                name="correct"
                className="size-3.5 shrink-0 accent-ok"
                checked={correct === i}
                onChange={() => setCorrect(i)}
                aria-label={`Option ${i + 1} is the correct answer`}
                title="Correct answer"
              />
            )}
            <input
              className="field h-8 flex-1 text-[12.5px]"
              placeholder={`Option ${i + 1}`}
              maxLength={MAX_OPTION}
              value={option}
              onChange={(e) =>
                setOptions((c) => c.map((v, j) => (j === i ? e.target.value : v)))
              }
              aria-label={`Option ${i + 1}`}
            />
            {options.length > 2 && (
              <button
                type="button"
                onClick={() => {
                  setOptions((c) => c.filter((_, j) => j !== i));
                  // Keep the correct answer pointing at the same option, not the
                  // one that slid into its index.
                  setCorrect((c) => (c > i ? c - 1 : c === i ? 0 : c));
                }}
                aria-label={`Remove option ${i + 1}`}
                className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-live outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                <TrashIcon className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        {options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => setOptions((c) => [...c, ""])}
            className="inline-flex items-center gap-1 text-[12px] font-medium text-brand transition-colors hover:text-brand-hover"
          >
            <PlusIcon className="size-3" />
            Add option
          </button>
        )}
      </div>

      <div className="rounded-lg border border-line-2 p-1.5">
        <Toggle
          checked={quiz}
          onChange={setQuiz}
          label="Quiz"
          description="One option is the right answer. Attendees see whether they were right once you close voting."
        />
      </div>
      <p className="text-[11.5px] leading-relaxed text-ink-3">
        Attendees see the question and the options only. The counts are yours — they
        never reach the audience, so nobody can see which way the room is going before
        they answer.
      </p>

      <div className="flex items-center gap-1.5">
        <button
          type="submit"
          disabled={!ready || saving}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-[12.5px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {saving && <Spinner className="size-3.5" />}
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-lg px-3 text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// --------------------------------------------------------------------- pieces

function PollHeading({ poll }: { poll: Poll }) {
  const badge =
    poll.state === "open"
      ? { text: "Open", tone: "bg-ok-soft text-ok" }
      : poll.state === "draft"
        ? { text: "Draft", tone: "bg-surface-2 text-ink-2" }
        : { text: "Closed", tone: "bg-surface-2 text-ink-3" };

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${badge.tone}`}
        >
          {badge.text}
        </span>
        {poll.kind === "quiz" && (
          <span className="shrink-0 rounded bg-warn-soft px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warn uppercase">
            Quiz
          </span>
        )}
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-3">
          {poll.totalVotes} {poll.totalVotes === 1 ? "vote" : "votes"}
        </span>
      </div>
      <p className="mt-1.5 text-[13px] leading-snug font-medium break-words text-ink">
        {poll.question}
      </p>
    </div>
  );
}

/** The tally, or the options with no numbers when the caller may not see it. */
function Results({ poll, showTally }: { poll: Poll; showTally: boolean }) {
  const total = poll.votes.reduce((a, b) => a + b, 0);

  return (
    <div className="mt-2.5 space-y-1.5">
      {poll.options.map((option, i) => {
        const count = poll.votes[i] ?? 0;
        const share = total > 0 ? Math.round((count / total) * 100) : 0;
        const isCorrect = poll.correctOption === i;
        const isMine = poll.myChoice === i;

        return (
          <div key={i} className="relative overflow-hidden rounded-lg border border-line">
            {showTally && (
              // The bar is behind the label rather than beside it, so a long option
              // is not squeezed into half the width.
              <div
                className={`absolute inset-y-0 left-0 ${isCorrect ? "bg-ok/20" : "bg-brand/15"}`}
                style={{ width: `${share}%` }}
                aria-hidden
              />
            )}
            <div className="relative flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px]">
              {isCorrect && <CheckIcon className="size-3.5 shrink-0 text-ok" />}
              <span
                className={`min-w-0 flex-1 break-words ${
                  isCorrect ? "font-medium text-ok" : "text-ink"
                }`}
              >
                {option}
              </span>
              {isMine && (
                <span className="shrink-0 text-[10.5px] font-medium text-brand">
                  Your answer
                </span>
              )}
              {showTally && (
                <span className="shrink-0 tabular-nums text-ink-2">{share}%</span>
              )}
            </div>
          </div>
        );
      })}

      {/* Said plainly rather than left as an absence, so nobody wonders whether the
          numbers failed to load. */}
      {!showTally && poll.state === "open" && (
        <p className="pt-0.5 text-[11.5px] text-ink-3">
          {poll.myChoice >= 0
            ? "Your answer is in. The host decides whether to share the results."
            : "Results aren't shared for this one."}
        </p>
      )}
      {poll.kind === "quiz" && poll.state === "open" && poll.correctOption < 0 && (
        <p className="pt-0.5 text-[11.5px] text-ink-3">
          The correct answer is revealed when voting closes.
        </p>
      )}
    </div>
  );
}

function HostAction({
  children,
  onClick,
  busy,
  primary = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
        primary
          ? "bg-brand text-white hover:bg-brand-hover"
          : "border border-line-2 text-ink-2 hover:bg-surface-2"
      }`}
    >
      {busy && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-10 text-center text-[12.5px] leading-relaxed text-ink-3">
      {children}
    </p>
  );
}
