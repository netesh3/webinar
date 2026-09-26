"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { Poll } from "@/lib/api-types";
import { activePoll, playPollCue } from "@/lib/polls";
import { keepDismissals, letterFor } from "@/lib/poll-view";
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
 *   it appears once   Dismissing is remembered for as long as that poll stays open.
 *                     The host closing it and relaunching it later brings it back,
 *                     which is deliberate — that is a second ask.
 *   it never nags     Answered polls do not reappear, and neither do closed ones. The
 *                     card goes the moment the answer is in; a toast confirms it.
 *   it is escapable   Escape, the close button and "Answer later" all work, and the
 *                     Polls panel still has everything. Trapping somebody in a modal
 *                     during a talk they are trying to watch is worse than a missed vote.
 *
 * No tally, at any point. The audience is shown the question and the options. The
 * numbers are the presenter's. Nothing here filters them out either: they are not in
 * the response.
 *
 * Portalled rather than rendered in place, for two reasons. `fixed` is only relative
 * to the viewport while no ancestor has a transform, filter or containment — true of
 * the room today and one CSS change away from not being. And when somebody is
 * watching fullscreen, only the fullscreen element is painted: a card anywhere else in
 * the document is invisible, so an attendee watching the broadcast full-screen would
 * never see the poll. The portal goes into whatever is fullscreen, or the body.
 */

export function PollPopup() {
  const { isHost, controls, me, polls } = useRoomUI();
  const { notify } = useToast();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const host = usePortalHost();

  const open = activePoll(polls.list);
  const openId = open?.id ?? null;

  // Dismissals last only as long as the poll they were for is the open one — see
  // keepDismissals. Adjusted during render (React's documented pattern for state
  // derived from props) so a relaunch never flashes the card closed for a frame.
  const [seenOpenId, setSeenOpenId] = useState<string | null>(openId);
  if (seenOpenId !== openId) {
    setSeenOpenId(openId);
    setDismissed((current) => keepDismissals(current, openId));
  }

  const showing = open && !dismissed.has(open.id) ? open : null;

  // isHost already covers a co-host (see webinar-room.tsx, where it is derived as
  // liveRole === "host" || isCoHost) — they launch polls from the host panel and
  // should not have it fight for their attention. Everyone else — attendees and
  // panelists — is exactly the audience this popup exists for. A panelist can vote
  // even while polls are switched off for the audience (the server's onStage rule in
  // api/internal/api/polls.go), so the control only gates attendees.
  const canSee = !isHost && (controls.pollsEnabled || me.role === "panelist");

  // One chime per launch, the moment it first has somebody to reach — not on every
  // render this effect happens to run. Reset once nothing is open, so a relaunch
  // chimes again. See lib/polls.ts for why this plays unconditionally rather than
  // behind chat's opt-in sound preference.
  const cuedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openId) {
      cuedFor.current = null;
      return;
    }
    if (!canSee || !showing || cuedFor.current === openId) return;
    cuedFor.current = openId;
    playPollCue();
  }, [canSee, openId, showing]);

  if (!canSee || !showing || !host) return null;

  return createPortal(
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
    />,
    host,
  );
}

/** document.body, or the element that is fullscreen right now. Null before mount. */
function usePortalHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const read = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      const full = doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
      setHost(full instanceof HTMLElement ? full : document.body);
    };
    read();
    document.addEventListener("fullscreenchange", read);
    document.addEventListener("webkitfullscreenchange", read);
    return () => {
      document.removeEventListener("fullscreenchange", read);
      document.removeEventListener("webkitfullscreenchange", read);
    };
  }, []);
  return host;
}

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
  // the thing that just appeared — and goes back where it was when the card goes.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
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
      data-poll-popup
      className="room-dark fixed inset-0 z-[70] grid place-items-center p-3 sm:p-4"
    >
      {/* The scrim does not dismiss on click: a stray click on the video should not
          throw away a half-picked answer. Close, Escape and "Answer later" do. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black/60 backdrop-blur-[3px] motion-safe:animate-[poll-scrim-in_180ms_ease-out]"
      />

      <div
        ref={card}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] outline-none motion-safe:animate-[poll-card-in_240ms_cubic-bezier(0.2,0.9,0.3,1.15)]"
      >
        {/* A thin brand edge, so the card reads as "from the host" at a glance. */}
        <div
          aria-hidden
          className={`h-1 w-full shrink-0 bg-gradient-to-r ${
            isQuiz ? "from-warn via-warn/70 to-warn/20" : "from-brand via-brand/70 to-brand/20"
          }`}
        />

        <div className="min-h-0 overflow-y-auto p-5 sm:p-6">
          <div className="flex items-center gap-2.5">
            <span
              className={`grid size-9 shrink-0 place-items-center rounded-xl ${
                isQuiz ? "bg-warn-soft text-warn" : "bg-brand-soft text-brand"
              }`}
            >
              <PollIcon className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <LivePill quiz={isQuiz} />
              <p className="mt-1 text-[12px] text-ink-3">The host is asking the room</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close — you can answer later from the Polls panel"
              className="grid size-9 shrink-0 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <CloseIcon className="size-4" />
            </button>
          </div>

          <h2
            id={titleId}
            className="mt-4 text-[17px] leading-snug font-semibold break-words wrap-anywhere text-ink sm:text-[18px]"
          >
            {poll.question}
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-3">
            {isQuiz ? "Pick the answer you think is right" : "Choose one answer"}
          </p>

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
              {poll.options.map((option, i) => (
                <OptionChoice
                  key={i}
                  name={`popup-${poll.id}`}
                  index={i}
                  label={option}
                  selected={choice === i}
                  disabled={sending}
                  onPick={() => setChoice(i)}
                  size="lg"
                />
              ))}
            </div>

            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="inline-flex h-11 items-center justify-center rounded-lg px-4 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:h-10"
              >
                Answer later
              </button>
              <button
                type="submit"
                disabled={choice === null || sending}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand text-[13.5px] font-semibold text-stage shadow-sm transition-colors hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 sm:h-10 sm:w-auto sm:flex-1"
              >
                {sending && <Spinner className="size-4" />}
                {sending ? "Submitting…" : "Submit answer"}
              </button>
            </div>
            <p className="mt-3 text-center text-[11.5px] leading-relaxed text-ink-3">
              One answer each — you can&apos;t change it once it&apos;s in.
              {isQuiz
                ? " The right answer is revealed when voting closes."
                : " Results are shown by the host."}
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ shared pieces

/* Shared with the Polls panel's answer card, so answering in the panel and answering
 * in the pop-up are visibly the same action. */

export function LivePill({ quiz }: { quiz: boolean }) {
  const tone = quiz ? "border-warn/30 bg-warn-soft text-warn" : "border-brand-line bg-brand-soft text-brand";
  const dot = quiz ? "bg-warn" : "bg-brand";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 text-[10.5px] leading-5 font-semibold tracking-[0.06em] uppercase ${tone}`}
    >
      <span className="relative flex size-1.5">
        <span className={`absolute inline-flex size-full rounded-full opacity-70 motion-safe:animate-ping ${dot}`} />
        <span className={`relative inline-flex size-1.5 rounded-full ${dot}`} />
      </span>
      {quiz ? "Live quiz" : "Live poll"}
    </span>
  );
}

export function OptionChoice({
  name,
  index,
  label,
  selected,
  disabled,
  onPick,
  size = "md",
}: {
  name: string;
  index: number;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
  size?: "md" | "lg";
}) {
  const lg = size === "lg";
  return (
    <label
      className={`group flex cursor-pointer items-center rounded-xl border transition-all has-focus-visible:ring-2 has-focus-visible:ring-brand/40 ${
        lg ? "min-h-12 gap-3 px-3 py-2.5 text-[13.5px]" : "min-h-11 gap-2.5 px-2.5 py-2 text-[13px] md:min-h-10"
      } ${
        selected
          ? "border-brand bg-brand-soft text-ink shadow-[0_0_0_1px_var(--color-brand)]"
          : "border-line text-ink hover:border-line-2 hover:bg-surface-2"
      } ${disabled ? "pointer-events-none opacity-70" : ""}`}
    >
      <input
        type="radio"
        name={name}
        className="sr-only"
        checked={selected}
        disabled={disabled}
        onChange={onPick}
      />
      <span
        aria-hidden
        className={`grid shrink-0 place-items-center rounded-lg font-semibold transition-colors ${
          lg ? "size-7 text-[12px]" : "size-6 text-[11px]"
        } ${selected ? "bg-brand text-stage" : "bg-surface-2 text-ink-2 group-hover:text-ink"}`}
      >
        {selected ? <CheckIcon className="size-3.5" /> : letterFor(index)}
      </span>
      <span className="min-w-0 flex-1 leading-snug break-words wrap-anywhere">{label}</span>
    </label>
  );
}
