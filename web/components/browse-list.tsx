"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRegistrations } from "./registrations";
import { CheckIcon, SearchIcon } from "./icons";
import { Avatar, Badge, ButtonLink, Card, Empty, kindLabel } from "./ui";
import {
  formatCount,
  formatDayShort,
  formatDuration,
  formatTimeRange,
  tzLabel,
} from "@/lib/format";
import type { Webinar } from "@/lib/api-types";

/** Attendee-facing discovery: search + track filter over upcoming webinars. */
export function BrowseList({
  webinars,
  tracks,
}: {
  webinars: Webinar[];
  tracks: string[];
}) {
  const [query, setQuery] = useState("");
  const [track, setTrack] = useState<string>("all");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return webinars.filter((w) => {
      if (track !== "all" && w.track !== track) return false;
      if (!q) return true;
      return (
        w.topic.toLowerCase().includes(q) ||
        w.summary.toLowerCase().includes(q) ||
        w.host.name.toLowerCase().includes(q) ||
        w.track.toLowerCase().includes(q)
      );
    });
  }, [webinars, query, track]);

  return (
    <>
      {/* filters, one row above the results */}
      <div className="mb-5 flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-56 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            className="field field-lg pl-9"
            placeholder="Search webinars, topics, or speakers"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search webinars"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <FilterChip active={track === "all"} onClick={() => setTrack("all")}>
            All topics
          </FilterChip>
          {tracks.map((t) => (
            <FilterChip key={t} active={track === t} onClick={() => setTrack(t)}>
              {t}
            </FilterChip>
          ))}
        </div>
      </div>

      <p className="mb-3 text-[12.5px] text-ink-3">
        {visible.length} {visible.length === 1 ? "webinar" : "webinars"} open for
        registration
      </p>

      {visible.length === 0 ? (
        <Empty
          title="No webinars match that"
          hint="Try a different topic, or clear the search to see everything upcoming."
        />
      ) : (
        <div className="grid gap-3">
          {visible.map((w) => (
            <WebinarRow key={w.id} webinar={w} />
          ))}
        </div>
      )}
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`h-8 rounded-lg border px-3 text-[12.5px] font-medium transition-colors ${
        active
          ? "border-brand-line bg-brand-soft text-brand"
          : "border-line bg-surface text-ink-2 hover:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function WebinarRow({ webinar: w }: { webinar: Webinar }) {
  const { isRegistered, registrations, error } = useRegistrations();
  const registered = isRegistered(w.id);
  // With the lookup unresolved AND failed, fall through to the register call to
  // action rather than pulsing a placeholder forever. Registering again is
  // idempotent, so guessing "not registered" here costs nothing.
  const stillChecking = registrations === null && !error;
  const kind = kindLabel(w);
  const seatsLeft = Math.max(0, w.attendeeLimit - w.registrantCount);
  // Proportional, not a fixed number. "412 seats left" in warning orange on a
  // 500-seat webinar is not scarcity, it is an empty room dressed up as urgency.
  const nearlyFull = seatsLeft > 0 && seatsLeft <= Math.max(10, w.attendeeLimit * 0.1);

  return (
    <Card className="overflow-hidden transition-shadow hover:shadow-[0_2px_10px_rgba(19,22,25,0.07)]">
      <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-stretch">
        {/* date block */}
        <div className="flex shrink-0 flex-row items-center gap-3 sm:w-[124px] sm:flex-col sm:items-start sm:justify-center sm:gap-1 sm:border-r sm:border-line sm:pr-4">
          <div className="text-[13px] font-semibold text-brand">
            {formatDayShort(w.startsAt, w.timeZone)}
          </div>
          <div className="text-[12.5px] text-ink-2">
            {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}
          </div>
          <div className="text-[11.5px] text-ink-3">
            {tzLabel(w.startsAt, w.timeZone)}
          </div>
        </div>

        {/* body */}
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={kind.tone} dot={w.status === "live"}>
              {kind.text}
            </Badge>
            {w.track && <Badge>{w.track}</Badge>}
            {w.priceUsd ? <Badge tone="brand">${w.priceUsd}</Badge> : <Badge tone="ok">Free</Badge>}
            {w.approval === "manual" && <Badge tone="warn">Approval required</Badge>}
          </div>

          <h3 className="text-[15.5px] leading-snug font-semibold tracking-[-0.01em]">
            <Link href={`/webinars/${w.id}`} className="hover:text-brand">
              {w.topic}
            </Link>
          </h3>
          <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-2">
            {w.summary}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-ink-3">
            <span className="flex items-center gap-1.5">
              <Avatar person={w.host} size={20} />
              {w.host.name}
            </span>
            {w.panelists.length > 0 && (
              <span>
                +{w.panelists.length}{" "}
                {w.panelists.length === 1 ? "panelist" : "panelists"}
              </span>
            )}
            <span>{formatDuration(w.durationMin)}</span>
            <span>{formatCount(w.registrantCount)} registered</span>
          </div>
        </div>

        {/* action */}
        <div className="flex shrink-0 flex-col justify-center gap-2 sm:w-[148px]">
          {stillChecking ? (
            // still reading localStorage — reserve the space, don't flicker
            <div className="h-10 animate-pulse rounded-lg bg-surface-2" />
          ) : registered ? (
            <>
              {w.status === "live" ? (
                <ButtonLink href={`/webinars/${w.id}/room`}>Join now</ButtonLink>
              ) : (
                <div className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-ok-soft text-[13px] font-medium text-ok">
                  <CheckIcon className="size-4" />
                  Registered
                </div>
              )}
              <ButtonLink href={`/webinars/${w.id}`} variant="ghost" size="sm">
                View details
              </ButtonLink>
            </>
          ) : (
            <>
              <ButtonLink href={`/webinars/${w.id}`}>
                {seatsLeft === 0 ? "Join the waitlist" : "Register"}
              </ButtonLink>
              {nearlyFull && (
                <p className="text-center text-[11.5px] text-warn">
                  {formatCount(seatsLeft)} {seatsLeft === 1 ? "seat" : "seats"} left
                </p>
              )}
              {seatsLeft === 0 && (
                <p className="text-center text-[11.5px] text-warn">Seats are full</p>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
