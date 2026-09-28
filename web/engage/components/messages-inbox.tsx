"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { engageApi } from "../api";
import { Alert, Spinner } from "@/components/controls";
import {
  ArrowLeftIcon,
  MaterialIcon,
  SearchIcon,
  SendIcon,
} from "@/components/icons";
import { useToast } from "@/components/providers";
import { Button, Card } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { ListPager } from "@/components/ui";
import {
  InboxAll,
  InboxNeedsReply,
  type CRMContact,
  type CRMInboxThread,
  type CRMMessage,
  type CRMTemplate,
  type CRMThreadResponse,
} from "@/lib/api-types";
import { kindText } from "./crm-screen";
import { templateKey } from "./crm-templates";
import { PersonAvatar, Ticks } from "./wa-kit";

/* Messages: its own screen, opened from the chat icon, not a tab on Your webinars.
 *
 * The list is the inbox endpoint (every conversation, or the ones waiting, or one
 * webinar's people). The open thread is the same read the old tab used, including
 * the 24-hour window: inside it the composer is the host's own words; outside it
 * the composer can only send an approved template, which is the send path the CRM
 * already has. Language, country and timezone are not on the contact the API
 * returns, so those facts are absent rather than filled in. The thread read is
 * capped, not paged, so there is no Load more.
 */

const POLL_MS = 20_000;
const PAGE = 30;
const TEXT_MAX = 4096;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function HostMessagesInbox() {
  const router = useRouter();
  const search = useSearchParams();
  const contactParam = search.get("contact") ?? "";
  const askedWebinar = search.get("webinar") ?? "";
  const askedUnread = search.get("filter") === "unread";

  const [filter, setFilter] = useState(askedUnread ? "unread" : askedWebinar);
  const [query, setQuery] = useState("");
  const [threads, setThreads] = useState<CRMInboxThread[] | null>(null);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [webinars, setWebinars] = useState<{ id: string; topic: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(
    contactParam || null,
  );
  const [mobileOpen, setMobileOpen] = useState(Boolean(contactParam));
  const [tick, setTick] = useState(0);
  const [templates, setTemplates] = useState<CRMTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);

  const view = filter === "unread" ? InboxNeedsReply : InboxAll;
  const webinarId = filter !== "unread" && filter !== "" ? filter : "";
  const [seenInbox, setSeenInbox] = useState(`${view}:${webinarId}`);
  if (`${view}:${webinarId}` !== seenInbox) {
    setSeenInbox(`${view}:${webinarId}`);
    setOffset(0);
    setThreads(null);
  }

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmInbox(view, webinarId, offset, PAGE)
      .then((res) => {
        if (cancelled) return;
        setThreads(res.threads ?? []);
        setTotal(res.total);
        setWebinars(res.webinars);
        setError(null);
      })
      .catch(() => {
        if (!cancelled) {
          setThreads([]);
          setError("Could not load your messages.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [view, webinarId, offset, tick]);

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmTemplates()
      .then((res) => {
        if (!cancelled) setTemplates(res.templates);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTemplates([]);
        setTemplatesError(
          e instanceof ApiError
            ? e.message
            : "Could not load your WhatsApp templates.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = (threads ?? []).filter((t) => matchesQuery(t, query));
  // A deep link or a click names the person. Otherwise the first conversation is
  // open, the way the screen is drawn — the list is not a menu you have to click first.
  const selectedId = pickedId ?? visible[0]?.contact.id ?? null;

  function chooseFilter(next: string) {
    setFilter(next);
    const params = new URLSearchParams(search.toString());
    params.delete("filter");
    params.delete("webinar");
    if (next === "unread") params.set("filter", "unread");
    else if (next) params.set("webinar", next);
    const q = params.toString();
    router.replace(q ? `/host/messages?${q}` : "/host/messages", {
      scroll: false,
    });
  }

  function choose(id: string) {
    setPickedId(id);
    setMobileOpen(true);
    const params = new URLSearchParams(search.toString());
    params.set("contact", id);
    router.replace(`/host/messages?${params.toString()}`, { scroll: false });
  }

  const selected =
    threads?.find((t) => t.contact.id === selectedId) ?? null;
  const inboxTotal = total;
  const inboxPages = Math.max(
    Math.floor(offset / PAGE) + 1,
    Math.ceil(inboxTotal / PAGE) || 1,
  );

  return (
    <div>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        ← Your webinars
      </Link>
      <h1 className="mb-1 text-[24px] font-semibold tracking-[-0.02em]">
        Messages
      </h1>
      <p className="mb-5 text-[13px] text-ink-2">
        WhatsApp conversations from your webinars.
      </p>
      <Card className="overflow-hidden">
        <div className="grid h-[min(40rem,calc(100dvh-16rem))] min-h-[28rem] grid-cols-1 md:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
          <aside
            className={`${mobileOpen ? "hidden md:flex" : "flex"} min-h-0 min-w-0 flex-col border-r border-line`}
          >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          <label className="relative min-w-[12rem] flex-1">
            <span className="sr-only">Search name or number</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or number"
              className="field h-9 w-full pl-8 text-[13px]"
            />
          </label>
          <select
            aria-label="Filter"
            value={filter}
            onChange={(e) => chooseFilter(e.target.value)}
            className="field h-9 w-[9.25rem] shrink-0 text-[13px]"
          >
            <option value="">All webinars</option>
            <option value="unread">Unread</option>
            {webinars.map((w) => (
              <option key={w.id} value={w.id}>
                {w.topic}
              </option>
            ))}
          </select>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {threads === null ? (
            <div className="grid place-items-center py-16">
              <Spinner className="size-5 text-ink-3" />
            </div>
          ) : error && threads.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink-2">
              {error}
            </p>
          ) : visible.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink-2">
              {offset > 0 && !query.trim()
                ? "Nobody on this page"
                : query.trim()
                  ? "No conversations match that search."
                  : filter === "unread"
                    ? "You're all caught up. Nobody is waiting on a reply."
                    : "No conversations yet."}
            </p>
          ) : (
            visible.map((t) => (
              <ConversationRow
                key={t.contact.id}
                thread={t}
                active={t.contact.id === selectedId}
                onSelect={() => choose(t.contact.id)}
              />
            ))
          )}
        </div>
        {inboxTotal > PAGE || offset > 0 ? (
          <ListPager
            layout="split"
            range="stack"
            className="border-t border-line px-3 py-2.5"
            page={Math.floor(offset / PAGE) + 1}
            pages={inboxPages}
            pageSize={PAGE}
            start={(threads?.length ?? 0) === 0 ? 0 : offset + 1}
            end={(threads?.length ?? 0) === 0 ? 0 : offset + (threads?.length ?? 0)}
            total={inboxTotal}
            onPrevious={() => setOffset((n) => Math.max(0, n - PAGE))}
            onNext={() => setOffset((n) => n + PAGE)}
          />
        ) : null}
          </aside>

          <section
            className={`${mobileOpen ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-col`}
          >
        {selectedId ? (
          <ThreadPane
            key={selectedId}
            contactId={selectedId}
            fallback={selected?.contact ?? null}
            tick={tick}
            templates={templates}
            templatesError={templatesError}
            onSent={() => setTick((t) => t + 1)}
            onBack={() => setMobileOpen(false)}
          />
        ) : (
          <div className="grid flex-1 place-items-center px-6 text-center text-[13px] text-ink-2">
            {threads === null
              ? "Loading conversations…"
              : "No conversations yet."}
          </div>
        )}
          </section>
        </div>
      </Card>
    </div>
  );
}

function matchesQuery(t: CRMInboxThread, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const digits = q.replace(/\s/g, "");
  const c = t.contact;
  return (
    (c.name ?? "").toLowerCase().includes(q) ||
    (c.phone ?? "").toLowerCase().replace(/\s/g, "").includes(digits)
  );
}

function ConversationRow({
  thread: t,
  active,
  onSelect,
}: {
  thread: CRMInboxThread;
  active: boolean;
  onSelect: () => void;
}) {
  const c = t.contact;
  const name = displayName(c);
  const m = t.lastMessage;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={`grid w-full grid-cols-[36px_minmax(0,1fr)_10px] items-center gap-2.5 border-b border-line px-3 py-2.5 text-left ${
        active ? "bg-brand-soft" : "hover:bg-surface-2"
      }`}
    >
      <PersonAvatar name={name} seed={c.id} size={36} />
      <span className="min-w-0">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-[13px] text-ink ${active ? "font-semibold" : ""}`}
          >
            {name}
          </span>
          {m && (
            <span className="shrink-0 text-[11px] text-ink-3">
              {listWhen(m.createdAt)}
            </span>
          )}
        </span>
        {m && (
          <span className="mt-px flex min-w-0 items-baseline gap-1 text-[12px] text-ink-2">
            {m.direction === "out" && (
              <span className="shrink-0 text-ink-3">
                You<span className="text-ink-3"> ·</span>
              </span>
            )}
            <span className="min-w-0 truncate">
              {m.body?.trim() ||
                m.templateName?.replace(/_/g, " ") ||
                kindText(m.kind)}
            </span>
            {m.direction === "out" && <Ticks status={m.status} />}
          </span>
        )}
        {t.webinar && (
          <span className="mt-0.5 block truncate text-[11.5px] text-ink-3">
            {t.webinar}
          </span>
        )}
      </span>
      {t.needsReply ? (
        <span className="size-2.5 rounded-full bg-ok" title="Unread" />
      ) : (
        <span />
      )}
    </button>
  );
}

function ThreadPane({
  contactId,
  fallback,
  tick,
  templates,
  templatesError,
  onSent,
  onBack,
}: {
  contactId: string;
  fallback: CRMContact | null;
  tick: number;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  onSent: () => void;
  onBack: () => void;
}) {
  const [thread, setThread] = useState<CRMThreadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmThread(contactId)
      .then((res) => {
        if (cancelled) return;
        setThread(res);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
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

  const messages = thread?.messages ?? null;
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const contact = thread?.contact ?? fallback;
  const name = contact ? displayName(contact) : "Contact";

  return (
    <>
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <button
          type="button"
          onClick={onBack}
          className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 md:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeftIcon className="size-4" />
        </button>
        <PersonAvatar name={name} seed={contactId} size={34} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-ink">{name}</div>
          <div className="truncate text-[11.5px] text-ink-3">
            {contact?.phone ? `${contact.phone} · WhatsApp` : "WhatsApp"}
          </div>
        </div>
      </header>

      {contact && <Facts contact={contact} />}

      <div
        ref={scroller}
        className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto bg-page px-4 py-4"
      >
        {error && <Alert tone="error">{error}</Alert>}
        {messages === null ? (
          <div className="grid flex-1 place-items-center">
            <Spinner className="size-5 text-ink-3" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-12 text-center text-[13px] text-ink-2">
            No messages with this person yet.
          </p>
        ) : (
          messages.map((m) => <Bubble key={m.id} m={m} />)
        )}
      </div>

      {contact && thread && (
        <Composer
          contact={contact}
          lastWrote={lastWroteAt(contact, thread.messages)}
          windowUntil={thread.serviceWindowUntil ?? ""}
          connected={thread.whatsappConnected}
          templates={templates}
          templatesError={templatesError}
          onSent={(msg) => {
            setThread((prev) =>
              prev
                ? { ...prev, messages: [...prev.messages, msg] }
                : prev,
            );
            onSent();
          }}
        />
      )}
    </>
  );
}

/** Customer since and last seen are on the contact. Language, country and
 *  timezone are not, so they are left out rather than guessed. */
function Facts({ contact }: { contact: CRMContact }) {
  const facts: { icon: string; k: string; v: string }[] = [];
  const since = dateLong(contact.createdAt);
  if (since) facts.push({ icon: "calendar_month", k: "Customer since", v: since });
  const seen = contact.lastSeenAt ? dateTime(contact.lastSeenAt) : "";
  if (seen) facts.push({ icon: "visibility", k: "Last seen", v: seen });
  if (facts.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-2 border-b border-line px-4 py-3">
      {facts.map((f) => (
        <div key={f.k} className="flex min-w-0 gap-2">
          <MaterialIcon name={f.icon} className="mt-px size-4 text-ink-3" />
          <div className="min-w-0">
            <div className="text-[11px] text-ink-3">{f.k}</div>
            <div className="mt-px truncate text-[12.5px] font-semibold text-ink">
              {f.v}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Bubble({ m }: { m: CRMMessage }) {
  const inbound = m.direction === "in";
  const when = inbound ? clock(m.createdAt) : bubbleStamp(m.createdAt);
  const who = inbound
    ? ""
    : m.automatic
      ? "Automation"
      : m.fromBot
        ? m.fromBot
        : m.manual
          ? "You"
          : "";
  const failed = m.status === "failed";
  return (
    <div className={`flex ${inbound ? "justify-start" : "justify-end"}`}>
      <div className="max-w-[min(440px,85%)] min-w-0">
        <div
          className={`rounded-2xl px-3 py-2 text-[13px] leading-relaxed break-words ${
            inbound
              ? "rounded-bl-md bg-surface text-ink"
              : failed
                ? "rounded-br-md border border-live/30 bg-live-soft text-ink"
                : "rounded-br-md bg-brand text-white"
          }`}
        >
          {!inbound && m.templateName && (
            <div
              className={`mb-0.5 text-[10px] font-semibold tracking-wide uppercase ${
                failed ? "text-live" : "text-white/80"
              }`}
            >
              Template
            </div>
          )}
          {m.body ? (
            <span className="whitespace-pre-wrap">{m.body}</span>
          ) : (
            <span className="italic opacity-80">{kindText(m.kind)}</span>
          )}
        </div>
        <div
          className={`mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-3 ${
            inbound ? "" : "justify-end"
          }`}
        >
          <span>{when}</span>
          {who && <span>· {who}</span>}
          {!inbound && <Ticks status={m.status} />}
        </div>
        {m.status === "failed" && m.error && (
          <p className={`mt-0.5 text-[11px] text-live ${inbound ? "" : "text-right"}`}>
            {m.error}
          </p>
        )}
      </div>
    </div>
  );
}

function Composer({
  contact,
  lastWrote,
  windowUntil,
  connected,
  templates,
  templatesError,
  onSent,
}: {
  contact: CRMContact;
  /** When they last wrote, from the contact or the thread. Empty if they never have. */
  lastWrote: string;
  windowUntil: string;
  connected: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  onSent: (msg: CRMMessage) => void;
}) {
  const open = windowUntil !== "";
  const name = contact.name || "They";

  return (
    <div className="border-t border-line bg-surface">
      <ReplyBox
        contact={contact}
        lastWrote={lastWrote}
        open={open}
        name={name}
        connected={connected}
        templates={templates}
        templatesError={templatesError}
        onSent={onSent}
      />
    </div>
  );
}

function ReplyBox({
  contact,
  lastWrote,
  open,
  name,
  connected,
  templates,
  templatesError,
  onSent,
}: {
  contact: CRMContact;
  lastWrote: string;
  open: boolean;
  name: string;
  connected: boolean;
  templates: CRMTemplate[] | null;
  templatesError: string | null;
  onSent: (msg: CRMMessage) => void;
}) {
  const { notify } = useToast();
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const optedOut = Boolean(contact.whatsappOptOutAt) && !contact.whatsappOptIn;
  if (!contact.phone) {
    return (
      <p className="px-3 py-3 text-[12.5px] leading-relaxed text-ink-2">
        This contact left an email address and no WhatsApp number, so there is
        nothing to send to.
      </p>
    );
  }
  if (optedOut) {
    return (
      <p className="px-3 py-3 text-[12.5px] leading-relaxed text-ink-2">
        This contact has asked not to receive WhatsApp messages. Nothing can be
        sent to them — only they can opt in again.
      </p>
    );
  }
  if (!connected) {
    return (
      <p className="px-3 py-3 text-[12.5px] leading-relaxed text-ink-2">
        Connect your own WhatsApp Business account in{" "}
        <Link href="/settings#integrations" className="font-medium underline">
          account settings
        </Link>{" "}
        to reply from here.
      </p>
    );
  }

  const usable = (templates ?? []).filter((t) => t.sendable);
  const template = usable.find((t) => templateKey(t) === chosen);
  const filled = template
    ? Array.from({ length: template.variables }, (_, i) =>
        (params[i] ?? "").trim(),
      )
    : [];
  const needsOptIn =
    template?.category === "MARKETING" && !contact.whatsappOptIn;
  const canSend = open
    ? text.trim() !== ""
    : Boolean(template) && !needsOptIn && filled.every((v) => v !== "");

  async function send() {
    if (!canSend || busy) return;
    const request = open
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
      const msg = await engageApi.crmSend(contact.id, request);
      onSent(msg);
      setText("");
      setChosen("");
      setParams([]);
      notify("Sent.", "ok");
    } catch (e: unknown) {
      notify(
        e instanceof ApiError ? e.message : "Could not send that message.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  const closedOn = shortDay(lastWrote);
  const closed = closedOn
    ? `Reply window closed. ${name} last wrote on ${closedOn}, so only an approved template can be sent.`
    : "Reply window closed, so only an approved template can be sent.";

  return (
    <div>
      {!open && (
        <div className="px-3 pt-3">
          <Alert tone="warn">{closed}</Alert>
        </div>
      )}
      {open ? (
        <div className="flex items-end gap-2 px-3 py-2.5">
          <label className="sr-only" htmlFor="inbox-reply">
            Your reply
          </label>
          <textarea
            id="inbox-reply"
            value={text}
            maxLength={TEXT_MAX}
            rows={2}
            placeholder={`Reply to ${displayName(contact)}…`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            className="field min-h-9 flex-1 resize-none py-2 text-[13px]"
          />
          <SendButton busy={busy} disabled={!canSend} onClick={() => void send()} label="Send" />
        </div>
      ) : (
        <div className="px-3 pt-2.5 pb-3">
          {templates === null ? (
            <div className="flex items-center gap-2 py-2 text-[12px] text-ink-2">
              <Spinner className="size-4 text-ink-3" />
              Loading your templates…
            </div>
          ) : usable.length === 0 ? (
            <p className="text-[12.5px] leading-relaxed text-ink-2">
              {templatesError ??
                "You have no approved templates yet. Templates are written and approved in WhatsApp Manager before they can be sent."}
            </p>
          ) : (
            <div className="flex items-center gap-2">
              <select
                aria-label="Approved template"
                value={chosen}
                onChange={(e) => {
                  setChosen(e.target.value);
                  setParams([]);
                }}
                className="field h-9 min-w-0 flex-1 text-[13px]"
              >
                <option value="">Choose an approved template</option>
                {usable.map((t) => (
                  <option key={templateKey(t)} value={templateKey(t)}>
                    {templateLabel(t, usable)}
                  </option>
                ))}
              </select>
              <SendButton
                busy={busy}
                disabled={!canSend}
                onClick={() => void send()}
                label="Send"
              />
            </div>
          )}
          {template && template.variables > 0 && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {filled.map((_, i) => (
                <label key={i} className="grid gap-1 text-[11px] text-ink-3">
                  {`Value for {{${i + 1}}}`}
                  <input
                    className="field h-9 text-[13px]"
                    value={params[i] ?? ""}
                    onChange={(e) =>
                      setParams((prev) => {
                        const next = [...prev];
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {needsOptIn && (
            <p className="mt-2 text-[12px] leading-relaxed text-warn">
              This is a marketing template and this contact has not opted in.
              A utility template can still be sent.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SendButton({
  busy,
  disabled,
  onClick,
  label,
  title,
}: {
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
  label: string;
  title?: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      title={title ?? label}
      aria-label={title ?? label}
      disabled={busy || disabled}
      onClick={onClick}
    >
      {busy ? (
        <Spinner className="size-3.5" />
      ) : (
        <SendIcon className="size-3.5" />
      )}
      {label}
    </Button>
  );
}

/** The thread contact often omits lastInboundAt; the messages themselves have it. */
function lastWroteAt(contact: CRMContact, messages: CRMMessage[]): string {
  if (contact.lastInboundAt) return contact.lastInboundAt;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === "in") return messages[i].createdAt;
  }
  return "";
}

function displayName(c: CRMContact): string {
  return c.name || c.phone || c.email || "Unknown";
}

function templateLabel(t: CRMTemplate, all: CRMTemplate[]): string {
  const name = t.name.replace(/_/g, " ");
  const dup = all.filter((x) => x.name === t.name).length > 1;
  return dup ? `${name} · ${t.language}` : name;
}

function at(iso?: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clock(iso?: string): string {
  const d = at(iso);
  if (!d) return "";
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function dateLong(iso?: string): string {
  const d = at(iso);
  if (!d) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function dateTime(iso?: string): string {
  const date = dateLong(iso);
  const time = clock(iso);
  return date && time ? `${date}, ${time}` : "";
}

function shortDay(iso?: string): string {
  const d = at(iso);
  if (!d) return "";
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function bubbleStamp(iso: string): string {
  const day = shortDay(iso);
  const time = clock(iso);
  return day && time ? `${day} · ${time}` : time;
}

function listWhen(iso: string): string {
  const d = at(iso);
  if (!d) return "";
  const now = new Date();
  const start = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff <= 0) return clock(iso);
  if (diff === 1) return "Yesterday";
  if (diff < 7) return WEEKDAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
