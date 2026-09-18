"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Poll } from "@/lib/api-types";
import { activePoll, playPollCue } from "@/lib/polls";
import { Alert, Spinner } from "../controls";
import { CheckIcon, CloseIcon, PollIcon } from "../icons";
import { useRoomUI } from "./context";

/* The poll that comes to you.
 *
 * When the host launches one, the server announces it on the data channel and this
 * appears — a slide-over on the stage, not a badge on a button nobody was looking at.
 * The point is that answering takes no navigation: a poll a presenter has to ask the
 * room to go and find is a poll half the room does not answer.
 *
 * Three rules keep it from becoming the thing people hate about pop-ups:
 *
 *   it appears once   Dismissing is remembered per poll for this session. The host
 *                     relaunching the same question brings it back, which is
 *                     deliberate — that is a second ask.
 *   it never nags     Answered polls do not reappear, and neither do closed ones.
 *   it is escapable   Escape and the close button both work, and the Polls panel still
 *                     has everything. Trapping somebody in a modal during a talk they
 *                     are trying to watch is worse than a missed vote.
 *
 * No tally, at any point. The audience is shown the question, the options, and — once
 * they have answered — that their answer was recorded. The numbers are the presenter's.
 * Nothing here filters them out either: they are not in the response.
 */

export function PollPopup() {
  const { isHost, controls, polls, permissions } = useRoomUI();
  // Dismissals are per poll id and last for this page: the host launching the same
  // question again is a fresh ask and should reach somebody who waved the first one
  // away.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // The poll whose "recorded" confirmation is still on screen. Kept after the vote so
  // the answer is acknowledged rather than the panel just vanishing.
  const [recorded, setRecorded] = useState<Poll | null>(null);

  const open = activePoll(polls.list);
  const showing = recorded ?? (open && !dismissed.has(open.id) ? open : null);

  const canSee = !isHost && !permissions.canPublish && controls.pollsEnabled;

  // One chime per poll, the moment it first has somebody to reach — not on every
  // render this effect happens to run. See lib/polls.ts for why this plays
  // unconditionally rather than behind chat's opt-in sound preference.
  const cuedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canSee || !open || dismissed.has(open.id) || cuedFor.current === open.id) return;
    cuedFor.current = open.id;
    playPollCue();
  }, [canSee, open, dismissed]);

  // The confirmation clears itself, quickly: it is three words and a checkmark, not
  // the question — there is nothing left to read past the first second. The Polls
  // panel keeps the answer if they want another look.
  useEffect(() => {
    if (!recorded) return;
    const timer = setTimeout(() => setRecorded(null), 1400);
    return () => clearTimeout(timer);
  }, [recorded]);

  // The host runs the polls from their own panel, where the tally is. A modal over
  // their own stage would be in the way of the thing they are presenting.
  if (!canSee || !showing) return null;

  return (
    <PollCard
      poll={showing}
      answered={recorded !== null}
      onClose={() => {
        if (recorded) setRecorded(null);
        else setDismissed((current) => new Set(current).add(showing.id));
      }}
      onVoted={(updated) => {
        polls.replace(updated);
        setRecorded(updated);
      }}
    />
  );
}

function PollCard({
  poll,
  answered,
  onClose,
  onVoted,
}: {
  poll: Poll;
  answered: boolean;
  onClose: () => void;
  onVoted: (poll: Poll) => void;
}) {
  const { slug, joinKey } = useRoomUI();
  const [choice, setChoice] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // Escape closes it. A modal during a live talk that cannot be escaped is a modal
  // that stops somebody watching the talk.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves in, so a keyboard user is not left tabbing through the room to reach
  // the thing that just appeared.
  useEffect(() => {
    card.current?.focus();
  }, []);

  async function submit() {
    if (choice === null || sending) return;
    setSending(true);
    setError(null);
    try {
      // The server's copy comes back, which is what the UI then trusts: whether the
      // vote counted is its answer, not ours.
      onVoted(await api.vote(slug, poll.id, { joinKey, choice }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your answer didn't go through.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      // Bottom-right on a desktop, a bottom sheet on a phone. Not centred and not
      // scrimmed: this is a session in progress and covering the speaker to ask a
      // question about the speaker is self-defeating.
      className="room-dark pointer-events-auto fixed inset-x-2 bottom-2 z-50 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[352px]"
      role="dialog"
      aria-modal="false"
      aria-label={answered ? "Your answer was recorded" : "A poll from the host"}
    >
      <div
        ref={card}
        tabIndex={-1}
        className="rounded-2xl border border-line bg-surface p-3.5 shadow-2xl outline-none"
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-brand-soft text-brand">
            {answered ? <CheckIcon className="size-3.5" /> : <PollIcon className="size-3.5" />}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
              {answered ? "Response recorded" : poll.kind === "quiz" ? "Quiz" : "Poll"}
            </p>
            <p className="mt-1 text-[13.5px] leading-snug font-medium break-words text-ink">
              {poll.question}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={answered ? "Dismiss" : "Close — you can answer from the Polls panel"}
            className="grid size-7 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>

        {answered ? (
          <div className="mt-2.5">
            {/* Their own answer, read back. The one number the audience gets is which
                option was theirs — the tally is the presenter's. */}
            <div className="flex items-center gap-1.5 rounded-lg border border-ok/30 bg-ok-soft px-2.5 py-2 text-[12.5px] font-medium text-ok">
              <CheckIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {poll.options[poll.myChoice] ?? "Your answer"}
              </span>
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
              Thanks — that&apos;s in. Results are shown by the host.
            </p>
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="mt-2.5"
          >
            {error && (
              <div className="mb-2">
                <Alert tone="error">{error}</Alert>
              </div>
            )}

            <div className="space-y-1.5">
              {poll.options.map((option, i) => (
                <label
                  key={i}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-[13px] text-ink transition-colors has-checked:border-brand has-checked:bg-brand-soft hover:bg-surface-2"
                >
                  <input
                    type="radio"
                    name={`popup-${poll.id}`}
                    className="size-3.5 accent-brand"
                    checked={choice === i}
                    disabled={sending}
                    onChange={() => setChoice(i)}
                  />
                  <span className="min-w-0 flex-1 break-words">{option}</span>
                </label>
              ))}
            </div>

            <button
              type="submit"
              disabled={choice === null || sending}
              className="mt-2.5 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-brand text-[13px] font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              {sending && <Spinner className="size-4" />}
              Submit
            </button>
            <p className="mt-1.5 text-center text-[11px] text-ink-3">
              One answer each. You can&apos;t change it once it&apos;s in.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
