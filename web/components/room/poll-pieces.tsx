"use client";

import type { Poll } from "@/lib/api-types";
import { letterFor, pollResults } from "@/lib/poll-view";
import { CheckIcon } from "../icons";
import { Pill } from "./chat-badges";

/* The pieces the host's and the audience's Polls views share: section headers,
 * the kind/state pills, and the results rows. One definition each, so the bars a
 * panelist sees and the bars the host sees cannot drift apart. */

export function SectionLabel({
  title,
  count,
  spaced = false,
  hint,
}: {
  title: string;
  count: number;
  spaced?: boolean;
  hint?: string;
}) {
  return (
    <p
      className={`flex items-center gap-1.5 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase ${
        spaced ? "pt-3" : ""
      }`}
    >
      {title}
      <span className="rounded-full bg-surface-2 px-1.5 text-[10px] leading-4 tracking-normal text-ink-2 tabular-nums">
        {count}
      </span>
      {hint && (
        <span className="ml-auto truncate text-[10.5px] font-normal tracking-normal text-ink-3 normal-case">
          {hint}
        </span>
      )}
    </p>
  );
}

export function KindPill({ poll }: { poll: Pick<Poll, "kind"> }) {
  if (poll.kind === "quiz") {
    return (
      <span className="shrink-0 rounded-full border border-warn/30 bg-warn-soft px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap text-warn">
        Quiz
      </span>
    );
  }
  return <Pill>Poll</Pill>;
}

export function StatePill({ poll }: { poll: Pick<Poll, "state"> }) {
  if (poll.state === "open") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-live/30 bg-live-soft px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap text-live">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full rounded-full bg-live opacity-70 motion-safe:animate-ping" />
          <span className="relative inline-flex size-1.5 rounded-full bg-live" />
        </span>
        Live
      </span>
    );
  }
  if (poll.state === "draft") return <Pill>Draft</Pill>;
  return <Pill>Closed</Pill>;
}

export function votesLabel(n: number): string {
  return `${n} ${n === 1 ? "vote" : "votes"}`;
}

/** The results, one row per option.
 *
 *  With a tally (the host, and panelists — the server decides): a bar behind each
 *  label, the share and the count, the leader in brand and a quiz's right answer in
 *  green. Without one (the audience): the options only, with their own answer and,
 *  once revealed, the right one marked. The bar is behind the label rather than
 *  beside it, so a long option is not squeezed into half the width. */
export function ResultRows({
  poll,
  showMine = true,
  highlightLeader = true,
  showTally = true,
}: {
  poll: Poll;
  showMine?: boolean;
  highlightLeader?: boolean;
  /** Off for a draft: nobody has been asked, so "0%" on every row is noise. */
  showTally?: boolean;
}) {
  const computed = pollResults(poll);
  const results = showTally ? computed : { ...computed, hasTally: false };
  const quiz = poll.kind === "quiz";
  const answered = poll.myChoice >= 0;

  return (
    <ul className="space-y-1.5" aria-label="Results">
      {results.rows.map((row) => {
        // A quiz highlights its right answer, not the popular one — being popular
        // and being right are the whole difference a quiz is for.
        const lead = highlightLeader && row.leading && !(quiz && poll.correctOption >= 0);
        const wrongMine = quiz && poll.correctOption >= 0 && row.mine && !row.correct;
        const tone = row.correct
          ? "border-ok/35"
          : lead
            ? "border-brand-line"
            : wrongMine
              ? "border-live/30"
              : "border-line";
        const fill = row.correct ? "bg-ok/20" : lead ? "bg-brand/25" : "bg-ink-3/15";

        return (
          <li
            key={row.index}
            className={`relative overflow-hidden rounded-lg border ${tone} ${
              !results.hasTally && row.correct ? "bg-ok-soft/60" : ""
            }`}
            aria-label={`${letterFor(row.index)}: ${row.label}${
              results.hasTally ? `, ${row.percent}%, ${votesLabel(row.count)}` : ""
            }${row.correct ? ", correct answer" : ""}${row.mine && showMine ? ", your answer" : ""}`}
          >
            {results.hasTally && (
              <div
                aria-hidden
                className={`absolute inset-y-0 left-0 origin-left transition-[width] duration-700 ease-out motion-safe:animate-[poll-bar-grow_700ms_cubic-bezier(0.2,0.8,0.2,1)] ${fill}`}
                style={{ width: `${row.percent}%` }}
              />
            )}
            <div className="relative flex min-h-9 items-center gap-2 px-2.5 py-1.5 text-[12.5px]">
              <span
                aria-hidden
                className={`grid size-5 shrink-0 place-items-center rounded-md text-[10.5px] font-semibold ${
                  row.correct
                    ? "bg-ok text-stage"
                    : lead
                      ? "bg-brand text-stage"
                      : "bg-surface-2 text-ink-2"
                }`}
              >
                {row.correct ? <CheckIcon className="size-3" /> : letterFor(row.index)}
              </span>
              <span
                className={`min-w-0 flex-1 leading-snug break-words wrap-anywhere ${
                  row.correct ? "font-medium text-ok" : lead ? "font-medium text-ink" : "text-ink"
                }`}
              >
                {row.label}
              </span>
              {showMine && row.mine && answered && (
                <span
                  className={`shrink-0 rounded-full border px-1.5 text-[10px] leading-4 font-semibold ${
                    wrongMine ? "border-live/30 bg-live-soft text-live" : "border-brand-line bg-brand-soft text-brand"
                  }`}
                >
                  You
                </span>
              )}
              {results.hasTally && (
                <span className="shrink-0 text-right tabular-nums">
                  <span className="text-[12.5px] font-semibold text-ink">{row.percent}%</span>
                  <span className="ml-1 text-[10.5px] text-ink-3">{row.count}</span>
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
