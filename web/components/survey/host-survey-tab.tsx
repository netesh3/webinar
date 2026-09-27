"use client";

import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { HostSurvey, Survey, SurveyInput, SurveyResults, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { cleanInput, emptyInput, previewSurvey, toInput, validateInput } from "@/lib/survey";
import { FIXTURE_HOST_SURVEY, FIXTURE_SURVEY_RESULTS } from "@/lib/survey-fixtures";
import { Alert, ConfirmModal, Spinner } from "../controls";
import { ClipboardIcon } from "../icons";
import { useToast } from "../providers";
import { Badge, Button, Card } from "../ui";
import { SurveyBuilder } from "./survey-builder";
import { SurveyForm } from "./survey-form";
import { SurveyResultsView } from "./survey-results";

/* The webinar's Survey tab: set it up, send it, read what came back.
 *
 * Lives with the other per-webinar management tabs because a survey is prepared before the
 * session like its registration settings are, and read after it like its report is. The room
 * has a compact twin (SurveyRoomControls) for "Send now" mid-session. */

/** Fixture data in place of the API: the dev-bypass host pages and /mock/survey. */
export interface SurveySample {
  host: HostSurvey;
  results: SurveyResults;
  view?: "setup" | "results";
}

export function HostSurveyTab({ webinar: w, sample: given }: { webinar: Webinar; sample?: SurveySample }) {
  const sample = given ?? (isDevAuthBypassActive() ? { host: FIXTURE_HOST_SURVEY, results: FIXTURE_SURVEY_RESULTS } : null);
  const bypass = sample !== null;
  const ended = w.status === "ended";
  const { notify } = useToast();
  const [host, setHost] = useState<HostSurvey | null>(sample?.host ?? null);
  const [draft, setDraft] = useState<SurveyInput | null>(() =>
    sample ? (sample.host.survey ? toInput(sample.host.survey) : emptyInput()) : null,
  );
  const [view, setView] = useState<"setup" | "results">(sample?.view ?? "setup");
  const [results, setResults] = useState<SurveyResults | null>(sample?.results ?? null);
  const [error, setError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<"save" | "launch" | "close" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (bypass) return;
    let live = true;
    api
      .hostSurvey(w.id)
      .then((h) => {
        if (!live) return;
        setHost(h);
        setDraft(h.survey ? toInput(h.survey) : emptyInput());
        if (h.survey && h.survey.responses + h.survey.linkClicks > 0) setView("results");
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : "Could not load the survey.");
      });
    return () => {
      live = false;
    };
  }, [w.id, bypass]);

  useEffect(() => {
    if (bypass || view !== "results" || !host?.survey) return;
    const ctl = new AbortController();
    const read = () =>
      api
        .surveyResults(w.id, ctl.signal)
        .then(setResults)
        .catch(() => undefined);
    void read();
    // Answers land while the survey is live; a gentle refresh, not a firehose.
    const t = host.survey.status === "live" ? window.setInterval(read, 15000) : undefined;
    return () => {
      ctl.abort();
      if (t) window.clearInterval(t);
    };
  }, [w.id, view, host?.survey, bypass]);

  const saved = host?.survey;
  const errors = useMemo(() => ({ ...(draft ? validateInput(draft) : {}), ...serverErrors }), [draft, serverErrors]);
  const dirty = useMemo(() => {
    if (!draft) return false;
    const base = saved ? toInput(saved) : null;
    return !base || JSON.stringify(cleanInput(draft)) !== JSON.stringify(cleanInput(base));
  }, [draft, saved]);
  const valid = Object.keys(validateInput(draft ?? emptyInput())).length === 0;

  async function save(): Promise<Survey | null> {
    if (!draft || !valid) return null;
    if (bypass) {
      notify("Survey saved", "ok");
      return saved ?? null;
    }
    setBusy("save");
    setError(null);
    setServerErrors({});
    try {
      const sv = await api.saveSurvey(w.id, cleanInput(draft));
      setHost((h) => ({ attended: h?.attended ?? 0, survey: sv }));
      setDraft(toInput(sv));
      notify("Survey saved", "ok");
      return sv;
    } catch (e) {
      if (e instanceof ApiError && e.fields) setServerErrors(e.fields);
      setError(e instanceof Error ? e.message : "Could not save the survey.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function launch() {
    if (bypass) return notify("Survey sent to the audience", "ok");
    if (dirty && !(await save())) return;
    setBusy("launch");
    try {
      const sv = await api.launchSurvey(w.id);
      setHost((h) => ({ attended: h?.attended ?? 0, survey: sv }));
      notify("Survey sent — attendees see it now", "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the survey.");
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    if (bypass) return;
    setBusy("close");
    try {
      const sv = await api.closeSurvey(w.id);
      setHost((h) => ({ attended: h?.attended ?? 0, survey: sv }));
      notify("Survey closed — no new answers", "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not close the survey.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setConfirmDelete(false);
    if (bypass) return;
    setBusy("delete");
    try {
      await api.deleteSurvey(w.id);
      setHost((h) => ({ attended: h?.attended ?? 0 }));
      setDraft(emptyInput());
      notify("Survey removed", "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the survey.");
    } finally {
      setBusy(null);
    }
  }

  if (!host || !draft) {
    return error ? <Alert>{error}</Alert> : <Spinner className="size-5" />;
  }

  const status = saved?.status;
  const locked = Boolean(saved?.locked);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
            <ClipboardIcon className="size-5" />
          </span>
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
              Post-event survey
              <StatusBadge survey={saved} ended={ended} />
            </h2>
            <p className="mt-1 text-[13px] text-ink-2">{statusLine(saved, ended, host.attended)}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {status === "live" ? (
            <Button size="sm" variant="secondary" onClick={() => void close()} disabled={busy !== null}>
              {busy === "close" && <Spinner className="size-3.5" />}
              Close survey
            </Button>
          ) : (
            <Button size="sm" onClick={() => void launch()} disabled={busy !== null || !valid}>
              {busy === "launch" && <Spinner className="size-3.5" />}
              {status === "closed" ? "Reopen survey" : "Send now"}
            </Button>
          )}
          {saved && !locked && status !== "live" && (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>
              Remove
            </Button>
          )}
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {saved && (
        <div role="tablist" aria-label="Survey" className="inline-flex w-fit rounded-lg bg-surface-2 p-0.5">
          {(["setup", "results"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => setView(v)}
              className={`h-8 rounded-md px-3 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                view === v ? "bg-surface text-ink shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              {v === "setup" ? "Setup" : `Results${saved.responses ? ` · ${saved.responses}` : ""}`}
            </button>
          ))}
        </div>
      )}

      {view === "results" && saved ? (
        results ? (
          <SurveyResultsView slug={w.id} results={results} preview={bypass} />
        ) : (
          <Spinner className="size-5" />
        )
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
          <Card className="p-4 sm:p-5">
            <SurveyBuilder
              value={draft}
              onChange={(next) => {
                setServerErrors({});
                setDraft(next);
              }}
              errors={errors}
              locked={locked}
            />
            {ended && draft.sendAt === "on_end" && status !== "live" && (
              <p className="mt-4 rounded-lg bg-warn-soft px-3 py-2 text-[12px] text-warn">
                This webinar has already ended, so “when it ends” won&apos;t fire. Use Send now to reach attendees on
                their replay and ended screens.
              </p>
            )}
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
              {dirty && saved && (
                <Button variant="ghost" size="sm" onClick={() => setDraft(toInput(saved))} disabled={busy !== null}>
                  Discard changes
                </Button>
              )}
              <Button onClick={() => void save()} disabled={!dirty || !valid || busy !== null}>
                {busy === "save" && <Spinner className="size-4" />}
                {saved ? "Save changes" : "Save survey"}
              </Button>
            </div>
          </Card>
          <div className="lg:sticky lg:top-4">
            <p className="mb-2 text-[12px] font-medium text-ink-3">What attendees see</p>
            <div className="room-dark rounded-2xl border border-line-2 bg-surface p-5 shadow-[0_18px_50px_-18px_rgba(0,0,0,0.5)]">
              <SurveyForm
                key={JSON.stringify(cleanInput(draft))}
                preview
                survey={previewSurvey(draft)}
                mine={{ submitted: false, linkClicked: false }}
                slug={w.id}
                onLater={() => undefined}
                onDone={() => setDraft({ ...draft })}
              />
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmDelete}
        title="Remove this survey?"
        body="Attendees won't be asked for feedback on this webinar. Nobody has answered yet, so nothing is lost."
        confirmLabel="Remove survey"
        onConfirm={() => void remove()}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}

function StatusBadge({ survey, ended }: { survey?: Survey; ended: boolean }) {
  if (!survey) return <Badge>Not set up</Badge>;
  if (survey.status === "live") return <Badge tone="ok" dot>Live</Badge>;
  if (survey.status === "closed") return <Badge>Closed</Badge>;
  if (survey.sendAt === "on_end" && !ended) return <Badge tone="brand">Sends when it ends</Badge>;
  return <Badge tone="warn">Draft</Badge>;
}

function statusLine(s: Survey | undefined, ended: boolean, attended: number): string {
  if (!s) return "Ask attendees to rate the session, or point them at your own survey.";
  const answered = `${s.responses} of ${attended} attendees answered`;
  if (s.status === "live") {
    return s.mode === "link" ? `${answered} · ${s.linkClicks} opened the link` : answered;
  }
  if (s.status === "closed") return `Closed · ${answered}`;
  if (s.sendAt === "on_end" && !ended) return "Goes out the moment you end the webinar. Early leavers are asked on their way out.";
  return "Saved as a draft. Send it when you're ready.";
}
