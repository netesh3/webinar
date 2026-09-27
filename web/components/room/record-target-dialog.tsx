"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  initialSelection,
  RECORD_TARGETS,
  type RecordAvailability,
  type RecordTarget,
} from "@/lib/record-target";
import { CloseIcon, CloudIcon, DeviceIcon, InfoIcon, RecordIcon } from "../icons";

/* "Where should this recording be saved?" — asked when Record is pressed and no
 * choice is remembered.
 *
 * Select-then-Start rather than start-on-select: the two targets behave very
 * differently (Local opens a screen picker and a save dialog straight away), so a
 * mis-tap on a card should not kick off a browser prompt. Arrow keys move between
 * the options (native radios), Enter starts, Escape cancels.
 *
 * Start is a real click, which matters for Local: getDisplayMedia and
 * showSaveFilePicker both need user activation, and onStart is called
 * synchronously from the submit so that chain is unbroken.
 *
 * Portalled to <body> because the control bar is a backdrop-filter surface, which
 * would otherwise become the containing block for `position: fixed`.
 */

export type RecordTargetDialogProps = {
  availability: RecordAvailability;
  initial: RecordTarget | null;
  /** Cloud retention; 0 = kept until deleted. */
  keepDays: number;
  /** Server-side (LiveKit Egress) cloud recording — nothing runs in this tab. */
  isEgress: boolean;
  onCancel: () => void;
  onStart: (target: RecordTarget, remember: boolean) => void;
};

export function RecordTargetDialog(props: RecordTargetDialogProps) {
  if (typeof document === "undefined") return null;
  return createPortal(<DialogBody {...props} />, document.body);
}

function DialogBody({
  availability,
  initial,
  keepDays,
  isEgress,
  onCancel,
  onStart,
}: RecordTargetDialogProps) {
  const [selected, setSelected] = useState<RecordTarget | null>(() =>
    initialSelection(initial, availability),
  );
  const [remember, setRemember] = useState(false);
  const card = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const descId = useId();
  const name = useId();

  // Escape cancels and Tab stays inside while it is up — aria-modal promises the
  // rest of the room is inert.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !card.current) return;
      const focusable = Array.from(
        card.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
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
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const radio = card.current?.querySelector<HTMLInputElement>('input[type="radio"]:checked');
    (radio ?? card.current)?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !availability[selected].available) return;
    onStart(selected, remember);
  };

  const copy: Record<RecordTarget, { title: string; lead: string; points: string[] }> = {
    cloud: {
      title: "Cloud",
      lead: "Saved to this webinar's Recordings tab. It's ready to watch, share or download shortly after you stop.",
      points: [
        keepDays > 0
          ? `Kept for ${keepDays} days — download a copy to keep it longer.`
          : "Kept until you delete it.",
        "Everyone in the room is shown that the session is being recorded.",
        isEgress
          ? "Recorded on the server — no extra load on this computer."
          : "Records the whole stage. Keep this tab open until you stop.",
      ],
    },
    local: {
      title: "This computer",
      lead: "Records the screen, window or tab you pick and writes it to a video file on this computer as it goes. Nothing is uploaded.",
      points: [
        "You'll choose what to capture, then where to save the file.",
        "Attendees aren't notified automatically — let them know you're recording.",
        "Keep this tab open until you stop, so the file is finished properly.",
      ],
    },
  };

  const selectedOk = selected !== null && availability[selected].available;

  return (
    <div
      className="room-dark fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-6"
      data-record-target-dialog
    >
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        aria-hidden
        onPointerDown={onCancel}
      />
      <form
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        onSubmit={submit}
        className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface text-ink shadow-2xl outline-none sm:max-w-[30rem] sm:rounded-2xl"
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-live/15 text-live" aria-hidden>
            <RecordIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-[15.5px] font-semibold leading-snug text-ink">
              Where should this recording be saved?
            </h2>
            <p id={descId} className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">
              Pick a destination, then start. You can stop from the control bar at any time.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="-mt-1 -mr-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <fieldset>
            <legend className="sr-only">Recording destination</legend>
            <div className="grid gap-2.5">
              {RECORD_TARGETS.map((target) => {
                const a = availability[target];
                const checked = selected === target;
                const c = copy[target];
                const Icon = target === "cloud" ? CloudIcon : DeviceIcon;
                const reasonId = `${name}-${target}-reason`;
                return (
                  <label
                    key={target}
                    data-target={target}
                    className={`group relative flex gap-3 rounded-xl border p-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand/50 ${
                      !a.available
                        ? "cursor-not-allowed border-line bg-surface opacity-60"
                        : checked
                          ? "cursor-pointer border-brand bg-brand-soft"
                          : "cursor-pointer border-line-2 bg-surface hover:border-ink-3/60 hover:bg-surface-2"
                    }`}
                  >
                    <input
                      type="radio"
                      name={name}
                      value={target}
                      checked={checked}
                      disabled={!a.available}
                      aria-describedby={a.available ? undefined : reasonId}
                      onChange={() => setSelected(target)}
                      className="sr-only"
                    />
                    <span
                      className={`grid size-9 shrink-0 place-items-center rounded-lg ${
                        target === "cloud" ? "bg-brand/15 text-brand" : "bg-ok/15 text-ok"
                      }`}
                      aria-hidden
                    >
                      <Icon className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[13.5px] font-semibold text-ink">{c.title}</span>
                        <span
                          aria-hidden
                          className={`grid size-4 shrink-0 place-items-center rounded-full border-2 transition-colors ${
                            checked && a.available ? "border-brand" : "border-line-2"
                          }`}
                        >
                          {checked && a.available && <span className="size-2 rounded-full bg-brand" />}
                        </span>
                      </span>
                      <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-2">{c.lead}</span>
                      {a.available ? (
                        <ul className="mt-2 space-y-1">
                          {c.points.map((p) => (
                            <li key={p} className="flex gap-2 text-[11.5px] leading-snug text-ink-3">
                              <span className="mt-[5px] size-1 shrink-0 rounded-full bg-ink-3/70" aria-hidden />
                              <span>{p}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <span
                          id={reasonId}
                          className="mt-2 flex items-start gap-1.5 rounded-md bg-warn-soft px-2 py-1.5 text-[11.5px] leading-snug text-warn"
                        >
                          <InfoIcon className="mt-px size-3.5 shrink-0" />
                          <span>
                            <span className="font-semibold">Unavailable.</span> {a.reason}
                          </span>
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="mt-3.5 flex cursor-pointer items-start gap-2.5 rounded-lg px-1 py-1">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 cursor-pointer rounded accent-[var(--color-brand)]"
            />
            <span className="min-w-0">
              <span className="block text-[12.5px] font-medium text-ink">Remember my choice</span>
              <span className="block text-[11.5px] leading-snug text-ink-3">
                Record will start right away next time. Change it from the arrow next to Record.
              </span>
            </span>
          </label>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3.5 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-line-2 px-4 text-[13.5px] font-medium text-ink outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!selectedOk}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-live px-4 text-[13.5px] font-semibold text-white outline-none transition-colors hover:bg-live/90 focus-visible:ring-2 focus-visible:ring-white/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="size-2.5 rounded-full bg-white" aria-hidden />
            {selected === "local" ? "Start recording on this computer" : "Start recording to Cloud"}
          </button>
        </div>
      </form>
    </div>
  );
}
