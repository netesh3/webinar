"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { Poll } from "@/lib/api-types";
import { groupPolls, letterFor } from "@/lib/poll-view";
import { Alert, Spinner } from "../controls";
import { CheckIcon, PollIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";
import { KindPill, ResultRows, SectionLabel, StatePill } from "./poll-pieces";
import { LivePill, OptionChoice } from "./poll-popup";
import { HostPolls } from "./polls-host";

/* Polls and quizzes.
 *
 * A quiz is a poll with a right answer — same question, same options, same voting,
 * same tally — so there is one panel and one code path, and the difference is a flag.
 *
 * Two views of the same rows, and which one you get is the SERVER's decision:
 *
 *   the host     every question including the drafts, every tally, and the correct
 *                answer to every quiz. (polls-host.tsx)
 *   the audience the open poll and the closed ones, and a quiz answer only once
 *                voting has ended. Panelists are "the stage" to the server and are
 *                sent the tallies too, which is why this view draws bars whenever
 *                there are numbers in the response and never otherwise.
 *
 * That is why there are two endpoints rather than one with a flag on it. The answers
 * to a live quiz must not be sitting in five hundred browsers while the room is still
 * answering, and nothing in this file is trusted to hide them: they are not sent.
 *
 * Opening or closing a poll arrives as a bare nudge on the data channel and every
 * client re-reads its own view — see announcePolls in api/internal/api/polls.go.
 */

export function PollsPanel() {
  const { isHost } = useRoomUI();
  return isHost ? <HostPolls /> : <AudiencePolls />;
}

// ------------------------------------------------------------------ audience

/* What an attendee sees: the question, the options, and whether their answer is in.
 *
 * The list comes from the room rather than from a fetch of its own, so the pop-up and
 * this panel agree and there is one request. Nothing polls: with no tally to refresh,
 * the host's open/close announcement is the only thing that changes anything.
 */
function AudiencePolls() {
  const { controls, permissions, polls, me } = useRoomUI();

  const onStage = permissions.canPublish || me.role === "panelist";
  if (!controls.pollsEnabled && !onStage) {
    return (
      <Empty title="Polls are off">The host hasn&apos;t opened polls for this session.</Empty>
    );
  }
  if (polls.list === null) {
    return polls.error ? (
      <div className="space-y-2 px-3 py-4">
        <Alert tone="error">{polls.error}</Alert>
        <button
          type="button"
          onClick={polls.reload}
          className="inline-flex h-9 items-center rounded-lg border border-line-2 px-3 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          Try again
        </button>
      </div>
    ) : (
      <div className="grid flex-1 place-items-center">
        <Spinner className="size-5 text-ink-3" />
      </div>
    );
  }
  if (polls.list.length === 0) {
    return (
      <Empty title="No polls yet">
        When the host launches one it pops up on your screen, and it stays here too.
      </Empty>
    );
  }

  const { live, drafts, closed } = groupPolls(polls.list);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div className="space-y-2.5">
        {live.length > 0 && (
          <>
            <SectionLabel title="Live now" count={live.length} />
            {live.map((poll) =>
              poll.myChoice < 0 ? (
                <AnswerCard key={poll.id} poll={poll} />
              ) : (
                <OutcomeCard key={poll.id} poll={poll} />
              ),
            )}
          </>
        )}

        {drafts.length > 0 && (
          // Only the stage is sent drafts; an attendee never reaches this.
          <>
            <SectionLabel
              title="Drafts"
              count={drafts.length}
              spaced={live.length > 0}
              hint="Only the stage sees these"
            />
            {drafts.map((poll) => (
              <OutcomeCard key={poll.id} poll={poll} />
            ))}
          </>
        )}

        {closed.length > 0 && (
          <>
            <SectionLabel title="Earlier" count={closed.length} spaced={live.length + drafts.length > 0} />
            {closed.map((poll) => (
              <OutcomeCard key={poll.id} poll={poll} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** The open poll, not yet answered: the pop-up's card, in the panel. */
function AnswerCard({ poll }: { poll: Poll }) {
  const { slug, joinKey, polls } = useRoomUI();
  const { notify } = useToast();
  const [choice, setChoice] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const quiz = poll.kind === "quiz";

  async function vote() {
    if (choice === null || sending) return;
    setSending(true);
    setFailed(null);
    try {
      // The server's copy replaces ours, so what appears is what it actually recorded.
      polls.replace(await api.vote(slug, poll.id, { joinKey, choice }));
      notify("Your answer was recorded", "ok");
    } catch (err) {
      setFailed(err instanceof Error ? err.message : "Your answer didn't go through.");
    } finally {
      setSending(false);
    }
  }

  return (
    <article
      aria-label={`${quiz ? "Quiz" : "Poll"}: ${poll.question}`}
      className="overflow-hidden rounded-xl border border-brand-line bg-surface shadow-[0_0_0_1px_var(--color-brand-line)]"
    >
      <div
        aria-hidden
        className={`h-0.5 w-full bg-gradient-to-r ${
          quiz ? "from-warn via-warn/60 to-transparent" : "from-brand via-brand/60 to-transparent"
        }`}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void vote();
        }}
        className="px-3 pt-2.5 pb-3"
      >
        <LivePill quiz={quiz} />
        <p className="mt-2 text-[14px] leading-snug font-semibold break-words wrap-anywhere text-ink">
          {poll.question}
        </p>
        <p className="mt-0.5 text-[11.5px] text-ink-3">
          {quiz ? "Pick the answer you think is right" : "Choose one answer"}
        </p>

        {failed && (
          <div className="mt-2.5">
            <Alert tone="error">{failed}</Alert>
          </div>
        )}

        <div role="radiogroup" aria-label={poll.question} className="mt-2.5 space-y-1.5">
          {poll.options.map((option, i) => (
            <OptionChoice
              key={i}
              name={`panel-${poll.id}`}
              index={i}
              label={option}
              selected={choice === i}
              disabled={sending}
              onPick={() => setChoice(i)}
            />
          ))}
        </div>

        <button
          type="submit"
          disabled={choice === null || sending}
          className="mt-3 inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-[13px] font-semibold text-stage transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {sending && <Spinner className="size-3.5" />}
          {sending ? "Submitting…" : "Submit answer"}
        </button>
        <p className="mt-2 text-center text-[11px] text-ink-3">
          One answer each — you can&apos;t change it once it&apos;s in.
        </p>
      </form>
    </article>
  );
}

/* After voting, after a poll closes — or a draft, for the stage.
 *
 * The inputs are gone rather than disabled, because there is nothing left to choose:
 * one answer each, and theirs is in. Their own option is marked, a quiz's right
 * answer once the server reveals it, and bars only if numbers were sent.
 */
function OutcomeCard({ poll }: { poll: Poll }) {
  const open = poll.state === "open";
  const answered = poll.myChoice >= 0;
  const quiz = poll.kind === "quiz";
  const revealed = quiz && poll.correctOption >= 0 && poll.state === "closed";
  const right = revealed && answered && poll.correctOption === poll.myChoice;

  return (
    <article
      aria-label={`${quiz ? "Quiz" : "Poll"}: ${poll.question}`}
      className={`rounded-xl border px-3 py-2.5 ${
        open ? "border-brand-line bg-brand-soft/30" : "border-line bg-surface-2/40"
      }`}
    >
      <header className="flex min-w-0 items-center gap-1.5">
        <StatePill poll={poll} />
        <KindPill poll={poll} />
      </header>
      <p className="mt-1.5 text-[13px] leading-snug font-semibold break-words wrap-anywhere text-ink">
        {poll.question}
      </p>

      <div className="mt-2">
        <ResultRows poll={poll} showTally={poll.state !== "draft"} />
      </div>

      {open && answered && (
        <p className="mt-2 flex items-center gap-1.5 text-[11.5px] font-medium text-ok">
          <CheckIcon className="size-3.5 shrink-0" />
          Your answer is in.
          <span className="font-normal text-ink-3">
            {quiz ? "The right answer is revealed when voting closes." : "Results are shown by the host."}
          </span>
        </p>
      )}
      {revealed && answered && (
        <p
          className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] font-medium ${
            right ? "border-ok/25 bg-ok-soft text-ok" : "border-warn/25 bg-warn-soft text-warn"
          }`}
        >
          {right
            ? "You got it right."
            : `Not quite — the answer was ${letterFor(poll.correctOption)}, “${
                poll.options[poll.correctOption]
              }”.`}
        </p>
      )}
      {!open && !answered && poll.state === "closed" && (
        <p className="mt-2 text-[11px] text-ink-3">
          You didn&apos;t answer this one.
          {revealed && ` The answer was ${letterFor(poll.correctOption)}.`}
        </p>
      )}
    </article>
  );
}

function Empty({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="grid size-11 place-items-center rounded-2xl bg-surface-2 text-ink-3">
        <PollIcon className="size-5" />
      </span>
      <p className="mt-3 text-[13px] font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-[16rem] text-[12px] leading-relaxed text-ink-3">{children}</p>
    </div>
  );
}
