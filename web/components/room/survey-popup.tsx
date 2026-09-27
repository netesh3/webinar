"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { AudienceSurvey } from "@/lib/api-types";
import { dismissalKey, surveyMoment } from "@/lib/survey";
import { SurveyForm } from "../survey/survey-form";
import { useToast } from "../providers";
import { usePortalHost } from "./poll-popup";

/* The post-event survey, brought to the attendee.
 *
 * The same contract as the poll pop-up (see poll-popup.tsx), because it is the same kind of
 * interruption: it appears once per launch, "Maybe later" and Escape put it away, and it never
 * nags. "Later" is real — somebody who puts it away is offered it again, once, on the way out
 * (the leave and ended screens, see SessionSurvey).
 *
 * Hosts and co-hosts never see it; the audience endpoint already hides it from the stage.
 * Portalled into whatever is fullscreen, for the same reason the poll pop-up is. */

export function SurveyPopup({
  slug,
  joinKey,
  survey,
  onChange,
  enabled,
}: {
  slug: string;
  joinKey?: string;
  survey: AudienceSurvey | null;
  onChange: (next: AudienceSurvey) => void;
  enabled: boolean;
}) {
  const host = usePortalHost();
  const { notify } = useToast();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [thanking, setThanking] = useState<AudienceSurvey | null>(null);

  const key = dismissalKey(survey?.survey);
  const moment = surveyMoment(survey, dismissed !== null && dismissed === key);
  // After a submit the server says "done" at once; the card stays for its thank-you.
  const showing = thanking ?? (moment === "popup" ? survey : null);

  if (!enabled || !host || !showing?.survey) return null;

  const close = () => {
    setThanking(null);
    setDismissed(key);
  };

  return createPortal(
    <SurveyDialog onClose={close} busy={false}>
      {(titleId) => (
        <SurveyForm
          key={key ?? "survey"}
          titleId={titleId}
          survey={showing.survey!}
          mine={showing.mine}
          slug={slug}
          joinKey={joinKey}
          onLater={close}
          onDone={close}
          onChange={(next) => {
            if (next.mine.submitted) {
              setThanking(showing);
              notify("Thanks — your feedback was sent", "ok");
            } else if (next.mine.linkClicked) {
              notify("Survey opened in a new tab", "ok");
            }
            onChange(next);
          }}
        />
      )}
    </SurveyDialog>,
    host,
  );
}

/** The centred card: scrim, focus in and back, Tab kept inside, Escape = close. */
export function SurveyDialog({
  onClose,
  busy,
  children,
}: {
  onClose: () => void;
  busy: boolean;
  children: (titleId: string) => React.ReactNode;
}) {
  const card = useRef<HTMLDivElement>(null);
  const titleId = "survey-dialog-title";
  useModalKeys(card, busy ? null : onClose);

  return (
    <div data-survey-popup className="room-dark fixed inset-0 z-[70] grid place-items-center p-3 sm:p-4">
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
        className="relative flex max-h-[calc(100dvh-1.5rem)] w-full max-w-[480px] flex-col overflow-hidden rounded-2xl border border-line-2 bg-surface shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] outline-none motion-safe:animate-[poll-card-in_240ms_cubic-bezier(0.2,0.9,0.3,1.15)]"
      >
        <div aria-hidden className="h-1 w-full shrink-0 bg-gradient-to-r from-brand via-brand/70 to-warn/40" />
        <div className="min-h-0 overflow-y-auto overscroll-contain p-5 sm:p-6">{children(titleId)}</div>
      </div>
    </div>
  );
}

function useModalKeys(card: RefObject<HTMLDivElement | null>, onClose: (() => void) | null) {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (e.key !== "Tab" || !card.current) return;
      const focusable = card.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [card]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    card.current?.focus();
    return () => {
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [card]);
}
