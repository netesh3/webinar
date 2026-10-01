"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "@/components/providers";
import { Button } from "@/components/ui";
import { textRuns } from "@/lib/chat-text";
import { ApiError, fresh, put, request } from "@/lib/http";
import { Alert } from "../controls";
import { INBOX_LIST_MIN, useInboxListWidth } from "./inbox-split";

type EmailMessage = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  subject: string;
  body: string;
  at: string;
  threadId?: string;
};

type EmailInbox = {
  address: string;
  local: string;
  canRename: boolean;
  alias?: string;
  items: EmailMessage[];
  nextCursor: string | null;
  total: number;
};

type PageMark = { cursor: string; origin: number };

type InboxSelection = { key: string | null; pinned: boolean };

type Thread = {
  key: string;
  name: string;
  email: string;
  messages: EmailMessage[];
};

function party(message: EmailMessage): { name: string; email: string } {
  const raw = (message.direction === "out" ? message.to : message.from).trim();
  const named = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (named) {
    const email = named[2].trim();
    const name = named[1].replace(/^"|"$/g, "").trim();
    return { name: name || email, email };
  }
  return { name: raw || "Unknown", email: raw };
}

function threadsOf(messages: EmailMessage[]): Thread[] {
  const groups = new Map<string, Thread>();
  const order: string[] = [];
  for (const message of messages) {
    const key = message.threadId || message.id;
    let thread = groups.get(key);
    if (!thread) {
      const who = party(message);
      thread = { key, name: who.name, email: who.email, messages: [] };
      groups.set(key, thread);
      order.push(key);
    }
    const who = party(message);
    if (who.name && who.name !== who.email) thread.name = who.name;
    thread.messages.push(message);
  }
  return order.map((key) => {
    const thread = groups.get(key)!;
    thread.messages.sort((a, b) => a.at.localeCompare(b.at));
    return thread;
  });
}

function preview(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  if (!line) return "";
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

function listWhen(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return "Yesterday";
  const days = (now.getTime() - at.getTime()) / 86_400_000;
  if (days < 7) return at.toLocaleDateString([], { weekday: "short" });
  return at.toLocaleDateString([], { month: "short", day: "numeric" });
}

function letterWhen(iso: string): string {
  const at = new Date(iso);
  const date = at.toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${date}, ${time}`;
}

const MONOGRAM_COLORS = ["#2563EB", "#0F766E", "#7C3AED", "#1D4ED8"];

function monogramHue(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 33 + seed.charCodeAt(i)) >>> 0;
  return MONOGRAM_COLORS[hash % MONOGRAM_COLORS.length];
}

function initials(name: string): string {
  const parts = name.replace(/@.*/, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function Monogram({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-full text-[12px] font-semibold text-white"
      style={{ backgroundColor: monogramHue(name || "?") }}
    >
      {initials(name)}
    </span>
  );
}

function StatusMark({ direction }: { direction: EmailMessage["direction"] }) {
  return (
    <span className="text-[10px] font-semibold tracking-[0.08em] text-ink-3 uppercase">
      {direction === "out" ? "Sent" : "Received"}
    </span>
  );
}

function addressedTo(message: EmailMessage): string {
  const raw = message.to.trim();
  const named = raw.match(/<([^>]+)>/);
  return (named ? named[1] : raw).trim();
}

function MessageText({ body }: { body: string }) {
  const runs = textRuns(body);
  return (
    <p className="text-[14px] leading-relaxed whitespace-pre-wrap text-ink">
      {runs.map((run, index) =>
        "href" in run ? (
          <a
            key={index}
            href={run.href}
            target="_blank"
            rel="noreferrer"
            className="break-all text-[#2563EB] dark:text-brand"
          >
            {run.text}
          </a>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </p>
  );
}

function ReplyIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  );
}

function inboxPath(cursor?: string) {
  if (!cursor) return "/api/host/email-inbox";
  return `/api/host/email-inbox?${new URLSearchParams({ cursor })}`;
}

export function EmailInboxScreen({ onCount }: { onCount?: (count: number) => void }) {
  const { account } = useSession();
  const urlId = useSearchParams().get("id");
  const [data, setData] = useState<EmailInbox | null>(null);
  const [dataCursor, setDataCursor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [before, setBefore] = useState<PageMark[]>([]);
  const [origin, setOrigin] = useState(1);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<InboxSelection>({ key: null, pinned: false });
  const [draft, setDraft] = useState("");
  const [replying, setReplying] = useState(false);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const nav = useRef(false);
  const split = useInboxListWidth(sectionRef);

  useEffect(() => {
    let gone = false;
    const requested = cursor ?? "";
    nav.current = true;
    request<EmailInbox>(inboxPath(cursor), fresh)
      .then((next) => {
        if (gone) return;
        setData(next);
        setDataCursor(requested);
        setError(null);
        onCount?.(next.total);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "Could not load email.");
      })
      .finally(() => {
        if (gone) return;
        nav.current = false;
        setLoading(false);
      });
    return () => {
      gone = true;
    };
  }, [cursor, reload, onCount]);

  const threads = useMemo(() => threadsOf(data?.items ?? []), [data]);
  const pageToken = `${cursor ?? ""}\0${dataCursor ?? ""}\0${threads.map((thread) => thread.key).join("\0")}\0${urlId ?? ""}`;
  const [seenPage, setSeenPage] = useState(pageToken);
  if (pageToken !== seenPage) {
    setSeenPage(pageToken);
    if (data && dataCursor === (cursor ?? "")) {
      if (threads.length === 0) {
        if (selection.key !== null) {
          setSelection({ key: null, pinned: selection.pinned });
          setDraft("");
          setReplying(false);
        }
      } else {
        const fromUrl =
          !selection.pinned && urlId
            ? threads.find(
                (thread) =>
                  thread.key === urlId || thread.messages.some((message) => message.id === urlId),
              )
            : undefined;
        const still =
          selection.key != null && threads.some((thread) => thread.key === selection.key);
        const nextKey = fromUrl && fromUrl.key !== selection.key ? fromUrl.key : !still ? threads[0].key : null;
        if (nextKey && nextKey !== selection.key) {
          setSelection({ key: nextKey, pinned: fromUrl ? false : selection.pinned });
          setDraft("");
          setReplying(false);
        }
      }
    }
  }
  const selected = threads.find((thread) => thread.key === selection.key) ?? null;
  const latest = selected?.messages.at(-1) ?? null;
  const rangeStart = threads.length === 0 ? 0 : origin;
  const rangeEnd = threads.length === 0 ? 0 : origin + threads.length - 1;

  useEffect(() => {
    if (replying) replyRef.current?.focus();
  }, [replying, selection.key]);

  function selectThread(key: string) {
    setSelection({ key, pinned: true });
    if (!draft.trim()) setReplying(false);
  }

  function turnPage(nextCursor: string | undefined, stack: PageMark[], nextOrigin: number) {
    if (nav.current) return;
    nav.current = true;
    setSelection((current) => ({ key: current.key, pinned: true }));
    setDraft("");
    setReplying(false);
    setBefore(stack);
    setOrigin(nextOrigin);
    setCursor(nextCursor);
    setLoading(true);
  }

  function goNext() {
    if (!data?.nextCursor) return;
    turnPage(data.nextCursor, [...before, { cursor: cursor ?? "", origin }], origin + threads.length);
  }

  function goPrev() {
    const prev = before[before.length - 1];
    if (!prev) return;
    turnPage(prev.cursor || undefined, before.slice(0, -1), prev.origin);
  }

  async function send() {
    if (!selected || !latest || !draft.trim()) return;
    const keep = selected.key;
    setSending(true);
    setError(null);
    try {
      await request<EmailMessage>(`/api/host/email-inbox/${latest.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft("");
      setSelection({ key: keep, pinned: true });
      setBefore([]);
      setOrigin(1);
      setCursor(undefined);
      setLoading(true);
      setReload((n) => n + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that reply.");
    } finally {
      setSending(false);
    }
  }

  const replyName = account?.name?.trim() || "you";

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      <section
        ref={sectionRef}
        style={{ "--inbox-list": `${split.width}px` } as CSSProperties}
        className={`flex w-full flex-col rounded-xl border border-line bg-surface shadow-sm min-[900px]:min-h-0 min-[900px]:flex-1 min-[900px]:flex-row min-[900px]:overflow-hidden ${split.dragging ? "select-none" : ""}`}
        aria-label="Email inbox"
      >
        <div
          data-tour="email-inbox"
          aria-busy={loading}
          className="flex max-h-80 w-full min-w-0 flex-col border-b border-line min-[900px]:max-h-none min-[900px]:min-h-0 min-[900px]:w-[var(--inbox-list)] min-[900px]:shrink-0 min-[900px]:border-b-0"
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
          {data && threads.length === 0 && (
            <p className="px-4 py-8 text-center text-[13px] text-ink-3">No email yet.</p>
          )}
          {!data && !error && (
            <p className="px-4 py-8 text-center text-[13px] text-ink-3">Loading…</p>
          )}
          {threads.map((thread) => {
            const last = thread.messages.at(-1)!;
            const on = selected?.key === thread.key;
            return (
              <button
                key={thread.key}
                type="button"
                data-tour="email-message"
                onClick={() => selectThread(thread.key)}
                className={`grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 border-b border-line px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 focus-visible:ring-inset ${
                  on
                    ? "bg-[#EFF6FF] shadow-[inset_3px_0_0_#2563EB] dark:bg-brand-soft dark:shadow-[inset_3px_0_0_var(--color-brand)]"
                    : "hover:bg-surface-2"
                }`}
              >
                <Monogram name={thread.name} />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold text-ink">
                    {thread.name}
                    {thread.messages.length > 1 && (
                      <span className="font-medium text-ink-3"> ({thread.messages.length})</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] text-ink">
                    {last.subject || "(no subject)"}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink-3">{preview(last.body)}</span>
                </span>
                <span className="flex flex-col items-end gap-1.5 pt-0.5">
                  <time className="text-[12px] text-ink-3 tabular-nums" dateTime={last.at}>
                    {listWhen(last.at)}
                  </time>
                  <StatusMark direction={last.direction} />
                </span>
              </button>
            );
          })}
          </div>
          {data && (
            <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2.5">
              <Button size="sm" variant="secondary" onClick={goPrev} disabled={loading || before.length === 0}>
                Previous
              </Button>
              <div className="text-center text-[12px] text-ink-3">
                {rangeStart > 0 ? (
                  <>
                    {rangeStart}–{rangeEnd}
                    {data.total > 0 ? ` of ${data.total}` : ""}
                  </>
                ) : (
                  "0"
                )}
              </div>
              <Button size="sm" variant="secondary" onClick={goNext} disabled={loading || !data.nextCursor}>
                Next
              </Button>
            </div>
          )}
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize conversation list"
          aria-valuemin={INBOX_LIST_MIN}
          aria-valuemax={split.max}
          aria-valuenow={split.width}
          tabIndex={0}
          onPointerDown={split.onPointerDown}
          onKeyDown={split.onKeyDown}
          className="group relative hidden w-2 shrink-0 cursor-col-resize touch-none select-none min-[900px]:block focus-visible:outline-none"
        >
          <span
            aria-hidden
            className={`absolute inset-y-0 left-1/2 -translate-x-1/2 bg-line group-hover:w-0.5 group-hover:bg-[#2563EB] group-focus-visible:w-0.5 group-focus-visible:bg-[#2563EB] ${
              split.dragging ? "w-0.5 bg-[#2563EB]" : "w-px"
            }`}
          />
        </div>

        <article className="flex min-h-[16rem] min-w-0 flex-col min-[900px]:min-h-0 min-[900px]:flex-1">
          {data && threads.length === 0 && (
            <p className="grid flex-1 place-items-center px-4 text-[13px] text-ink-3">No email yet.</p>
          )}
          {selected && latest && (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="flex min-h-full flex-col px-5 py-4">
                <h2 className="text-[18px] font-semibold tracking-[-0.02em] text-ink">
                  {latest.subject || "(no subject)"}
                </h2>
                <div className="mt-4 flex items-start gap-3">
                  <Monogram name={selected.name} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <p className="min-w-0 text-[13px] leading-snug">
                        <b className="font-semibold text-ink">{selected.name}</b>
                        {selected.email && selected.email !== selected.name && (
                          <span className="ml-2 break-all text-ink-3">{selected.email}</span>
                        )}
                      </p>
                      <p className="flex shrink-0 items-center gap-2 text-[12px] text-ink-3">
                        <time dateTime={latest.at}>{letterWhen(latest.at)}</time>
                        <StatusMark direction={latest.direction} />
                      </p>
                    </div>
                    {addressedTo(latest) && (
                      <p className="mt-0.5 text-[12px] text-ink-3">To {addressedTo(latest)}</p>
                    )}
                    {selected.messages.length > 1 && (
                      <p className="mt-0.5 text-[12px] text-ink-3">
                        {selected.messages.length} messages in this thread
                      </p>
                    )}
                  </div>
                </div>
                <div className="mt-5">
                  {selected.messages.length === 1 ? (
                    <MessageText body={latest.body} />
                  ) : (
                    <div className="grid gap-4">
                      {selected.messages.map((message) => (
                        <div key={message.id} className="border-l-2 border-line-2 pl-3">
                          <div className="text-[12px] text-ink-2">
                            <b className="font-semibold text-ink">
                              {message.direction === "out" ? "Sent" : "Received"}
                            </b>
                            {" · "}
                            {letterWhen(message.at)}
                          </div>
                          <div className="mt-1.5">
                            <MessageText body={message.body} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="mt-6">
                  {replying ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void send();
                      }}
                    >
                      <div className="mb-2 text-[12px] text-ink-2">
                        Reply as <b className="font-semibold text-ink">{replyName}</b>
                        {data?.address ? ` <${data.address}>` : ""}
                      </div>
                      <textarea
                        ref={replyRef}
                        data-tour="email-reply"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        rows={3}
                        placeholder="Write a reply…"
                        aria-label="Your reply"
                        className="field text-[13.5px]"
                      />
                      <div className="mt-2 flex justify-end">
                        <Button type="submit" size="sm" disabled={sending || !draft.trim()}>
                          {sending ? "Sending…" : "Send reply"}
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setReplying(true)}
                      className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#2563EB] bg-surface px-3.5 text-[13.5px] font-medium text-[#2563EB] outline-none hover:bg-[#EFF6FF] focus-visible:ring-2 focus-visible:ring-[#2563EB]/40 dark:border-brand dark:text-brand dark:hover:bg-brand-soft"
                    >
                      <ReplyIcon />
                      Reply
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </article>
      </section>
    </div>
  );
}

export function EmailIntegration({
  address,
  note,
}: {
  address: string;
  note: string;
}) {
  const [local, setLocal] = useState("");
  const [canRename, setCanRename] = useState(true);
  const [alias, setAlias] = useState("");
  const [current, setCurrent] = useState(address);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let gone = false;
    request<EmailInbox>("/api/host/email-inbox", fresh)
      .then((inbox) => {
        if (gone) return;
        setCurrent(inbox.address);
        setLocal(inbox.local);
        setCanRename(inbox.canRename);
        setAlias(inbox.alias ?? "");
      })
      .catch(() => {
        if (!gone) setLocal(address.split("@")[0] ?? "");
      });
    return () => {
      gone = true;
    };
  }, [address]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await put<EmailInbox>("/api/host/email-inbox/address", { local });
      setCurrent(next.address);
      setLocal(next.local);
      setCanRename(next.canRename);
      setAlias(next.alias ?? "");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that address.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      data-tour="email-address"
      className="flex h-full flex-col rounded-xl border border-line bg-surface p-4"
    >
      <div className="text-[11px] font-semibold tracking-[0.04em] text-ink-3 uppercase">Email</div>
      <h3 className="mt-1 text-[15px] font-semibold">Your reply inbox</h3>
      <p className="mt-1 text-[13px] text-ink">{current || address}</p>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Replies to your webinars arrive at this address. Outbound mail stays on the shared Gmail
        account, with this address as Reply-To.
      </p>
      {alias && (
        <p className="mt-1 text-[12.5px] text-ink-3">
          Mail to {alias}@webinarliv.com still reaches you.
        </p>
      )}
      <label className="mt-3 block text-[12px] font-medium text-ink-2" htmlFor="inbox-local">
        Address
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id="inbox-local"
          value={local}
          disabled={!canRename || saving}
          onChange={(e) => setLocal(e.target.value.toLowerCase())}
          className="w-40 rounded-lg border border-line bg-surface px-2 py-1.5 text-[13px] disabled:bg-surface-2"
        />
        <span className="text-[13px] text-ink-3">@webinarliv.com</span>
        {canRename && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-lg bg-brand px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            Save
          </button>
        )}
      </div>
      <p className="mt-2 text-[12px] text-ink-3">
        {canRename ? note || "You can change this once." : "Contact support to change this address."}
      </p>
      {error && (
        <div className="mt-2">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
    </article>
  );
}
