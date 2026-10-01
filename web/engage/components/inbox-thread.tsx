"use client";

import { useEffect, useRef, useState } from "react";
import { engageApi } from "../api";
import { Alert, ConfirmModal, Spinner } from "@/components/controls";
import { ArrowLeftIcon, CheckIcon } from "@/components/icons";
import { useToast } from "@/components/providers";
import { Badge, Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type {
  CRMContact,
  CRMMessage,
  CRMNote,
  CRMSnippet,
  CRMTag,
  CRMTemplate,
  CRMThreadMeta,
} from "@/lib/api-types";
import { useNow } from "@/lib/clock";
import { formatRelative } from "@/lib/format";
import { NotesPane } from "./crm-notes";
import { MessageContent } from "./message-content";
import { Compose, ConsentBadge } from "./crm-screen";
import { ContactTags } from "./crm-tags";
import { PersonAvatar, Ticks, WA_BUBBLE, WA_WALL } from "./wa-kit";

/* The Messages tab's conversation, made to look like WhatsApp (Engage v2).
 *
 * Three columns on a wide screen: the list (the parent's), this chat, and a profile
 * panel with who the person is — their webinars with a watch bar each, tags, notes.
 * The chat is the phone's: green outgoing bubbles with ticks, a day marker per day
 * that says what happened with a webinar that day, runs of automatic messages folded
 * into one line, and a pill for the time left to reply freely.
 */
export function InboxThread({
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
  actions,
  snippets,
  onManageSnippets,
}: {
  contactId: string;
  fallback: CRMContact | null;
  tick: number;
  allTags: CRMTag[] | null;
  notesOn: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  syncing: boolean;
  onRefreshTemplates: () => void;
  onChanged: () => void;
  onBack: () => void;
  /** Mark done / Reopen, from the parent, in the chat header. */
  actions?: React.ReactNode;
  snippets?: CRMSnippet[];
  onManageSnippets?: () => void;
}) {
  const { notify } = useToast();
  const [contact, setContact] = useState<CRMContact | null>(fallback);
  const [messages, setMessages] = useState<CRMMessage[] | null>(null);
  const [notes, setNotes] = useState<CRMNote[]>([]);
  const [meta, setMeta] = useState<CRMThreadMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [windowUntil, setWindowUntil] = useState("");
  const [connected, setConnected] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  // Open at the newest message, as a phone does.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmThread(contactId)
      .then((res) => {
        if (cancelled) return;
        setContact(res.contact);
        setMessages(res.messages);
        setNotes(res.notes);
        setMeta(res.meta);
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

  async function setBotPaused(paused: boolean) {
    setBusy(true);
    try {
      setContact(await engageApi.setCrmContactBot(contactId, { paused }));
      onChanged();
      notify(
        paused
          ? "Yours now — no bot answers this person until you hand it back."
          : "Handed back to the bot.",
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
      const updated = await engageApi.crmOptOut(contactId);
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

  const name = contact
    ? contact.name || contact.phone || contact.email || "Unknown"
    : "Contact";

  return (
    <div className="grid min-h-[34rem] overflow-hidden rounded-xl border border-line bg-surface xl:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="flex min-w-0 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-2.5">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 grid size-8 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 lg:hidden"
            aria-label="Back to conversations"
          >
            <ArrowLeftIcon className="size-4" />
          </button>
          <PersonAvatar name={name} seed={contactId} size={34} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-ink">
              {name}
            </div>
            <div className="truncate text-[11.5px] text-ink-3">
              {[contact?.phone, lastSeen(messages)].filter(Boolean).join(" · ")}
            </div>
          </div>
          {contact?.phone &&
            (contact.botPausedAt ||
              (messages ?? []).some((m) => m.fromBot)) && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setBotPaused(!contact.botPausedAt)}
              >
                {contact.botPausedAt
                  ? "Let the bot answer"
                  : "Take over from bot"}
              </Button>
            )}
          {actions}
        </header>

        {error && (
          <div className="px-4 py-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}

        <div
          ref={scroller}
          className="h-[30rem] overflow-y-auto px-4 py-4"
          style={{ background: WA_WALL }}
        >
          {messages === null ? (
            <div className="grid h-full place-items-center">
              <Spinner className="size-5 text-ink-3" />
            </div>
          ) : messages.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-ink-2">
              No messages with this person yet.
            </p>
          ) : (
            <Chat
              messages={messages}
              history={meta?.history ?? []}
              windowUntil={windowUntil}
            />
          )}
        </div>

        {contact && (
          <Compose
            contact={contact}
            windowUntil={windowUntil}
            connected={connected}
            templates={templates}
            templatesError={templatesError}
            syncing={syncing}
            onRefreshTemplates={onRefreshTemplates}
            snippets={snippets}
            onManageSnippets={onManageSnippets}
            onSent={(msg) => {
              setMessages((prev) => [...(prev ?? []), msg]);
              onChanged();
            }}
          />
        )}
      </div>

      <aside className="hidden border-l border-line xl:block">
        {contact && (
          <Profile
            contact={contact}
            meta={meta}
            allTags={allTags}
            notesOn={notesOn}
            notes={notes}
            onNotes={setNotes}
            onTags={(next) => {
              setContact({ ...contact, tags: next });
              onChanged();
            }}
            onOptOut={() => setConfirming(true)}
          />
        )}
      </aside>

      <ConfirmModal
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={optOut}
        busy={busy}
        title="Mark as opted out?"
        body="Nothing will be sent to this contact on WhatsApp. You cannot undo this from here — only they can opt in again, by asking to or by registering with the box ticked."
        confirmLabel="Mark opted out"
      />
    </div>
  );
}

function lastSeen(messages: CRMMessage[] | null): string {
  const last = [...(messages ?? [])]
    .reverse()
    .find((m) => m.direction === "in");
  return last ? `wrote ${formatRelative(last.createdAt, new Date())}` : "";
}

// ---------------------------------------------------------------------- chat

type Item =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: CRMMessage }
  | { kind: "auto"; key: string; ms: CRMMessage[] };

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string, history: CRMThreadMeta["history"]): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString([], { day: "numeric", month: "short" });
  const w = (history ?? []).find((h) => dayKey(h.startsAt) === dayKey(iso));
  if (!w) return date;
  if (!w.ended) return `${date} · ${w.topic}`;
  if (!w.joined) return `${date} · Didn't join ${w.topic}`;
  return `${date} · Joined live, watched ${w.watchMin} of ${w.durationMin} min`;
}

/** Days, messages, and runs of two or more automatic messages folded into one. */
function items(
  messages: CRMMessage[],
  history: CRMThreadMeta["history"],
): Item[] {
  const out: Item[] = [];
  let day = "";
  let run: CRMMessage[] = [];
  const flush = () => {
    if (run.length === 1) out.push({ kind: "msg", key: run[0].id, m: run[0] });
    else if (run.length > 1)
      out.push({ kind: "auto", key: run[0].id, ms: run });
    run = [];
  };
  /* A run of automatic messages spans days — confirmation on the 12th, reminders on
   * the 24th — and folds into one line; a day marker is for what else happened. */
  const marker = (iso: string) => {
    const k = dayKey(iso);
    if (k === day) return;
    day = k;
    out.push({ kind: "day", key: "d" + k, label: dayLabel(iso, history) });
  };
  // Webinars they joined or missed are events of their own, between messages.
  const events = (history ?? [])
    .filter((h) => h.ended)
    .map((h) => ({ at: new Date(h.startsAt).getTime(), iso: h.startsAt }))
    .sort((x, y) => x.at - y.at);
  let e = 0;
  for (const m of messages) {
    const t = new Date(m.createdAt).getTime();
    while (e < events.length && events[e].at <= t) {
      flush();
      marker(events[e].iso);
      e++;
    }
    if (m.automatic && m.direction === "out") {
      if (run.length === 0) marker(m.createdAt);
      run.push(m);
      continue;
    }
    flush();
    marker(m.createdAt);
    out.push({ kind: "msg", key: m.id, m });
  }
  flush();
  return out;
}

function Chat({
  messages,
  history,
  windowUntil,
}: {
  messages: CRMMessage[];
  history: CRMThreadMeta["history"];
  windowUntil: string;
}) {
  const list = items(messages, history);
  return (
    <div className="grid gap-1.5">
      {list.map((it) =>
        it.kind === "day" ? (
          <div
            key={it.key}
            className="my-1.5 justify-self-center rounded-md bg-white/85 px-2.5 py-0.5 text-[11px] text-ink-2 shadow-sm"
          >
            {it.label}
          </div>
        ) : it.kind === "auto" ? (
          <AutoRun key={it.key} ms={it.ms} />
        ) : (
          <Bubble key={it.key} m={it.m} />
        ),
      )}
      <WindowPill until={windowUntil} />
    </div>
  );
}

function AutoRun({ ms }: { ms: CRMMessage[] }) {
  const [open, setOpen] = useState(false);
  if (open) {
    return (
      <>
        {ms.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="justify-self-center text-[11px] font-medium text-brand hover:underline"
        >
          Fold automatic messages
        </button>
      </>
    );
  }
  const read = ms.every((m) => m.status === "read");
  return (
    <div className="my-0.5 flex items-center gap-2 justify-self-center rounded-lg border border-dashed border-line-2 bg-white/70 px-3 py-1.5 text-[11.5px] text-ink-2">
      <span>
        <b className="font-semibold text-ink">{ms.length} automatic messages</b>{" "}
        · {autoKinds(ms)}
        {read && " · all read"}
      </span>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-medium text-brand hover:underline"
      >
        Show
      </button>
    </div>
  );
}

function autoKinds(ms: CRMMessage[]): string {
  const names = new Set(
    ms.map((m) => {
      const t = (m.templateName ?? "").toLowerCase();
      if (t.includes("confirm")) return "confirmation";
      if (t.includes("remind")) return "reminders";
      if (t.includes("replay") || t.includes("record")) return "replay";
      return "updates";
    }),
  );
  return [...names].join(", ");
}

function Bubble({ m }: { m: CRMMessage }) {
  const inbound = m.direction === "in";
  const failed = m.status === "failed";
  const time = new Date(m.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div
        className={`max-w-[80%] min-w-0 rounded-lg px-2.5 pt-1.5 pb-1 text-[13px] leading-relaxed break-words text-[#111] shadow-sm ${
          inbound ? "rounded-tl-none bg-white" : "rounded-tr-none"
        } ${failed ? "ring-1 ring-live/50" : ""}`}
        style={inbound ? undefined : { background: WA_BUBBLE }}
      >
        {!inbound && (m.fromBot || (m.templateName && !m.manual)) && (
          <div className="mb-0.5 text-[10px] font-semibold tracking-wide text-[#1f7a4d] uppercase">
            {m.fromBot
              ? `Bot · ${m.fromBot}`
              : m.templateName?.replace(/_/g, " ")}
          </div>
        )}
        <MessageContent message={m} />
        <span className="float-right mt-1.5 ml-2 flex items-center gap-1 text-[10px] text-[#667781]">
          {time}
          {!inbound && <Ticks status={m.status} />}
        </span>
        {failed && m.error && (
          <p className="clear-both mt-1 text-[11px] text-live">{m.error}</p>
        )}
      </div>
    </div>
  );
}

/** The 24-hour window, said as time left: the one number that decides what can be sent. */
function WindowPill({ until }: { until: string }) {
  const now = useNow();
  if (!until) {
    return (
      <div className="mt-2 justify-self-center rounded-full bg-white/85 px-3 py-1 text-[11px] text-ink-2 shadow-sm">
        Reply window closed · only an approved template can be sent
      </div>
    );
  }
  if (now === null) return null;
  const hours = Math.max(0, (new Date(until).getTime() - now) / 3_600_000);
  const soon = hours < 3;
  const left =
    hours >= 1
      ? `${Math.floor(hours)} more hour${Math.floor(hours) === 1 ? "" : "s"}`
      : `${Math.max(1, Math.round(hours * 60))} more min`;
  return (
    <div
      className={`mt-2 flex items-center gap-1.5 justify-self-center rounded-full px-3 py-1 text-[11px] font-medium shadow-sm ${
        soon ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"
      }`}
    >
      <span className={`size-1.5 rounded-full ${soon ? "bg-warn" : "bg-ok"}`} />
      You can reply freely for {left}
    </div>
  );
}

// ------------------------------------------------------------------- profile

function Profile({
  contact,
  meta,
  allTags,
  notesOn,
  notes,
  onNotes,
  onTags,
  onOptOut,
}: {
  contact: CRMContact;
  meta: CRMThreadMeta | null;
  allTags: CRMTag[] | null;
  notesOn: boolean;
  notes: CRMNote[];
  onNotes: (n: CRMNote[]) => void;
  onTags: (t: CRMTag[]) => void;
  onOptOut: () => void;
}) {
  const name = contact.name || contact.phone || "Unknown";
  const history = meta?.history ?? [];
  return (
    <div className="grid content-start divide-y divide-line">
      <section className="grid justify-items-center gap-1.5 px-4 py-5 text-center">
        <PersonAvatar name={name} seed={contact.id} size={60} />
        <div className="mt-1 text-[14px] font-semibold text-ink">{name}</div>
        <div className="text-[11.5px] break-all text-ink-3">
          {[contact.company, contact.email].filter(Boolean).join(" · ") ||
            contact.phone}
        </div>
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          <ConsentBadge contact={contact} />
          {contact.botPausedAt && (
            <Badge tone="warn">Yours, not a bot&apos;s</Badge>
          )}
        </div>
      </section>

      <section className="grid gap-2.5 px-4 py-3.5">
        <h4 className="text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">
          Webinars
        </h4>
        {history.length === 0 ? (
          <p className="text-[12px] text-ink-3">Not registered for any yet.</p>
        ) : (
          history.map((h) => (
            <div key={h.id} className="grid gap-1">
              <div className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="truncate font-medium text-ink">{h.topic}</span>
                <span className="shrink-0 text-[11px] text-ink-3">
                  {!h.ended
                    ? new Date(h.startsAt).toLocaleDateString([], {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                      })
                    : h.joined
                      ? `${h.watchMin} / ${h.durationMin} min`
                      : "Didn't join"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className={`h-full rounded-full ${h.joined ? "bg-brand" : "bg-line-2"}`}
                  style={{
                    width: `${h.ended && h.joined ? Math.min(100, (h.watchMin / Math.max(1, h.durationMin)) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
          ))
        )}
      </section>

      {allTags !== null && (
        <section className="grid gap-2 px-4 py-3.5">
          <h4 className="text-[10.5px] font-semibold tracking-wider text-ink-3 uppercase">
            Tags
          </h4>
          <ContactTags
            contactId={contact.id}
            tags={contact.tags ?? []}
            all={allTags}
            onChanged={onTags}
          />
        </section>
      )}

      {notesOn && (
        <section className="[&>*]:border-t-0">
          <NotesPane contactId={contact.id} notes={notes} onChanged={onNotes} />
        </section>
      )}

      {contact.phone && !contact.whatsappOptOutAt && (
        <section className="px-4 py-3">
          <button
            type="button"
            onClick={onOptOut}
            className="text-[11.5px] font-medium text-live hover:underline"
          >
            Mark opted out
          </button>
        </section>
      )}
    </div>
  );
}

export function DoneButton({
  done,
  busy,
  onClick,
}: {
  done: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button size="sm" variant="secondary" onClick={onClick} disabled={busy}>
      {!done && <CheckIcon className="size-3.5" />}
      {done ? "Reopen" : "Done"}
    </Button>
  );
}
