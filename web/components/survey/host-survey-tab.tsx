"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { HostSurvey, Survey, SurveyResults, Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { FIXTURE_HOST_SURVEY, FIXTURE_SURVEY_RESULTS } from "@/lib/survey-fixtures";
import { Alert, Spinner } from "../controls";
import { ClipboardIcon } from "../icons";
import { useToast } from "../providers";
import { Badge, Button, Card, ButtonLink } from "../ui";
import { SurveyResultsView } from "./survey-results";

/* A completed webinar's Survey tab: what came back.
 *
 * Only results. The survey is set up with the rest of the webinar in the schedule form, and
 * sent from the room — so after the session there is one question left, "how did it go?",
 * and this answers it. The one action kept is for a survey that never went out (the host
 * ended without sending it): send it now, to the ended screen and the replay. */

/** Fixture data in place of the API: the dev-bypass host pages and /mock/survey. */
export interface SurveySample {
  host: HostSurvey;
  results: SurveyResults;
}

export function HostSurveyTab({ webinar: w, sample: given }: { webinar: Webinar; sample?: SurveySample }) {
  const sample = given ?? (isDevAuthBypassActive() ? { host: FIXTURE_HOST_SURVEY, results: FIXTURE_SURVEY_RESULTS } : null);
  const bypass = sample !== null;
  const { notify } = useToast();
  const [host, setHost] = useState<HostSurvey | null>(sample?.host ?? null);
  const [results, setResults] = useState<SurveyResults | null>(sample?.results ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (bypass) return;
    let live = true;
    api
      .hostSurvey(w.id)
      .then((h) => live && setHost(h))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load the survey."));
    return () => {
      live = false;
    };
  }, [w.id, bypass]);

  const sv = host?.survey;
  const sent = Boolean(sv && sv.status !== "draft");
  useEffect(() => {
    if (bypass || !sent) return;
    const ctl = new AbortController();
    const read = () =>
      api
        .surveyResults(w.id, ctl.signal)
        .then(setResults)
        .catch(() => undefined);
    void read();
    // Late answers still arrive from the ended screen while it is open.
    const t = sv?.status === "live" ? window.setInterval(read, 15000) : undefined;
    return () => {
      ctl.abort();
      if (t) window.clearInterval(t);
    };
  }, [w.id, bypass, sent, sv?.status]);

  async function run(action: "launch" | "close") {
    if (bypass) return;
    setBusy(true);
    setError(null);
    try {
      const next = action === "launch" ? await api.launchSurvey(w.id) : await api.closeSurvey(w.id);
      setHost((h) => ({ attended: h?.attended ?? 0, survey: next }));
      notify(action === "launch" ? "Survey sent" : "Survey closed — no new answers", "ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  if (!host) return error ? <Alert tone="error">{error}</Alert> : <Spinner className="size-5" />;

  if (!sv) {
    return (
      <Card className="grid justify-items-center gap-2 px-6 py-12 text-center">
        <span className="grid size-11 place-items-center rounded-xl bg-surface-2 text-ink-3">
          <ClipboardIcon className="size-5" />
        </span>
        <h2 className="text-[15px] font-semibold">No feedback survey for this webinar</h2>
        <p className="max-w-sm text-[13px] text-ink-2">
          Next time, switch on &ldquo;Ask attendees for feedback&rdquo; when you schedule — it takes a minute and
          you&apos;ll see ratings and comments here.
        </p>
        <ButtonLink href="/host/new" size="sm" variant="secondary" className="mt-2">
          Schedule a webinar
        </ButtonLink>
      </Card>
    );
  }

  if (!sent) {
    return (
      <Card className="flex flex-wrap items-center gap-4 p-5">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warn-soft text-warn">
          <ClipboardIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">The survey wasn&apos;t sent</h2>
          <p className="mt-0.5 text-[13px] text-ink-2">
            The webinar ended before it went out. Send it now and attendees see it on the ended page and the replay.
          </p>
        </div>
        {error && <Alert tone="error">{error}</Alert>}
        <Button size="sm" onClick={() => void run("launch")} disabled={busy}>
          {busy && <Spinner className="size-3.5" />}
          Send survey now
        </Button>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
            <ClipboardIcon className="size-5" />
          </span>
          <div>
            <h2 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
              {sv.title || "Feedback survey"}
              <StatusBadge survey={sv} />
            </h2>
            <p className="mt-0.5 text-[13px] text-ink-2">{statusLine(sv, host.attended)}</p>
          </div>
        </div>
        <Button size="sm" variant="secondary" onClick={() => void run(sv.status === "live" ? "close" : "launch")} disabled={busy}>
          {busy && <Spinner className="size-3.5" />}
          {sv.status === "live" ? "Stop taking answers" : "Reopen"}
        </Button>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      {results ? <SurveyResultsView slug={w.id} results={results} preview={bypass} /> : <Spinner className="size-5" />}
    </div>
  );
}

function StatusBadge({ survey }: { survey: Survey }) {
  if (survey.status === "live") return <Badge tone="ok" dot>Taking answers</Badge>;
  return <Badge>Closed</Badge>;
}

function statusLine(s: Survey, attended: number): string {
  const answered = `${s.responses} of ${attended} attendees answered`;
  if (s.mode === "link") return `${answered} · ${s.linkClicks} opened the link`;
  return s.status === "live" ? `${answered} · people who missed it can still answer from the ended page` : answered;
}
