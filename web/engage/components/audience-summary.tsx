"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { useToast } from "@/components/providers";
import { Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import {
  PeopleHighlyEngaged,
  PeopleSlipping,
  type CRMAudiencePerson,
  type CRMAudienceSummary,
} from "@/lib/api-types";
import { PersonAvatar } from "./wa-kit";

/* The top of the Audience tab: how people engage across your webinars. Read from the
 * stored rollup (migrations/0065) — nothing is recomputed to draw it. */
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
  const [data, setData] = useState<CRMAudienceSummary | null>(null);
  const [busy, setBusy] = useState("");
  const { notify } = useToast();

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmAudienceSummary(last)
      .then((r) => !cancelled && setData(r))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [last]);

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

  if (!data)
    return <div className="h-40 animate-pulse rounded-xl bg-surface-2" />;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px] text-ink-2">
          Across your last {data.webinars.length || last} webinars
        </span>
        <div className="flex gap-1.5">
          {[6, 12, 50].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setLast(n)}
              className={`rounded-full border px-3 py-1 text-[12px] font-medium ${
                last === n
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-line bg-surface text-ink-2 hover:text-ink"
              }`}
            >
              {n === 50 ? "All" : `Last ${n}`}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
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
