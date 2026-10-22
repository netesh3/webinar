"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Spinner } from "./controls";
import { FollowupSendDialog } from "./followup-send-dialog";
import { CopyIcon, SendIcon, SparklesIcon } from "./icons";
import { useSession, useToast } from "./providers";
import { Badge, Button, Card, SectionTitle } from "./ui";
import { ENGAGE_HOME, FollowupWhatsAppActions, messagesHref } from "@/engage";
import { ApiError, api } from "@/lib/api";
import type { FollowupDraft, FollowupsResponse, Lead, LeadsResponse, Webinar } from "@/lib/api-types";
import { useDevAuthBypassActive } from "@/lib/dev-bypass-session";
import type { ChannelPref } from "@/lib/followup-send";
import {
  FOLLOWUP_GROUPS,
  csvFileName,
  downloadCsv,
  followupsEmptyState,
  followupsErrorStatus,
  groupContactIds,
  groupHint,
  groupLabel,
  groupSegment,
  leadChips,
  leadsAINote,
  leadsCsv,
  leadsInGroup,
  tagLabel,
  tagTone,
  waTemplateWording,
} from "@/lib/leads";

/** How often an AI output still being written is looked at again. */
const PROCESSING_POLL_MS = 5_000;
/** Leads shown before "Show more". */
const LEADS_SHOWN = 10;

function useCopy() {
  const { notify } = useToast();
  return async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied.`, "ok");
    } catch {
      notify("Couldn't reach the clipboard.", "info");
    }
  };
}

function AITitle({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <SparklesIcon className="-mt-3 size-4 text-brand" />
      <SectionTitle>{children}</SectionTitle>
    </div>
  );
}

/* The Results tab's two AI cards for an ended session, side by side: Hot leads (who to
 * follow up with first, and why) and the Follow-up writer (a draft per group). The leads
 * are read once here and shared, so the follow-up groups' exports are the same people. */
export function AILeadsAndFollowups({ webinar }: { webinar: Webinar }) {
  const bypass = useDevAuthBypassActive();
  const slug = webinar.id;
  const [leads, setLeads] = useState<LeadsResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [poll, setPoll] = useState(0);

  useEffect(() => {
    if (bypass) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    api
      .sessionLeads(slug, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setLeads(res);
        setLoadError(false);
        if (res.aiStatus === "processing") timer = setTimeout(() => setPoll((n) => n + 1), PROCESSING_POLL_MS);
      })
      .catch(() => {
        if (!ctl.signal.aborted) setLoadError(true);
      });
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [slug, bypass, poll]);

  if (bypass) return null;
  return (
    <div className="mb-4 grid gap-4 lg:grid-cols-2">
      <HotLeadsCard topic={webinar.topic} data={leads} loadError={loadError} />
      <FollowupsCard webinar={webinar} leads={leads} />
    </div>
  );
}

function HotLeadsCard({ topic, data, loadError }: { topic: string; data: LeadsResponse | null; loadError: boolean }) {
  const copy = useCopy();
  const [more, setMore] = useState(false);

  const header = (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <AITitle>Hot leads</AITitle>
      {data && data.leads.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => downloadCsv(csvFileName("leads", topic), leadsCsv(data.leads))}
        >
          Export CSV
        </Button>
      )}
    </div>
  );

  if (!data) {
    return (
      <Card className="p-5">
        {header}
        <p className="text-[13px] text-ink-2">
          {loadError ? "Couldn't load the leads. Reload the page to try again." : "Loading the leads…"}
        </p>
      </Card>
    );
  }

  const ranked = data.leads.filter((l) => l.score > 0);
  const shown = more ? ranked : ranked.slice(0, LEADS_SHOWN);
  const note = leadsAINote(data.aiStatus);
  return (
    <Card className="p-5">
      {header}
      <p className="mb-3 text-[12.5px] text-ink-3">
        Ranked by what people did: watch time, questions, chat, polls, raised hands. The reasons are written by AI.
      </p>
      {note && (
        <p className="mb-3 text-[12.5px] text-ink-2">
          {data.aiStatus === "processing" && <Spinner />} {note}
        </p>
      )}
      {ranked.length === 0 ? (
        <p className="text-[13px] text-ink-2">Nobody took part in this session yet, so there are no leads.</p>
      ) : (
        <ol className="grid gap-3">
          {shown.map((l, i) => (
            <LeadRow key={l.key} lead={l} rank={i + 1} onCopy={copy} />
          ))}
        </ol>
      )}
      {ranked.length > LEADS_SHOWN && (
        <button
          type="button"
          className="mt-3 text-[12.5px] font-medium text-brand hover:underline"
          onClick={() => setMore((m) => !m)}
        >
          {more ? "Show fewer" : `Show all ${ranked.length}`}
        </button>
      )}
    </Card>
  );
}

function contactLine(l: Lead): string {
  return [l.name, l.email, l.phone].filter(Boolean).join(", ");
}

function LeadRow({
  lead: l,
  rank,
  onCopy,
}: {
  lead: Lead;
  rank: number;
  onCopy: (text: string, what: string) => Promise<void>;
}) {
  return (
    <li className="rounded-lg border border-line px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-[12px] tabular-nums text-ink-3">{rank}</span>
        <span className="text-[13.5px] font-medium text-ink">{l.name || "Guest"}</span>
        <Badge tone={tagTone(l.tag)}>{tagLabel(l.tag)}</Badge>
        <span className="text-[12px] tabular-nums text-ink-3" title="Lead score, out of 100">
          {l.score}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink"
            onClick={() => void onCopy(contactLine(l), "Contact")}
            aria-label={`Copy ${l.name}'s contact details`}
          >
            <CopyIcon className="size-3.5" />
            Copy
          </button>
          {l.contactId && (
            <Link
              href={messagesHref(l.contactId)}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              Open in CRM
            </Link>
          )}
        </span>
      </div>
      {l.reason && (
        <p className="mt-1 flex items-start gap-1 pl-7 text-[13px] text-ink">
          <SparklesIcon className="mt-0.5 size-3.5 shrink-0 text-brand" aria-label="Written by AI" />
          {l.reason}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
        {leadChips(l.signals).map((c) => (
          <span key={c} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
            {c}
          </span>
        ))}
      </div>
      {(l.email || l.phone) && (
        <p className="mt-1 pl-7 text-[12px] text-ink-3">{[l.email, l.phone].filter(Boolean).join(" · ")}</p>
      )}
    </li>
  );
}

type Lang = "en" | "hinglish";

function FollowupsCard({ webinar, leads }: { webinar: Webinar; leads: LeadsResponse | null }) {
  const slug = webinar.id;
  const copy = useCopy();
  const { notify } = useToast();
  const [lang, setLang] = useState<Lang | null>(null);
  const [data, setData] = useState<FollowupsResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [group, setGroup] = useState<string>("hot");
  const [edit, setEdit] = useState<FollowupDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [poll, setPoll] = useState(0);
  const [sending, setSending] = useState<{ keys: string[]; pref: ChannelPref } | null>(null);
  const { account } = useSession();
  // Sending goes from the host's own number and in their name: the host only, not a co-host.
  const canSend = Boolean(account && account.id === webinar.host.id);

  useEffect(() => {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    api
      .sessionFollowups(slug, lang ?? undefined, ctl.signal)
      .then((res) => {
        if (ctl.signal.aborted) return;
        setData(res);
        setStatus(res.status);
        setLoadError(false);
        setEdit(null);
        if (res.status === "processing") timer = setTimeout(() => setPoll((n) => n + 1), PROCESSING_POLL_MS);
        // Open on the first group with anybody in it.
        setGroup((g) => {
          const cur = res.groups.find((x) => x.group === g);
          return cur && cur.count > 0 ? g : (res.groups.find((x) => x.count > 0)?.group ?? g);
        });
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        if (err instanceof ApiError && err.status !== 404) {
          setStatus(followupsErrorStatus(err.code));
          return;
        }
        setLoadError(true);
      });
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [slug, lang, poll]);

  const language: Lang = (lang ?? (data?.language as Lang | undefined)) || "en";
  const header = (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
      <AITitle>Follow-up writer</AITitle>
      {data && status === "ready" && (
        <div className="-mt-3 inline-flex rounded-md border border-line p-0.5" role="group" aria-label="Language">
          {(["en", "hinglish"] as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              aria-pressed={language === l}
              onClick={() => setLang(l)}
              className={`rounded px-2 py-0.5 text-[12px] ${language === l ? "bg-brand-soft text-brand" : "text-ink-2 hover:text-ink"}`}
            >
              {l === "en" ? "English" : "Hinglish"}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  if (!data && !status) {
    return (
      <Card className="p-5">
        {header}
        <p className="text-[13px] text-ink-2">
          {loadError ? "Couldn't load the follow-ups. Reload the page to try again." : "Loading the follow-ups…"}
        </p>
      </Card>
    );
  }

  const empty = followupsEmptyState(status ?? "failed");
  const groups = data?.groups ?? [];
  const current = groups.find((g) => g.group === group);
  const people = leads ? leadsInGroup(leads.leads, group) : [];
  const exportGroup = () =>
    downloadCsv(csvFileName(`follow-up-${group.replace("_", "-")}`, webinar.topic), leadsCsv(people));

  const groupTabs = (
    <div className="mb-3 flex flex-wrap gap-1.5" role="tablist">
      {FOLLOWUP_GROUPS.map((g) => {
        const count = groups.find((x) => x.group === g)?.count ?? 0;
        return (
          <button
            key={g}
            type="button"
            role="tab"
            aria-selected={group === g}
            disabled={count === 0}
            onClick={() => {
              setGroup(g);
              setEdit(null);
            }}
            className={`rounded-full border px-2.5 py-0.5 text-[12px] disabled:opacity-40 ${
              group === g ? "border-brand-line bg-brand-soft text-brand" : "border-line text-ink-2 hover:text-ink"
            }`}
          >
            {groupLabel(g)} · {count}
          </button>
        );
      })}
    </div>
  );

  if (empty || !current) {
    const state = empty ?? followupsEmptyState("failed")!;
    return (
      <Card className="p-5">
        {header}
        {groups.length > 0 && groupTabs}
        <p className="text-[13.5px] font-medium text-ink">
          {state.pending && <Spinner />} {state.title}
        </p>
        <p className="mt-1 text-[13px] text-ink-2">{state.detail}</p>
        {people.length > 0 && (
          <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={exportGroup}>
            Download this group (CSV)
          </Button>
        )}
      </Card>
    );
  }

  const draft = edit ?? current.draft ?? null;
  const dirty = edit !== null;
  const save = async () => {
    if (!edit || saving) return;
    setSaving(true);
    try {
      const res = await api.saveFollowup(slug, group, edit, language);
      setData(res);
      setEdit(null);
      notify("Draft saved.", "ok");
    } catch (err) {
      notify(err instanceof ApiError ? err.message : "Couldn't save the draft.", "error");
    } finally {
      setSaving(false);
    }
  };
  const change = (patch: Partial<FollowupDraft>) => {
    if (!draft) return;
    setEdit({ ...draft, ...patch });
  };
  const wa = draft ? waTemplateWording(draft.whatsapp, data?.replayLink) : null;
  const contactIds = leads ? groupContactIds(leads.leads, group) : [];

  return (
    <Card className="p-5">
      {header}
      <p className="mb-3 text-[12.5px] text-ink-3">
        Drafts written by AI for each group. Edit them here, then send them from the list below: you review every message first, and nothing is sent until you press Send.
      </p>
      {groupTabs}
      <p className="mb-3 text-[12.5px] text-ink-2">
        {groupHint(group)} {current.edited && <Badge tone="brand">Edited</Badge>}
      </p>
      {draft ? (
        <div className="grid gap-3">
          <label className="grid gap-1 text-[12.5px] font-medium text-ink-2">
            Email subject
            <input
              className="field"
              value={draft.emailSubject}
              maxLength={200}
              onChange={(e) => change({ emailSubject: e.target.value })}
            />
          </label>
          <label className="grid gap-1 text-[12.5px] font-medium text-ink-2">
            Email
            <textarea
              className="field min-h-36 resize-y py-2"
              value={draft.emailBody}
              maxLength={5000}
              onChange={(e) => change({ emailBody: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void copy(`${draft.emailSubject}\n\n${draft.emailBody}`, "Email")}
            >
              <CopyIcon className="size-3.5" />
              Copy email
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={exportGroup} disabled={people.length === 0}>
              Download this group (CSV)
            </Button>
          </div>
          <label className="grid gap-1 text-[12.5px] font-medium text-ink-2">
            WhatsApp
            <textarea
              className="field min-h-24 resize-y py-2"
              value={draft.whatsapp}
              maxLength={1024}
              onChange={(e) => change({ whatsapp: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => void copy(draft.whatsapp, "WhatsApp message")}>
              <CopyIcon className="size-3.5" />
              Copy WhatsApp
            </Button>
            {wa && (
              <FollowupWhatsAppActions
                webinarId={slug}
                groupLabel={`${groupLabel(group)} · ${webinar.topic}`}
                wording={wa.body}
                params={wa.params}
                templateTitle={`Follow up ${groupLabel(group)}`}
                segment={group === "hot" ? undefined : groupSegment(group, leads?.sessionMin ?? 0)}
                contactIds={group === "hot" ? contactIds : undefined}
              />
            )}
          </div>
          <p className="text-[12px] text-ink-3">
            {"{{first_name}}"} is each person&apos;s first name
            {data?.replayLink ? (
              <>
                {" "}and {"{{replay_link}}"} is{" "}
                <a href={data.replayLink} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                  the replay
                </a>
              </>
            ) : null}
            . WhatsApp to a group goes out as an approved template, as Meta requires outside the 24-hour window.
          </p>
          {dirty && (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setEdit(null)} disabled={saving}>
                Discard
              </Button>
              <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>
                {saving && <Spinner />}
                Save draft
              </Button>
            </div>
          )}
          {canSend && (
            <FollowupPeople
              key={group}
              people={people}
              dirty={dirty}
              whatsappConnected={Boolean(account?.whatsapp)}
              onSend={(keys, pref) => setSending({ keys, pref })}
            />
          )}
        </div>
      ) : (
        <p className="text-[13px] text-ink-2">No draft for this group.</p>
      )}
      {sending && (
        <FollowupSendDialog
          slug={slug}
          topic={webinar.topic}
          keys={sending.keys}
          group={group}
          lang={language}
          pref={sending.pref}
          onClose={() => setSending(null)}
        />
      )}
    </Card>
  );
}

/** Rows shown before "Show all" in the people list under the drafts. */
const PEOPLE_SHOWN = 8;

/* The people of the open group, under its drafts: a Send email / Send WhatsApp per person,
 * and ticks for "Send to selected". Every button opens the review screen; nothing is sent
 * from here. Disabled while the draft has unsaved edits, since the review screen reads the
 * saved one. */
function FollowupPeople({
  people,
  dirty,
  whatsappConnected,
  onSend,
}: {
  people: Lead[];
  dirty: boolean;
  whatsappConnected: boolean;
  onSend: (keys: string[], pref: ChannelPref) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [all, setAll] = useState(false);
  if (people.length === 0) return null;
  const shown = all ? people : people.slice(0, PEOPLE_SHOWN);
  const toggle = (key: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const everyone = picked.size === people.length;
  return (
    <div className="mt-1 border-t border-line pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-ink-2">Send to people in this group</span>
        <label className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <input
            type="checkbox"
            checked={everyone}
            onChange={() => setPicked(everyone ? new Set() : new Set(people.map((l) => l.key)))}
          />
          Select all {people.length}
        </label>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          disabled={dirty || picked.size === 0}
          onClick={() => onSend([...picked], "auto")}
        >
          <SendIcon className="size-3.5" />
          Send to selected{picked.size ? ` (${picked.size})` : ""}
        </Button>
      </div>
      {dirty && <p className="mb-2 text-[12px] text-ink-3">Save the draft first: sending uses the saved one.</p>}
      <ul className="grid gap-1">
        {shown.map((l) => (
          <li key={l.key} className="flex flex-wrap items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-2">
            <input
              type="checkbox"
              aria-label={`Select ${l.name || "Guest"}`}
              checked={picked.has(l.key)}
              onChange={() => toggle(l.key)}
            />
            <span className="text-[13px] text-ink">{l.name || "Guest"}</span>
            <span className="truncate text-[11.5px] text-ink-3">{[l.email, l.phone].filter(Boolean).join(" · ")}</span>
            <span className="ml-auto flex gap-1">
              <button
                type="button"
                className="h-7 rounded-md px-2 text-[12px] text-ink-2 hover:bg-surface hover:text-ink disabled:opacity-40"
                disabled={dirty || !l.email}
                title={l.email ? undefined : "No email address"}
                onClick={() => onSend([l.key], "email")}
              >
                Send email
              </button>
              <button
                type="button"
                className="h-7 rounded-md px-2 text-[12px] text-ink-2 hover:bg-surface hover:text-ink disabled:opacity-40"
                disabled={dirty || !whatsappConnected || l.whatsappStatus !== "opted_in"}
                title={
                  !whatsappConnected
                    ? "Connect WhatsApp to send"
                    : l.whatsappStatus !== "opted_in"
                      ? "Didn't opt in to WhatsApp"
                      : undefined
                }
                onClick={() => onSend([l.key], "whatsapp")}
              >
                Send WhatsApp
              </button>
            </span>
          </li>
        ))}
      </ul>
      {people.length > PEOPLE_SHOWN && (
        <button
          type="button"
          className="mt-1 text-[12.5px] font-medium text-brand hover:underline"
          onClick={() => setAll((a) => !a)}
        >
          {all ? "Show fewer" : `Show all ${people.length}`}
        </button>
      )}
      {!whatsappConnected && (
        <p className="mt-2 text-[12px] text-ink-3">
          Follow-ups go by email.{" "}
          <Link href={`${ENGAGE_HOME}?view=setup`} className="text-brand hover:underline">
            Connect WhatsApp
          </Link>{" "}
          to send them from your business number too.
        </p>
      )}
    </div>
  );
}
