"use client";

import { useCallback, useEffect, useState } from "react";
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

export function EmailInboxScreen() {
  const [data, setData] = useState<EmailInbox | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    const next = await request<EmailInbox>("/api/host/email-inbox", fresh);
    setData(next);
    setError(null);
    setOpen((cur) => cur ?? next.messages.at(-1)?.id ?? null);
    return next;
  }, []);

  useEffect(() => {
    let gone = false;
    request<EmailInbox>("/api/host/email-inbox", fresh)
      .then((next) => {
        if (gone) return;
        setData(next);
        setError(null);
        setOpen((cur) => cur ?? next.messages.at(-1)?.id ?? null);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "Could not load email.");
      });
    return () => {
      gone = true;
    };
  }, []);

  const selected = data?.messages.find((m) => m.id === open) ?? null;

  async function send() {
    if (!selected || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      await request<EmailMessage>(`/api/host/email-inbox/${selected.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ body: draft.trim() }),
      });
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send that reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-[-0.02em]">Email</h1>
        <p className="mt-1 text-[13px] text-ink-3">
          {data
            ? `Replies to ${data.address}, and mail sent for you, both show here. Sending still uses the shared From address, with this address as Reply-To.`
            : "Loading your inbox…"}
        </p>
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="grid min-h-[420px] overflow-hidden rounded-xl border border-line md:grid-cols-[280px_1fr]">
        <ul className="divide-y divide-line border-b border-line md:border-r md:border-b-0">
          {(data?.messages.length ?? 0) === 0 && (
            <li className="p-4 text-[13px] text-ink-3">No email yet.</li>
          )}
          {data?.messages.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => setOpen(m.id)}
                className={`block w-full px-3 py-3 text-left ${open === m.id ? "bg-brand-soft" : "hover:bg-surface-2"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-ink-2 uppercase">
                    {m.direction === "out" ? "Sent" : "Received"}
                  </span>
                  <span className="truncate text-[13px] font-medium">{m.subject || "(no subject)"}</span>
                </div>
                <div className="truncate text-[12px] text-ink-3">
                  {m.direction === "out" ? `To ${m.to}` : `From ${m.from}`}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex min-h-[320px] flex-col">
          {!selected && <p className="p-4 text-[13px] text-ink-3">Select a message.</p>}
          {selected && (
            <>
              <div className="border-b border-line px-4 py-3">
                <div className="text-[15px] font-medium">{selected.subject || "(no subject)"}</div>
                <div className="mt-1 text-[12px] text-ink-3">
                  {selected.direction === "out" ? "Sent" : "Received"}
                  {" · "}
                  {selected.direction === "out" ? `To ${selected.to}` : `From ${selected.from}`}
                  {" · "}
                  {new Date(selected.at).toLocaleString()}
                </div>
              </div>
              <pre className="flex-1 overflow-auto px-4 py-3 font-sans text-[13px] whitespace-pre-wrap text-ink">
                {selected.body}
              </pre>
              <form
                className="border-t border-line p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  rows={3}
                  placeholder="Reply…"
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-[13px]"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  className="mt-2 rounded-lg bg-brand px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
                >
                  {sending ? "Sending…" : "Send reply"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
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
