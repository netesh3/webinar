"use client";

import { engageApi } from "../api";
import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { Alert, ConfirmModal, Select, Spinner } from "@/components/controls";
import { DateTimeField } from "@/components/date-picker";
import {
  BlockedList,
  RefreshTemplates,
  defaultTokens,
  exampleFor,
  renderTemplate,
  templateKey,
} from "./crm-templates";
import { MaterialIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { Badge, Button, Card } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import {
  AudienceContacts,
  AudienceOptedIn,
  AudienceTag,
  AudienceWebinar,
  PeopleAttended,
  PeopleHighlyEngaged,
  PeopleHotLeads,
  PeopleNeverAttended,
} from "@/lib/api-types";
import type {
  CRMAudienceResponse,
  CRMBroadcast,
  CRMMergeField,
  CRMParam,
  CRMPeopleCounts,
  CRMTag,
  CRMTemplate,
  Webinar,
} from "@/lib/api-types";
import { formatRelative, instantToZoned, localTimeZone, zonedToInstant } from "@/lib/format";
import { useNow } from "@/lib/clock";
import { rupees, templateRate } from "./wa-kit";
import {
  audienceLabel,
  broadcastTitle,
  deliveryPercent,
  formatBroadcastStamp,
  languageLabel,
  readPercent,
} from "./broadcast-copy";

/* Broadcasts — one message to many people, on the WhatsApp tab.
 *
 * The composer is mostly an argument for showing the host the number before they
 * commit: every message here is charged to their own Meta account, so "everyone
 * who opted in" has to be a count on screen rather than a phrase they trust. That
 * is what the audience preview is, and it is asked again every time the audience
 * changes.
 *
 * Three rules from the server are visible in the shape of this form, because a
 * button that produces an error is worse than one that explains itself:
 *
 *   - a broadcast only ever reaches people who opted in, whatever category the
 *     template is — a marketing template is not a different audience, it is a
 *     different price;
 *   - the audience is frozen when the broadcast is created, so the count shown
 *     beside the send button is the number of people who will be messaged;
 *   - consent is checked AGAIN as each message leaves, so somebody who opts out
 *     an hour after a broadcast is scheduled never receives it.
 *
 * None of that is enforced here. The server re-checks all of it. There is no
 * draft and no duplicate: a broadcast is created by sending it, and the only
 * way to stop one is Cancel while messages are still waiting.
 */

/** How often a broadcast in flight re-reads itself, while the tab is being looked
 *  at. The outbox drains on a 30-second sweep, so there is nothing to see faster
 *  than this — and nothing to poll for at all once everything has gone out. */
const POLL_MS = 20_000;

/** The merge fields that read from a webinar, and so need one named. The server
 *  is the authority (it refuses with `crm_no_webinar`); this only saves the host
 *  a round trip to find out. */
const WEBINAR_FIELDS = ["topic", "when"];

/** The "same words for everybody" choice in a placeholder's picker. Not a token
 *  the server offers, which is exactly why it is safe as the sentinel. */
const LITERAL = "\u0000text";

const INTRO =
  "Send a one-off WhatsApp message to a group, like a replay link to no-shows or an invite to your next webinar. Automations send on their own; broadcasts go when you choose.";

/** Audiences the People page already messages, in the order the drawer shows them.
 *  Highly engaged and hot leads stay hidden until somebody is actually in them —
 *  the same rule as that page, so an empty "Hot leads" is not offered as a group. */
const PEOPLE_ROWS: {
  filter: string;
  label: string;
  count: (c: CRMPeopleCounts) => number;
  always: boolean;
}[] = [
  { filter: PeopleAttended, label: "Came", count: (c) => c.attended, always: true },
  {
    filter: PeopleNeverAttended,
    label: "Didn't come",
    count: (c) => c.neverAttended,
    always: true,
  },
  {
    filter: PeopleHighlyEngaged,
    label: "Highly engaged",
    count: (c) => c.highlyEngaged,
    always: false,
  },
  { filter: PeopleHotLeads, label: "Hot leads", count: (c) => c.hotLeads, always: false },
];

export type BroadcastPreset = "no-shows" | "past-attendees";

function presetFilter(preset: BroadcastPreset | null): string {
  if (preset === "no-shows") return PeopleNeverAttended;
  if (preset === "past-attendees") return PeopleAttended;
  return "";
}

export function Broadcasts({
  whatsappConnected,
  templates,
  templatesError,
  syncing,
  tags,
  onRefreshTemplates,
  onCount,
}: {
  whatsappConnected: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  /** The host's tags, or null when this account has no tags switched on — which
   *  is not the same as having none of them, and is why the third audience is
   *  hidden rather than offered and then refused. Handed down from the screen,
   *  which already reads them with the contacts list. */
  tags: CRMTag[] | null;
  onRefreshTemplates: () => void;
  /** Lets the tab badge follow a send or a cancel without another read. */
  onCount?: (n: number) => void;
}) {
  const { notify } = useToast();
  const [broadcasts, setBroadcasts] = useState<CRMBroadcast[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<BroadcastPreset | null | false>(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<CRMBroadcast | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmBroadcasts()
      .then((res) => {
        if (cancelled) return;
        setBroadcasts(res.broadcasts);
        setFields(res.fields);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setBroadcasts([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your broadcasts.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  useEffect(() => {
    if (broadcasts) onCount?.(broadcasts.length);
  }, [broadcasts, onCount]);

  /* Polled only while something is actually moving. A host reading last month's
   * campaigns is reading numbers that will not change, and a timer against a
   * background tab is a cost with no reader. */
  const inFlight = (broadcasts ?? []).some(
    (b) => b.status === "scheduled" || b.status === "sending",
  );

  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, refresh]);

  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    try {
      const updated = await engageApi.cancelCrmBroadcast(cancelling.id);
      setBroadcasts((prev) =>
        (prev ?? []).map((b) => (b.id === updated.id ? updated : b)),
      );
      setCancelling(null);
      notify(
        updated.stats.queued === 0 && updated.stats.sent === 0
          ? "Cancelled — nothing was sent."
          : `Cancelled. ${countText(updated.stats.sent, "message")} had already gone out.`,
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not cancel that broadcast.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  if (broadcasts === null) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  const openNew = (preset: BroadcastPreset | null) => setComposer(preset);

  return (
    <div className="grid gap-4">
      {error && <Alert tone="error">{error}</Alert>}

      {broadcasts.length === 0 ? (
        <EmptyBroadcasts onNew={openNew} />
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 max-w-2xl">
              <h2 className="text-[18px] font-semibold">Broadcasts</h2>
              <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{INTRO}</p>
            </div>
            <Button type="button" onClick={() => openNew(null)} className="shrink-0">
              New broadcast
            </Button>
          </div>
          <div className="grid gap-3">
            {broadcasts.map((b) => (
              <BroadcastCard
                key={b.id}
                broadcast={b}
                open={openId === b.id}
                onView={() => setOpenId((id) => (id === b.id ? null : b.id))}
                onCancel={() => setCancelling(b)}
              />
            ))}
          </div>
        </>
      )}

      {composer !== false && (
        <Composer
          preset={composer}
          fields={fields}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          whatsappConnected={whatsappConnected}
          tags={tags}
          onRefreshTemplates={onRefreshTemplates}
          onClose={() => setComposer(false)}
          onCreated={(b) => {
            setBroadcasts((prev) => [b, ...(prev ?? [])]);
            setComposer(false);
          }}
        />
      )}

      <ConfirmModal
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        onConfirm={cancel}
        busy={busy}
        title="Cancel this broadcast?"
        body="Everything still waiting will not be sent, and this cannot be undone — a cancelled broadcast is not rescheduled. Messages that have already left cannot be recalled."
        confirmLabel="Cancel broadcast"
      />
    </div>
  );
}

function EmptyBroadcasts({
  onNew,
}: {
  onNew: (preset: BroadcastPreset | null) => void;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="grid size-16 place-items-center rounded-full bg-brand-soft text-brand">
        <MaterialIcon name="campaign" className="!text-[32px]" />
      </span>
      <h2 className="mt-4 text-[18px] font-semibold">No broadcasts yet</h2>
      <p className="mt-1.5 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
        Message a whole group at once — for example, send the replay to people who missed it.
      </p>
      <Button type="button" className="mt-5" onClick={() => onNew(null)}>
        New broadcast
      </Button>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={() => onNew("no-shows")}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2 hover:border-line-2 hover:text-ink"
        >
          Replay to no-shows
        </button>
        <button
          type="button"
          onClick={() => onNew("past-attendees")}
          className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-2 hover:border-line-2 hover:text-ink"
        >
          Invite past attendees
        </button>
      </div>
    </div>
  );
}

function BroadcastCard({
  broadcast: b,
  open,
  onView,
  onCancel,
}: {
  broadcast: CRMBroadcast;
  open: boolean;
  onView: () => void;
  onCancel: () => void;
}) {
  const s = b.stats;
  /* Only while there is something left to stop. A sent broadcast has nothing to
   * cancel, and offering the button would imply the messages could be recalled. */
  const stoppable = b.status === "scheduled" || b.status === "sending";
  const width = deliveryPercent(s.delivered, s.recipients);
  const read = readPercent(s.read, s.sent);

  return (
    <Card className="px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-[15px] font-semibold">{broadcastTitle(b)}</h3>
            <StatusBadge status={b.status} />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Chip>{audienceLabel(b)}</Chip>
            <Chip>{b.template}</Chip>
            <Chip>{languageLabel(b.language)}</Chip>
          </div>
          <p className="mt-2 text-[12.5px] text-ink-3">{whenLine(b)}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {stoppable && (
            <Button type="button" variant="danger" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-expanded={open}
            onClick={onView}
            className="border-brand text-brand hover:bg-brand-soft"
          >
            View
          </Button>
        </div>
      </div>

      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={width}
        aria-label="Delivered"
      >
        <div className="h-full rounded-full bg-ok" style={{ width: `${width}%` }} />
      </div>

      <p className="mt-2.5 flex flex-wrap gap-x-2 text-[12.5px] text-ink-3">
        <StatBit label="Recipients" value={s.recipients} />
        <Dot />
        <StatBit label="Sent" value={s.sent} />
        <Dot />
        <StatBit label="Delivered" value={s.delivered} />
        <Dot />
        <span>
          Read <b className="font-semibold text-ink-2">{s.read}</b>
          {read && <span className="font-medium text-ok"> ({read})</span>}
        </span>
      </p>

      {open && (
        <dl className="mt-3 grid gap-1 border-t border-line pt-3 text-[12.5px] text-ink-2 sm:grid-cols-2">
          <Extra label="Waiting" value={s.queued} />
          <Extra label="Failed" value={s.failed} />
          <Extra label="Not sent" value={s.skipped} />
          <Extra label="Replied" value={s.replied} />
        </dl>
      )}
    </Card>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="inline-flex max-w-full truncate rounded-md bg-surface-2 px-2 py-0.5 text-[12px] text-ink-2">
      {children}
    </span>
  );
}

function Dot() {
  return <span aria-hidden>·</span>;
}

function StatBit({ label, value }: { label: string; value: number }) {
  return (
    <span>
      {label} <b className="font-semibold text-ink-2">{value}</b>
    </span>
  );
}

function Extra({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-3">
      <dt>{label}</dt>
      <dd className="font-semibold text-ink">{value}</dd>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "sending":
      return (
        <Badge tone="warn" dot>
          Sending
        </Badge>
      );
    case "sent":
      return <Badge tone="ok">Sent</Badge>;
    case "cancelled":
      return <Badge>Cancelled</Badge>;
    case "scheduled":
      return <Badge tone="brand">Scheduled</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
}

function whenLine(b: CRMBroadcast): string {
  const stamp = formatBroadcastStamp(b.scheduledAt);
  const relative = formatRelative(b.scheduledAt, new Date());
  switch (b.status) {
    case "scheduled":
      return stamp ? `Scheduled for ${stamp}` : `Sending ${relative}`;
    case "sending":
      return `Started ${relative}`;
    case "cancelled":
      return stamp ? `Cancelled, was due ${stamp}` : "Cancelled";
    default:
      return stamp ? `Sent ${relative} · ${stamp}` : `Sent ${relative}`;
  }
}

// ----------------------------------------------------------------- composer

type Timing = "now" | "later";
type Kind = "opted_in" | "people" | "webinar" | "tag";

/** One audience count, tagged with the audience it was asked about so a stale
 *  answer can be recognised and dropped rather than shown against a different
 *  selection. contactIds is set for a People-page group, which the broadcast
 *  API addresses by id — the same call the Audience page uses to message them. */
type Counted = {
  key: string;
  res?: CRMAudienceResponse;
  contactIds?: string[];
  error?: string;
};

function Composer({
  preset,
  fields,
  templates,
  templatesError,
  syncing,
  whatsappConnected,
  tags,
  onRefreshTemplates,
  onClose,
  onCreated,
}: {
  preset: BroadcastPreset | null;
  fields: CRMMergeField[];
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  whatsappConnected: boolean;
  /** Null when the account has no tags feature: the audience is not offered. */
  tags: CRMTag[] | null;
  onRefreshTemplates: () => void;
  onClose: () => void;
  onCreated: (b: CRMBroadcast) => void;
}) {
  const { notify } = useToast();
  const titleId = useId();
  const seeded = presetFilter(preset);
  const [kind, setKind] = useState<Kind>(seeded ? "people" : "opted_in");
  const [peopleFilter, setPeopleFilter] = useState(seeded);
  const [webinarId, setWebinarId] = useState("");
  const [tagId, setTagId] = useState("");
  const [chosen, setChosen] = useState("");
  const [params, setParams] = useState<CRMParam[]>([]);
  const [timing, setTiming] = useState<Timing>("now");
  const [when, setWhen] = useState({ at: "", past: false });
  const now = useNow(30_000);
  const zone = localTimeZone();
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [counted, setCounted] = useState<Counted | null>(null);
  const [optedInCount, setOptedInCount] = useState<number | null>(null);
  const [peopleCounts, setPeopleCounts] = useState<CRMPeopleCounts | null>(null);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* A People-page group that cannot be read is not a segment. The chip that
   * asked for it has already opened the drawer; the selection falls back here
   * without a second render committed from an effect. */
  const resolvedKind: Kind = peopleFailed && kind === "people" ? "opted_in" : kind;
  const resolvedFilter = resolvedKind === "people" ? peopleFilter : "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || saving) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, saving]);

  useEffect(() => {
    let cancelled = false;
    api
      .hostWebinarsForPicker()
      .then((list) => {
        if (!cancelled) setWebinars(list);
      })
      .catch(() => {
        if (!cancelled) setWebinars([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmAudience(AudienceOptedIn)
      .then((res) => {
        if (!cancelled) setOptedInCount(res.recipients);
      })
      .catch(() => {});
    engageApi
      .crmPeople({ limit: 1 })
      .then((res) => {
        if (!cancelled) setPeopleCounts(res.counts);
      })
      .catch(() => {
        if (!cancelled) setPeopleFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const needsWebinar = resolvedKind === "webinar";
  const needsTag = resolvedKind === "tag";
  const needsPeople = resolvedKind === "people";
  const askable =
    resolvedKind !== "people" &&
    (!needsWebinar || webinarId !== "") &&
    (!needsTag || tagId !== "");
  const audienceKey = needsPeople
    ? `people\u0000${resolvedFilter}`
    : `${resolvedKind}\u0000${webinarId}\u0000${tagId}`;

  useEffect(() => {
    if (!askable) return;
    let cancelled = false;
    const audience = needsTag
      ? AudienceTag
      : needsWebinar
        ? AudienceWebinar
        : AudienceOptedIn;
    engageApi
      .crmAudience(audience, webinarId, tagId)
      .then((res) => {
        if (!cancelled) setCounted({ key: audienceKey, res });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCounted({
          key: audienceKey,
          error:
            e instanceof ApiError && e.code !== "network"
              ? e.message
              : "Could not count that audience.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [askable, audienceKey, needsTag, needsWebinar, webinarId, tagId]);

  useEffect(() => {
    if (!needsPeople || !resolvedFilter) return;
    let cancelled = false;
    const key = `people\u0000${resolvedFilter}`;
    engageApi
      .crmPeopleIds({ filter: resolvedFilter })
      .then(async ({ contactIds }) => {
        if (cancelled) return;
        if (contactIds.length === 0) {
          setCounted({
            key,
            contactIds,
            res: {
              audience: AudienceContacts,
              recipients: 0,
              noOptIn: 0,
              optedOut: 0,
              noNumber: 0,
            },
          });
          return;
        }
        const res = await engageApi.crmAudienceFor({
          name: "",
          template: "",
          language: "",
          audience: AudienceContacts,
          contactIds,
        });
        if (!cancelled) setCounted({ key, res, contactIds });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCounted({
          key,
          error:
            e instanceof ApiError && e.code !== "network"
              ? e.message
              : "Could not count that audience.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [needsPeople, resolvedFilter]);

  const current = counted?.key === audienceKey ? counted : null;
  const preview = current?.res ?? null;
  const previewError = current?.error ?? null;

  const usable = (templates ?? []).filter((t) => t.sendable);
  const blocked = (templates ?? []).filter((t) => !t.sendable);
  const template = usable.find((t) => templateKey(t) === chosen);

  function pickTemplate(key: string) {
    setChosen(key);
    const picked = usable.find((t) => templateKey(t) === key);
    setParams(
      picked
        ? defaultTokens(picked.variables, fields).map((token) =>
            token ? { field: token } : { text: "" },
          )
        : [],
    );
  }

  function setParam(i: number, change: CRMParam) {
    setParams((prev) => prev.map((p, j) => (j === i ? change : p)));
  }

  function pickKind(next: Kind, filter = "") {
    setKind(next);
    setPeopleFilter(filter);
  }

  const filled = params.map((p) =>
    p.field ? exampleFor(fields, p.field) : (p.text ?? ""),
  );
  const usesWebinarField = params.some(
    (p) => p.field && WEBINAR_FIELDS.includes(p.field),
  );
  const scheduledAt =
    timing === "later" && when.at
      ? zonedToInstant(...splitLocal(when.at))
      : null;
  const peopleLabel =
    PEOPLE_ROWS.find((row) => row.filter === resolvedFilter)?.label ?? "";

  const blocker = !whatsappConnected
    ? "Connect your own WhatsApp Business account to send anything."
    : !template
      ? "Pick the template to send."
      : needsWebinar && !webinarId
        ? "Pick the webinar whose registrants you mean."
        : needsTag && !tagId
          ? "Pick the tag you mean."
            : needsPeople && !resolvedFilter
            ? "Pick who should get this."
            : usesWebinarField && !webinarId
              ? "The webinar title and start time have to be read from a webinar, so pick one."
              : params.some((p) => !p.field && !(p.text ?? "").trim())
                ? "Every placeholder needs something to fill it — WhatsApp rejects a message with a blank in it rather than sending the rest."
                : timing === "later" && !scheduledAt
                  ? "Pick when to send it."
                  : timing === "later" && when.past
                    ? "That time has already passed."
                    : previewError || (needsPeople && !preview)
                      ? ""
                      : preview && preview.recipients === 0
                          ? "Nobody in this audience can be messaged: a broadcast only goes to contacts who opted in and have not opted out."
                          : null;

  function audienceName(): string {
    if (resolvedKind === "people") return peopleLabel || "Selected people";
    if (resolvedKind === "webinar") {
      const topic = (webinars ?? []).find((w) => w.id === webinarId)?.topic;
      return topic ? `Registrants for ${topic}` : "Registrants";
    }
    if (resolvedKind === "tag") {
      const tag = (tags ?? []).find((t) => t.id === tagId);
      return tag ? `Everybody tagged ${tag.name}` : "Tagged";
    }
    return "Everyone who opted in";
  }

  async function send() {
    if (!template || blocker !== null) return;
    if (needsPeople && !(current?.contactIds && current.contactIds.length > 0)) return;
    setSaving(true);
    try {
      const created = await engageApi.createCrmBroadcast({
        name: audienceName(),
        template: template.name,
        language: template.language,
        params,
        audience: needsPeople
          ? AudienceContacts
          : needsTag
            ? AudienceTag
            : needsWebinar
              ? AudienceWebinar
              : AudienceOptedIn,
        webinarId:
          (needsWebinar || usesWebinarField) && webinarId ? webinarId : undefined,
        tagId: needsTag ? tagId : undefined,
        contactIds: needsPeople ? current?.contactIds : undefined,
        scheduledAt: scheduledAt ? scheduledAt.toISOString() : undefined,
      });
      setError(null);
      notify(
        created.status === "scheduled" && created.stats.sent === 0
          ? `Queued for ${countText(created.stats.recipients, "person", "people")}.`
          : `Sending to ${countText(created.stats.recipients, "person", "people")}.`,
        "ok",
      );
      onCreated(created);
    } catch (e: unknown) {
      const message =
        e instanceof ApiError ? e.message : "Could not create that broadcast.";
      setError(message);
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  }

  const peopleRows = PEOPLE_ROWS.filter((row) => {
    if (peopleFailed) return false;
    if (!peopleCounts) return row.always;
    return row.always || row.count(peopleCounts) > 0;
  });

  function rowCount(rowKind: Kind, filter = ""): number | null {
    if (rowKind === "opted_in") return optedInCount;
    if (rowKind === "people") {
      if (resolvedKind === "people" && filter === resolvedFilter && preview) return preview.recipients;
      if (!peopleCounts) return null;
      const row = PEOPLE_ROWS.find((item) => item.filter === filter);
      return row ? row.count(peopleCounts) : null;
    }
    if (rowKind === resolvedKind && preview) return preview.recipients;
    return null;
  }

  const rate = template ? templateRate(template) : 0;
  const showCost = rate > 0 && preview != null && preview.recipients > 0;
  const scheduleStamp =
    timing === "later" && when.at && scheduledAt
      ? formatBroadcastStamp(scheduledAt.toISOString())
      : "";

  const node = (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-scrim/35"
        onClick={() => {
          if (!saving) onClose();
        }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-[440px] flex-col bg-surface shadow-[-12px_0_32px_rgba(16,24,40,0.1)] outline-none"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-[16px] font-semibold">
            New broadcast
          </h2>
          <button
            type="button"
            onClick={() => {
              if (!saving) onClose();
            }}
            aria-label="Close"
            className="grid size-8 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <MaterialIcon name="close" className="!text-[18px]" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          {error && <Alert tone="error">{error}</Alert>}

          <section className="grid gap-2">
            <SectionHead n={1} title="Who" />
            <div className="grid gap-1" role="radiogroup" aria-label="Who gets it">
              <WhoRow
                label="Everyone who opted in"
                count={rowCount("opted_in")}
                checked={resolvedKind === "opted_in"}
                onPick={() => pickKind("opted_in")}
              />
              {peopleRows.map((row) => (
                <WhoRow
                  key={row.filter}
                  label={row.label}
                  count={rowCount("people", row.filter)}
                  checked={resolvedKind === "people" && resolvedFilter === row.filter}
                  onPick={() => pickKind("people", row.filter)}
                />
              ))}
              <WhoRow
                label="Registered for one webinar"
                count={rowCount("webinar")}
                checked={resolvedKind === "webinar"}
                onPick={() => pickKind("webinar")}
              />
              {tags !== null && (
                <WhoRow
                  label="Everybody with one tag"
                  count={rowCount("tag")}
                  checked={resolvedKind === "tag"}
                  onPick={() => pickKind("tag")}
                />
              )}
            </div>

            {needsTag && (
              <Select
                label="Which tag"
                id="broadcast-tag"
                value={tagId}
                onChange={setTagId}
                hint={
                  (tags ?? []).length === 0
                    ? "You have no tags yet. Put one on somebody from their conversation first."
                    : undefined
                }
              >
                <option value="">Choose a tag…</option>
                {(tags ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({countText(t.contacts, "contact")})
                  </option>
                ))}
              </Select>
            )}

            {(needsWebinar || usesWebinarField) && (
              <Select
                label={needsWebinar ? "Which webinar" : "Webinar this message is about"}
                id="broadcast-webinar"
                value={webinarId}
                onChange={setWebinarId}
                hint={
                  needsWebinar
                    ? undefined
                    : "The webinar title and start time are read from this."
                }
              >
                <option value="">
                  {needsWebinar ? "Choose a webinar…" : "Choose a webinar…"}
                </option>
                {(webinars ?? []).map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.topic}
                  </option>
                ))}
              </Select>
            )}

            <Audience
              preview={preview}
              error={previewError}
              waitingFor={
                needsWebinar && !webinarId
                  ? "webinar"
                  : needsTag && !tagId
                    ? "tag"
                    : null
              }
            />
          </section>

          <section className="grid gap-2">
            <SectionHead n={2} title="Message" />
            {templates === null ? (
              <p className="flex items-center gap-2 text-[12.5px] text-ink-2">
                <Spinner className="size-4 text-ink-3" />
                Loading your templates…
              </p>
            ) : usable.length === 0 ? (
              <div className="grid gap-2">
                <p className="text-[12.5px] leading-relaxed text-ink-2">
                  {templatesError ??
                    (blocked.length > 0
                      ? "None of your templates can be sent yet."
                      : "You have no WhatsApp templates yet.")}{" "}
                  A broadcast can only be an approved template: it reaches people who
                  have not written to you, and WhatsApp does not let a business send its
                  own words then. Write one in WhatsApp Manager and Meta will review it.
                </p>
                {blocked.length > 0 && <BlockedList templates={blocked} />}
                <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
              </div>
            ) : (
              <>
                <Select
                  label="Template"
                  id="broadcast-template"
                  value={chosen}
                  onChange={pickTemplate}
                >
                  <option value="">Choose a template…</option>
                  {usable.map((t) => (
                    <option key={templateKey(t)} value={templateKey(t)}>
                      {t.name} · {languageLabel(t.language)} · {t.category.toLowerCase()}
                    </option>
                  ))}
                </Select>
                {template && (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      <Chip>{template.name}</Chip>
                      <span className="inline-flex rounded-md bg-ok-soft px-2 py-0.5 text-[12px] font-medium text-ok">
                        {template.status.toUpperCase() === "APPROVED"
                          ? "Approved"
                          : template.status}
                      </span>
                      <Chip>{languageLabel(template.language)}</Chip>
                    </div>
                    {params.length > 0 && (
                      <div className="grid gap-2">
                        {params.map((p, i) => (
                          <div key={i} className="grid gap-2">
                            <Select
                              label={`Fill {{${i + 1}}} with`}
                              id={`broadcast-param-${i}`}
                              value={p.field || LITERAL}
                              onChange={(next) =>
                                setParam(
                                  i,
                                  next === LITERAL ? { text: "" } : { field: next },
                                )
                              }
                            >
                              {fields.map((f) => (
                                <option key={f.token} value={f.token}>
                                  {f.label}
                                </option>
                              ))}
                              <option value={LITERAL}>The same words for everybody</option>
                            </Select>
                            {!p.field && (
                              <div>
                                <label className="label" htmlFor={`broadcast-text-${i}`}>
                                  {`What {{${i + 1}}} says`}
                                </label>
                                <input
                                  id={`broadcast-text-${i}`}
                                  className="field"
                                  value={p.text ?? ""}
                                  onChange={(e) => setParam(i, { text: e.target.value })}
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <div
                      className="rounded-xl px-3 py-3"
                      style={{ background: "#e7f6e9" }}
                    >
                      <div className="max-w-[92%] rounded-lg rounded-tl-sm bg-[#d9fdd3] px-3 py-2 text-[13px] leading-relaxed text-[#111] shadow-sm">
                        {template.header && (
                          <p className="font-semibold">{template.header}</p>
                        )}
                        <p className="whitespace-pre-wrap">
                          {renderTemplate(template.body ?? "", filled)}
                        </p>
                        {template.footer && (
                          <p className="mt-1 text-[11px] text-[#667781]">{template.footer}</p>
                        )}
                        <p className="mt-0.5 text-right text-[10px] text-[#667781]">
                          {new Date().toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </section>

          <section className="grid gap-2">
            <SectionHead n={3} title="When" />
            <div className="grid grid-cols-2 gap-2">
              <WhenCard
                title="Send now"
                hint="Goes out immediately"
                checked={timing === "now"}
                onPick={() => setTiming("now")}
              />
              <WhenCard
                title="Schedule"
                hint={scheduleStamp || "Pick a time"}
                checked={timing === "later"}
                onPick={() => setTiming("later")}
              />
            </div>
            {timing === "later" && (
              <div>
                <DateTimeField
                  id="broadcast-at"
                  ariaLabel="When to send it"
                  date={when.at.slice(0, 10)}
                  time={when.at.length >= 16 ? when.at.slice(11, 16) : ""}
                  timeZone={zone}
                  minDate={
                    now != null
                      ? instantToZoned(new Date(now).toISOString(), zone).date
                      : undefined
                  }
                  notBeforeMs={now ?? undefined}
                  rule="Must be in the future"
                  onChange={(date, time) => setWhen(chose(`${date}T${time}`))}
                />
                <p className="mt-1 text-[11.5px] text-ink-3">
                  Your time zone ({zone}). Messages go out within a minute or two of it.
                </p>
              </div>
            )}
          </section>

          {!whatsappConnected && (
            <Alert tone="warn">
              Connect your own WhatsApp Business account in{" "}
              <Link href="/settings#integrations" className="font-medium underline">
                account settings
              </Link>{" "}
              to send this.
            </Alert>
          )}

          {blocker && (
            <p className="text-[11.5px] leading-relaxed text-ink-3">{blocker}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
          {showCost && preview ? (
            <p className="text-[12px] text-ink-3">
              ≈ {rupees(rate)} per message · {preview.recipients}{" "}
              {preview.recipients === 1 ? "recipient" : "recipients"}
            </p>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                if (!saving) onClose();
              }}
            >
              Cancel
            </Button>
            <Button type="button" onClick={send} disabled={saving || blocker !== null}>
              {saving && <Spinner className="size-3.5" />}
              {timing === "later" ? "Schedule broadcast" : "Send broadcast"}
            </Button>
          </div>
        </div>
      </aside>
    </div>
  );

  return createPortal(node, document.body);
}

function SectionHead({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-6 place-items-center rounded-full bg-brand-soft text-[12px] font-semibold text-brand">
        {n}
      </span>
      <h3 className="text-[14px] font-semibold">{title}</h3>
    </div>
  );
}

function WhoRow({
  label,
  count,
  checked,
  onPick,
}: {
  label: string;
  count: number | null;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 ${
        checked ? "bg-brand-soft" : "hover:bg-surface-2"
      }`}
    >
      <input
        type="radio"
        name="broadcast-who"
        className="size-4 accent-brand"
        checked={checked}
        onChange={onPick}
      />
      <span className="min-w-0 flex-1 text-[13.5px]">{label}</span>
      {count != null && (
        <span className="tabular-nums text-[13px] text-ink-3">{count}</span>
      )}
    </label>
  );
}

function WhenCard({
  title,
  hint,
  checked,
  onPick,
}: {
  title: string;
  hint: string;
  checked: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={checked}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 text-left ${
        checked ? "border-brand bg-brand-soft/40 ring-1 ring-brand" : "border-line"
      }`}
    >
      <span
        className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${
          checked ? "border-brand" : "border-line-2"
        }`}
        aria-hidden
      >
        {checked && <span className="size-2 rounded-full bg-brand" />}
      </span>
      <span>
        <span className="block text-[13.5px] font-medium">{title}</span>
        <span className="mt-0.5 block text-[12px] text-ink-3">{hint}</span>
      </span>
    </button>
  );
}

function Audience({
  preview,
  error,
  waitingFor,
}: {
  preview: CRMAudienceResponse | null;
  error: string | null;
  waitingFor: "webinar" | "tag" | null;
}) {
  if (error) return <Alert tone="warn">{error}</Alert>;
  if (waitingFor) {
    return (
      <p className="text-[12px] text-ink-3">
        {waitingFor === "tag"
          ? "Pick a tag to see how many of the people carrying it can be messaged."
          : "Pick a webinar to see how many of its registrants can be messaged."}
      </p>
    );
  }
  if (!preview) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-ink-3">
        <Spinner className="size-3.5" />
        Counting…
      </p>
    );
  }

  const excluded = [
    preview.noOptIn > 0 && `${preview.noOptIn} never opted in`,
    preview.optedOut > 0 && `${preview.optedOut} opted out`,
    preview.noNumber > 0 && `${preview.noNumber} left no number`,
  ].filter((s): s is string => typeof s === "string");

  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
      <p className="text-[13px] font-medium">
        {preview.recipients === 0
          ? "Nobody can be messaged"
          : `${countText(preview.recipients, "person", "people")} will get this`}
      </p>
      {excluded.length > 0 && (
        <p className="mt-0.5 text-[11.5px] text-ink-3">
          Not sent to {excluded.join(", ")}.
        </p>
      )}
    </div>
  );
}

function countText(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function chose(value: string): { at: string; past: boolean } {
  const instant = value ? zonedToInstant(...splitLocal(value)) : null;
  return {
    at: value,
    past: instant !== null && instant.getTime() < Date.now(),
  };
}

function splitLocal(value: string): [string, string, string] {
  const [date = "", time = ""] = value.split("T");
  return [date, time, localTimeZone()];
}
