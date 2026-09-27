"use client";

import { useState } from "react";
import type { Survey, SurveyInput, Webinar } from "@/lib/api-types";
import { cleanInput, emptyInput, previewSurvey, validateInput } from "@/lib/survey";
import { FIXTURE_HOST_SURVEY, FIXTURE_SURVEY_RESULTS } from "@/lib/survey-fixtures";
import { SurveyDialog } from "../room/survey-popup";
import { Card } from "../ui";
import { HostSurveyTab } from "./host-survey-tab";
import { SurveyBuilder } from "./survey-builder";
import { SurveyForm } from "./survey-form";

/* The survey's screens over fixture data, for design review and screenshots — the same
 * components the room and the host pages use, with no API behind them. See app/mock/survey. */

export type SampleView = "popup" | "link" | "thanks" | "setup" | "setup-link" | "results";

const RATING: Survey = { ...FIXTURE_HOST_SURVEY.survey!, responses: 0, locked: false };

const LINK: Survey = {
  ...RATING,
  mode: "link",
  title: "Tell us how we did",
  buttonLabel: "Open the 2-minute survey",
  externalUrl: "https://forms.gle/Wk3ExampleSurvey",
  askRating: true,
  questions: [],
};

const MINE = { submitted: false, linkClicked: false };

export function SampleSurvey({ view, webinar }: { view: SampleView; webinar: Webinar }) {
  if (view === "popup" || view === "link" || view === "thanks") {
    const survey = view === "link" ? LINK : RATING;
    return (
      <div className="room-dark relative min-h-dvh overflow-hidden bg-stage">
        <FakeRoom topic={webinar.topic} />
        <SurveyDialog onClose={() => undefined} busy={false}>
          {(titleId) => (
            <SurveyForm
              titleId={titleId}
              survey={survey}
              mine={MINE}
              slug={webinar.id}
              offline
              startThanked={view === "thanks"}
              onLater={() => undefined}
              onDone={() => undefined}
            />
          )}
        </SurveyDialog>
      </div>
    );
  }

  const host = FIXTURE_HOST_SURVEY;
  if (view === "setup" || view === "setup-link") {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5 sm:py-8">
        <SampleScheduleSurvey link={view === "setup-link"} />
      </main>
    );
  }
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5 sm:py-8">
      <HostSurveyTab webinar={webinar} sample={{ host, results: FIXTURE_SURVEY_RESULTS }} />
    </main>
  );
}

/** The schedule form's survey section on its own, over a fresh draft. */
function SampleScheduleSurvey({ link }: { link: boolean }) {
  const [draft, setDraft] = useState<SurveyInput>(() =>
    link ? { ...emptyInput(), mode: "link", externalUrl: "https://forms.gle/Wk3ExampleSurvey" } : emptyInput(),
  );
  return (
    <Card className="p-5">
      <h3 className="mb-4 text-[14px] font-semibold">Feedback survey</h3>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <SurveyBuilder value={draft} onChange={setDraft} errors={validateInput(draft)} locked={false} durationMin={60} />
        <div className="room-dark rounded-2xl border border-line-2 bg-surface p-5">
          <SurveyForm
            key={JSON.stringify(cleanInput(draft))}
            preview
            survey={previewSurvey(draft)}
            mine={MINE}
            slug="preview"
            onLater={() => undefined}
          />
        </div>
      </div>
    </Card>
  );
}

/** A still of the room behind the pop-up: a stage tile, a speaker, a control bar. */
function FakeRoom({ topic }: { topic: string }) {
  return (
    <div aria-hidden className="absolute inset-0 flex flex-col">
      <div className="flex h-12 items-center gap-3 px-4 text-[13px] text-white/80">
        <span className="rounded-full bg-live px-2 py-0.5 text-[10.5px] font-semibold tracking-wide text-white uppercase">
          Live
        </span>
        {topic}
      </div>
      <div className="grid flex-1 place-items-center p-6">
        <div className="grid aspect-video w-full max-w-4xl place-items-center rounded-2xl bg-gradient-to-br from-stage-tile to-stage-bar">
          <span className="grid size-24 place-items-center rounded-full bg-brand/70 text-[32px] font-semibold text-white">
            AK
          </span>
        </div>
      </div>
      <div className="mx-auto mb-4 flex h-14 w-fit items-center gap-2 rounded-2xl bg-stage-bar px-4">
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="size-10 rounded-full bg-white/10" />
        ))}
        <span className="h-10 w-20 rounded-full bg-live/80" />
      </div>
    </div>
  );
}
