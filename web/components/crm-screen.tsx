"use client";

import Link from "next/link";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  Alert,
  ConfirmModal,
  Disclosure,
  Select,
  Spinner,
  Tabs,
} from "./controls";
import { Bots } from "./crm-bots";
import { Broadcasts } from "./crm-broadcasts";
import { Drips } from "./crm-drips";
import { NotesPane } from "./crm-notes";
import { ContactTags, TagChips, TagManager } from "./crm-tags";
import {
  BlockedList,
  RefreshTemplates,
  defaultTokens,
  exampleFor,
  renderTemplate,
  templateKey,
} from "./crm-templates";
import { ArrowLeftIcon, SearchIcon, SendIcon, WhatsAppIcon } from "./icons";
import { useSession, useToast } from "./providers";
import { Badge, Button, Card, Empty } from "./ui";
import { ApiError, api } from "@/lib/api";
import {
  FeatureCRMNotes,
  FeatureCRMTags,
  FeatureReplayLinks,
  NotifyWhatsAppConfirmed,
  NotifyWhatsAppReminder1h,
  NotifyWhatsAppReminder24h,
  NotifyWhatsAppReplay,
} from "@/lib/api-types";
import type {
  CRMContact,
  CRMMergeField,
  CRMMessage,
  CRMNote,
  CRMReminder,
  CRMSendRequest,
  CRMTag,
  CRMTemplate,
  NotificationKind,
} from "@/lib/api-types";
import { formatRelative } from "@/lib/format";

/* Contacts and Inbox — the host's CRM.
 *
 * One screen rather than two routes, because a contact list whose rows do not
 * open the conversation is a spreadsheet, and an inbox with no way back to the
 * list is a dead end. Desktop shows both panes; a phone shows one at a time and
 * the row press is the navigation.
 *
 * Sending is here too, and most of what the compose box does is decline to offer
 * a send that WhatsApp would refuse: free-form text only inside the 24 hours the
 * contact's own last message opened, approved templates otherwise, nothing at all
 * to somebody who has opted out. None of that is enforced here — the server
 * re-checks every rule — but a button that produces an error is worse than a
 * button that explains itself, so the same rules shape what is on screen.
 */

/** How often an open inbox re-reads itself, while the tab is actually being
 *  looked at. Long enough not to matter to the API, short enough that a host on
 *  this screen sees a reply arrive without wondering whether to reload. */
const POLL_MS = 20_000;

/** The four views of the CRM: the people, one message sent to many of them at once,
 *  the sequences that keep sending on their own, and the bots that answer without
 *  anybody here at all. Tabs rather than routes because they are the same list seen
 *  four ways — a host who has just read a reply is one click from the campaign that
 *  prompted it, or from the flow that sent it. */
const CRM_VIEWS = ["contacts", "broadcasts", "sequences", "bots"] as const;
type CRMView = (typeof CRM_VIEWS)[number];

const VIEW_LABELS: Record<CRMView, string> = {
  contacts: "Contacts",
  broadcasts: "Broadcasts",
  sequences: "Sequences",
  bots: "Bots",
};

export function CRMScreen() {
  const { account, status } = useSession();
  const { notify } = useToast();
  const [view, setView] = useState<CRMView>("contacts");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<CRMContact[] | null>(null);
  /* Every tag this host has, for the picker beside a conversation and for the
   * manager. It arrives with the contacts list rather than in a call of its own:
   * both screens that need it are this one, and a picker that loads separately
   * from the chips it adds to would briefly disagree with them. Empty for an
   * account whose tags switch is off — the server sends nothing then. */
  const [tags, setTags] = useState<CRMTag[] | null>(null);
  const [total, setTotal] = useState(0);
  const [whatsappConnected, setWhatsappConnected] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* Bumped on a timer and after a write, and read by both panes: one counter is
   * what keeps the list and the open thread from disagreeing about when "now"
   * was — an opt-out applied in the thread has to change the badge in the list. */
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const canHost = account?.canHost ?? false;
  /* What this account has switched on, as the server describes it. Checked again
   * on every request it gates — this only decides whether to show a pane whose
   * every call would be refused, which is a kindness rather than a permission. */
  const features = account?.features ?? [];
  const tagsOn = features.includes(FeatureCRMTags);
  const notesOn = features.includes(FeatureCRMNotes);

  /* Templates belong to the host, not to a contact, so they are loaded here and
   * handed down: they are the same list for every conversation, and re-reading
   * them each time a row is clicked would be one request per click for an answer
   * that changes about once a week. Not on `tick` either — the 20-second poll is
   * for arriving messages. */
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
    let cancelled = false;
    api
      .crmTemplates()
      .then((res) => {
        if (cancelled) return;
        setTemplates(res.templates);
        setTemplatesError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your WhatsApp templates.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [status, canHost]);

  /* Asking Meta again, on purpose. Behind a button because it is a real Graph
   * call against a per-WABA rate limit — the host who has just created a template
   * in WhatsApp Manager is the one person who needs it, and they know they do. */
  const refreshTemplates = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await api.crmTemplates(true);
      setTemplates(res.templates);
      setTemplatesError(null);
      notify(
        res.templates.length === 1
          ? "1 template from WhatsApp."
          : `${res.templates.length} templates from WhatsApp.`,
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not reach WhatsApp.",
        "error",
      );
    } finally {
      setSyncing(false);
    }
  }, [notify]);

  useEffect(() => {
    const id = setInterval(() => {
      // A background tab is not an inbox anybody is reading, and polling one for
      // hours is a cost with no reader.
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  /* The search is debounced and the FIRST load is not.
   *
   * Typing "tha" should not be three requests, but arriving on the screen should
   * not wait a quarter of a second for nothing. The empty query is the arrival
   * case and also the "cleared the box" case, both of which want the answer now.
   */
  useEffect(() => {
    if (status !== "signed-in" || !canHost) return;
    let cancelled = false;
    const run = () => {
      api
        .crmContacts(query)
        .then((res) => {
          if (cancelled) return;
          setContacts(res.contacts);
          setTags(res.tags);
          setTotal(res.total);
          setWhatsappConnected(res.whatsappConnected);
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setContacts([]);
          setError(
            e instanceof ApiError && e.code !== "network"
              ? e.message
              : "Could not load your contacts.",
          );
        });
    };
    const delay = query.trim() ? 250 : 0;
    const timer = setTimeout(run, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, tick, status, canHost]);

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (status === "anonymous" || !canHost) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">Contacts are for hosts</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          Every contact belongs to the host who collected them. Sign in with a
          hosting account to see yours.
        </p>
      </Card>
    );
  }

  const selected = contacts?.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            {VIEW_LABELS[view]}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            {view === "contacts"
              ? `Everyone who registered for one of your webinars or wrote to your WhatsApp number — ${total === 1 ? "1 person" : `${total} people`}.`
              : view === "broadcasts"
                ? "One message to many people, from your own WhatsApp number and billed to your Meta account."
                : view === "sequences"
                  ? "Several messages over days, sent on their own to everybody who registers from now on."
                  : "A reply to somebody who writes in, with the conversation handed to you the moment the flow runs out of answers."}
          </p>
        </div>
        {view === "contacts" && (
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Search contacts</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-3" />
            <input
              className="field pl-9"
              type="search"
              placeholder="Name, email or number"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        )}
      </div>

      <Tabs<CRMView>
        tabs={CRM_VIEWS}
        value={view}
        onChange={setView}
        labels={VIEW_LABELS}
      />

      {/* The leads are all still here with WhatsApp disconnected — only the
          sending is gone. Saying which is which is the difference between a
          host fixing a connection and a host thinking they lost their list. */}
      {!whatsappConnected && (
        <Alert tone="warn" title="WhatsApp isn't connected">
          Your contacts and conversations are unaffected, but nothing can be
          sent until you connect your own WhatsApp Business account in{" "}
          <Link href="/account" className="font-medium underline">
            account settings
          </Link>
          .
        </Alert>
      )}

      {view === "broadcasts" ? (
        <Broadcasts
          whatsappConnected={whatsappConnected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          tags={tagsOn ? (tags ?? []) : null}
          onRefreshTemplates={refreshTemplates}
        />
      ) : view === "sequences" ? (
        <Drips
          whatsappConnected={whatsappConnected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          onRefreshTemplates={refreshTemplates}
        />
      ) : view === "bots" ? (
        /* No templates handed down: a bot only ever replies inside the 24 hours
           the contact's own message opened, where WhatsApp allows the host's own
           words. Nothing it sends is a template. */
        <Bots whatsappConnected={whatsappConnected} />
      ) : (
        <>
          {error && <Alert tone="error">{error}</Alert>}

          {/* Folded away by default: the subject of this screen is the list, and
              the automatic messages are set up once and then left for months. */}
          {whatsappConnected && (
            <Card className="px-5 py-3">
              <Disclosure summary="Automatic WhatsApp messages">
                <RemindersSettings
                  templates={templates}
                  templatesError={templatesError}
                  syncing={syncing}
                  onRefreshTemplates={refreshTemplates}
                />
              </Disclosure>
            </Card>
          )}

          {/* Folded away for the same reason, and shown whether or not WhatsApp
              is connected: a label is a fact about a person, and it is still
              worth recording on a list nothing can currently be sent to. */}
          {tagsOn && (
            <Card className="px-5 py-3">
              <Disclosure
                summary={`Tags${tags && tags.length > 0 ? ` · ${tags.length}` : ""}`}
              >
                <TagManager tags={tags} onChanged={refresh} />
              </Disclosure>
            </Card>
          )}

          {contacts === null ? (
            <div className="grid place-items-center py-20">
              <Spinner className="size-6 text-ink-3" />
            </div>
          ) : contacts.length === 0 ? (
            query.trim() ? (
              <Empty
                title="No contacts match that"
                hint="Search runs over names, email addresses and phone numbers."
              />
            ) : (
              <Empty
                title="No contacts yet"
                hint="Anyone who registers for one of your webinars lands here, and so does anyone who messages your WhatsApp number."
              />
            )
          ) : (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] lg:items-start">
              {/* One pane at a time on a phone: a 340px list beside a
                  conversation is two unreadable columns on a 390px screen. */}
              <Card
                className={`divide-y divide-line overflow-hidden ${selectedId ? "hidden lg:block" : ""}`}
              >
                {contacts.map((c) => (
                  <ContactRow
                    key={c.id}
                    contact={c}
                    active={c.id === selectedId}
                    onSelect={() => setSelectedId(c.id)}
                  />
                ))}
              </Card>

              <div className={selectedId ? "" : "hidden lg:block"}>
                {selectedId ? (
                  <Thread
                    key={selectedId}
                    contactId={selectedId}
                    fallback={selected}
                    tick={tick}
                    allTags={tagsOn ? (tags ?? []) : null}
                    notesOn={notesOn}
                    templates={templates}
                    templatesError={templatesError}
                    syncing={syncing}
                    onRefreshTemplates={refreshTemplates}
                    onChanged={refresh}
                    onBack={() => setSelectedId(null)}
                  />
                ) : (
                  <Card className="grid place-items-center px-6 py-20 text-center">
                    <p className="text-[13.5px] text-ink-2">
                      Pick a contact to read the conversation.
                    </p>
                  </Card>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- reminders

/** The automatic messages, in the order they reach somebody, with the host's
 *  words for them: `wa_reminder_24h` is our name for it, not theirs. */
const REMINDER_KINDS: {
  kind: NotificationKind;
  label: string;
  hint: string;
  /** When set, the row is only shown to an account with that switch on. The
   *  others are the reminders every host has always had. */
  feature?: string;
}[] = [
  {
    kind: NotifyWhatsAppConfirmed,
    label: "When somebody registers",
    hint: "Sent as soon as they register — or as soon as you approve them, on a webinar that needs approval.",
  },
  {
    kind: NotifyWhatsAppReminder24h,
    label: "24 hours before it starts",
    hint: "Skipped for anyone who registers later than that.",
  },
  {
    kind: NotifyWhatsAppReminder1h,
    label: "1 hour before it starts",
    hint: "The one most people act on.",
  },
  {
    kind: NotifyWhatsAppReplay,
    label: "When you publish the recording",
    /* Not "after the webinar": nothing is sent when a session ends, because the
     * host has not decided the recording may be watched yet. Publishing it is
     * that decision, and it is the only one — see the note in 0048. */
    hint: "Sent once, to everybody who registered, when you switch on public viewing for a recording. Everyone gets the email; this is the WhatsApp copy. The per-webinar reminder switch does not apply to it — publishing is the decision.",
    feature: FeatureReplayLinks,
  },
];

/* Which template each automatic message uses.
 *
 * A host-level setting and not a per-webinar one, because the sentence does not
 * change per webinar — the facts in it do, which is what the merge fields are.
 * The per-webinar half of the decision is the WhatsApp switch in the schedule
 * form, and nothing is sent for a webinar that does not have it on.
 *
 * There is no default template and no fallback. Meta only delivers templates it
 * has approved, so a name this application invented would be a rejection rather
 * than a message — a kind with nothing chosen is simply not sent.
 */
function RemindersSettings({
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
}: {
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
}) {
  const { notify } = useToast();
  const { account } = useSession();
  /* The replay row is only offered to an account that has it. A host who cannot
   * send the message should not be choosing a template for it — and the row
   * would save happily while nothing ever went out, which is the one outcome
   * worth designing away. */
  const shown = REMINDER_KINDS.filter(
    (k) => !k.feature || (account?.features ?? []).includes(k.feature),
  );
  const [rows, setRows] = useState<CRMReminder[] | null>(null);
  const [fields, setFields] = useState<CRMMergeField[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .crmReminders()
      .then((res) => {
        if (cancelled) return;
        setRows(res.reminders);
        setFields(res.fields);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setRows([]);
        setError(
          e instanceof ApiError && e.code !== "network"
            ? e.message
            : "Could not load your automatic messages.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const usable = (templates ?? []).filter((t) => t.sendable);

  function update(kind: string, change: Partial<CRMReminder>) {
    setRows((prev) =>
      (prev ?? []).map((r) => (r.kind === kind ? { ...r, ...change } : r)),
    );
  }

  async function save() {
    if (rows === null) return;
    setSaving(true);
    try {
      const res = await api.setCrmReminders({ reminders: rows });
      setRows(res.reminders);
      setError(null);
      notify("Automatic messages saved.", "ok");
    } catch (e: unknown) {
      /* The server's sentence, because every refusal here names the template or
       * the field that is wrong — "could not save" would leave a host guessing
       * which of three rows it meant. */
      const message =
        e instanceof ApiError ? e.message : "Could not save those messages.";
      setError(message);
      notify(message, "error");
    } finally {
      setSaving(false);
    }
  }

  if (rows === null || templates === null) {
    return (
      <div className="flex items-center gap-2 py-3 text-[12px] text-ink-2">
        <Spinner className="size-4 text-ink-3" />
        Loading your automatic messages…
      </div>
    );
  }

  if (usable.length === 0) {
    return (
      <div className="grid gap-2 py-1">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
          {templatesError ?? "You have no approved WhatsApp templates yet."} An
          automatic message can only be an approved template: it arrives when
          the contact has not written in, and WhatsApp does not let a business
          send its own words then. Write one in WhatsApp Manager and Meta will
          review it.
        </p>
        <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
      </div>
    );
  }

  // A kind whose template no longer has a value for every {{n}} cannot be saved,
  // and Meta would refuse it anyway — a mismatch is rejected outright rather
  // than sent with a blank.
  const incomplete = rows.some((r) => {
    if (!r.template) return false;
    const t = usable.find(
      (x) => x.name === r.template && x.language === r.language,
    );
    if (!t) return false;
    return Array.from({ length: t.variables }, (_, i) => r.params[i]).some(
      (v) => !v,
    );
  });

  return (
    <div className="grid gap-4 py-1">
      <p className="max-w-prose text-[12.5px] leading-relaxed text-ink-2">
        Sent to registrants who ticked the WhatsApp box, from your own WhatsApp
        Business number and billed to your Meta account. Each webinar decides
        whether to use them — the switch is in its settings, and it is off until
        you turn it on.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      {shown.map(({ kind, label, hint }) => {
        const row =
          rows.find((r) => r.kind === kind) ??
          ({ kind, template: "", language: "", params: [] } as CRMReminder);
        /* The tokens this kind may be filled with. The replay link only has a
         * value on the replay message — offering it on a reminder would produce
         * a sentence whose whole subject is a dash, and the server refuses it
         * there anyway. */
        const usableFields = fields.filter(
          (f) => !f.onlyKind || f.onlyKind === kind,
        );
        const template = usable.find(
          (t) => t.name === row.template && t.language === row.language,
        );
        // A template that was chosen and has since been paused or deleted at
        // Meta. Said out loud rather than silently shown as "Don't send", which
        // would read as a setting the host had made.
        const missing = row.template !== "" && !template;
        const tokens = Array.from(
          { length: template?.variables ?? 0 },
          (_, i) => row.params[i] ?? "",
        );

        return (
          <div key={kind} className="grid gap-2 border-t border-line pt-3">
            <div>
              <p className="text-[13px] font-medium">{label}</p>
              <p className="mt-0.5 text-[11.5px] text-ink-3">{hint}</p>
            </div>

            {missing && (
              <Alert tone="warn">
                <span className="font-medium">{row.template}</span> is not
                available in your WhatsApp account any more, so this message is
                not being sent. Pick another one.
              </Alert>
            )}

            <Select
              label="Template"
              id={`reminder-${kind}`}
              value={template ? templateKey(template) : ""}
              onChange={(next) => {
                const picked = usable.find((t) => templateKey(t) === next);
                if (!picked) {
                  update(kind, { template: "", language: "", params: [] });
                  return;
                }
                update(kind, {
                  template: picked.name,
                  language: picked.language,
                  // Prefilled in the order the fields are listed, so a newly
                  // picked template is already valid: name, then topic, then
                  // when. Changing one is a click; getting one wrong loses a
                  // message.
                  params: defaultTokens(picked.variables, usableFields),
                });
              }}
            >
              <option value="">Don&apos;t send this one</option>
              {usable.map((t) => (
                <option key={templateKey(t)} value={templateKey(t)}>
                  {t.name} · {t.language} · {t.category.toLowerCase()}
                </option>
              ))}
            </Select>

            {template && (
              <>
                {tokens.length > 0 && (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {tokens.map((token, i) => (
                      <Select
                        key={i}
                        label={`Fill {{${i + 1}}} with`}
                        id={`reminder-${kind}-${i}`}
                        value={token}
                        onChange={(next) =>
                          update(kind, {
                            params: tokens.map((v, j) => (j === i ? next : v)),
                          })
                        }
                      >
                        {token === "" && <option value="">Choose…</option>}
                        {usableFields.map((f) => (
                          <option key={f.token} value={f.token}>
                            {f.label}
                          </option>
                        ))}
                      </Select>
                    ))}
                  </div>
                )}

                {/* The message as one registrant will read it, with the example
                    values. A host approving "Hi {{1}}" has not read what they
                    are about to send to a thousand people. */}
                <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
                  {template.header && (
                    <p className="text-[12.5px] font-semibold">
                      {template.header}
                    </p>
                  )}
                  <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap">
                    {renderTemplate(
                      template.body ?? "",
                      tokens.map((t) => exampleFor(fields, t)),
                    )}
                  </p>
                  {template.footer && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      {template.footer}
                    </p>
                  )}
                </div>

                {template.category === "MARKETING" && (
                  <p className="text-[11.5px] leading-relaxed text-ink-3">
                    This is a marketing template. It is still only sent to
                    people who ticked the WhatsApp box when they registered.
                  </p>
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={saving || incomplete}
        >
          {saving && <Spinner className="size-3.5" />}
          Save messages
        </Button>
      </div>
      {incomplete && (
        <p className="text-[11.5px] text-ink-3">
          Every placeholder needs something to fill it — WhatsApp rejects a
          message with a blank in it rather than sending the rest.
        </p>
      )}
    </div>
  );
}

// --------------------------------------------------------------------- list

function ContactRow({
  contact: c,
  active,
  onSelect,
}: {
  contact: CRMContact;
  active: boolean;
  onSelect: () => void;
}) {
  const last = c.lastMessage;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors ${
        active ? "bg-brand-soft" : "hover:bg-surface-2"
      }`}
    >
      <span
        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-surface-2 text-[11.5px] font-semibold text-ink-2"
        aria-hidden
      >
        {initialsOf(c)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13.5px] font-medium">
            {displayName(c)}
          </span>
          {/* Whichever timestamp there is: activity if they have ever been in
              touch, otherwise the day they were collected. A row with no date
              at all reads like a bug. */}
          <span className="shrink-0 text-[11px] text-ink-3">
            {whenText(c.lastSeenAt || c.createdAt)}
          </span>
        </span>
        <span className="mt-0.5 block truncate text-[12px] text-ink-2">
          {last ? previewOf(last) : c.phone || c.email || "No contact details"}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <ConsentBadge contact={c} />
          {/* Read-only here. The list is for finding somebody, and the chips are
              what a host scans it by — they are edited in the conversation, where
              the reason for a label is on screen beside it. Empty for an account
              without the tags switch, which the server decides. */}
          <TagChips tags={c.tags ?? []} />
        </span>
      </span>
    </button>
  );
}

/** The one fact about a contact that decides what a host may do with them, so it
 *  is on every row rather than only in the detail pane. */
function ConsentBadge({ contact: c }: { contact: CRMContact }) {
  if (!c.phone) return <Badge>Email only</Badge>;
  if (c.whatsappOptOutAt) return <Badge tone="live">Opted out</Badge>;
  if (c.whatsappOptIn) {
    return (
      <Badge tone="ok">
        <WhatsAppIcon className="size-3" />
        Opted in
      </Badge>
    );
  }
  // A number with no opt-in is not a mistake — it is most of a list — and the
  // wording has to be neutral enough that nobody reads it as "fix this".
  return <Badge>No WhatsApp consent</Badge>;
}

// ------------------------------------------------------------------- thread

function Thread({
  contactId,
  fallback,
  tick,
  allTags,
  notesOn,
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
  onChanged,
  onBack,
}: {
  contactId: string;
  /** The row the host clicked, shown while the thread loads so the pane opens
   *  with a name in it rather than a spinner where the name will be. */
  fallback: CRMContact | null;
  tick: number;
  /** Every tag the host has, for the picker — or null when the account does not
   *  have tags, which is not the same as having none of them. */
  allTags: CRMTag[] | null;
  notesOn: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  onChanged: () => void;
  onBack: () => void;
}) {
  const { notify } = useToast();
  const [contact, setContact] = useState<CRMContact | null>(fallback);
  const [messages, setMessages] = useState<CRMMessage[] | null>(null);
  // Arrives with the thread, then kept here: writing a note must not make the
  // whole conversation reload underneath the pane the host is typing in.
  const [notes, setNotes] = useState<CRMNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  /* Both from the server, and neither derivable here. The window runs from the
   * contact's last inbound message on the server's clock — the message list is
   * capped, and the reader's timezone is not the one Meta enforces — and the
   * connection can be gone while every contact is still in place. */
  const [windowUntil, setWindowUntil] = useState("");
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .crmThread(contactId)
      .then((res) => {
        if (cancelled) return;
        setContact(res.contact);
        setMessages(res.messages);
        setNotes(res.notes);
        setWindowUntil(res.serviceWindowUntil ?? "");
        setConnected(res.whatsappConnected);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setMessages([]);
        setError(
          e instanceof ApiError && e.status === 404
            ? "That contact is no longer there."
            : "Could not load the conversation.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [contactId, tick]);

  /* Taking a conversation over from a bot, and handing it back.
   *
   * On the contact rather than on the flow they are in, because that is the scope of
   * the decision: "I am dealing with this person" has to hold for their next message
   * too, which may arrive after the flow has ended. Nothing is undone by it — what
   * the bot already said stays in the thread, labelled. */
  async function setBotPaused(paused: boolean) {
    setBusy(true);
    try {
      const updated = await api.setCrmContactBot(contactId, { paused });
      setContact(updated);
      onChanged();
      notify(
        paused
          ? "Yours now — no bot answers this contact until you hand it back."
          : "Handed back. A bot can answer their next message.",
        "ok",
      );
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not change that.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function optOut() {
    setBusy(true);
    try {
      const updated = await api.crmOptOut(contactId);
      setContact(updated);
      setConfirming(false);
      onChanged();
      notify("Recorded — nothing will be sent to this contact.", "ok");
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not record the opt-out.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  /* A sent message is appended from the send's own response rather than waited
   * for: it already carries the server's id and status, and a conversation that
   * shows nothing for a second after the press reads as a failure. onChanged
   * re-reads the list behind it so the row's preview agrees. */
  function recordSent(msg: CRMMessage) {
    setMessages((prev) => [...(prev ?? []), msg]);
    onChanged();
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="-ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 lg:hidden"
          aria-label="Back to contacts"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">
            {contact ? displayName(contact) : "Contact"}
          </div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
            {[contact?.phone, contact?.email, contact?.company]
              .filter(Boolean)
              .join(" · ") || "No contact details"}
          </div>
          {contact && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ConsentBadge contact={contact} />
              {contact.botPausedAt && (
                <Badge tone="warn">Yours, not a bot&apos;s</Badge>
              )}
              {contact.source && <Badge>From {contact.source}</Badge>}
            </div>
          )}
          {/* In the header rather than in a sidebar: a label is a fact about this
              person, and the moment to apply one is while their own words are on
              screen — which is also when a `tag_added` sequence is the thing the
              host actually meant to start. */}
          {contact && allTags !== null && (
            <div className="mt-2">
              <ContactTags
                contactId={contactId}
                tags={contact.tags ?? []}
                all={allTags}
                onChanged={(next) => {
                  setContact({ ...contact, tags: next });
                  // The row behind this pane shows the same chips.
                  onChanged();
                }}
              />
            </div>
          )}
        </div>
        {/* Offered when a bot has actually spoken in this conversation, and always
            once one has been taken over: a host with no bots should not be reading
            about them, and a host who has taken one over needs the way back. */}
        {contact?.phone &&
          (contact.botPausedAt || (messages ?? []).some((m) => m.fromBot)) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setBotPaused(!contact.botPausedAt)}
            >
              {busy ? (
                <Spinner className="size-3.5" />
              ) : contact.botPausedAt ? (
                "Let the bot answer again"
              ) : (
                "Take over from the bot"
              )}
            </Button>
          )}
        {/* Offered for anybody with a number, opted in or not: a host who has
            been told "don't message me" on a call needs to write it down before
            a broadcast exists to catch them out. Hidden once it is recorded,
            because the second press would change nothing — the FIRST refusal is
            the one that counts. */}
        {contact?.phone && !contact.whatsappOptOutAt && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            onClick={() => setConfirming(true)}
          >
            Mark opted out
          </Button>
        )}
      </div>

      {error && (
        <div className="px-4 py-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {messages === null ? (
        <div className="grid place-items-center py-16">
          <Spinner className="size-5 text-ink-3" />
        </div>
      ) : messages.length === 0 ? (
        <p className="px-4 py-12 text-center text-[13px] text-ink-2">
          No messages with this contact yet.
        </p>
      ) : (
        <div className="grid gap-2.5 px-4 py-4">
          {messages.map((m) => (
            <Bubble key={m.id} message={m} />
          ))}
        </div>
      )}

      {contact && (
        <Compose
          contact={contact}
          windowUntil={windowUntil}
          connected={connected}
          templates={templates}
          templatesError={templatesError}
          syncing={syncing}
          onRefreshTemplates={onRefreshTemplates}
          onSent={recordSent}
        />
      )}

      {/* Below the compose box, which is the whole point of where it is: the two
          are next to each other because a host reaches for one when they have
          decided not to use the other. */}
      {notesOn && (
        <NotesPane contactId={contactId} notes={notes} onChanged={setNotes} />
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={optOut}
        busy={busy}
        title="Mark as opted out?"
        body="Nothing will be sent to this contact on WhatsApp. You cannot undo this from here — only they can opt in again, by asking to or by registering with the box ticked."
        confirmLabel="Mark opted out"
      />
    </Card>
  );
}

function Bubble({ message: m }: { message: CRMMessage }) {
  const inbound = m.direction === "in";
  const failed = m.status === "failed";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div className="max-w-[85%] min-w-0">
        <div
          className={`rounded-2xl px-3 py-2 text-[13px] leading-relaxed break-words ${
            inbound
              ? "rounded-bl-md bg-surface-2 text-ink"
              : failed
                ? "rounded-br-md border border-live/30 bg-live-soft text-ink"
                : "rounded-br-md bg-brand text-white"
          }`}
        >
          {m.body ? (
            <span className="whitespace-pre-wrap">{m.body}</span>
          ) : (
            // A sticker, a location pin, a voice note: the body is genuinely
            // empty, and skipping the message would leave a gap in a
            // conversation the host is trying to follow.
            <span className="italic opacity-80">{kindText(m.kind)}</span>
          )}
        </div>
        <div
          className={`mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-3 ${
            inbound ? "" : "justify-end"
          }`}
        >
          <span>{whenText(m.createdAt)}</span>
          {!inbound && <span>· {m.status}</span>}
          {/* Which half of a handed-over conversation the host did not write. The
              bot's name rather than "automatic": the host named it, and the name
              is what tells them which flow to go and fix. */}
          {m.fromBot && <span>· {m.fromBot}</span>}
          {m.templateName && <span>· {m.templateName}</span>}
        </div>
        {/* Meta's own words, kept verbatim by the webhook. Usually something
            only the host can fix — an unpaid WABA, a number not registered —
            and unfixable if we paraphrase it into "delivery failed". */}
        {failed && m.error && (
          <p
            className={`mt-0.5 text-[11px] text-live ${inbound ? "" : "text-right"}`}
          >
            {m.error}
          </p>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ compose

/** Meta's own limit on a free-form message, enforced by the server too. Here it
 *  is a maxLength rather than an error, because a box that stops accepting
 *  characters is a better explanation than a refusal after the press. */
const TEXT_MAX = 4096;

type ComposeMode = "reply" | "template";

/* The compose box, which mostly consists of not offering a send.
 *
 * WhatsApp allows a business exactly two things: its own words, for 24 hours
 * after the contact last wrote to it, and an approved template at any time. So
 * there are two boxes, and which one is available is not a preference — outside
 * the window the typing box does not exist, because Meta would reject what it
 * produced and the host would have lost what they wrote.
 *
 * Consent is ours rather than Meta's and cuts across both: a contact who has
 * opted out gets nothing in any category, and a MARKETING template needs the
 * opt-in that the registration form's tick box is for. Both are checked again on
 * the server, which is what actually enforces them; what they do here is explain
 * themselves before the press instead of after it.
 */
function Compose({
  contact,
  windowUntil,
  connected,
  templates,
  templatesError,
  syncing,
  onRefreshTemplates,
  onSent,
}: {
  contact: CRMContact;
  /** RFC3339, or empty when no window is open. */
  windowUntil: string;
  connected: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  onSent: (msg: CRMMessage) => void;
}) {
  const { notify } = useToast();
  const [mode, setMode] = useState<ComposeMode>("reply");
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState("");
  /** One box per `{{n}}`, by position. Sparse while it is being filled in. */
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  /* Opted out unless a later opt-in overrode it, which is exactly what the
   * server's computed whatsappOptIn already answers. */
  const optedOut = Boolean(contact.whatsappOptOutAt) && !contact.whatsappOptIn;
  /* No clock of our own: the server sends a deadline only while the window is
   * still open, and the thread re-reads itself every 20 seconds. Between two
   * reads this can be up to 20 seconds stale, which the server catches — it
   * refuses the send and the host still has what they typed. A second clock
   * running in the reader's timezone would be a worse answer, not a fresher one. */
  const open = windowUntil !== "";

  // The three cases where there is nothing to compose. Said in a line rather
  // than shown as a disabled box, which reads as something failing to load.
  if (!contact.phone) {
    return (
      <ComposeNote>
        This contact left an email address and no WhatsApp number, so there is
        nothing to send to.
      </ComposeNote>
    );
  }
  if (optedOut) {
    return (
      <ComposeNote>
        This contact has asked not to receive WhatsApp messages. Nothing can be
        sent to them — only they can opt in again.
      </ComposeNote>
    );
  }
  if (!connected) {
    return (
      <ComposeNote>
        Connect your own WhatsApp Business account in{" "}
        <Link href="/account" className="font-medium underline">
          account settings
        </Link>{" "}
        to reply from here.
      </ComposeNote>
    );
  }

  const usable = (templates ?? []).filter((t) => t.sendable);
  const blocked = (templates ?? []).filter((t) => !t.sendable);
  const template = usable.find((t) => templateKey(t) === chosen) ?? usable[0];
  // Exactly as many values as the template declares, in order: Meta rejects a
  // mismatch outright rather than leaving a blank.
  const filled = template
    ? Array.from({ length: template.variables }, (_, i) =>
        (params[i] ?? "").trim(),
      )
    : [];
  const needsOptIn =
    template?.category === "MARKETING" && !contact.whatsappOptIn;

  const typing = mode === "reply" && open;
  const canSend = typing
    ? text.trim() !== ""
    : Boolean(template) && !needsOptIn && filled.every((v) => v !== "");

  async function send() {
    /* One or the other, never both — the server refuses a request carrying both
     * rather than guessing which was meant. */
    const request: CRMSendRequest | null = typing
      ? { body: text.trim() }
      : template
        ? {
            template: template.name,
            language: template.language,
            params: filled,
          }
        : null;
    if (!request) return;

    setBusy(true);
    try {
      const msg = await api.crmSend(contact.id, request);
      onSent(msg);
      setText("");
      setParams([]);
      notify("Sent.", "ok");
    } catch (e: unknown) {
      /* The server's own sentence, which is usually Meta's: an unpaid WABA, a
       * template paused an hour ago, a window that closed while this box was
       * open. All of them are things only the host can act on. */
      notify(
        e instanceof ApiError ? e.message : "Could not send that message.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-t border-line bg-surface-2 px-4 py-3">
      {/* Only offered while the window is actually open. A tab that explains why
          it is empty is still a tab a host will try first. */}
      {open && (
        <div className="-mx-4 -mt-3 mb-3 px-4">
          <Tabs<ComposeMode>
            tabs={["reply", "template"] as const}
            value={mode}
            onChange={setMode}
            labels={{ reply: "Reply", template: "Template" }}
          />
        </div>
      )}

      {typing ? (
        <div className="grid gap-2">
          <label className="sr-only" htmlFor="crm-reply">
            Your reply
          </label>
          <textarea
            id="crm-reply"
            className="field min-h-20 resize-y py-2"
            maxLength={TEXT_MAX}
            placeholder={`Reply to ${displayName(contact)}…`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11.5px] text-ink-3">
              WhatsApp&apos;s 24-hour window closes{" "}
              {formatRelative(windowUntil, new Date())}. After that, only an
              approved template can be sent.
            </p>
            <SendButton busy={busy} disabled={!canSend} onClick={send} />
          </div>
        </div>
      ) : templates === null ? (
        <div className="flex items-center gap-2 py-2 text-[12px] text-ink-2">
          <Spinner className="size-4 text-ink-3" />
          Loading your templates…
        </div>
      ) : usable.length === 0 ? (
        <div className="grid gap-2">
          <p className="text-[12px] leading-relaxed text-ink-2">
            {templatesError ??
              (blocked.length > 0
                ? "None of your templates can be sent from here yet."
                : "You have no WhatsApp templates yet.")}{" "}
            Templates are written and approved in WhatsApp Manager — Meta has to
            approve the wording before it can be sent to anybody.
          </p>
          {blocked.length > 0 && <BlockedList templates={blocked} />}
          <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
        </div>
      ) : (
        <div className="grid gap-2.5">
          <Select
            label="Template"
            id="crm-template"
            value={template ? templateKey(template) : ""}
            onChange={(next) => {
              setChosen(next);
              // Values belong to the template they were typed for; carrying them
              // across would put somebody's first name in a date field.
              setParams([]);
            }}
          >
            {usable.map((t) => (
              <option key={templateKey(t)} value={templateKey(t)}>
                {t.name} · {t.language} · {t.category.toLowerCase()}
              </option>
            ))}
          </Select>

          {template && (
            <>
              {template.variables > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {filled.map((_, i) => (
                    <div key={i}>
                      <label className="label" htmlFor={`crm-param-${i}`}>
                        {`Value for {{${i + 1}}}`}
                      </label>
                      <input
                        id={`crm-param-${i}`}
                        className="field"
                        value={params[i] ?? ""}
                        onChange={(e) =>
                          setParams((prev) => {
                            const next = [...prev];
                            next[i] = e.target.value;
                            return next;
                          })
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* The message as the contact will read it, placeholders filled.
                  A host approving "Hi {{1}}" has not read what they are
                  sending. */}
              <div className="rounded-xl border border-line bg-surface px-3 py-2">
                {template.header && (
                  <p className="text-[12.5px] font-semibold">
                    {template.header}
                  </p>
                )}
                <p className="mt-0.5 text-[13px] leading-relaxed whitespace-pre-wrap">
                  {renderTemplate(template.body ?? "", filled)}
                </p>
                {template.footer && (
                  <p className="mt-1 text-[11px] text-ink-3">
                    {template.footer}
                  </p>
                )}
              </div>

              {needsOptIn && (
                <Alert tone="warn">
                  This is a marketing template and this contact has not opted in
                  to marketing messages. A utility template — a reminder about a
                  webinar they registered for — can still be sent.
                </Alert>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <RefreshTemplates syncing={syncing} onClick={onRefreshTemplates} />
            <SendButton busy={busy} disabled={!canSend} onClick={send} />
          </div>

          {!open && (
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              Only a template can be sent right now. WhatsApp allows a business
              to write in its own words for 24 hours after the contact&apos;s
              last message, and this one has not written recently.
            </p>
          )}
          {blocked.length > 0 && <BlockedList templates={blocked} />}
        </div>
      )}
    </div>
  );
}

/** The footer where the compose box would be, for the contacts there is nothing
 *  to compose to. Same place and same weight, so the pane does not change shape
 *  depending on who is selected. */
function ComposeNote({ children }: { children: ReactNode }) {
  return (
    <p className="border-t border-line bg-surface-2 px-4 py-3 text-[12px] leading-relaxed text-ink-2">
      {children}
    </p>
  );
}

function SendButton({
  busy,
  disabled,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      size="sm"
      onClick={onClick}
      disabled={busy || disabled}
      className="ml-auto"
    >
      {busy ? (
        <Spinner className="size-3.5" />
      ) : (
        <SendIcon className="size-3.5" />
      )}
      Send
    </Button>
  );
}

// ------------------------------------------------------------------ helpers

/** A contact always has SOMETHING to be called: a name, a number, an email, and
 *  in the worst case the fact that we do not know. An empty row is unclickable
 *  in practice. */
function displayName(c: CRMContact): string {
  return c.name || c.phone || c.email || "Unknown contact";
}

function initialsOf(c: CRMContact): string {
  const words = (c.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Relative while it is recent and useful ("2 hours ago"), which is the whole of
 *  what an inbox row needs; the full timestamp is a tooltip nobody has asked for
 *  yet. Empty for a missing date rather than "Invalid Date". */
function whenText(iso?: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return formatRelative(iso, new Date());
}

function previewOf(m: CRMMessage): string {
  const text = m.body || kindText(m.kind);
  return m.direction === "out" ? `You: ${text}` : text;
}

/** What to show for a message whose content is not text. Meta's own vocabulary,
 *  turned into a sentence rather than left as a bare `document`. */
function kindText(kind?: string): string {
  switch (kind) {
    case "image":
      return "Sent a photo";
    case "video":
      return "Sent a video";
    case "voice":
      return "Sent a voice note";
    case "audio":
      return "Sent audio";
    case "document":
      return "Sent a document";
    case "sticker":
      return "Sent a sticker";
    case "location":
      return "Shared a location";
    case "contacts":
      return "Shared a contact";
    case "button":
    case "interactive":
      return "Tapped a button";
    case "":
    case undefined:
      return "No message text";
    default:
      // A type Meta added after this was written. Naming it is more use to a
      // host than "unsupported message".
      return `Sent a ${kind}`;
  }
}
