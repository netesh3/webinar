"use client";

import { useEffect, useRef, useState } from "react";
import type { CallState, Contact } from "@/lib/api-types";
import { ApiError } from "@/lib/http";
import { callsApi } from "@/lib/calls-api";
import { CALL_WINDOW_EVENT, callerStatusLabel, contactQueryKind, secondsLeft, type CallEvent } from "@/lib/calls";
import { AccountAvatar } from "../account-avatar";
import { MaterialIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* "Call someone", from a meeting's Participants panel (31 Oct 2026, docs/calling.md).
 *
 * For the host and co-hosts of a meeting. Search the people you have shared a session with by
 * name, or anybody with an account by their whole email address (GET /api/contacts), and ring
 * them into this meeting (POST /api/calls). Each call placed here shows how it is going —
 * ringing with its countdown, then joining, declined or no answer — from the account's event
 * stream (call_ended, re-dispatched on window by components/incoming-call.tsx), with a read of
 * the call when its ring runs out in case that event was missed. */

type Placed = { callId: string; contact: Contact; state: CallState | "placing"; expiresAt: string };

export function CallSomeoneButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="mb-2 flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-line-2 px-3 text-[13px] font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-0 md:h-8"
      >
        <MaterialIcon name="call" className="size-4" />
        Call someone
      </button>
      {open && <CallSomeonePanel onClose={() => setOpen(false)} />}
    </>
  );
}

function CallSomeonePanel({ onClose }: { onClose: () => void }) {
  const { slug } = useRoomUI();
  const { notify } = useToast();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Contact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const panel = useRef<HTMLDivElement | null>(null);

  // Search as the host types, a quarter of a second after they stop.
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      callsApi
        .contacts(q.trim())
        .then((r) => {
          if (!live) return;
          setResults(r.contacts);
          setError(null);
        })
        .catch((err: unknown) => {
          if (live) setError(err instanceof ApiError ? err.message : "Could not search.");
        });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);

  // How each call ended, from the account's stream.
  useEffect(() => {
    const onCall = (e: Event) => {
      const ev = (e as CustomEvent<CallEvent>).detail;
      if (ev?.type !== "call_ended") return;
      setPlaced((list) => list.map((p) => (p.callId === ev.callId ? { ...p, state: ev.state } : p)));
    };
    window.addEventListener(CALL_WINDOW_EVENT, onCall);
    return () => window.removeEventListener(CALL_WINDOW_EVENT, onCall);
  }, []);

  // The countdown, and a read of any call whose ring ran out without an answer arriving.
  const anyRinging = placed.some((p) => p.state === "ringing");
  useEffect(() => {
    if (!anyRinging) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyRinging]);
  const checked = useRef(new Set<string>());
  useEffect(() => {
    for (const p of placed) {
      if (p.state !== "ringing" || secondsLeft(p.expiresAt, now) > 0 || checked.current.has(p.callId)) continue;
      checked.current.add(p.callId);
      void callsApi
        .get(p.callId)
        .then((c) => setPlaced((list) => list.map((x) => (x.callId === c.callId ? { ...x, state: c.state } : x))))
        .catch(() => {});
    }
  }, [now, placed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function call(contact: Contact) {
    const optimistic: Placed = { callId: `placing-${contact.userId}`, contact, state: "placing", expiresAt: "" };
    setPlaced((list) => [optimistic, ...list.filter((p) => p.contact.userId !== contact.userId)]);
    try {
      const res = await callsApi.start({ calleeUserId: contact.userId, meetingSlug: slug });
      setPlaced((list) =>
        list.map((p) =>
          p.callId === optimistic.callId ? { ...p, callId: res.callId, state: "ringing", expiresAt: res.expiresAt } : p,
        ),
      );
    } catch (err) {
      setPlaced((list) => list.filter((p) => p.callId !== optimistic.callId));
      notify(err instanceof ApiError ? err.message : "Could not place the call.", "error");
    }
  }

  async function hangUp(p: Placed) {
    try {
      const c = await callsApi.cancel(p.callId);
      setPlaced((list) => list.map((x) => (x.callId === p.callId ? { ...x, state: c.state } : x)));
    } catch {
      // Answered or over a moment ago: the stream brings the real state.
    }
  }

  const kind = contactQueryKind(q);
  const placedIds = new Set(placed.map((p) => p.contact.userId));

  return (
    <div
      ref={panel}
      role="dialog"
      aria-label="Call someone into this meeting"
      className="room-dark absolute right-2 bottom-full left-2 z-50 mb-2 max-h-[60vh] overflow-y-auto rounded-xl border border-line bg-surface p-2 shadow-2xl"
    >
      <div className="flex items-center gap-2">
        <input
          autoFocus
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Name, or their email address"
          aria-label="Search people to call"
          className="h-9 min-w-0 flex-1 rounded-lg border border-line-2 bg-surface-2 px-3 text-[13px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        />
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="grid size-9 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
        >
          <MaterialIcon name="close" className="size-4" />
        </button>
      </div>

      {placed.length > 0 && (
        <ul className="mt-2 grid gap-1 border-b border-line pb-2">
          {placed.map((p) => (
            <li key={p.callId} className="flex items-center gap-2 px-1 py-1">
              <AccountAvatar initials={p.contact.initials} hue={p.contact.hue} photo={p.contact.avatarUrl} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-ink">{p.contact.name}</span>
                <span
                  className={`block text-[11.5px] ${p.state === "declined" || p.state === "missed" ? "text-live" : "text-ink-3"}`}
                >
                  {callerStatusLabel(p.state, secondsLeft(p.expiresAt, now))}
                </span>
              </span>
              {p.state === "ringing" && (
                <button
                  type="button"
                  onClick={() => void hangUp(p)}
                  className="h-7 rounded-md px-2 text-[12px] font-medium text-live hover:bg-live-soft"
                >
                  Cancel
                </button>
              )}
              {(p.state === "declined" || p.state === "missed" || p.state === "cancelled") && (
                <button
                  type="button"
                  onClick={() => void call(p.contact)}
                  className="h-7 rounded-md px-2 text-[12px] font-medium text-brand hover:bg-surface-2"
                >
                  Call again
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-2 grid gap-1">
        {error ? (
          <li className="px-2 py-3 text-[12.5px] text-live">{error}</li>
        ) : results === null ? (
          <li className="px-2 py-3 text-[12.5px] text-ink-3">Searching…</li>
        ) : results.length === 0 ? (
          <li className="px-2 py-3 text-[12.5px] text-ink-3">
            {kind === "email"
              ? "Nobody has an account with that address."
              : kind === "name"
                ? "Nobody you've met here by that name. Try their full email address."
                : "People you've met in your sessions show here. Or type someone's full email address."}
          </li>
        ) : (
          results
            .filter((c) => !placedIds.has(c.userId))
            .map((c) => (
              <li key={c.userId} className="flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface-2">
                <AccountAvatar initials={c.initials} hue={c.hue} photo={c.avatarUrl} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{c.name}</span>
                  {c.email && <span className="block truncate text-[11.5px] text-ink-3">{c.email}</span>}
                </span>
                <button
                  type="button"
                  onClick={() => void call(c)}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-brand px-2.5 text-[12px] font-medium text-on-brand hover:bg-brand-hover"
                >
                  <MaterialIcon name="call" className="size-3.5" />
                  Call
                </button>
              </li>
            ))
        )}
      </ul>
    </div>
  );
}
