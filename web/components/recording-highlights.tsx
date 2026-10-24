"use client";

import { useEffect, useState } from "react";
import { Spinner } from "./controls";
import { SparklesIcon } from "./icons";
import { useToast } from "./providers";
import { Button } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Highlight, HighlightsResponse, Recording } from "@/lib/api-types";
import { clock, highlightsStatusText, lengthText, parseClock, rangeProblem, signalChips } from "@/lib/highlights";
import { playableRecordingParts } from "@/lib/recording-parts";

/** How often a pick still being made is looked at again. */
const POLL_MS = 5_000;

/** Where each take sits on the player's timeline, by id: a clip stays inside one. */
function partBounds(rec: Recording): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  let at = 0;
  for (const p of playableRecordingParts(rec)) {
    const d = Math.max(0, p.durationMs / 1000);
    out.set(p.id, { start: at, end: at + d });
    at += d;
  }
  return out;
}

/* Suggested highlights under the player in the Recording tab (the clips switch): the moments
 * AI picked as the best short clips, from the transcript and where the audience reacted. Each
 * can be previewed (the player plays just that stretch), its start and end adjusted (the
 * times are the player's own) and made into a clip (onMakeClip, with the adjusted times).
 * Found the first time this opens, then kept. */
export function RecordingHighlights({
  slug,
  recording,
  onPreview,
  onMakeClip,
}: {
  slug: string;
  recording: Recording;
  onPreview: (startSec: number, endSec: number) => void;
  onMakeClip?: (h: Highlight, startSec: number, endSec: number) => void;
}) {
  const { notify } = useToast();
  const [data, setData] = useState<HighlightsResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [poll, setPoll] = useState(0);
  const [finding, setFinding] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    api
      .recordingHighlights(slug, recording.id, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setData(res);
        setLoadError(false);
        if (res.status === "processing") timer = setTimeout(() => setPoll((n) => n + 1), POLL_MS);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setLoadError(true);
      });
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [slug, recording.id, poll]);

  const findAgain = async () => {
    setFinding(true);
    try {
      setData(await api.findHighlights(slug, recording.id));
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't find the highlights again.", "error");
    } finally {
      setFinding(false);
    }
  };

  const bounds = partBounds(recording);
  const state = data ? highlightsStatusText(data.status) : null;
  const list = data?.highlights ?? [];
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold tracking-wide text-ink-3 uppercase">
          Highlights{" "}
          <span className="inline-flex items-center gap-1 font-normal normal-case">
            · <SparklesIcon className="size-3 text-brand" /> by AI
          </span>
        </p>
        {data && (data.status === "ready" || list.length > 0) && (
          <Button type="button" variant="ghost" size="sm" disabled={finding} onClick={() => void findAgain()}>
            {finding && <Spinner className="size-3.5" />}
            Find them again
          </Button>
        )}
      </div>
      {!data ? (
        <p className="text-[12.5px] text-ink-3">
          {loadError ? (
            "Couldn't load the highlights. Reload the page to try again."
          ) : (
            <>
              <Spinner className="size-3.5" /> Finding the best moments… this takes up to a minute.
            </>
          )}
        </p>
      ) : (
        <>
          {state && (
            <p className="mb-2 text-[12.5px] text-ink-2">
              {state.pending && <Spinner className="size-3.5" />} {state.text}
            </p>
          )}
          {data.status === "ready" && list.length === 0 && (
            <p className="text-[12.5px] text-ink-2">No moment stood out as a short clip in this recording.</p>
          )}
          {list.length > 0 && (
            <>
              <p className="mb-2 text-[12px] text-ink-3">
                Picked from what was said and where the audience reacted. Preview one to play just that part; adjust
                its start and end to taste.
              </p>
              <ol className="grid gap-2">
                {list.map((h) => (
                  <HighlightRow
                    key={`${h.id}:${data.generatedAt ?? ""}`}
                    highlight={h}
                    part={bounds.get(h.partId) ?? { start: 0, end: Number.POSITIVE_INFINITY }}
                    onPreview={onPreview}
                    onMakeClip={onMakeClip}
                  />
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  );
}

function HighlightRow({
  highlight: h,
  part,
  onPreview,
  onMakeClip,
}: {
  highlight: Highlight;
  part: { start: number; end: number };
  onPreview: (startSec: number, endSec: number) => void;
  onMakeClip?: (h: Highlight, startSec: number, endSec: number) => void;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const [startText, setStartText] = useState(clock(h.startSec));
  const [endText, setEndText] = useState(clock(h.endSec));
  // Typed times are whole seconds; untouched ones keep the suggestion's tenths.
  const start = startText === clock(h.startSec) ? h.startSec : parseClock(startText);
  const end = endText === clock(h.endSec) ? h.endSec : parseClock(endText);
  const problem = rangeProblem(start, end, part);
  const changed = start !== h.startSec || end !== h.endSec;
  const chips = signalChips(h.signals);
  const shownStart = problem ? h.startSec : (start ?? h.startSec);
  const shownEnd = problem ? h.endSec : (end ?? h.endSec);
  const nudge = (which: "start" | "end", by: number) => {
    const cur = (which === "start" ? start : end) ?? (which === "start" ? h.startSec : h.endSec);
    const next = clock(Math.max(0, cur + by));
    if (which === "start") setStartText(next);
    else setEndText(next);
  };

  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[12px] text-brand">
          {clock(shownStart)}–{clock(shownEnd)}
        </span>
        <span className="text-[12px] text-ink-3">{lengthText(shownEnd - shownStart)}</span>
        <span className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">{h.title}</span>
      </div>
      {h.why && <p className="mt-1 text-[12.5px] text-ink-2">{h.why}</p>}
      {h.quote && <p className="mt-1 truncate text-[12.5px] text-ink-3 italic">“{h.quote}”</p>}
      {chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => onPreview(shownStart, shownEnd)}>
          Preview
        </Button>
        {onMakeClip && (
          <Button type="button" size="sm" disabled={!!problem} onClick={() => onMakeClip(h, shownStart, shownEnd)}>
            Make a clip
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" aria-expanded={adjusting} onClick={() => setAdjusting((a) => !a)}>
          {adjusting ? "Done" : "Adjust start and end"}
        </Button>
        {changed && !problem && <span className="text-[12px] text-ink-3">Adjusted</span>}
      </div>
      {adjusting && (
        <div className="mt-2 grid gap-2">
          <div className="flex flex-wrap items-end gap-3">
            {(
              [
                ["start", "Start", startText, setStartText],
                ["end", "End", endText, setEndText],
              ] as const
            ).map(([which, label, value, set]) => (
              <label key={which} className="grid gap-1 text-[12px] font-medium text-ink-2">
                {label}
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    className="h-8 rounded-md border border-line px-2 text-[12px] text-ink-2 hover:bg-surface-2"
                    aria-label={`${label} one second earlier`}
                    onClick={() => nudge(which, -1)}
                  >
                    −1 s
                  </button>
                  <input
                    className="field h-8 w-20 text-center font-mono text-[12.5px]"
                    value={value}
                    inputMode="numeric"
                    onChange={(e) => set(e.target.value)}
                  />
                  <button
                    type="button"
                    className="h-8 rounded-md border border-line px-2 text-[12px] text-ink-2 hover:bg-surface-2"
                    aria-label={`${label} one second later`}
                    onClick={() => nudge(which, 1)}
                  >
                    +1 s
                  </button>
                </span>
              </label>
            ))}
            {changed && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStartText(clock(h.startSec));
                  setEndText(clock(h.endSec));
                }}
              >
                Back to the suggestion
              </Button>
            )}
          </div>
          {problem && <p className="text-[12px] text-live">{problem}</p>}
        </div>
      )}
    </li>
  );
}
