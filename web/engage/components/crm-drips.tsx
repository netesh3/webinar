"use client";

import { engageApi } from "../api";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, ConfirmModal, Select, Spinner, Toggle } from "@/components/controls";
import {
  BlockedList,
  RefreshTemplates,
  defaultTokens,
  exampleFor,
  renderTemplate,
  templateKey,
} from "./crm-templates";
import { useToast } from "@/components/providers";
import { Badge, Button, Card, Empty } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { DripManual, DripTagAdded } from "@/lib/api-types";
import type {
  CRMContact,
  CRMDrip,
  CRMDripEnrollment,
  CRMDripStep,
  CRMMergeField,
  CRMParam,
  CRMTag,
  CRMTemplate,
  Webinar,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* Sequences — several messages, sent over days, to people who have not registered yet.
 *
 * The difference from the broadcast composer next door is who is present when this
 * sends: nobody. A broadcast is a decision about a list that exists, taken while the
 * host watches the count; a sequence is a rule about people who will sign up next
 * month, and its third message goes out on a Tuesday with nobody looking.
 *
 * Three things in this screen follow from that:
 *
 *   - the builder shows the whole sequence as a timeline, with each step's wait
 *     accumulated into "2 days after they join". A host reading "1440 minutes" three
 *     times over cannot tell what day the last message lands on.
 *   - pausing is offered at least as prominently as deleting. Pausing holds everybody
 *     where they are; deleting forgets who was on it, and an unpaused mistake keeps
 *     messaging people while the host works out what to do about it.
 *   - the people on a sequence are shown with their place in it and, when they left
 *     early, why. "Exited: opted out" is the answer to the only question a host asks
 *     about a sequence that has stopped for somebody.
 *
 * Nothing here is what makes a step legal. The server checks consent at entry, again
 * when the step is queued and again as it leaves.
 */

/** How often a running sequence re-reads itself, while the tab is being looked at.
 *  Steps are queued by a 30-second sweep on the server, so positions move with
 *  nobody clicking anything — but there is nothing to see faster than this. */
const POLL_MS = 20_000;

/** The merge fields that read from a webinar. The server is the authority (it
 *  refuses with `crm_no_webinar`); this only saves a round trip to find out. */
const WEBINAR_FIELDS = ["topic", "when"];

/** The "same words for everybody" choice in a placeholder's picker. Not a token the
 *  server offers, which is what makes it safe as the sentinel. */
const LITERAL = "\u0000text";

const TRIGGER_LABELS: Record<string, string> = {
  manual: "People I add myself",
  registered: "When somebody registers",
  attended: "When a webinar ends — the people who came",
  no_show: "When a webinar ends — the people who missed it",
  ended: "When a webinar ends — everybody who registered",
  /* The only rule that is not about a webinar, which is the whole point of it: a
   * host who tags somebody "wants a call" has said something no registration
   * could, and this is how that turns into messages. Offered only when the server
   * lists it, so an account without tags never sees a rule it cannot use. */
  tag_added: "When I put a tag on somebody",
};

/** The same rules, short enough for a row in the list. */
const TRIGGER_SHORT: Record<string, string> = {
  manual: "Added by hand",
  registered: "On registering",
  attended: "Attended",
  no_show: "No-show",
  ended: "Webinar ended",
  tag_added: "Tag added",
};

export function Drips({
  whatsappConnected,
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
}: {
  whatsappConnected: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
}) {
  const { notify } = useToast();
  const [drips, setDrips] = useState<CRMDrip[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [triggers, setTriggers] = useState<string[]>([]);
  /** The tags a `tag_added` rule may name. Empty when that trigger is not offered,
   *  which is the same condition — the server decides both. */
  const [tags, setTags] = useState<CRMTag[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The sequence being written: a fresh one, or the one being edited. */
  const [editing, setEditing] = useState<CRMDrip | "new" | null>(null);
  const [deleting, setDeleting] = useState<CRMDrip | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmDrips()
      .then((res) => {
        if (cancelled) return;
        setDrips(res.drips);
        setFields(res.fields);
        setTriggers(res.triggers);
        setTags(res.tags);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDrips([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your sequences.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  /* Polled only while somebody is actually part-way through one. A host reading a
   * paused sequence, or one nobody has entered, is reading numbers that will not
   * change on their own. */
  const running = (drips ?? []).some((d) => d.active && d.stats.active > 0);

  useEffect(() => {
    if (!running || editing !== null) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [running, editing, refresh]);

  /* Pausing is a full save, because the sequence is written as a whole — see the
   * PUT in lib/api.ts. Worth the round trip for how often it is the right answer to
   * a mistake: everybody keeps their place, and nothing is sent meanwhile. */
  async function setActive(drip: CRMDrip, active: boolean) {
    setBusy(drip.id);
    try {
      const saved = await engageApi.updateCrmDrip(drip.id, {
        name: drip.name,
        trigger: drip.trigger,
        webinarId: drip.webinarId,
        active,
        steps: drip.steps,
      });
      setDrips((prev) =>
        (prev ?? []).map((d) => (d.id === saved.drip.id ? saved.drip : d)),
      );
      notify(
        active
          ? "Running again — anybody waiting gets their next message within a minute."
          : "Paused. Nobody new joins it and nothing is sent, and everybody keeps their place.",
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not change that sequence.",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusy(deleting.id);
    try {
      await engageApi.deleteCrmDrip(deleting.id);
      setDrips((prev) => (prev ?? []).filter((d) => d.id !== deleting.id));
      setDeleting(null);
      notify("Sequence deleted.", "ok");
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not delete that sequence.",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  if (drips === null) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (editing !== null) {
    return (
      <div className="grid gap-4">
        {error && <Alert tone="error">{error}</Alert>}
        <Builder
          drip={editing === "new" ? null : editing}
          fields={fields}
          triggers={triggers}
          tags={tags}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          whatsappConnected={whatsappConnected}
          onRefreshTemplates={onRefreshTemplates}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setDrips((prev) => {
              const list = prev ?? [];
              return list.some((d) => d.id === saved.id)
                ? list.map((d) => (d.id === saved.id ? saved : d))
                : [saved, ...list];
            });
            setEditing(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      {error && <Alert tone="error">{error}</Alert>}

      {whatsappConnected && drips.length > 0 && (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => setEditing("new")}>
            New sequence
          </Button>
        </div>
      )}

      {drips.length === 0 ? (
        <Empty
          title="No sequences yet"
          hint="A sequence sends several approved templates over days — a welcome after somebody registers, a follow-up for the people who missed the webinar. It keeps running for everybody who registers from now on, and stops the moment somebody opts out."
          action={
            whatsappConnected ? (
              <Button type="button" onClick={() => setEditing("new")}>
                New sequence
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3">
          {drips.map((d) => (
            <DripRow
              key={d.id}
              drip={d}
              fields={fields}
              busy={busy === d.id}
              whatsappConnected={whatsappConnected}
              onEdit={() => setEditing(d)}
              onToggle={(active) => setActive(d, active)}
              onDelete={() => setDeleting(d)}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={remove}
        busy={busy !== null}
        title="Delete this sequence?"
        body="Anybody part-way through stops where they are and is forgotten, so a later registration could put them on a new sequence from the beginning. Messages already sent stay in their conversations. Pausing it instead keeps everybody's place."
        confirmLabel="Delete sequence"
      />
    </div>
  );
}

// --------------------------------------------------------------------- list

function DripRow({
  drip: d,
  fields,
  busy,
  whatsappConnected,
  onEdit,
  onToggle,
  onDelete,
}: {
  drip: CRMDrip;
  fields: CRMMergeField[];
  busy: boolean;
  whatsappConnected: boolean;
  onEdit: () => void;
  onToggle: (active: boolean) => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const s = d.stats;

  return (
    <Card className="grid gap-3 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-medium">{d.name}</span>
            {d.active ? (
              <Badge tone="ok" dot>
                Running
              </Badge>
            ) : (
              <Badge tone="warn">Paused</Badge>
            )}
          </div>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {TRIGGER_SHORT[d.trigger] ?? d.trigger}
            {/* Whichever one this rule is scoped to, and never both — a sequence
                is about a webinar or about a tag. The tag's name is read as it is
                now, because renaming a label does not make it another one. */}
            {d.tagName ? ` · ${d.tagName}` : ""}
            {d.webinarTopic ? ` · ${d.webinarTopic}` : ""} ·{" "}
            {d.steps.length === 1 ? "1 message" : `${d.steps.length} messages`}
            {d.steps.length > 1 ? ` over ${spanText(d.steps)}` : ""}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-3">
            Created {formatRelative(d.createdAt, new Date())}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Pause before delete, and in that order on purpose: it is what a host
              who has spotted a mistake in a running sequence actually wants. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || !whatsappConnected}
            onClick={() => onToggle(!d.active)}
          >
            {busy ? (
              <Spinner className="size-3.5" />
            ) : d.active ? (
              "Pause"
            ) : (
              "Resume"
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!whatsappConnected}
            onClick={onEdit}
          >
            Edit
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      {/* People first, messages second: "how many are on it" is the question, and
          "what has that cost" is the follow-up. */}
      <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px]">
        <Stat label="part-way through" value={s.active} always />
        <Stat label="finished" value={s.done} />
        <Stat label="stopped early" value={s.exited} />
        <Stat label="waiting to send" value={s.queued} />
        <Stat label="sent" value={s.sent} />
        <Stat label="failed" value={s.failed} tone="live" />
      </dl>

      <Steps steps={d.steps} fields={fields} />

      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide the people on it" : "Show the people on it"}
        </Button>
      </div>
      {open && <People drip={d} />}
    </Card>
  );
}

/** The sequence as a timeline, with each step's wait accumulated: "2 days after
 *  they join" is the thing a host is checking, and it is not what any one step
 *  stores. */
function Steps({
  steps,
  fields,
}: {
  steps: CRMDripStep[];
  fields: CRMMergeField[];
}) {
  const marks = cumulative(steps.map((s) => s.delayMinutes));
  return (
    <ol className="grid gap-1.5 border-l border-line pl-3 text-[12px]">
      {steps.map((step, i) => {
        return (
          <li key={i} className="grid gap-0.5">
            <span className="text-ink-3">{atText(marks[i])}</span>
            <span className="text-ink-2">
              <span className="font-medium text-ink">{step.template}</span>
              {step.params.length > 0 &&
                ` · ${step.params
                  .map((p) =>
                    p.field
                      ? (fields.find((f) => f.token === p.field)?.label ??
                        p.field)
                      : `“${p.text ?? ""}”`,
                  )
                  .join(", ")}`}
            </span>
          </li>
        );
      })}
    </ol>
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

// ------------------------------------------------------------------- people

/* Who is on a sequence, where they are in it, and — when they left early — why.
 *
 * Read on demand rather than with the list: a host with eight sequences is not asking
 * about eight sets of enrollments, and this is a view of who is on it rather than an
 * export of it (the server caps the list).
 */
function People({ drip }: { drip: CRMDrip }) {
  const { notify } = useToast();
  const [rows, setRows] = useState<CRMDripEnrollment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmDrip(drip.id)
      .then((res) => {
        if (cancelled) return;
        setRows(res.enrollments);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load who is on this sequence.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [drip.id]);

  async function removePerson(row: CRMDripEnrollment) {
    setBusy(row.id);
    try {
      const res = await engageApi.removeCrmDripEnrollment(drip.id, row.id);
      setRows(res.enrollments);
      notify(
        "Taken off the sequence. The message that was waiting for them will not be sent.",
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not take them off.",
        "error",
      );
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-ink-3">
        <Spinner className="size-3.5" />
        Loading…
      </p>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5">
      {error && <Alert tone="warn">{error}</Alert>}

      {rows.length === 0 ? (
        <p className="text-[12px] text-ink-3">
          {drip.trigger === DripManual
            ? "Nobody yet — this sequence only has the people you add to it."
            : "Nobody yet. People join it when the trigger fires."}
        </p>
      ) : (
        <ul className="grid divide-y divide-line">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px]">
                  {row.contactName || row.phone || "Somebody"}
                </p>
                <p className="text-[11.5px] text-ink-3">
                  {placeText(row, drip)}
                </p>
              </div>
              {row.state === "active" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy === row.id}
                  onClick={() => removePerson(row)}
                >
                  {busy === row.id ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    "Take off"
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <AddPerson
          drip={drip}
          onClose={() => setAdding(false)}
          onAdded={(enrollments) => {
            setRows(enrollments);
            setAdding(false);
          }}
        />
      ) : (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setAdding(true)}
          >
            Add somebody
          </Button>
        </div>
      )}
    </div>
  );
}

/* Adding one person by hand, which is available for every trigger and not only the
 * manual one: a host who wants one more person on a sequence should not have to wait
 * for them to register for something.
 *
 * Only contacts who opted in are offered, because the server will refuse the rest —
 * and a picker that lists people who cannot be added is a picker that produces errors.
 */
function AddPerson({
  drip,
  onClose,
  onAdded,
}: {
  drip: CRMDrip;
  onClose: () => void;
  onAdded: (enrollments: CRMDripEnrollment[]) => void;
}) {
  const { notify } = useToast();
  const [contacts, setContacts] = useState<CRMContact[] | null>(null);
  const [contactId, setContactId] = useState("");
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [webinarId, setWebinarId] = useState("");
  const [saving, setSaving] = useState(false);

  /* Whether this person's messages need a webinar to fill themselves in. The
   * sequence's own webinar answers it when it has one; otherwise the host has to
   * say, because somebody added by hand has no registration to infer it from. */
  const needsWebinar =
    !drip.webinarId &&
    drip.steps.some((s) =>
      s.params.some((p) => p.field && WEBINAR_FIELDS.includes(p.field)),
    );

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmContacts()
      .then((res) => {
        if (!cancelled)
          setContacts(res.contacts.filter((c) => c.whatsappOptIn));
      })
      .catch(() => {
        if (!cancelled) setContacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!needsWebinar) return;
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
  }, [needsWebinar]);

  async function add() {
    if (!contactId) return;
    setSaving(true);
    try {
      const res = await engageApi.enrollCrmDrip(drip.id, {
        contactId,
        webinarId: webinarId || undefined,
      });
      notify(
        drip.active
          ? "Added. Their first message goes out within a minute."
          : "Added. Nothing is sent until you take this sequence off pause.",
        "ok",
      );
      onAdded(res.enrollments);
    } catch (e: unknown) {
      /* The server's own sentence: "already on it", "has not opted in" and "this
       * sequence needs a webinar" are three different things to do about it. */
      notify(
        e instanceof ApiError ? e.message : "Could not add them.",
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  if (contacts === null) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-ink-3">
        <Spinner className="size-3.5" />
        Loading your contacts…
      </p>
    );
  }

  if (contacts.length === 0) {
    return (
      <div className="grid gap-2">
        <p className="text-[12px] leading-relaxed text-ink-2">
          None of your contacts have opted in to WhatsApp yet, so there is
          nobody who can be added. Opting in happens on the registration form,
          or by the contact writing to your number.
        </p>
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-2 border-t border-line pt-2">
      <Select
        label="Who to add"
        id={`drip-${drip.id}-contact`}
        value={contactId}
        onChange={setContactId}
        hint="Only contacts who opted in to WhatsApp are listed."
      >
        <option value="">Choose somebody…</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name || c.phone || c.email || c.id}
          </option>
        ))}
      </Select>

      {needsWebinar && (
        <Select
          label="Which webinar this is about"
          id={`drip-${drip.id}-webinar`}
          value={webinarId}
          onChange={setWebinarId}
          hint="This sequence mentions a webinar's title or start time, and somebody added by hand has no registration to read it from."
        >
          <option value="">Choose a webinar…</option>
          {(webinars ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.topic}
            </option>
          ))}
        </Select>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={saving || !contactId || (needsWebinar && !webinarId)}
          onClick={add}
        >
          {saving ? <Spinner className="size-3.5" /> : "Add to sequence"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ builder

/** A step being written. Same shape as the API's, with the wait split into a number
 *  and a unit — nobody writes "2880 minutes", and a form that asks for minutes is a
 *  form whose sequences are accidentally an hour long. */
type Draft = {
  delay: number;
  unit: Unit;
  template: string;
  params: CRMParam[];
};

type Unit = "minutes" | "hours" | "days";

const UNIT_MINUTES: Record<Unit, number> = {
  minutes: 1,
  hours: 60,
  days: 24 * 60,
};

function Builder({
  drip,
  fields,
  triggers,
  tags,
  templates,
  templatesError,
  syncing,
  whatsappConnected,
  onRefreshTemplates,
  onClose,
  onSaved,
}: {
  drip: CRMDrip | null;
  fields: CRMMergeField[];
  triggers: string[];
  /** For the `tag_added` rule. Empty when the account has no tags, in which case
   *  that rule is not in `triggers` either. */
  tags: CRMTag[];
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  whatsappConnected: boolean;
  onRefreshTemplates: () => void;
  onClose: () => void;
  onSaved: (drip: CRMDrip) => void;
}) {
  const { notify } = useToast();
  const usable = (templates ?? []).filter((t) => t.sendable);
  const blocked = (templates ?? []).filter((t) => !t.sendable);

  const [name, setName] = useState(drip?.name ?? "");
  const [trigger, setTrigger] = useState(drip?.trigger ?? "registered");
  const [webinarId, setWebinarId] = useState(drip?.webinarId ?? "");
  const [tagId, setTagId] = useState(drip?.tagId ?? "");
  /* A new sequence starts paused, and deliberately: the host has not read it back
   * yet, and an active `registered` sequence begins messaging whoever signs up
   * next. Switching it on is one press, in front of the finished steps. */
  const [active, setActive] = useState(drip?.active ?? false);
  const [steps, setSteps] = useState<Draft[]>(() =>
    (drip?.steps ?? []).map(toDraft),
  );
  const [webinars, setWebinars] = useState<Webinar[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const manual = trigger === DripManual;
  const byTag = trigger === DripTagAdded;
  /* Whether the webinar merge fields are available at all. An unscoped sequence with
   * a webinar trigger still has one per person — their enrollment remembers which —
   * which is why this is not simply "a webinar is selected".
   *
   * Never for a tag rule, and not for want of a picker: somebody tagged "wants a
   * call" was tagged as a person, and there is no registration behind it to read a
   * topic or a start time from. A step that mentions either is refused rather than
   * sent with a blank in it. */
  const hasWebinar = byTag ? false : !manual || webinarId !== "";

  function setStep(i: number, change: Partial<Draft>) {
    setSteps((prev) => prev.map((s, j) => (j === i ? { ...s, ...change } : s)));
  }

  function addStep() {
    const first = usable[0];
    setSteps((prev) => [
      ...prev,
      {
        // A day after the one before it, which is what a sequence usually is, and
        // zero for the first step — "as soon as they join" is the welcome message.
        delay: prev.length === 0 ? 0 : 1,
        unit: prev.length === 0 ? "minutes" : "days",
        template: first ? templateKey(first) : "",
        params: first
          ? defaultTokens(first.variables, fields).map((token) =>
              token ? { field: token } : { text: "" },
            )
          : [],
      },
    ]);
  }

  function pickTemplate(i: number, key: string) {
    const picked = usable.find((t) => templateKey(t) === key);
    /* Values never carry across a template change: the placeholders of two
     * templates are not the same placeholders, and carrying them over would put
     * somebody's first name where a date goes. */
    setStep(i, {
      template: key,
      params: picked
        ? defaultTokens(picked.variables, fields).map((token) =>
            token ? { field: token } : { text: "" },
          )
        : [],
    });
  }

  const templateFor = (s: Draft) =>
    usable.find((t) => templateKey(t) === s.template);

  /* One sentence rather than a disabled button with nothing to read. In the order
   * the form is filled in, so the first thing still missing is the one named. */
  const blocker = !whatsappConnected
    ? "Connect your own WhatsApp Business account to build a sequence."
    : !name.trim()
      ? "Name the sequence, so you can tell it from the next one."
      : steps.length === 0
        ? "Add the first message."
        : steps.some((s) => !templateFor(s))
          ? "Every step needs an approved template."
          : steps.some((s) => s.delay < 0 || totalMinutes(s) > 90 * 24 * 60)
            ? "A wait has to be between none at all and 90 days."
            : steps.some((s) =>
                  s.params.some((p) => !p.field && !(p.text ?? "").trim()),
                )
              ? "Every placeholder needs something to fill it — WhatsApp rejects a message with a blank in it rather than sending the rest."
              : steps.some((s) =>
                    s.params.some(
                      (p) => p.field && WEBINAR_FIELDS.includes(p.field),
                    ),
                  ) && !hasWebinar
                ? byTag
                  ? "A message mentions the webinar's title or start time, and a tag is not about a webinar — there would be nothing to fill those in from. Change the message, or the entry rule."
                  : "A message mentions the webinar's title or start time, so this sequence has to be about a webinar — pick one, or change the entry rule."
                : null;

  async function save() {
    if (blocker) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        trigger,
        webinarId: manual || byTag ? undefined : webinarId || undefined,
        /* Empty means any tag, which is a real choice and not a missing one — "any
         * tag I add" is how a host who labels people one way uses this. */
        tagId: byTag ? tagId || undefined : undefined,
        active,
        steps: steps.map((s): CRMDripStep => {
          const tmpl = templateFor(s);
          return {
            delayMinutes: totalMinutes(s),
            template: tmpl?.name ?? "",
            language: tmpl?.language ?? "",
            params: s.params,
          };
        }),
      };
      const res = drip
        ? await engageApi.updateCrmDrip(drip.id, body)
        : await engageApi.createCrmDrip(body);
      setError(null);
      notify(
        res.drip.active
          ? drip
            ? "Saved. Anybody part-way through keeps their place."
            : "Sequence running. People join it as the trigger fires."
          : "Saved, and paused — switch it on when you are happy with it.",
        "ok",
      );
      onSaved(res.drip);
    } catch (e: unknown) {
      /* The server's own sentence, which names the step: "Step 2: that template
       * needs exactly 1 value filling in" is the difference between fixing it and
       * guessing which message is wrong. */
      const message =
        e instanceof ApiError ? e.message : "Could not save that sequence.";
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

  /* Nothing to build a sequence out of, and the reason is Meta's: every step reaches
   * somebody who has not written in, and the only thing WhatsApp delivers then is
   * wording it has approved. */
  if (usable.length === 0) {
    return (
      <Card className="grid gap-2 px-5 py-4">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
          {templatesError ??
            (blocked.length > 0
              ? "None of your templates can be sent yet."
              : "You have no WhatsApp templates yet.")}{" "}
          Every step of a sequence is an approved template: it arrives days
          after anybody last wrote to you, and WhatsApp does not let a business
          send its own words then. Write one in WhatsApp Manager and Meta will
          review it.
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

  /** When each step lands, counted from the moment somebody joins. Worked out up
   *  front rather than accumulated while rendering: a running total that a render
   *  mutates is a total that depends on how often React re-renders. */
  const marks = cumulative(steps.map(totalMinutes));

  return (
    <Card className="grid gap-3.5 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">
            {drip ? "Edit sequence" : "New sequence"}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Sent from your own WhatsApp number and billed to your Meta account,
            one message at a time as each wait passes.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {drip ? "Cancel" : "Discard"}
        </Button>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      {/* Said before the steps, because it is the thing about editing a running
          sequence that is easy to get wrong and impossible to undo. */}
      {drip && drip.stats.active > 0 && (
        <Alert tone="warn">
          {drip.stats.active === 1
            ? "1 person is part-way through this sequence"
            : `${drip.stats.active} people are part-way through this sequence`}{" "}
          and they keep their place. Changing a later message changes what they
          are about to receive, and adding one in the middle moves everybody
          along by a step.
        </Alert>
      )}

      <div>
        <label className="label" htmlFor="drip-name">
          Name it, for your own list
        </label>
        <input
          id="drip-name"
          className="field"
          placeholder="Welcome sequence"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="mt-1 text-[11.5px] text-ink-3">
          Only you see this. Nothing in it is sent to anybody.
        </p>
      </div>

      <Select
        label="Who joins it"
        id="drip-trigger"
        value={trigger}
        onChange={setTrigger}
        hint="Somebody joins a sequence once. A second registration does not start them again."
      >
        {(triggers.length > 0 ? triggers : Object.keys(TRIGGER_LABELS)).map(
          (t) => (
            <option key={t} value={t}>
              {TRIGGER_LABELS[t] ?? t}
            </option>
          ),
        )}
      </Select>

      {byTag && (
        <Select
          label="Which tag"
          id="drip-tag"
          value={tagId}
          onChange={setTagId}
          hint={
            tags.length === 0
              ? "You have no tags yet. Make one under Tags on the Contacts tab, then come back."
              : "Any tag starts this sequence unless you name one. Somebody joins it once — putting a second tag on them later does not start them again."
          }
        >
          <option value="">Any tag</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      )}

      {!manual && !byTag && (
        <Select
          label="Which webinar"
          id="drip-webinar"
          value={webinarId}
          onChange={setWebinarId}
          hint="Leave it on every webinar and the sequence keeps applying to the next one you run. Either way, each person's messages are filled in from the webinar they came from."
        >
          <option value="">Every webinar</option>
          {(webinars ?? []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.topic}
            </option>
          ))}
        </Select>
      )}

      <div className="grid gap-3">
        {steps.map((step, i) => {
          const tmpl = templateFor(step);
          const filled = step.params.map((p) =>
            p.field ? exampleFor(fields, p.field) : (p.text ?? ""),
          );
          return (
            <div
              key={i}
              className="grid gap-2.5 rounded-xl border border-line bg-surface-2 px-3 py-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[13px] font-medium">
                  Message {i + 1}
                  <span className="ml-2 font-normal text-ink-3">
                    {atText(marks[i])}
                  </span>
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setSteps((prev) => prev.filter((_, j) => j !== i))
                  }
                >
                  Remove
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-[6rem_1fr]">
                <div>
                  <label className="label" htmlFor={`drip-delay-${i}`}>
                    Wait
                  </label>
                  <input
                    id={`drip-delay-${i}`}
                    className="field"
                    type="number"
                    min={0}
                    value={step.delay}
                    onChange={(e) =>
                      setStep(i, {
                        delay: Math.max(0, e.target.valueAsNumber || 0),
                      })
                    }
                  />
                </div>
                <Select
                  label={
                    i === 0 ? "after they join" : "after the message before"
                  }
                  id={`drip-unit-${i}`}
                  value={step.unit}
                  onChange={(next) => setStep(i, { unit: next as Unit })}
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </Select>
              </div>

              <Select
                label="Template"
                id={`drip-template-${i}`}
                value={step.template}
                onChange={(key) => pickTemplate(i, key)}
              >
                <option value="">Choose a template…</option>
                {usable.map((t) => (
                  <option key={templateKey(t)} value={templateKey(t)}>
                    {t.name} · {t.language} · {t.category.toLowerCase()}
                  </option>
                ))}
              </Select>

              {step.params.length > 0 && (
                <div className="grid gap-2">
                  {step.params.map((p, j) => (
                    <div key={j} className="grid gap-2 sm:grid-cols-2">
                      <Select
                        label={`Fill {{${j + 1}}} with`}
                        id={`drip-param-${i}-${j}`}
                        value={p.field || LITERAL}
                        onChange={(next) =>
                          setStep(i, {
                            params: step.params.map((q, k) =>
                              k === j
                                ? next === LITERAL
                                  ? { text: "" }
                                  : { field: next }
                                : q,
                            ),
                          })
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
                          <label
                            className="label"
                            htmlFor={`drip-text-${i}-${j}`}
                          >
                            {`What {{${j + 1}}} says`}
                          </label>
                          <input
                            id={`drip-text-${i}-${j}`}
                            className="field"
                            value={p.text ?? ""}
                            onChange={(e) =>
                              setStep(i, {
                                params: step.params.map((q, k) =>
                                  k === j ? { text: e.target.value } : q,
                                ),
                              })
                            }
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* The message as one person will read it. A host approving
                  "Hi {{1}}" has not read what they are about to send. */}
              {tmpl && (
                <div className="rounded-lg border border-line bg-surface px-3 py-2">
                  {tmpl.header && (
                    <p className="text-[12.5px] font-semibold">{tmpl.header}</p>
                  )}
                  <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap">
                    {renderTemplate(tmpl.body ?? "", filled)}
                  </p>
                  {tmpl.footer && (
                    <p className="mt-1 text-[11px] text-ink-3">{tmpl.footer}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div>
          <Button type="button" variant="ghost" size="sm" onClick={addStep}>
            {steps.length === 0
              ? "Add the first message"
              : "Add another message"}
          </Button>
        </div>
      </div>

      <Toggle
        checked={active}
        onChange={setActive}
        label="Run this sequence"
        description={
          trigger === DripManual
            ? "Paused, nobody you add is sent anything until you switch it on."
            : "Paused, nobody new joins it and nothing is sent — and everybody already on it keeps their place."
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
        <Button
          type="button"
          onClick={save}
          disabled={saving || blocker !== null}
          className="ml-auto"
        >
          {saving && <Spinner className="size-3.5" />}
          {drip ? "Save sequence" : "Create sequence"}
        </Button>
      </div>

      {blocker ? (
        <p className="text-[11.5px] leading-relaxed text-ink-3">{blocker}</p>
      ) : (
        <p className="text-[11.5px] leading-relaxed text-ink-3">
          Each message is checked again as it goes out: anybody who has opted
          out, or replied STOP, is taken off the sequence rather than sent the
          rest of it.
        </p>
      )}

      {!whatsappConnected && (
        <Alert tone="warn">
          Connect your own WhatsApp Business account in{" "}
          <Link href="/account" className="font-medium underline">
            account settings
          </Link>{" "}
          to build a sequence.
        </Alert>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ helpers

/** A stored step as the form holds it: the largest unit the wait divides into
 *  exactly, so a sequence written in days reads back in days. */
function toDraft(step: CRMDripStep): Draft {
  const minutes = step.delayMinutes;
  const unit: Unit =
    minutes > 0 && minutes % UNIT_MINUTES.days === 0
      ? "days"
      : minutes > 0 && minutes % UNIT_MINUTES.hours === 0
        ? "hours"
        : "minutes";
  return {
    delay: minutes / UNIT_MINUTES[unit],
    unit,
    template: `${step.template}\u0000${step.language}`,
    params: step.params ?? [],
  };
}

function totalMinutes(s: Draft): number {
  return Math.round(s.delay * UNIT_MINUTES[s.unit]);
}

/** Each wait added to the ones before it, so step n knows how long after joining it
 *  lands. Every step's delay is relative to the step before — see CRMDripStep. */
function cumulative(waits: number[]): number[] {
  let total = 0;
  return waits.map((wait) => (total += wait));
}

/** When a step lands, counted from the moment somebody joins — the accumulated
 *  wait rather than the step's own, because that is the question a host reading a
 *  sequence is asking. */
function atText(minutes: number): string {
  if (minutes <= 0) return "As soon as they join";
  return `${durationText(minutes)} after they join`;
}

/** How long the whole sequence takes, for the one-line summary in the list. */
function spanText(steps: CRMDripStep[]): string {
  return durationText(steps.reduce((sum, s) => sum + s.delayMinutes, 0));
}

function durationText(minutes: number): string {
  if (minutes <= 0) return "no time at all";
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), "day");
  if (minutes >= 24 * 60) {
    const days = Math.floor(minutes / (24 * 60));
    const hours = Math.round((minutes % (24 * 60)) / 60);
    return hours === 0
      ? plural(days, "day")
      : `${plural(days, "day")} ${plural(hours, "hour")}`;
  }
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}

/** Where one person is, in the words a host would use. The exit reason is the
 *  interesting half: a sequence that stopped for somebody prompts exactly one
 *  question, and "they opted out" is the answer to it. */
function placeText(row: CRMDripEnrollment, drip: CRMDrip): string {
  const total = drip.steps.length;
  switch (row.state) {
    case "done":
      return `Had all ${total === 1 ? "1 message" : `${total} messages`}`;
    case "exited":
      return `Stopped after ${row.step === 1 ? "1 message" : `${row.step} messages`}${
        row.exitReason ? ` — ${row.exitReason}` : ""
      }`;
    default:
      return `Message ${Math.min(row.step + 1, total)} of ${total}${
        row.nextDueAt
          ? `, due ${formatRelative(row.nextDueAt, new Date())}`
          : ""
      }`;
  }
}
