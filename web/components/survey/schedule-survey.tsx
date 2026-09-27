"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ApiError, api } from "@/lib/api";
import type { Survey, SurveyInput, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { cleanInput, emptyInput, previewSurvey, sendSummary, toInput, validateInput } from "@/lib/survey";
import { Spinner, Toggle } from "../controls";
import { SurveyBuilder } from "./survey-builder";
import { SurveyForm } from "./survey-form";

/* The feedback survey, set up where the rest of the webinar is: in the schedule form.
 *
 * A survey is part of planning a session, like its agenda or reminders, so it is built here
 * rather than on a tab the host has to remember to visit. It needs the webinar's slug, so it
 * is written right after the webinar itself saves (see persist); a failure there is a toast,
 * not a lost webinar.
 *
 * New webinars start with it on, sent the recommended way. An existing webinar shows what it
 * has; one without a survey starts with it off, so opening Edit never adds one silently. */

type Load = "loading" | "ready" | "error";

export interface ScheduleSurvey {
  node: ReactNode;
  /** Why the form should not submit yet, or null. */
  problem: () => string | null;
  /** Writes (or removes) the survey for a saved webinar. Resolves to a warning, or null. */
  persist: (slug: string) => Promise<string | null>;
  on: boolean;
}

export function useScheduleSurvey(webinar: Webinar | null, durationMin: number): ScheduleSurvey {
  const editing = webinar !== null;
  const bypass = isDevAuthBypassActive();
  const [load, setLoad] = useState<Load>(editing && !bypass ? "loading" : "ready");
  const [saved, setSaved] = useState<Survey | null>(null);
  const [on, setOn] = useState(!editing || (bypass && Boolean(webinar?.options.postWebinarSurvey)));
  const [draft, setDraft] = useState<SurveyInput>(emptyInput);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});

  const slug = webinar?.id;
  useEffect(() => {
    if (!slug || bypass) return;
    let live = true;
    api
      .hostSurvey(slug)
      .then((h) => {
        if (!live) return;
        setSaved(h.survey ?? null);
        setOn(Boolean(h.survey));
        if (h.survey) setDraft(toInput(h.survey));
        setLoad("ready");
      })
      .catch(() => {
        if (live) setLoad("error");
      });
    return () => {
      live = false;
    };
  }, [slug, bypass]);

  const errors = useMemo(
    () => (on ? { ...validateInput(draft), ...serverErrors } : {}),
    [on, draft, serverErrors],
  );
  const locked = Boolean(saved?.locked);

  function problem(): string | null {
    if (!on || load !== "ready") return null;
    return Object.keys(validateInput(draft)).length > 0
      ? "The feedback survey needs a fix before this can be saved — see the highlighted field."
      : null;
  }

  async function persist(target: string): Promise<string | null> {
    // Never guess: if the current survey could not be read, leave it exactly as it is.
    if (load !== "ready" || bypass) return null;
    try {
      if (on) {
        const body = cleanInput(draft);
        if (saved && JSON.stringify(body) === JSON.stringify(cleanInput(toInput(saved)))) return null;
        const sv = await api.saveSurvey(target, body);
        setSaved(sv);
        setDraft(toInput(sv));
      } else if (saved && !locked) {
        await api.deleteSurvey(target);
        setSaved(null);
      }
      return null;
    } catch (e) {
      if (e instanceof ApiError && e.fields) setServerErrors(e.fields);
      return e instanceof Error
        ? `Saved the webinar, but not the feedback survey: ${e.message}`
        : "Saved the webinar, but not the feedback survey.";
    }
  }

  const node = (
    <div id="survey" className="grid scroll-mt-24 gap-4">
      {load === "loading" ? (
        <Spinner className="size-5" />
      ) : load === "error" ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2.5 text-[12.5px] text-warn">
          Couldn&apos;t load this webinar&apos;s survey, so saving here won&apos;t touch it. Reload to try again.
        </p>
      ) : (
        <>
          <div
            className={`rounded-[10px] border px-1.5 py-0.5 ${on ? "border-brand-line bg-brand-soft" : "border-line bg-surface"}`}
          >
            <Toggle
              checked={on}
              disabled={locked}
              onChange={setOn}
              label="Ask attendees for feedback"
              description={
                locked
                  ? `${saved?.responses ?? 0} people have answered, so it can't be turned off.`
                  : on
                    ? `A short survey pops up in the middle of their screen. ${sendSummary(draft)}.`
                    : "Nobody is asked to rate this webinar."
              }
            />
          </div>

          {on && (
            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
              <SurveyBuilder
                value={draft}
                onChange={(next) => {
                  setServerErrors({});
                  setDraft(next);
                }}
                errors={errors}
                locked={locked}
                durationMin={durationMin}
              />
              <div className="xl:sticky xl:top-4">
                <p className="mb-2 text-[12px] font-medium text-ink-3">What attendees see</p>
                <div className="room-dark rounded-2xl border border-line-2 bg-surface p-5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.5)]">
                  <SurveyForm
                    key={JSON.stringify(cleanInput(draft))}
                    preview
                    survey={previewSurvey(draft)}
                    mine={{ submitted: false, linkClicked: false }}
                    slug={slug ?? "preview"}
                    onLater={() => undefined}
                    onDone={() => setDraft({ ...draft })}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );

  return { node, problem, persist, on };
}
