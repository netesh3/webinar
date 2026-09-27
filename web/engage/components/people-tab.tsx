"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Spinner } from "@/components/controls";
import { ChevronDownIcon, SearchIcon, SendIcon } from "@/components/icons";
import { Button, Card, Empty } from "@/components/ui";
import {
  CRMStatusNoNumber,
  CRMStatusNoOptIn,
  CRMStatusOptedOut,
  PeopleAttended,
  PeopleNeverAttended,
  PeopleReplied,
  type CRMPeopleCounts,
  type CRMPeopleResponse,
  type CRMPerson,
} from "@/lib/api-types";
import { formatDuration } from "@/lib/format";
import { PersonAvatar } from "./wa-kit";
import { SendDialog, type SendTarget } from "./send-dialog";

/* Hosting → People: everybody who has registered for any of your webinars, once each.
 *
 * The question a coach brings here is "who should I follow up with?", so each row says
 * the two things that decide it — did they come, and to what — and nothing else. The
 * old columns that did not answer it are gone: a bare webinar count (now "came to 2 of
 * 3"), a WhatsApp column that read "Opted in" on almost every row (now only the
 * exceptions are shown, because those are the people a message will not reach), and a
 * "Last seen" that was blank for anyone who had never written in.
 *
 * "WhatsApp opted in" left the chips for the same reason: it is a property of the send,
 * and the send dialog already counts who can and cannot be reached.
 */

const FILTERS: { id: string; label: string; count: (c: CRMPeopleCounts) => number }[] = [
  { id: "", label: "Everyone", count: (c) => c.everyone },
  { id: PeopleAttended, label: "Came", count: (c) => c.attended },
  { id: PeopleNeverAttended, label: "Didn't come", count: (c) => c.neverAttended },
  { id: PeopleReplied, label: "Replied", count: (c) => c.replied },
];

const PAGE = 50;

export function HostPeopleTab({ initialWebinar = "" }: { initialWebinar?: string }) {
  const [webinar, setWebinar] = useState(initialWebinar);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<CRMPeopleResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<SendTarget | null>(null);
  const [opening, setOpening] = useState(false);

  // Typing settles for a moment before it becomes a request.
  useEffect(() => {
    const t = setTimeout(() => {
      if (q.trim() === query) return;
      setQuery(q.trim());
      setTicked(new Set());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q, query]);

  // A different list is a different selection, and starts at its first page.
  function narrow(apply: () => void) {
    apply();
    setTicked(new Set());
    setOffset(0);
  }

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmPeople({ webinarId: webinar, filter, q: query, offset })
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load your people.");
      });
    return () => {
      cancelled = true;
    };
  }, [webinar, filter, query, offset]);

  if (error && !data) return <Empty title={error} />;
  if (!data)
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );

  const people = data.people;
  const canMessage = data.whatsappConnected;
  const allOnPage = people.length > 0 && people.every((p) => ticked.has(p.contact.id));
  const webinarName = data.webinars.find((w) => w.id === webinar)?.topic;
  const filterName = FILTERS.find((f) => f.id === filter)?.label ?? "Everyone";

  async function messageAll() {
    setOpening(true);
    try {
      const { contactIds } = await engageApi.crmPeopleIds({ webinarId: webinar, filter, q: query });
      setTarget({
        kind: "contacts",
        contactIds,
        webinarId: webinar || undefined,
        label: [filterName, webinarName && `from ${webinarName}`].filter(Boolean).join(" "),
      });
    } finally {
      setOpening(false);
    }
  }

  function messageTicked() {
    setTarget({
      kind: "contacts",
      contactIds: [...ticked],
      webinarId: webinar || undefined,
      label: `${ticked.size} ${ticked.size === 1 ? "person" : "people"} you picked`,
    });
  }

  function messageOne(p: CRMPerson) {
    setTarget({
      kind: "contacts",
      contactIds: [p.contact.id],
      webinarId: webinar || undefined,
      label: displayName(p),
    });
  }

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (data.counts.everyone === 0 && !webinar && !query) {
    return (
      <Empty
        title="Nobody yet"
        hint="Everyone who registers for one of your webinars appears here once, however many they come to — so you can see who came and follow up."
      />
    );
  }

  const c = data.counts;

  return (
    <div className="grid gap-4">
      {/* The answer before the list: how big the audience is, and how much of it showed. */}
      <p className="text-[13px] text-ink-2">
        <span className="font-semibold text-ink tabular-nums">{c.everyone}</span>{" "}
        {c.everyone === 1 ? "person" : "people"}{" "}
        {webinarName ? (
          <>
            registered for <span className="font-medium text-ink">{webinarName}</span>
          </>
        ) : (
          <>
            from {data.webinarCount} {data.webinarCount === 1 ? "webinar" : "webinars"}
          </>
        )}
        {c.everyone > 0 && (
          <>
            {" "}
            · <span className="tabular-nums text-ok">{c.attended} came</span>
            {c.neverAttended > 0 && (
              <>
                {" "}
                · <span className="tabular-nums">{c.neverAttended} didn&apos;t</span>
              </>
            )}
          </>
        )}
      </p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative min-w-0 flex-1 sm:max-w-72">
          <span className="sr-only">Search people</span>
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            type="search"
            className="field h-9 pl-9 text-[13px]"
            placeholder="Search name, email or phone"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>

        <label className="relative min-w-0 sm:w-64">
          <span className="sr-only">Webinar</span>
          <select
            className="field h-9 appearance-none pr-8 text-[13px]"
            value={webinar}
            onChange={(e) => narrow(() => setWebinar(e.target.value))}
          >
            <option value="">All webinars</option>
            {data.webinars.map((w) => (
              <option key={w.id} value={w.id}>
                {w.topic}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-3" />
        </label>

        {canMessage && (
          <div className="flex items-center gap-2 sm:ml-auto">
            {ticked.size > 0 ? (
              <>
                <button
                  type="button"
                  className="text-[12.5px] text-ink-2 hover:text-ink"
                  onClick={() => setTicked(new Set())}
                >
                  Clear
                </button>
                <Button size="sm" onClick={messageTicked}>
                  <SendIcon className="size-3.5" />
                  Message {ticked.size} picked
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={messageAll} disabled={data.total === 0 || opening}>
                {opening ? <Spinner className="size-3.5" /> : <SendIcon className="size-3.5" />}
                Message {data.total === 1 ? "1 person" : `all ${data.total}`}
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {FILTERS.map((f) => {
          const on = filter === f.id;
          return (
            <button
              key={f.id || "all"}
              type="button"
              aria-pressed={on}
              onClick={() => narrow(() => setFilter(f.id))}
              className={`rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors ${
                on
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-line bg-surface text-ink-2 hover:border-line-2 hover:text-ink"
              }`}
            >
              {f.label} <span className="tabular-nums opacity-70">{f.count(c)}</span>
            </button>
          );
        })}
      </div>

      {!canMessage && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-brand-line bg-brand-soft/50 px-4 py-3">
          <p className="text-[13px] text-ink-2">
            <span className="font-medium text-ink">Follow up on WhatsApp.</span> Connect your
            number to message the people who came — or the ones who missed it.
          </p>
          <Link href="/account" className="text-[13px] font-medium text-brand hover:underline">
            Connect WhatsApp
          </Link>
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        {people.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-ink-3">
            Nobody matches that.
          </div>
        ) : (
          <>
            <div className="hidden items-center gap-3 border-b border-line px-4 py-2 text-[11.5px] text-ink-3 sm:flex">
              {canMessage && (
                <input
                  type="checkbox"
                  aria-label="Pick everyone on this page"
                  className="size-3.5 accent-brand"
                  checked={allOnPage}
                  onChange={() =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      for (const p of people) {
                        if (allOnPage) next.delete(p.contact.id);
                        else next.add(p.contact.id);
                      }
                      return next;
                    })
                  }
                />
              )}
              <span className="flex-1">Person</span>
              <span className="w-44">{webinar ? "At this webinar" : "Attendance"}</span>
              {!webinar && <span className="hidden w-56 md:block">Last webinar</span>}
              {canMessage && <span className="w-24" />}
            </div>
            <ul className="divide-y divide-line">
              {people.map((p) => (
                <PersonRow
                  key={p.contact.id}
                  person={p}
                  scoped={Boolean(webinar)}
                  canMessage={canMessage}
                  ticked={ticked.has(p.contact.id)}
                  onTick={() => toggle(p.contact.id)}
                  onMessage={() => messageOne(p)}
                />
              ))}
            </ul>
          </>
        )}
      </Card>

      {data.total > PAGE && (
        <div className="flex items-center justify-between text-[12px] text-ink-2">
          <span className="tabular-nums">
            {offset + 1}–{Math.min(offset + people.length, data.total)} of {data.total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={offset + people.length >= data.total}
              onClick={() => setOffset(offset + PAGE)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <SendDialog
        open={target !== null}
        target={target}
        onClose={() => setTarget(null)}
        onSent={() => setTicked(new Set())}
      />
    </div>
  );
}

function displayName(p: CRMPerson): string {
  const c = p.contact;
  return c.name || c.phone || c.email || "Unknown";
}

/** Why a message will not reach this person, or null when it will — the same rule the
 *  send applies (crmstore's `reachable`: a number, and a standing opt-in). */
function unreachable(p: CRMPerson): string | null {
  switch (p.whatsappStatus) {
    case CRMStatusNoNumber:
      return "No phone number";
    case CRMStatusOptedOut:
      return "Opted out";
    case CRMStatusNoOptIn:
      return "Not opted in";
    default:
      return null;
  }
}

function PersonRow({
  person: p,
  scoped,
  canMessage,
  ticked,
  onTick,
  onMessage,
}: {
  person: CRMPerson;
  scoped: boolean;
  canMessage: boolean;
  ticked: boolean;
  onTick: () => void;
  onMessage: () => void;
}) {
  const c = p.contact;
  const name = displayName(p);
  const blocked = unreachable(p);
  const replied = Boolean(c.lastInboundAt);
  const secondary = c.phone && c.email ? `${c.phone} · ${c.email}` : c.phone || c.email;

  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap ${
        ticked ? "bg-brand-soft/40" : "hover:bg-surface-2/50"
      }`}
    >
      {canMessage && (
        <input
          type="checkbox"
          aria-label={`Pick ${name}`}
          className="size-3.5 shrink-0 accent-brand"
          checked={ticked}
          onChange={onTick}
        />
      )}

      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PersonAvatar name={name} seed={c.id} size={34} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href={`/host?tab=messages&contact=${encodeURIComponent(c.id)}`}
              className="truncate text-[13.5px] font-medium text-ink hover:text-brand"
            >
              {name}
            </Link>
            {replied && (
              <span className="shrink-0 rounded-full bg-ok-soft px-1.5 py-px text-[10.5px] font-medium text-ok">
                Replied
              </span>
            )}
          </div>
          {secondary && (
            <div className="truncate text-[12px] text-ink-3 tabular-nums">{secondary}</div>
          )}
        </div>
      </div>

      <div className="w-full pl-[46px] sm:w-44 sm:pl-0">
        <Attendance person={p} scoped={scoped} />
      </div>

      {!scoped && (
        <div className="hidden w-56 min-w-0 md:block">
          <span className="block truncate text-[13px] text-ink-2" title={p.lastWebinar}>
            {p.lastWebinar ?? "—"}
          </span>
        </div>
      )}

      {canMessage && (
        <div className="flex w-full justify-end sm:w-24">
          {blocked ? (
            <span className="text-right text-[11.5px] leading-tight text-ink-3">{blocked}</span>
          ) : (
            <Button size="sm" variant="secondary" onClick={onMessage}>
              Message
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function Attendance({ person: p, scoped }: { person: CRMPerson; scoped: boolean }) {
  if (scoped) {
    return p.attended ? (
      <Status tone="ok" text={`Came · watched ${formatDuration(p.watchMin)}`} />
    ) : (
      <Status tone="muted" text="Didn't come" />
    );
  }
  if (p.webinars === 0) return <Status tone="muted" text="Not registered yet" />;
  if (p.attendedWebinars === 0) {
    return (
      <Status
        tone="muted"
        text={p.webinars === 1 ? "Didn't come" : `Missed all ${p.webinars}`}
      />
    );
  }
  return (
    <Status
      tone="ok"
      text={p.webinars === 1 ? "Came" : `Came to ${p.attendedWebinars} of ${p.webinars}`}
    />
  );
}

function Status({ tone, text }: { tone: "ok" | "muted"; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${tone === "ok" ? "bg-ok" : "bg-line-2"}`}
      />
      {text}
    </span>
  );
}
