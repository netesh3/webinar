"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { SalesConversation, SalesMessage, SalesStatus } from "@/lib/api-types";
import { ApiError } from "@/lib/http";
import { Spinner, Tabs } from "./controls";
import { Badge, Button, Empty } from "./ui";

/* Admin → Sales chats: the people the home page's assistant handed over.
 *
 * Having this open is what makes the team "online" to visitors (the inbox poll
 * marks the admin present), so the widget tells a waiting visitor someone will be
 * with them shortly rather than that they'll get an email.
 *
 * Joining posts "<name> joined the chat" and silences the assistant. A reply goes
 * to the chat while the visitor is there and to their email once they have left;
 * the admin can force either.
 */

const FILTERS = ["needs", "ai", "closed"] as const;
type Filter = (typeof FILTERS)[number];

const INBOX_POLL_MS = 5000;
const THREAD_POLL_MS = 3000;

function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function who(c: SalesConversation): string {
  return c.name || c.email || c.accountEmail || "Visitor";
}

function StatusBadge({ c }: { c: SalesConversation }) {
  const map: Record<SalesStatus, [string, "warn" | "brand" | "ok" | "neutral"]> = {
    waiting: [c.visitorOnline ? "Waiting · online now" : c.email || c.accountEmail ? "Waiting · left, reply by email" : "Waiting · left", "warn"],
    human: [c.assignedTo ? `With ${c.assignedTo.split(" ")[0]}` : "With the team", "ok"],
    ai: ["AI handling", "brand"],
    closed: ["Closed", "neutral"],
  };
  const [label, tone] = map[c.status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function AdminSales({
  initialId,
  onCount,
}: {
  initialId?: string | null;
  onCount?: (n: number) => void;
}) {
  const [filter, setFilter] = useState<Filter>("needs");
  const [list, setList] = useState<SalesConversation[] | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Filter, number>>>({});
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.adminSalesInbox(filter).then(
        (inbox) => {
          setList(inbox.conversations);
          setCounts((c) => ({ ...c, needs: inbox.needsYou }));
          onCount?.(inbox.needsYou);
          setError(null);
        },
        (err) => setError(err instanceof ApiError ? err.message : "Couldn't load the sales inbox."),
      ),
    [filter, onCount],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const id = window.setInterval(() => void load(), INBOX_POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [load]);

  return (
    <div className="grid gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
      <div className="min-w-0">
        <Tabs
          tabs={FILTERS}
          value={filter}
          onChange={(f) => {
            setList(null);
            setFilter(f);
          }}
          counts={{ needs: counts.needs }}
          labels={{ needs: "Needs you", ai: "AI handling", closed: "Closed" }}
        />
        {error && <p className="mt-3 text-[13px] text-live">{error}</p>}
        <div className="mt-3 grid gap-2">
          {list === null ? (
            [0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-surface-2" />)
          ) : list.length === 0 ? (
            <Empty
              title={filter === "needs" ? "Nobody is waiting" : filter === "ai" ? "No chats with the assistant right now" : "No closed chats"}
              hint={filter === "needs" ? "When the assistant hands a visitor over, they appear here and every admin gets an email." : undefined}
            />
          ) : (
            list.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelected(c.id)}
                className={`grid gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selected === c.id ? "border-brand bg-brand-soft" : "border-line bg-surface hover:bg-surface-2"
                }`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <b className="truncate text-[13.5px]">{who(c)}</b>
                  <small className="shrink-0 text-[12px] text-ink-3">{ago(c.lastMessageAt)}</small>
                </span>
                <span className="truncate text-[12.5px] text-ink-2">{c.lastMessage || "—"}</span>
                <span>
                  <StatusBadge c={c} />
                </span>
              </button>
            ))
          )}
        </div>
      </div>
      <div className="min-w-0">
        {selected ? (
          <Thread key={selected} id={selected} onChanged={() => void load()} />
        ) : (
          <Empty title="Pick a conversation" hint="Join a waiting chat to talk to the visitor live, or reply by email if they've left." />
        )}
      </div>
    </div>
  );
}

function Thread({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [conv, setConv] = useState<SalesConversation | null>(null);
  const [messages, setMessages] = useState<SalesMessage[]>([]);
  const [text, setText] = useState("");
  const [via, setVia] = useState<"" | "chat" | "email">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const last = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const take = useCallback((d: { conversation: SalesConversation; messages: SalesMessage[] }) => {
    setConv(d.conversation);
    if (d.messages.length) {
      last.current = d.messages[d.messages.length - 1].id;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...prev, ...d.messages.filter((m) => !seen.has(m.id))];
      });
    }
  }, []);

  useEffect(() => {
    let live = true;
    const tick = () =>
      api
        .adminSalesConversation(id, last.current)
        .then((d) => live && take(d))
        .catch((err) => live && setError(err instanceof ApiError ? err.message : "Couldn't load this chat."));
    void tick();
    const t = window.setInterval(tick, THREAD_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [id, take]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  if (!conv) {
    return (
      <div className="grid place-items-center rounded-xl border border-line bg-surface py-20">
        {error ? <p className="text-[13px] text-live">{error}</p> : <Spinner />}
      </div>
    );
  }

  const replyTo = conv.email || conv.accountEmail;
  const mode: "chat" | "email" = via || (conv.visitorOnline || !replyTo ? "chat" : "email");

  async function act(fn: () => Promise<{ conversation: SalesConversation; messages: SalesMessage[] }>) {
    setBusy(true);
    setError(null);
    try {
      take(await fn());
      onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? (err.fields ? Object.values(err.fields)[0] : err.message) : "That didn't go through.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    if (await act(() => api.adminSalesReply(id, body, via, last.current))) setText("");
  }

  const joined = conv.status === "human";

  return (
    <div className="flex h-[min(72vh,720px)] flex-col overflow-hidden rounded-xl border border-line bg-surface">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">
            {who(conv)}
            {replyTo && conv.name ? <span className="font-normal text-ink-3"> · {replyTo}</span> : null}
          </p>
          <p className="text-[12.5px] text-ink-3">
            {conv.visitorOnline ? "Online now" : "Left the chat"}
            {conv.page ? ` · opened on ${conv.page}` : ""}
            {conv.handoffAt ? ` · asked for a person ${ago(conv.handoffAt)} ago` : ""}
          </p>
        </div>
        {conv.status !== "closed" && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act(() => api.adminSalesClose(id, last.current))}>
            Close
          </Button>
        )}
        {!joined && (
          <Button size="sm" disabled={busy} onClick={() => void act(() => api.adminSalesJoin(id, last.current))}>
            Join conversation
          </Button>
        )}
      </header>
      {conv.handoffReason && (
        <p className="mx-4 mt-3 rounded-lg border border-warn/25 bg-warn-soft px-3 py-2 text-[13px] text-warn">
          <b>Why you were called:</b> {conv.handoffReason}
        </p>
      )}
      <div ref={scroller} className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {messages.map((m) =>
          m.role === "system" ? (
            <p key={m.id} className="self-center rounded-full border border-line px-3 py-1 text-[12px] text-ink-3">
              {m.body}
            </p>
          ) : (
            <div key={m.id} className={`flex max-w-[78%] flex-col gap-0.5 ${m.role === "visitor" ? "self-start" : "self-end items-end"}`}>
              <span className="text-[11.5px] text-ink-3">
                {m.role === "visitor" ? who(conv) : m.role === "ai" ? "AI Agent" : m.authorName || "Team"} · {clock(m.createdAt)}
                {m.emailed ? " · sent by email" : ""}
              </span>
              <p
                className={`whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13.5px] leading-relaxed ${
                  m.role === "visitor"
                    ? "border border-line bg-surface-2"
                    : m.role === "ai"
                      ? "border border-brand-line bg-brand-soft"
                      : "bg-brand text-white"
                }`}
              >
                {m.body}
              </p>
            </div>
          ),
        )}
      </div>
      <footer className="border-t border-line px-4 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px]">
          <button
            type="button"
            onClick={() => setVia("chat")}
            className={`rounded-full border px-3 py-1 font-medium ${mode === "chat" ? "border-ink bg-ink text-white" : "border-line text-ink-2"}`}
          >
            Reply in chat{conv.visitorOnline ? " (online)" : ""}
          </button>
          <button
            type="button"
            disabled={!replyTo}
            onClick={() => setVia("email")}
            className={`rounded-full border px-3 py-1 font-medium disabled:opacity-40 ${mode === "email" ? "border-ink bg-ink text-white" : "border-line text-ink-2"}`}
          >
            {replyTo ? `Send as email to ${replyTo}` : "No email left yet"}
          </button>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={3}
            maxLength={4000}
            placeholder={joined ? "Type a reply…" : "Type a reply — sending one joins the conversation"}
            aria-label="Reply"
            className="field min-h-[72px] flex-1 resize-y"
          />
          <Button disabled={busy || !text.trim()} onClick={() => void send()}>
            Send
          </Button>
        </div>
        {error && <p className="mt-2 text-[12.5px] text-live">{error}</p>}
      </footer>
    </div>
  );
}
