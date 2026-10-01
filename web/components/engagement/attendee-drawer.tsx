"use client";

import { useEffect, useRef } from "react";
import type { EngagementAttendeeDetail, EngagementAttendeeRow } from "@/lib/api-types";
import { Spinner } from "@/components/controls";
import { useAttendeeDetail } from "@/lib/engagement/hooks";
import { TIER_META, asTier } from "@/lib/engagement/score";
import type { EngagementSource } from "@/lib/engagement/source";
import { joinLabel, minuteLabel } from "@/lib/engagement/viz";
import { clockAt } from "@/lib/engagement/sections";
import { formatTime } from "@/lib/format";
import type { HeatmapClock } from "./attendee-heatmap";
import { Initials, MiniStat, TierChip } from "./primitives";
import { ErrorState } from "./states";

const EVENT_ICON: Record<string, { icon: string; tone: string }> = {
  join: { icon: "login", tone: "bg-ok-soft text-ok" },
  leave: { icon: "logout", tone: "bg-live-soft text-live" },
  chat: { icon: "chat", tone: "bg-brand-soft text-brand" },
  question: { icon: "help", tone: "bg-[#e0f2f6] text-[#0e7490]" },
  upvote: { icon: "thumb_up", tone: "bg-[#e0f2f6] text-[#0e7490]" },
  poll: { icon: "bar_chart", tone: "bg-warn-soft text-warn" },
  quiz: { icon: "quiz", tone: "bg-[#f1ebfe] text-[#7c3aed]" },
  reaction: { icon: "mood", tone: "bg-[#fce8f1] text-[#be185d]" },
  hand: { icon: "back_hand", tone: "bg-surface-2 text-ink-2" },
  stage: { icon: "podium", tone: "bg-surface-2 text-ink-2" },
};

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Escape closes; Tab cycles inside; focus returns to whatever opened it. */
function useDialogFocus(open: boolean, onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      restore?.focus();
    };
  }, [open, onClose]);
  return panel;
}

function Presence({ d, lobbyMin, clock }: { d: EngagementAttendeeDetail; lobbyMin: number; clock?: HeatmapClock }) {
  const total = d.sessionMin + lobbyMin;
  const pos = (m: number) => ((Math.max(-lobbyMin, Math.min(d.sessionMin, m)) + lobbyMin) / total) * 100;
  const last = d.row.lastLeaveMin;
  const at = (m: number) => {
    const iso = clock ? clockAt(clock.startedAt, m) : null;
    return iso && clock ? formatTime(iso, clock.timeZone) : minuteLabel(m);
  };
  return (
    <section aria-labelledby="att-presence">
      <h3 id="att-presence" className="mb-2 text-[12.5px] font-semibold">
        In the room
      </h3>
      <div className="relative h-4 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {lobbyMin > 0 && <div className="absolute inset-y-0 left-0 bg-line" style={{ width: `${(lobbyMin / total) * 100}%` }} />}
        {d.visits.map((v) => {
          const to = v.toMin < 0 ? d.sessionMin : v.toMin;
          return (
            <div
              key={`${v.fromMin}-${v.toMin}`}
              className="absolute inset-y-0 rounded-full bg-brand"
              style={{ left: `${pos(v.fromMin)}%`, width: `${Math.max(0.8, pos(to) - pos(v.fromMin))}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-ink-3 tabular-nums" aria-hidden>
        <span>{lobbyMin > 0 ? "Lobby" : "0m"}</span>
        {lobbyMin > 0 && <span>0m</span>}
        <span>{Math.round(d.sessionMin / 2)}m</span>
        <span>{d.sessionMin}m</span>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-2">
        {d.visits.length > 1
          ? `Dropped ${d.visits.length - 1}× and came back.`
          : last < 0 || last >= d.sessionMin
            ? "Stayed to the end."
            : `Left at ${last}m and did not return.`}
      </p>
      {/* Each visit with its clock times — what the old attendance table's expanded row showed. */}
      <ol className="mt-2 grid gap-1 text-[12px] text-ink-2 tabular-nums" aria-label="Visits">
        {d.visits.map((v, i) => (
          <li key={`${v.fromMin}-${v.toMin}-${i}`} className="flex items-center gap-2">
            <span className="w-4 text-ink-3">{i + 1}.</span>
            <span>{at(v.fromMin)}</span>
            <span aria-hidden className="text-ink-3">→</span>
            <span className="sr-only">to</span>
            <span>{v.toMin < 0 ? <span className="text-ink-3">still in</span> : at(v.toMin)}</span>
            {v.toMin >= 0 && <span className="text-ink-3">({Math.max(0, v.toMin - Math.max(0, v.fromMin))}m)</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Breakdown({ d }: { d: EngagementAttendeeDetail }) {
  const color = TIER_META[asTier(d.row.tier)].color;
  return (
    <section aria-labelledby="att-why">
      <h3 id="att-why" className="mb-2 text-[12.5px] font-semibold">
        Why {d.row.score}?
      </h3>
      <ul className="space-y-2">
        {d.components.map((c) => (
          <li key={c.key}>
            <div className="flex items-baseline justify-between gap-3 text-[12px]">
              <span className="text-ink-2">
                {c.label} <span className="text-ink-3">· {c.detail}</span>
              </span>
              <span className="shrink-0 font-medium tabular-nums">
                {c.points.toFixed(1)}
                <span className="text-ink-3">/{Math.round(c.weight)}</span>
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full" style={{ width: `${Math.round(c.ratio * 100)}%`, background: color }} />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11.5px] text-ink-3">Tools this person wasn&apos;t in the room for don&apos;t count against them.</p>
    </section>
  );
}

function Timeline({ d }: { d: EngagementAttendeeDetail }) {
  const events = d.timeline.filter((e) => e.kind !== "reaction");
  const stayed = d.row.lastLeaveMin < 0 || d.row.lastLeaveMin >= d.sessionMin;
  return (
    <section aria-labelledby="att-timeline">
      <h3 id="att-timeline" className="mb-2 text-[12.5px] font-semibold">
        Timeline
      </h3>
      {d.truncated && <p className="mb-2 text-[11.5px] text-ink-3">Showing the most recent activity only.</p>}
      <ol className="relative space-y-2.5 border-l border-line pl-4">
        {events.map((e, i) => {
          const meta = EVENT_ICON[e.kind] ?? EVENT_ICON.stage;
          return (
            <li key={`${e.atSec}-${e.kind}-${i}`} className="relative">
              <span className={`absolute top-0 -left-[27px] grid size-[22px] place-items-center rounded-full ring-4 ring-surface ${meta.tone}`} aria-hidden>
                <span className="material-symbols-outlined !text-[13px]">{meta.icon}</span>
              </span>
              <div className="flex gap-2 text-[12.5px]">
                <span className="w-10 shrink-0 tabular-nums text-ink-3">{minuteLabel(Math.floor(e.atSec / 60))}</span>
                <span className="min-w-0 break-words text-ink">
                  {e.text}
                  {e.correct === true && <span className="ml-1.5 text-[11px] font-medium text-ok">✓ correct</span>}
                  {e.correct === false && <span className="ml-1.5 text-[11px] font-medium text-live">✗ wrong</span>}
                </span>
              </div>
            </li>
          );
        })}
        {stayed && (
          <li className="relative text-[12.5px]">
            <span className="absolute top-0 -left-[27px] grid size-[22px] place-items-center rounded-full bg-surface-2 text-ink-3 ring-4 ring-surface" aria-hidden>
              <span className="material-symbols-outlined !text-[13px]">flag</span>
            </span>
            <span className="mr-2 inline-block w-10 tabular-nums text-ink-3">{d.sessionMin}m</span>
            Webinar ended
          </li>
        )}
      </ol>
    </section>
  );
}

function Consent({ optIn }: { optIn?: boolean }) {
  if (optIn === undefined) return <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">No CRM contact</span>;
  return optIn ? (
    <span className="rounded-full border border-ok/25 bg-ok-soft px-2 py-0.5 text-[11px] font-medium text-ok">WhatsApp opted in</span>
  ) : (
    <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-3">No WhatsApp consent</span>
  );
}

/** Right-hand sheet (full screen on a phone) with one attendee's whole session. */
export function AttendeeDrawer({
  source,
  row,
  lobbyMin,
  onClose,
  clock,
}: {
  source: EngagementSource;
  row: EngagementAttendeeRow | null;
  lobbyMin: number;
  onClose: () => void;
  clock?: HeatmapClock;
}) {
  const detail = useAttendeeDetail(source, row?.identity ?? null);
  const panel = useDialogFocus(!!row, onClose);
  if (!row) return null;
  const d = detail.data;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-scrim/35 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="att-drawer-title"
        tabIndex={-1}
        className="relative flex h-full w-full flex-col bg-surface shadow-2xl outline-none sm:max-w-[440px]"
      >
        <div className="flex items-start gap-3 border-b border-line px-5 py-4">
          <Initials name={row.name} seed={row.identity} size={44} />
          <div className="min-w-0 flex-1">
            <h2 id="att-drawer-title" className="truncate text-[16px] font-semibold">
              {row.name}
            </h2>
            {row.email && <p className="truncate text-[12.5px] text-ink-3">{row.email}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <TierChip tier={row.tier} />
              {d && <Consent optIn={d.whatsAppOptIn} />}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-lg text-ink-2 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-brand/40"
            aria-label="Close details"
          >
            <span aria-hidden className="text-[18px] leading-none">×</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-2">
            <MiniStat label="Score" value={String(row.score)} />
            <MiniStat label="Watched" value={`${row.watchMin}m`} />
            <MiniStat label="Joined" value={joinLabel(row.firstJoinMin)} />
          </div>
          {detail.loading && (
            <div className="grid place-items-center py-10" aria-label="Loading details">
              <Spinner className="size-5 text-ink-3" />
            </div>
          )}
          {detail.error != null && <ErrorState error={detail.error} onRetry={detail.retry} compact />}
          {d && (
            <>
              <Presence d={d} lobbyMin={lobbyMin} clock={clock} />
              <Breakdown d={d} />
              {d.reactions.length > 0 && (
                <section aria-labelledby="att-reactions">
                  <h3 id="att-reactions" className="mb-1.5 text-[12.5px] font-semibold">
                    Reactions ({d.reactions.reduce((s, r) => s + r.count, 0)})
                  </h3>
                  <ul className="flex flex-wrap gap-2 text-[13px]">
                    {d.reactions.map((r) => (
                      <li key={r.label} className="rounded-full bg-surface-2 px-2.5 py-1 tabular-nums">
                        <span className="text-[16px]">{r.label}</span> × {r.count}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <Timeline d={d} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
