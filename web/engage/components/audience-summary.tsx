"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { readCache, TTL_AUDIENCE } from "@/lib/http";
import {
  PeopleHighlyEngaged,
  PeopleSlipping,
  type CRMAudiencePerson,
  type CRMAudienceSummary,
} from "@/lib/api-types";
import { PersonAvatar } from "./wa-kit";

/** Fast responses never paint a placeholder. Slow ones get a shaped skeleton. */
const PLACEHOLDER_DELAY_MS = 200;

/* The top of the Audience tab: how people engage across your webinars. Read from the
 * stored rollup (migrations/0065) — nothing is recomputed to draw it.
 *
 * Each range is kept in the session memory cache (`crm-audience:${last}`). Switching
 * back paints that copy immediately. A range that is not cached yet leaves the
 * summary already on screen in place and revalidates behind it. */
export function AudienceSummary({
  onPick,
  onMessage,
  canMessage,
}: {
  /** Narrow the list below to one of the groups. */
  onPick: (filter: string) => void;
  onMessage: (contactIds: string[], label: string) => void;
  canMessage: boolean;
}) {
  const [last, setLast] = useState(6);
  const [data, setData] = useState<CRMAudienceSummary | null>(
    () => readCache<CRMAudienceSummary>(`crm-audience:6`, TTL_AUDIENCE)?.value ?? null,
  );
  const [loading, setLoading] = useState(
    () => !readCache<CRMAudienceSummary>(`crm-audience:6`, TTL_AUDIENCE)?.fresh,
  );
  const [error, setError] = useState<string | null>(null);
  const [showPlaceholder, setShowPlaceholder] = useState(false);
  const [busy, setBusy] = useState("");
  const audienceKey = `crm-audience:${last}`;
  const [seenAudience, setSeenAudience] = useState(audienceKey);
  if (audienceKey !== seenAudience) {
    setSeenAudience(audienceKey);
    const cached = readCache<CRMAudienceSummary>(audienceKey, TTL_AUDIENCE);
    if (cached) setData(cached.value);
    setLoading(!cached?.fresh);
    setError(null);
  }
  const { notify } = useToast();

  useEffect(() => {
    if (readCache<CRMAudienceSummary>(`crm-audience:${last}`, TTL_AUDIENCE)?.fresh) return;
    let cancelled = false;
    engageApi
      .crmAudienceSummary(last)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoading(false);
        setError(e instanceof ApiError ? e.message : "Could not load this summary.");
      });
    return () => {
      cancelled = true;
    };
  }, [last]);

  useEffect(() => {
    if (data) return;
    const id = window.setTimeout(() => setShowPlaceholder(true), PLACEHOLDER_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [data]);

  async function message(filter: string, label: string) {
    setBusy(filter);
    try {
      const { contactIds } = await engageApi.crmPeopleIds({ filter });
      onMessage(contactIds, label);
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not find these people.",
        "error",
      );
    } finally {
      setBusy("");
    }
  }

  if (!data) {
    if (error) return <SummaryError message={error} />;
    if (!showPlaceholder) return null;
    return <SummarySkeleton />;
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-ink-2">
          Across your last {data.webinars.length || last} webinars
        </span>
        <div className="flex rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Webinars in this summary">
          {[6, 12, 50].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLast(n)}
              aria-pressed={last === n}
              aria-busy={loading && last === n ? true : undefined}
              className={`relative rounded-md px-3 py-1 text-[12.5px] font-medium ${
                last === n
                  ? "bg-brand-soft text-brand"
                  : "text-ink-3 hover:text-ink"
              }`}
            >
              {n === 50 ? "All" : `Last ${n}`}
              {loading && last === n && (
                <Spinner className="pointer-events-none absolute -top-1 -right-0.5 size-3 motion-reduce:animate-none" />
              )}
            </button>
          ))}
        </div>
      </div>

      {error && <SummaryError message={error} />}

      <div
        className={`grid gap-4${loading ? " opacity-60 transition-opacity duration-150 motion-reduce:transition-none" : ""}`}
        aria-busy={loading || undefined}
      >
      <div className="grid grid-cols-2 gap-3 min-[900px]:grid-cols-4">
        <Kpi
          label="People reached"
          value={String(data.people)}
          note={`${data.activeMonth} came this month`}
        />
        <Kpi
          label="Show-up rate"
          value={data.webinars.length ? `${data.showUpPct}%` : "—"}
          note="of those who registered"
        />
        <Kpi
          label="Avg engagement"
          value={data.webinars.length ? String(data.avgIndex) : "—"}
          note="session index, out of 100"
        />
        <Kpi
          label="Came back"
          value={String(data.cameBack)}
          note="joined 2 or more"
        />
      </div>

      <div className="grid items-start gap-4 min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13.5px] font-semibold text-ink">
              Webinar by webinar
            </h3>
            <span className="flex gap-3 text-[11.5px] text-ink-3">
              <Legend className="bg-brand/35" text="Showed up %" />
              <Legend className="bg-brand" text="Engagement" />
            </span>
          </div>
          {data.webinars.length === 0 ? (
            <p className="py-8 text-center text-[12.5px] text-ink-3">
              Numbers appear after your first webinar ends.
            </p>
          ) : (
            <div className="flex h-40 items-end gap-3">
              {data.webinars.map((w) => {
                const show = w.registered
                  ? Math.round((w.attended / w.registered) * 100)
                  : 0;
                return (
                  <Link
                    key={w.id}
                    href={`/host/${encodeURIComponent(w.id)}?tab=results`}
                    className="group grid min-w-0 flex-1 justify-items-center gap-1.5"
                    title={`${w.topic}: ${show}% showed up · engagement ${w.index}`}
                  >
                    <div className="flex h-32 w-full items-end gap-1">
                      <span
                        className="flex-1 rounded-t bg-brand/35"
                        style={{ height: `${Math.max(3, show)}%` }}
                      />
                      <span
                        className="flex-1 rounded-t bg-brand"
                        style={{ height: `${Math.max(3, w.index)}%` }}
                      />
                    </div>
                    <span className="w-full truncate text-center text-[11px] text-ink-3 group-hover:text-brand">
                      {w.topic}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>

        <div className="grid gap-4">
          <PeopleList
            title="Your best people"
            hint="came 2+, engaged"
            people={data.best}
            count={data.bestCount}
            empty="Once people come to two webinars and take part, they show up here."
            action={
              canMessage && data.bestCount > 0 ? (
                <Button
                  size="sm"
                  disabled={busy !== ""}
                  onClick={() =>
                    void message(PeopleHighlyEngaged, "Your best people")
                  }
                >
                  Message these {data.bestCount}
                </Button>
              ) : null
            }
            onSeeAll={() => onPick(PeopleHighlyEngaged)}
          />
          <PeopleList
            title="Slipping away"
            hint="registered 2+, never came"
            people={data.slipping}
            count={data.slippingCount}
            empty="Nobody has registered twice without coming. 🎉"
            action={
              canMessage && data.slippingCount > 0 ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy !== ""}
                  onClick={() =>
                    void message(PeopleSlipping, "People who keep missing it")
                  }
                >
                  Message these {data.slippingCount}
                </Button>
              ) : null
            }
            onSeeAll={() => onPick(PeopleSlipping)}
          />
        </div>
      </div>
      </div>
    </div>
  );
}

function SummaryError({ message }: { message: string }) {
  return (
    <p role="alert" className="text-[12.5px] text-live">
      {message}
    </p>
  );
}

const BONE = "animate-pulse bg-surface-2 motion-reduce:animate-none";

function Bone({ className }: { className: string }) {
  return <div className={`${BONE} ${className}`} />;
}

/** Same stack as the loaded summary, so the people table does not jump when data arrives. */
function SummarySkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Loading audience summary">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Bone className="h-[1lh] w-56 rounded-md text-[12.5px]" />
        <div className="flex rounded-lg border border-line bg-surface p-0.5" aria-hidden>
          {[6, 12, 50].map((n) => (
            <span
              key={n}
              className={`${BONE} rounded-md px-3 py-1 text-[12.5px] font-medium text-transparent`}
            >
              {n === 50 ? "All" : `Last ${n}`}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 min-[900px]:grid-cols-4">
        {["People reached", "Show-up rate", "Avg engagement", "Came back"].map((label) => (
          <Card key={label} className="px-4 py-3">
            <Bone className="h-[1lh] w-24 rounded-md text-[12px]" />
            <Bone className="mt-1 h-[1lh] w-14 rounded-md text-[22px] leading-tight" />
            <Bone className="mt-0.5 h-[1lh] w-32 rounded-md text-[11.5px]" />
          </Card>
        ))}
      </div>

      <div className="grid items-start gap-4 min-[900px]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Bone className="h-[1lh] w-36 rounded-md text-[13.5px]" />
            <Bone className="h-[1lh] w-40 rounded-md text-[11.5px]" />
          </div>
          <Bone className="h-40 w-full rounded-md" />
        </Card>
        <div className="grid gap-4">
          <PanelSkeleton />
          <PanelSkeleton />
        </div>
      </div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <Bone className="h-[1lh] w-32 rounded-md text-[13.5px]" />
        <Bone className="h-[1lh] w-24 rounded-md text-[11.5px]" />
      </div>
      <ul className="mt-2 divide-y divide-line">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex items-center gap-2.5 py-2">
            <Bone className="size-7 shrink-0 rounded-full" />
            <span className="min-w-0 flex-1">
              <Bone className="h-[1lh] w-28 rounded-md text-[13px]" />
              <Bone className="h-[1lh] w-36 rounded-md text-[11.5px]" />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between gap-2">
        <Bone className="h-8 w-36 rounded-lg" />
        <Bone className="h-[1lh] w-16 rounded-md text-[12px]" />
      </div>
    </Card>
  );
}

function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="mt-1 text-[22px] leading-tight font-semibold text-ink tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 text-[11.5px] text-ink-3">{note}</div>
    </Card>
  );
}

function Legend({ className, text }: { className: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span aria-hidden className={`size-2.5 rounded-sm ${className}`} />
      {text}
    </span>
  );
}

function PeopleList({
  title,
  hint,
  people,
  count,
  empty,
  action,
  onSeeAll,
}: {
  title: string;
  hint: string;
  people: CRMAudiencePerson[];
  count: number;
  empty: string;
  action: React.ReactNode;
  onSeeAll: () => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-ink">{title}</h3>
        <span className="text-[11.5px] text-ink-3">{hint}</span>
      </div>
      {people.length === 0 ? (
        <p className="py-3 text-[12.5px] text-ink-3">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {people.slice(0, 3).map((p) => (
            <li key={p.contactId} className="flex items-center gap-2.5 py-2">
              <PersonAvatar name={p.name || "?"} seed={p.contactId} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">
                  {p.name || "Unknown"}
                </span>
                <span className="block text-[11.5px] text-ink-3">
                  came to {p.attended} of {p.registered}
                  {p.attended > 0 ? ` · avg ${p.avgScore}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {(action || count > 3) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {action}
          {count > 0 && (
            <button
              type="button"
              onClick={onSeeAll}
              className="text-[12px] font-medium text-brand hover:underline"
            >
              See all {count}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
