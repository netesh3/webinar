"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { engageApi } from "../api";
import { Select, Spinner } from "@/components/controls";
import { SearchIcon, SendIcon } from "@/components/icons";
import { Badge, Button, Card, Empty } from "@/components/ui";
import {
  PeopleAttended,
  PeopleNeverAttended,
  PeopleOptedIn,
  PeopleReplied,
  type CRMPeopleCounts,
  type CRMPeopleResponse,
  type CRMPerson,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { SendDialog, type SendTarget } from "./send-dialog";

/* Hosting → People: everybody who has registered for any of your webinars, once each.
 *
 * A tab beside Upcoming and Past rather than a separate CRM, because the question it
 * answers — "who are my people, and who should hear from me" — is asked from the same
 * place a host plans the next session. A person, not a registration: somebody who came
 * to three webinars is one row, with three against their name.
 */

const FILTERS: { id: string; label: string; count: (c: CRMPeopleCounts) => number }[] = [
  { id: "", label: "Everyone", count: (c) => c.everyone },
  { id: PeopleAttended, label: "Attended", count: (c) => c.attended },
  { id: PeopleNeverAttended, label: "Never attended", count: (c) => c.neverAttended },
  { id: PeopleReplied, label: "Replied", count: (c) => c.replied },
  { id: PeopleOptedIn, label: "WhatsApp opted in", count: (c) => c.optedIn },
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

  if (data.counts.everyone === 0 && !webinar && !query) {
    return (
      <Empty
        title="Nobody yet"
        hint="Everybody who registers for one of your webinars shows up here, once — however many they come to."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      {/* items-end: the webinar picker has a label above it; the search and the send
          button line up with its box, not with its label. */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative min-w-52 flex-1 sm:max-w-72">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
          <input
            className="field pl-9"
            placeholder="Search name, email or phone"
            aria-label="Search people"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="w-full sm:w-64">
          <Select label="Webinar" value={webinar} onChange={(v) => narrow(() => setWebinar(v))}>
            <option value="">All webinars ({data.webinarCount})</option>
            {data.webinars.map((w) => (
              <option key={w.id} value={w.id}>
                {w.topic}
              </option>
            ))}
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {ticked.size > 0 ? (
            <>
              <button
                type="button"
                className="text-[12px] text-ink-2 hover:text-ink"
                onClick={() => setTicked(new Set())}
              >
                Clear
              </button>
              <Button size="sm" onClick={messageTicked} disabled={!data.whatsappConnected}>
                <SendIcon className="size-3.5" />
                Message these {ticked.size}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              onClick={messageAll}
              disabled={!data.whatsappConnected || data.total === 0 || opening}
            >
              {opening ? <Spinner className="size-3.5" /> : <SendIcon className="size-3.5" />}
              Message all {data.total}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id || "all"}
            type="button"
            onClick={() => narrow(() => setFilter(f.id))}
            className={`rounded-full border px-3 py-1 text-[12px] font-medium transition ${
              filter === f.id
                ? "border-brand bg-brand-soft text-brand"
                : "border-line text-ink-2 hover:border-line-strong"
            }`}
          >
            {f.label} <span className="tabular-nums opacity-70">{f.count(data.counts)}</span>
          </button>
        ))}
      </div>

      {!data.whatsappConnected && (
        <p className="text-[12px] text-ink-3">
          Connect WhatsApp in{" "}
          <Link href="/account" className="font-medium text-brand hover:underline">
            Account settings
          </Link>{" "}
          to message people from here.
        </p>
      )}

      <Card className="overflow-x-auto p-0">
        {people.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-ink-3">
            Nobody matches that.
          </div>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-[11.5px] text-ink-3">
              <tr>
                <th className="w-10 py-2 pl-4 pr-3">
                  <input
                    type="checkbox"
                    aria-label="Tick everyone on this page"
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
                </th>
                <th className="py-2 pr-3 font-medium">Name</th>
                <th className="py-2 pr-3 font-medium">Webinars</th>
                <th className="py-2 pr-3 font-medium">{webinar ? "Watched" : "Last webinar"}</th>
                <th className="py-2 pr-3 font-medium">WhatsApp</th>
                <th className="py-2 pr-4 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {people.map((p) => (
                <PersonRow
                  key={p.contact.id}
                  person={p}
                  scoped={Boolean(webinar)}
                  ticked={ticked.has(p.contact.id)}
                  onTick={() =>
                    setTicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.contact.id)) next.delete(p.contact.id);
                      else next.add(p.contact.id);
                      return next;
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {data.total > PAGE && (
        <div className="flex items-center justify-between text-[12px] text-ink-2">
          <span>
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

function PersonRow({
  person: p,
  scoped,
  ticked,
  onTick,
}: {
  person: CRMPerson;
  scoped: boolean;
  ticked: boolean;
  onTick: () => void;
}) {
  const c = p.contact;
  const name = c.name || c.phone || c.email || "Unknown";
  return (
    <tr className={ticked ? "bg-brand-soft/40" : undefined}>
      <td className="py-2.5 pl-4 pr-3">
        <input
          type="checkbox"
          aria-label={`Tick ${name}`}
          className="size-3.5 accent-brand"
          checked={ticked}
          onChange={onTick}
        />
      </td>
      <td className="py-2.5 pr-3">
        <Link
          href={`/host?tab=messages&contact=${encodeURIComponent(c.id)}`}
          className="font-medium text-ink hover:text-brand"
        >
          {name}
        </Link>
        <div className="text-[11.5px] text-ink-3">{c.phone || c.email}</div>
      </td>
      <td className="py-2.5 pr-3 tabular-nums text-ink-2">{p.webinars}</td>
      <td className="max-w-56 py-2.5 pr-3 text-ink-2">
        {scoped ? (
          p.attended ? (
            `${p.watchMin} min`
          ) : (
            <span className="text-ink-3">Didn&apos;t join</span>
          )
        ) : (
          <span className="block truncate">{p.lastWebinar ?? "—"}</span>
        )}
      </td>
      <td className="py-2.5 pr-3">
        <WhatsAppBadge status={p.whatsappStatus} />
      </td>
      <td className="py-2.5 pr-4 text-ink-3">
        {c.lastSeenAt ? formatRelative(c.lastSeenAt, new Date()) : "—"}
      </td>
    </tr>
  );
}

export function WhatsAppBadge({ status }: { status: string }) {
  switch (status) {
    case "replied":
      return <Badge tone="ok">Replied</Badge>;
    case "opted_in":
    case "no_reply":
      return <Badge tone="brand">Opted in</Badge>;
    case "opted_out":
      return <Badge tone="live">Opted out</Badge>;
    case "no_number":
      return <span className="text-[12px] text-ink-3">No number</span>;
    default:
      return <span className="text-[12px] text-ink-3">Not opted in</span>;
  }
}
