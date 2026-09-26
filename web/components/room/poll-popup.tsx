"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Poll } from "@/lib/api-types";
import { activePoll, playPollCue } from "@/lib/polls";
import { Alert, Spinner } from "../controls";
import { useToast } from "../providers";
import { CheckIcon, CloseIcon, PollIcon } from "../icons";
import { useRoomUI } from "./context";

/* The poll that comes to you.
 *
 * When the host launches one, the server announces it on the data channel and this
 * appears — a centred card over the room, not a badge on a button nobody was looking
 * at. The point is that answering takes no navigation: a poll a presenter has to ask
 * the room to go and find is a poll half the room does not answer.
 *
 * Three rules keep it from becoming the thing people hate about pop-ups:
 *
 *   it appears once   Dismissing is remembered per poll for this session. The host
 *                     relaunching the same question brings it back, which is
 *                     deliberate — that is a second ask.
 *   it never nags     Answered polls do not reappear, and neither do closed ones. The
 *                     card goes the moment the answer is in; a toast confirms it.
 *   it is escapable   Escape, the close button and "Answer later" all work, and the
 *                     Polls panel still has everything. Trapping somebody in a modal
 *                     during a talk they are trying to watch is worse than a missed vote.
 *
 * No tally, at any point. The audience is shown the question and the options. The
 * numbers are the presenter's. Nothing here filters them out either: they are not in
 * the response.
 */

export function PollPopup() {
  const { isHost, controls, me, polls } = useRoomUI();
  const { notify } = useToast();
  // Dismissals are per poll id and last for this page: the host launching the same
  // question again is a fresh ask and should reach somebody who waved the first one
  // away.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const open = activePoll(polls.list);
  const showing = open && !dismissed.has(open.id) ? open : null;

  // isHost already covers a co-host (see webinar-room.tsx, where it is derived as
  // liveRole === "host" || isCoHost) — they launch polls from the host panel and
  // should not have it fight for their attention. Everyone else — attendees and
  // panelists — is exactly the audience this popup exists for. A panelist can vote
  // even while polls are switched off for the audience (the server's onStage rule in
  // api/internal/api/polls.go), so the control only gates attendees.
  const canSee = !isHost && (controls.pollsEnabled || me.role === "panelist");

  // One chime per poll, the moment it first has somebody to reach — not on every
  // render this effect happens to run. See lib/polls.ts for why this plays
  // unconditionally rather than behind chat's opt-in sound preference.
  const cuedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!canSee || !open || dismissed.has(open.id) || cuedFor.current === open.id) return;
    cuedFor.current = open.id;
    playPollCue();
  }, [canSee, open, dismissed]);

  if (!canSee || !showing) return null;

  return (
    <PollDialog
      // Keyed so a second poll arriving straight after the first starts with a clean
      // selection rather than inheriting the previous one's radio index.
      key={showing.id}
      poll={showing}
      onClose={() => setDismissed((current) => new Set(current).add(showing.id))}
      onVoted={(updated) => {
        // The server's copy replaces ours; with myChoice set, activePoll no longer
        // returns it, so the dialog unmounts on this same render.
        polls.replace(updated);
        notify("Your answer was recorded", "ok");
      }}
    />
  );
}

const LETTERS = "ABCDEFGHIJ";

function PollDialog({
  poll,
  onClose,
  onVoted,
}: {
  poll: Poll;
  onClose: () => void;
  onVoted: (poll: Poll) => void;
}) {
  const { slug, joinKey } = useRoomUI();
  const [choice, setChoice] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const isQuiz = poll.kind === "quiz";

  // Escape closes it, and Tab stays inside the card while it is up: aria-modal is a
  // promise to assistive tech that the rest of the page is inert.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !card.current) return;
      const focusable = card.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === card.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
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
    <div className="room-dark fixed inset-0 z-[55] grid place-items-center p-4">
      {/* The scrim does not dismiss on click: a stray click on the video should not
          throw away a half-picked answer. Close, Escape and "Answer later" do. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black/55 backdrop-blur-[3px] motion-safe:animate-[poll-scrim-in_180ms_ease-out]"
      />

      <div
        ref={card}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-[460px] overflow-hidden rounded-2xl border border-line bg-surface shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] outline-none motion-safe:animate-[poll-card-in_240ms_cubic-bezier(0.2,0.9,0.3,1.15)]"
      >
        {/* A thin brand edge, so the card reads as "from the host" at a glance. */}
        <div aria-hidden className="h-1 w-full bg-gradient-to-r from-brand via-brand/70 to-brand/30" />

        <div className="max-h-[calc(100dvh-2rem)] overflow-y-auto p-5 sm:p-6">
          <div className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
              <PollIcon className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.08em] text-brand uppercase">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full rounded-full bg-brand opacity-70 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
                </span>
                {isQuiz ? "Live quiz" : "Live poll"}
              </span>
              <p className="mt-1 text-[12px] text-ink-3">The host is asking the room</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close — you can answer later from the Polls panel"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <CloseIcon className="size-4" />
            </button>
          </div>

          <h2
            id={titleId}
            className="mt-4 text-[17px] leading-snug font-semibold break-words text-ink sm:text-[18px]"
          >
            {poll.question}
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-3">Choose one answer</p>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="mt-4"
          >
            {error && (
              <div className="mb-3">
                <Alert tone="error">{error}</Alert>
              </div>
            )}

            <div role="radiogroup" aria-labelledby={titleId} className="space-y-2">
              {poll.options.map((option, i) => {
                const selected = choice === i;
                return (
                  <label
                    key={i}
                    className={`group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-[13.5px] transition-all has-focus-visible:ring-2 has-focus-visible:ring-brand/40 ${
                      selected
                        ? "border-brand bg-brand-soft text-ink shadow-[0_0_0_1px_var(--color-brand)]"
                        : "border-line text-ink hover:border-ink-3/40 hover:bg-surface-2"
                    } ${sending ? "pointer-events-none opacity-70" : ""}`}
                  >
                    <input
                      type="radio"
                      name={`popup-${poll.id}`}
                      className="sr-only"
                      checked={selected}
                      disabled={sending}
                      onChange={() => setChoice(i)}
                    />
                    <span
                      aria-hidden
                      className={`grid size-7 shrink-0 place-items-center rounded-lg text-[12px] font-semibold transition-colors ${
                        selected
                          ? "bg-brand text-white"
                          : "bg-surface-2 text-ink-2 group-hover:text-ink"
                      }`}
                    >
                      {selected ? <CheckIcon className="size-3.5" /> : (LETTERS[i] ?? i + 1)}
                    </span>
                    <span className="min-w-0 flex-1 leading-snug break-words">{option}</span>
                  </label>
                );
              })}
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="inline-flex h-10 items-center justify-center rounded-lg px-4 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                Answer later
              </button>
              <button
                type="submit"
                disabled={choice === null || sending}
                className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-brand text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
              >
                {sending && <Spinner className="size-4" />}
                {sending ? "Submitting…" : "Submit answer"}
              </button>
            </div>
            <p className="mt-3 text-center text-[11.5px] text-ink-3">
              One answer each — you can&apos;t change it once it&apos;s in. Results are
              shown by the host.
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
