"use client";

import { useEffect, useState } from "react";
import { isDone } from "@/lib/survey";
import { markOffered, useAudienceSurvey, wasOffered } from "@/lib/use-audience-survey";
import { Spinner } from "../controls";
import { SurveyForm } from "./survey-form";

/* The survey on the way out: the "webinar has ended" screen, and the screen somebody sees
 * after pressing Leave early.
 *
 * The room is gone by now (or going), so there is no data channel to hear a launch on — this
 * reads the survey itself. The server already offers an "on end" survey to somebody leaving a
 * live room, so an early leaver is asked the same questions the room will be asked at the end.
 *
 * Offered once per launch per tab (see wasOffered), and answering is never required to leave. */

export function SessionSurvey({
  slug,
  joinKey,
  className = "",
}: {
  slug: string;
  joinKey?: string;
  className?: string;
}) {
  // The end-of-webinar launch and this read can race by a few milliseconds; one re-read
  // shortly after catches a survey that went live just as the room closed.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setRevision(1), 2500);
    return () => window.clearTimeout(t);
  }, []);
  const { data, replace } = useAudienceSurvey(slug, joinKey, revision, true);
  const [done, setDone] = useState(false);
  const showable = Boolean(data?.survey) && !isDone(data!);
  useEffect(() => {
    // Seen here, so the leave screen right after does not ask again.
    if (showable) markOffered(slug, data);
  }, [showable, slug, data]);

  if (done || !data?.survey || (isDone(data) && !data.mine.submitted)) return null;
  if (data.mine.submitted && !done) {
    // Answered in the room already: a quiet line, not the form again.
    return (
      <p className={`text-[12.5px] text-white/55 ${className}`}>Thanks for your feedback on this session.</p>
    );
  }

  return (
    <div
      className={`room-dark w-full max-w-[460px] rounded-2xl border border-line-2 bg-surface p-5 text-left shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] sm:p-6 ${className}`}
    >
      <SurveyForm
        survey={data.survey}
        mine={data.mine}
        slug={slug}
        joinKey={joinKey}
        onChange={(next) => {
          if (!next.mine.submitted) replace(next);
        }}
        onDone={() => setDone(true)}
      />
    </div>
  );
}

/* Leaving early. Rendered by the attendee gate in place of the room once somebody presses
 * Leave: if there is a survey they have not answered and have not already been offered on
 * the way out, they see it here with a clear way on; otherwise they go straight through. */
export function LeftSession({
  slug,
  joinKey,
  topic,
  onContinue,
}: {
  slug: string;
  joinKey?: string;
  topic: string;
  onContinue: () => void;
}) {
  const { data, loaded } = useAudienceSurvey(slug, joinKey, 0, true);
  const [decided, setDecided] = useState<"ask" | "skip" | null>(null);

  useEffect(() => {
    if (decided) return;
    // Never hold somebody at the door for a slow request.
    const t = window.setTimeout(() => setDecided("skip"), 3000);
    return () => window.clearTimeout(t);
  }, [decided]);

  // Decided once, during render, as soon as the read lands (React's pattern for state
  // derived from props); marking it offered is the effect that follows.
  if (!decided && loaded) {
    setDecided(Boolean(data?.survey) && !isDone(data!) && !wasOffered(slug, data) ? "ask" : "skip");
  }
  useEffect(() => {
    if (decided === "ask") markOffered(slug, data);
  }, [decided, slug, data]);

  useEffect(() => {
    if (decided === "skip") onContinue();
  }, [decided, onContinue]);

  if (decided !== "ask" || !data?.survey) {
    return (
      <main className="grid min-h-dvh place-items-center bg-stage">
        <Spinner className="size-6 text-white/60" />
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-stage p-4 sm:p-6">
      <div className="flex w-full max-w-[460px] flex-col items-center text-center">
        <h1 className="text-[18px] font-semibold text-white">You left the webinar</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-white/60">
          {topic ? <>Before you go — how was “{topic}”?</> : "Before you go — how was it?"}
        </p>
        <div className="room-dark mt-5 w-full rounded-2xl border border-line-2 bg-surface p-5 text-left shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] sm:p-6">
          <SurveyForm
            survey={data.survey}
            mine={data.mine}
            slug={slug}
            joinKey={joinKey}
            onLater={onContinue}
            laterLabel="Skip"
            onDone={onContinue}
          />
        </div>
        <button
          type="button"
          onClick={() => location.reload()}
          className="mt-4 text-[12.5px] font-medium text-white/60 underline-offset-4 hover:text-white hover:underline"
        >
          Rejoin the webinar
        </button>
      </div>
    </main>
  );
}
