"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError, fresh, put, request } from "@/lib/http";
import { Alert } from "../controls";

type EmailMessage = {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  subject: string;
  body: string;
  at: string;
};

type EmailInbox = {
  address: string;
  local: string;
  canRename: boolean;
  alias?: string;
  messages: EmailMessage[];
};

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
  for (const message of messages) {
    const who = party(message);
    const key = who.email.toLowerCase() || message.id;
    const thread = groups.get(key) ?? {
      key,
      name: who.name,
      email: who.email,
      messages: [],
    };
    if (who.name && who.name !== who.email) thread.name = who.name;
    thread.messages.push(message);
    groups.set(key, thread);
  }
  const threads = [...groups.values()];
  for (const thread of threads) {
    thread.messages.sort((a, b) => a.at.localeCompare(b.at));
  }
  threads.sort((a, b) => {
    const last = (thread: Thread) => thread.messages.at(-1)?.at ?? "";
    return last(b).localeCompare(last(a));
  });
  return threads;
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
  return new Date(iso).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function EmailInboxScreen({ onCount }: { onCount?: (count: number) => void }) {
  const { account } = useSession();
  const [data, setData] = useState<EmailInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const next = await request<EmailInbox>("/api/host/email-inbox", fresh);
    setData(next);
    setError(null);
    onCount?.(next.messages.length);
    return next;
  }, [onCount]);

  useEffect(() => {
    let gone = false;
    request<EmailInbox>("/api/host/email-inbox", fresh)
      .then((next) => {
        if (gone) return;
        setData(next);
        setError(null);
        onCount?.(next.messages.length);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "Could not load email.");
      });
    return () => {
      gone = true;
    };
  }, [onCount]);

  const threads = useMemo(() => threadsOf(data?.messages ?? []), [data]);
  const selected = threads.find((thread) => thread.key === openKey) ?? threads[0] ?? null;
  const latest = selected?.messages.at(-1) ?? null;

  async function send() {
    if (!latest || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      await request<EmailMessage>(`/api/host/email-inbox/${latest.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft("");
      setOpenKey(selected?.key ?? null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that reply.");
    } finally {
      setSending(false);
    }
  }

  const replyName = account?.name?.trim() || "you";

  return (
    <div className="grid gap-3">
      {error && <Alert tone="error">{error}</Alert>}
      <section
        className="grid min-h-[420px] overflow-hidden rounded-xl border border-line bg-surface shadow-sm md:h-[560px] md:grid-cols-[300px_minmax(0,1fr)]"
        aria-label="Email inbox"
      >
        <div className="flex min-w-0 flex-col overflow-y-auto border-b border-line md:border-r md:border-b-0">
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
                onClick={() => setOpenKey(thread.key)}
                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-b border-line px-3 py-2.5 text-left ${
                  on ? "bg-brand-soft" : "hover:bg-surface-2"
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {thread.name}
                    {thread.messages.length > 1 && (
                      <span className="font-medium text-ink-3"> ({thread.messages.length})</span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-[13px] font-semibold text-ink">
                    {last.subject || "(no subject)"}
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink-3">{preview(last.body)}</span>
                </span>
                <span className="flex flex-col items-end gap-1.5">
                  <time className="text-[11px] text-ink-3 tabular-nums" dateTime={last.at}>
                    {listWhen(last.at)}
                  </time>
                  <span className="text-[10px] font-semibold tracking-wide text-ink-3 uppercase">
                    {last.direction === "out" ? "Sent" : "Received"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <article className="flex min-h-[320px] min-w-0 flex-col">
          {!selected && (
            <p className="grid flex-1 place-items-center px-4 text-[13px] text-ink-3">
              {data ? "No email yet." : ""}
            </p>
          )}
          {selected && latest && (
            <>
              <div className="border-b border-line px-4 pt-3.5 pb-3">
                <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">
                  {latest.subject || "(no subject)"}
                </h2>
                <p className="mt-2 text-[12px] leading-normal text-ink-2">
                  {latest.direction === "out" ? "To " : ""}
                  <b className="font-semibold text-ink">{selected.name}</b>
                  {selected.email ? ` <${selected.email}>` : ""}
                  {latest.direction === "in" && data?.address ? ` · to ${data.address}` : ""}
                  <br />
                  {letterWhen(latest.at)}
                  {" · "}
                  {latest.direction === "out" ? "Sent" : "Received"}
                  {selected.messages.length > 1
                    ? ` · ${selected.messages.length} messages in this thread`
                    : ""}
                </p>
              </div>
              <div className="flex-1 overflow-auto px-4 py-3.5 text-[13.5px] leading-relaxed text-ink">
                {selected.messages.length === 1 ? (
                  <p className="whitespace-pre-wrap">{latest.body}</p>
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
                        <p className="mt-1.5 whitespace-pre-wrap">{message.body}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <form
                className="mt-auto border-t border-line p-3"
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
            </>
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
    <article className="rounded-xl border border-line bg-surface p-4">
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
