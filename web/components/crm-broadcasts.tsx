"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, ConfirmModal, Select, Spinner } from "./controls";
import {
  BlockedList,
  RefreshTemplates,
  defaultTokens,
  exampleFor,
  renderTemplate,
  templateKey,
} from "./crm-templates";
import { SendIcon } from "./icons";
import { useToast } from "./providers";
import { Badge, Button, Card, Empty } from "./ui";
import { ApiError, api } from "@/lib/api";
import {
  AudienceOptedIn,
  AudienceTag,
  AudienceWebinar,
} from "@/lib/api-types";
import type {
  CRMAudienceResponse,
  CRMBroadcast,
  CRMMergeField,
  CRMParam,
  CRMTag,
  CRMTemplate,
  Webinar,
} from "@/lib/api-types";
import {
  formatRelative,
  instantToZoned,
  localTimeZone,
  zonedToInstant,
} from "@/lib/format";

/* Broadcasts — one message to many people.
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
 * None of that is enforced here. The server re-checks all of it.
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

export function Broadcasts({
  whatsappConnected,
  templates,
  templatesError,
  syncing,
  tags,
  onRefreshTemplates,
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
}) {
  const { notify } = useToast();
  const [broadcasts, setBroadcasts] = useState<CRMBroadcast[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [cancelling, setCancelling] = useState<CRMBroadcast | null>(null);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    api
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
      const updated = await api.cancelCrmBroadcast(cancelling.id);
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

  return (
    <div className="grid gap-4">
      {error && <Alert tone="error">{error}</Alert>}

      {composing ? (
        <Composer
          fields={fields}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          whatsappConnected={whatsappConnected}
          tags={tags}
          onRefreshTemplates={onRefreshTemplates}
          onClose={() => setComposing(false)}
          onCreated={(b) => {
            setBroadcasts((prev) => [b, ...(prev ?? [])]);
            setComposing(false);
          }}
        />
      ) : (
        whatsappConnected && (
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={() => setComposing(true)}>
              New broadcast
            </Button>
          </div>
        )
      )}

      {broadcasts.length === 0 ? (
        !composing && (
          <Empty
            title="No broadcasts yet"
            hint="A broadcast is one approved template sent to everyone who opted in — or to the people who registered for one webinar. Nothing is sent to anybody who opted out."
            action={
              whatsappConnected ? (
                <Button type="button" onClick={() => setComposing(true)}>
                  New broadcast
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <Card className="divide-y divide-line">
          {broadcasts.map((b) => (
            <BroadcastRow
              key={b.id}
              broadcast={b}
              onCancel={() => setCancelling(b)}
            />
          ))}
        </Card>
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

// --------------------------------------------------------------------- list

function BroadcastRow({
  broadcast: b,
  onCancel,
}: {
  broadcast: CRMBroadcast;
  onCancel: () => void;
}) {
  const s = b.stats;
  /* Only while there is something left to stop. A sent broadcast has nothing to
   * cancel, and offering the button would imply the messages could be recalled. */
  const stoppable = b.status === "scheduled" || b.status === "sending";

  return (
    <div className="grid gap-2 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium">{b.name}</span>
            <StatusBadge status={b.status} />
          </div>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {audienceText(b)} · {b.template} · {b.language}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-3">{whenText(b)}</p>
        </div>
        {stoppable && (
          <Button type="button" variant="danger" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>

      {/* Recipients always, the rest only once there is a number in it: a row of
          zeroes reads as something having gone wrong, and on a freshly scheduled
          broadcast nothing has. Delivered and read are subsets of sent, reported
          by WhatsApp later — a message can be sent and never delivered, to a
          number that is no longer on WhatsApp. */}
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
        <Stat label="recipients" value={s.recipients} always />
        <Stat label="waiting" value={s.queued} />
        <Stat label="sent" value={s.sent} />
        <Stat label="delivered" value={s.delivered} />
        <Stat label="read" value={s.read} />
        <Stat label="failed" value={s.failed} tone="live" />
        <Stat label="not sent" value={s.skipped} />
      </dl>
    </div>
  );
}

function Stat({
  label,
  value,
  always = false,
  tone,
}: {
  label: string;
  value: number;
  always?: boolean;
  tone?: "live";
}) {
  if (value === 0 && !always) return null;
  return (
    <div className="flex items-baseline gap-1">
      <dt className="sr-only">{label}</dt>
      <dd
        className={`text-[13px] font-semibold ${tone === "live" ? "text-live" : ""}`}
      >
        {value}
      </dd>
      <span aria-hidden className="text-ink-3">
        {label}
      </span>
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
    default:
      return <Badge tone="brand">Scheduled</Badge>;
  }
}

// ----------------------------------------------------------------- composer

type Timing = "now" | "later";

/** One audience count, tagged with the audience it was asked about so a stale
 *  answer can be recognised and dropped rather than shown against a different
 *  selection. */
type Counted = {
  key: string;
  res?: CRMAudienceResponse;
  error?: string;
};

function Composer({
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
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<string>(AudienceOptedIn);
  const [webinarId, setWebinarId] = useState("");
  const [tagId, setTagId] = useState("");
  const [chosen, setChosen] = useState("");
  /** One entry per `{{n}}`, in order — a merge field or the same words for
   *  everybody. Replaced wholesale when the template changes. */
  const [params, setParams] = useState<CRMParam[]>([]);
  const [timing, setTiming] = useState<Timing>("now");
  /* The chosen time, and whether it had already passed when it was chosen. The
   * second half is decided in the change handler rather than while rendering:
   * "is this in the past" is a question about the moment the host picked it, and
   * reading the clock during a render makes the answer depend on when React
   * happens to re-render. The server treats a past time as "now" either way. */
  const [when, setWhen] = useState({ at: "", past: false });
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [counted, setCounted] = useState<Counted | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Every webinar this host has, not only the upcoming ones: a broadcast to the
   * people who attended last week's is a real thing to want, and "thanks for
   * coming" is the most obvious broadcast there is. */
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

  /* The count, re-asked every time the audience changes. Its own request because
   * it is the decision: a host about to spend their own Meta credit on "everyone
   * who opted in" is entitled to know whether that is eleven people or four
   * thousand, and to find out without creating anything.
   *
   * Each answer carries the audience it was asked about, and a stale one is simply
   * not shown. That is the whole of the staleness handling: a number left over
   * from the previous selection is worse than no number, because it would be
   * read as this audience's. */
  const needsWebinar = audience === AudienceWebinar;
  const needsTag = audience === AudienceTag;
  const askable =
    (!needsWebinar || webinarId !== "") && (!needsTag || tagId !== "");
  const audienceKey = `${audience}\u0000${webinarId}\u0000${tagId}`;

  useEffect(() => {
    if (!askable) return;
    let cancelled = false;
    api
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
  }, [askable, audience, webinarId, tagId, audienceKey]);

  const current = counted?.key === audienceKey ? counted : null;
  const preview = current?.res ?? null;
  const previewError = current?.error ?? null;

  const usable = (templates ?? []).filter((t) => t.sendable);
  const blocked = (templates ?? []).filter((t) => !t.sendable);
  const template = usable.find((t) => templateKey(t) === chosen);

  function pickTemplate(key: string) {
    setChosen(key);
    const picked = usable.find((t) => templateKey(t) === key);
    /* Prefilled with the fields in the order they are offered, which for the
     * templates hosts actually write ("Hi {{1}}, {{2}} starts {{3}}") is usually
     * right first time. Values never carry across a template change — that would
     * put somebody's first name in a date. */
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

  /* One sentence rather than a disabled button with no explanation. In this order
   * because it is the order a host fills the form in — the first thing still
   * missing is the one worth naming. */
  const blocker = !whatsappConnected
    ? "Connect your own WhatsApp Business account to send anything."
    : !template
      ? "Pick the template to send."
      : needsWebinar && !webinarId
        ? "Pick the webinar whose registrants you mean."
        : needsTag && !tagId
          ? "Pick the tag you mean."
          : usesWebinarField && !webinarId
            ? "The webinar title and start time have to be read from a webinar, so pick one."
            : params.some((p) => !p.field && !(p.text ?? "").trim())
              ? "Every placeholder needs something to fill it — WhatsApp rejects a message with a blank in it rather than sending the rest."
              : timing === "later" && !scheduledAt
                ? "Pick when to send it."
                : timing === "later" && when.past
                  ? "That time has already passed."
                  : preview && preview.recipients === 0
                    ? "Nobody in this audience can be messaged: a broadcast only goes to contacts who opted in and have not opted out."
                    : null;

  async function send() {
    if (!template || blocker) return;
    setSaving(true);
    try {
      const created = await api.createCrmBroadcast({
        name: name.trim() || template.name,
        template: template.name,
        language: template.language,
        params,
        audience,
        /* Sent for the opted-in audience too when a webinar is picked: it is
         * then not the audience but the source of the topic and start time. */
        webinarId: webinarId || undefined,
        /* Only for the tag audience. A tag is never the source of anything a
         * message says, so unlike the webinar it has no second use here — and
         * the server ignores it for the other audiences. */
        tagId: needsTag ? tagId : undefined,
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
      /* The server's own sentence. Every refusal here names the thing that is
       * wrong — the template, one placeholder, the audience — and "could not
       * create that broadcast" would leave a host guessing which. */
      const message =
        e instanceof ApiError ? e.message : "Could not create that broadcast.";
      setError(message);
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  }

  if (templates === null) {
    return (
      <Card className="flex items-center gap-2 px-5 py-4 text-[12.5px] text-ink-2">
        <Spinner className="size-4 text-ink-3" />
        Loading your templates…
      </Card>
    );
  }

  /* No usable template means there is nothing to compose, and the reason is
   * Meta's rather than ours: a broadcast reaches people who have not written in,
   * and the only thing WhatsApp delivers then is wording it has approved. */
  if (usable.length === 0) {
    return (
      <Card className="grid gap-2 px-5 py-4">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
          {templatesError ??
            (blocked.length > 0
              ? "None of your templates can be sent yet."
              : "You have no WhatsApp templates yet.")}{" "}
          A broadcast can only be an approved template: it reaches people who
          have not written to you, and WhatsApp does not let a business send its
          own words then. Write one in WhatsApp Manager and Meta will review it.
        </p>
        {blocked.length > 0 && <BlockedList templates={blocked} />}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="grid gap-3.5 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">New broadcast</h2>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Sent from your own WhatsApp number and billed to your Meta account.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Discard
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div>
        <label className="label" htmlFor="broadcast-name">
          Name it, for your own list
        </label>
        <input
          id="broadcast-name"
          className="field"
          placeholder={template ? template.name : "October course launch"}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="mt-1 text-[11.5px] text-ink-3">
          Only you see this. Nothing in it is sent to anybody.
        </p>
      </div>

      <Select
        label="Who gets it"
        id="broadcast-audience"
        value={audience}
        onChange={setAudience}
        hint="Whichever you choose, only contacts who opted in to WhatsApp and have not opted out — a broadcast never goes to anybody else, whichever category the template is."
      >
        <option value={AudienceOptedIn}>Everyone who opted in</option>
        <option value={AudienceWebinar}>
          People who registered for one webinar
        </option>
        {tags !== null && (
          <option value={AudienceTag}>Everybody with one tag</option>
        )}
      </Select>

      {/* Only for the tag audience, and unlike the webinar picker there is no
          second reason to offer it: a tag says who, never what the message is
          about. Offered as a list of what exists rather than typed, so a
          broadcast cannot be addressed to a label nobody carries. */}
      {needsTag && (
        <Select
          label="Which tag"
          id="broadcast-tag"
          value={tagId}
          onChange={setTagId}
          hint={
            (tags ?? []).length === 0
              ? "You have no tags yet. Put one on somebody from their conversation on the Contacts tab first."
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

      {/* Offered for both audiences, and required for only one: the registrants
          audience IS a webinar, and for the opted-in list a webinar is still
          where the title and start time in the message come from. */}
      <Select
        label={needsWebinar ? "Which webinar" : "Webinar this message is about"}
        id="broadcast-webinar"
        value={webinarId}
        onChange={setWebinarId}
        hint={
          needsWebinar
            ? undefined
            : "Optional. Only needed if the message mentions the webinar title or when it starts."
        }
      >
        <option value="">{needsWebinar ? "Choose a webinar…" : "None"}</option>
        {(webinars ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {w.topic}
          </option>
        ))}
      </Select>

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

      <Select
        label="Template"
        id="broadcast-template"
        value={chosen}
        onChange={pickTemplate}
      >
        <option value="">Choose a template…</option>
        {usable.map((t) => (
          <option key={templateKey(t)} value={templateKey(t)}>
            {t.name} · {t.language} · {t.category.toLowerCase()}
          </option>
        ))}
      </Select>

      {template && (
        <>
          {params.length > 0 && (
            <div className="grid gap-2">
              {params.map((p, i) => (
                <div key={i} className="grid gap-2 sm:grid-cols-2">
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
                    <option value={LITERAL}>
                      The same words for everybody
                    </option>
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

          {/* The message as one recipient will read it, with the example values
              for the merge fields. A host approving "Hi {{1}}" has not read what
              they are about to send to a thousand people. */}
          <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
            {template.header && (
              <p className="text-[12.5px] font-semibold">{template.header}</p>
            )}
            <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap">
              {renderTemplate(template.body ?? "", filled)}
            </p>
            {template.footer && (
              <p className="mt-1 text-[11px] text-ink-3">{template.footer}</p>
            )}
          </div>
        </>
      )}

      <fieldset className="grid gap-2">
        <legend className="label">When</legend>
        <div className="flex flex-wrap items-center gap-4 text-[13px]">
          {(["now", "later"] as const).map((t) => (
            <label key={t} className="flex items-center gap-2">
              <input
                type="radio"
                name="broadcast-timing"
                className="size-4 accent-brand"
                checked={timing === t}
                onChange={() => setTiming(t)}
              />
              {t === "now" ? "Send now" : "Schedule it"}
            </label>
          ))}
        </div>
        {timing === "later" && (
          <div>
            <label className="sr-only" htmlFor="broadcast-at">
              When to send it
            </label>
            <input
              id="broadcast-at"
              type="datetime-local"
              className="field sm:max-w-64"
              min={localNow()}
              value={when.at}
              onChange={(e) => setWhen(chose(e.target.value))}
            />
            {/* The reader's own clock, said out loud: a host in Cape Town
                scheduling 09:00 means their 09:00, and a webinar's time zone is
                a different setting on a different screen. */}
            <p className="mt-1 text-[11.5px] text-ink-3">
              Your time zone ({localTimeZone()}). Messages go out within a
              minute or two of it.
            </p>
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
        <Button
          type="button"
          onClick={send}
          disabled={saving || blocker !== null}
          className="ml-auto"
        >
          {saving ? (
            <Spinner className="size-3.5" />
          ) : (
            <SendIcon className="size-3.5" />
          )}
          {timing === "later" ? "Schedule broadcast" : sendLabel(preview)}
        </Button>
      </div>

      {blocker ? (
        <p className="text-[11.5px] leading-relaxed text-ink-3">{blocker}</p>
      ) : (
        /* Said at the moment of the press, because it is the one thing about a
         * broadcast that cannot be undone afterwards. */
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          The audience is fixed when you press this. Anyone who opts out
          afterwards is dropped before their message goes out, and you can
          cancel whatever has not been sent yet.
        </p>
      )}

      {!whatsappConnected && (
        <Alert tone="warn">
          Connect your own WhatsApp Business account in{" "}
          <Link href="/account" className="font-medium underline">
            account settings
          </Link>{" "}
          to send this.
        </Alert>
      )}
    </Card>
  );
}

/* How many people this would reach, and why the rest would not.
 *
 * The four buckets are shown rather than swallowed: "40 of your 900 contacts" is
 * a reasonable thing to read, and a silent 40 looks like a broken list. They are
 * disjoint, so they add up to the size of the audience. */
function Audience({
  preview,
  error,
  waitingFor,
}: {
  preview: CRMAudienceResponse | null;
  error: string | null;
  /** What the audience still needs before it can be counted at all, named so the
   *  line says which picker is empty rather than "make a selection". */
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

// ------------------------------------------------------------------ helpers

/** The send button's own label, which names the number when there is one: the
 *  count is the last thing a host reads before pressing. */
function sendLabel(preview: CRMAudienceResponse | null): string {
  if (!preview || preview.recipients === 0) return "Send now";
  return `Send to ${countText(preview.recipients, "person", "people")}`;
}

function countText(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* The tag name comes down with the broadcast, and it is the name as it is NOW:
 * a renamed tag is the same tag, and a past broadcast saying "VIP" when the label
 * has since become "Priority" would describe a segment that no longer exists. Who
 * it actually went to is frozen in the recipient list either way. */
function audienceText(b: CRMBroadcast): string {
  if (b.audience === AudienceTag) {
    return `Everybody tagged ${b.tagName || "with one tag"}`;
  }
  if (b.audience !== AudienceWebinar) return "Everyone who opted in";
  return `Registrants for ${b.webinarTopic || b.webinarId || "a webinar"}`;
}

/** When it went, or when it will. Relative, because "in 3 hours" is what a host
 *  scanning the list is checking, and the exact minute is on the message. */
function whenText(b: CRMBroadcast): string {
  const when = formatRelative(b.scheduledAt, new Date());
  switch (b.status) {
    case "scheduled":
      return `Sending ${when}`;
    case "sending":
      return `Started ${when}`;
    case "cancelled":
      return `Cancelled, was due ${when}`;
    default:
      return `Sent ${when}`;
  }
}

/** A time the host has just picked, judged against the clock now — in a handler,
 *  where reading the clock is allowed, rather than during a render, where the
 *  answer would change every time the component happened to re-render. */
function chose(value: string): { at: string; past: boolean } {
  const instant = value ? zonedToInstant(...splitLocal(value)) : null;
  return {
    at: value,
    past: instant !== null && instant.getTime() < Date.now(),
  };
}

/** Now, as a `datetime-local` value, so the picker will not offer a time that
 *  has already gone. */
function localNow(): string {
  const { date, time } = instantToZoned(
    new Date().toISOString(),
    localTimeZone(),
  );
  return `${date}T${time}`;
}

/** A `datetime-local` value as the arguments zonedToInstant takes, read in the
 *  reader's own zone — which is the zone the input itself is in. */
function splitLocal(value: string): [string, string, string] {
  const [date = "", time = ""] = value.split("T");
  return [date, time, localTimeZone()];
}
