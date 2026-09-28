"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import type { HostSurvey } from "@/lib/api-types";
import { Modal, Spinner } from "../controls";
import { ClipboardIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* The feedback survey from the host's side of the room.
 *
 * The flow this is built for, and the one the schedule form recommends: near the end the host
 * presses Send survey, it pops up in the middle of every attendee's screen (SurveyPopup), the
 * host watches the answers come in on a pill at the top of the stage, and ends from that pill
 * once enough are in. Ending without having sent it asks first, because a survey sent after
 * the tab is closed is a survey nobody answers.
 *
 * One read shared by the three places that show it — the pill, the End dialog and the Polls
 * panel's row — so they never disagree about whether it has gone out. */

interface HostSurveyApi {
  host: HostSurvey | null;
  busy: boolean;
  send: () => Promise<boolean>;
  close: () => Promise<boolean>;
}

const Ctx = createContext<HostSurveyApi | null>(null);

/** Null outside a host's room (attendees, the preview), so callers render nothing. */
export function useHostSurvey(): HostSurveyApi | null {
  return useContext(Ctx);
}

export function HostSurveyProvider({
  enabled,
  sample,
  children,
}: {
  enabled: boolean;
  /** Fixture state with no API behind it: the /preview/room design review. */
  sample?: HostSurvey;
  children: ReactNode;
}) {
  const { slug, realtime, previewChrome } = useRoomUI();
  const { notify } = useToast();
  const on = enabled && (!previewChrome || Boolean(sample));
  const [host, setHost] = useState<HostSurvey | null>(sample ?? null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(() => {
    api
      .hostSurvey(slug)
      .then(setHost)
      .catch(() => undefined);
  }, [slug]);

  useEffect(() => {
    if (on && !sample) read();
  }, [on, sample, read, realtime.surveyRevision]);

  // Answers do not announce themselves; while it is on screen the count is polled.
  const live = host?.survey?.status === "live";
  useEffect(() => {
    if (!on || !live || sample) return;
    const t = window.setInterval(read, 5000);
    return () => window.clearInterval(t);
  }, [on, live, read, sample]);

  const run = useCallback(
    async (action: "launch" | "close") => {
      if (sample) {
        setHost((h) => h && h.survey ? { ...h, survey: { ...h.survey, status: action === "launch" ? "live" : "closed" } } : h);
        return true;
      }
      setBusy(true);
      try {
        const next = action === "launch" ? await api.launchSurvey(slug) : await api.closeSurvey(slug);
        setHost((h) => ({ attended: h?.attended ?? 0, survey: next }));
        notify(action === "launch" ? "Survey is on everyone's screen" : "Survey closed", "ok");
        return true;
      } catch (e) {
        notify(e instanceof Error ? e.message : "That didn't work.", "error");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [slug, notify, sample],
  );

  const value = useMemo<HostSurveyApi | null>(
    () => (on ? { host, busy, send: () => run("launch"), close: () => run("close") } : null),
    [on, host, busy, run],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/* While the survey is on screen: how many have answered, and the two things a host does next
 * — end, or take it down and carry on. Sits at the top of the stage, clear of the talk. */
export function HostSurveyPill() {
  const s = useHostSurvey();
  const [ending, setEnding] = useState(false);
  const sv = s?.host?.survey;
  if (!s || !sv || sv.status !== "live") return null;

  const attended = Math.max(s.host?.attended ?? 0, sv.responses);
  const pct = attended > 0 ? Math.round((sv.responses / attended) * 100) : 0;

  return (
    <>
      <div className="pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-3">
        <div
          role="status"
          className="room-dark pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-ok/30 bg-surface/95 py-2 pr-2 pl-3 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.7)] backdrop-blur"
        >
          <span className="relative flex size-2.5 shrink-0">
            <span className="absolute inline-flex size-full rounded-full bg-ok opacity-60 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2.5 rounded-full bg-ok" />
          </span>
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-ink">Survey is on everyone&apos;s screen</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="h-1.5 w-28 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: `${pct}%` }} />
              </span>
              <span className="text-[11.5px] tabular-nums text-ink-2">
                {sv.responses} of {attended} answered
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void s.close()}
              disabled={s.busy}
              className="h-8 rounded-lg px-2.5 text-[12px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              Take it down
            </button>
            <button
              type="button"
              onClick={() => setEnding(true)}
              className="h-8 rounded-lg bg-live px-3 text-[12px] font-semibold text-white hover:bg-live/90 outline-none focus-visible:ring-2 focus-visible:ring-live/40"
            >
              End webinar
            </button>
          </div>
        </div>
      </div>
      <EndWebinarDialog open={ending} onClose={() => setEnding(false)} />
    </>
  );
}

/* The survey's one button in the control bar, beside Leave: visible without opening a panel
 * because it is the thing a host reaches for at the end. Shown only while there is a survey
 * that is not already on screen. */
export function SendSurveyButton({ disabled }: { disabled?: boolean }) {
  const s = useHostSurvey();
  const sv = s?.host?.survey;
  if (!s || !sv || sv.status !== "draft") return null;
  return (
    <button
      type="button"
      onClick={() => void s.send()}
      disabled={disabled || s.busy}
      title="Put the feedback survey on everyone's screen"
      aria-label="Send survey"
      className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-brand px-3 text-[13px] font-semibold text-white transition-colors hover:bg-brand/90 outline-none focus-visible:ring-2 focus-visible:ring-white/50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {s.busy ? <Spinner className="size-4" /> : <ClipboardIcon className="size-4" />}
      <span className="hidden sm:inline">Send survey</span>
    </button>
  );
}

/* Ending, with the survey in mind.
 *
 *   not sent yet   offer to send it first (the recommended path), or end without it — or,
 *                  when it is timed or set for the end, end and let it go out as it closes.
 *   on screen      say how many have answered; the rest can finish on the ended screen.
 *   none / closed  the plain confirmation. */
export function EndWebinarDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { slug, markEnding } = useRoomUI();
  const { notify } = useToast();
  const s = useHostSurvey();
  const [ending, setEnding] = useState(false);

  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setEnding(false);
  }

  const sv = s?.host?.survey;
  const state = !sv || sv.status === "closed" ? "none" : sv.status === "live" ? "live" : "unsent";
  const goesOutOnEnd = sv?.sendAt === "on_end" || sv?.sendAt === "at_minute";
  const busy = ending || Boolean(s?.busy);

  async function end() {
    setEnding(true);
    // Before the request: the server closes the room while it is still answering, and that
    // disconnect must read as the end rather than a drop to reconnect from.
    markEnding(true);
    try {
      await api.endWebinar(slug);
      onClose();
    } catch (err) {
      markEnding(false);
      notify(err instanceof Error ? err.message : "Could not end the webinar.", "error");
      setEnding(false);
    }
  }

  async function sendFirst() {
    if (await s?.send()) onClose();
  }

  const close = () => {
    if (!busy) onClose();
  };

  if (state === "unsent") {
    return (
      <Modal
        dark
        open={open}
        size="sm"
        onClose={close}
        title="Send the feedback survey first?"
        footer={
          <>
            <button
              type="button"
              onClick={() => void end()}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-line-2 px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
            >
              {ending && <Spinner className="size-3.5" />}
              {goesOutOnEnd ? "End now" : "End without survey"}
            </button>
            <button
              type="button"
              onClick={() => void sendFirst()}
              disabled={busy}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3.5 text-[13px] font-semibold text-white hover:bg-brand/90 disabled:opacity-50"
            >
              {s?.busy && <Spinner className="size-3.5" />}
              Send survey now
            </button>
          </>
        }
      >
        <div className="flex gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <ClipboardIcon className="size-[18px]" />
          </span>
          <div className="text-[13px] leading-relaxed text-ink-2">
            <p>
              People answer while they&apos;re still here. It pops up in the middle of everyone&apos;s screen and
              takes about 30 seconds — you&apos;ll see the answers come in, then end when you&apos;re ready.
            </p>
            {goesOutOnEnd && (
              <p className="mt-2 text-ink-3">
                If you end now it still pops up as the webinar closes, but some people will already have left.
              </p>
            )}
          </div>
        </div>
      </Modal>
    );
  }

  const answered = sv ? `${sv.responses} of ${Math.max(s?.host?.attended ?? 0, sv.responses)}` : "";
  return (
    <Modal
      dark
      open={open}
      size="sm"
      onClose={close}
      title="End this webinar for everyone?"
      footer={
        <>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            className="h-9 rounded-lg border border-line-2 px-3.5 text-[13px] font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
          >
            {state === "live" ? "Keep waiting" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={() => void end()}
            disabled={busy}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-live px-3.5 text-[13px] font-medium text-white hover:bg-live/90 disabled:opacity-50"
          >
            {ending && <Spinner className="size-3.5" />}
            End for everyone
          </button>
        </>
      }
    >
      {state === "live" && (
        <p className="mb-2.5 rounded-lg bg-ok-soft px-3 py-2 text-[13px] font-medium text-ok">
          {answered} have answered the survey.
        </p>
      )}
      <p className="text-[13.5px] leading-relaxed text-ink-2">
        {state === "live"
          ? "Anyone still answering can finish on the ended screen. Everyone is disconnected and nobody can rejoin."
          : "Everyone is disconnected and the webinar is marked as ended. Registrations and the attendance record are kept, but nobody can rejoin."}
      </p>
    </Modal>
  );
}
