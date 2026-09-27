"use client";

import { useEffect, useRef, useState } from "react";
import { engageApi } from "../api";
import { Alert, Modal, Spinner } from "@/components/controls";
import { useToast } from "@/components/providers";
import { Button } from "@/components/ui";
import { ApiError } from "@/lib/api";
import type { CRMSnippet } from "@/lib/api-types";

/* Inbox speed: saved quick replies, snoozing a conversation, and the keyboard.
 * See docs/engage/V2.md, "Phase 3". */

/** The host's quick replies, loaded once, with a way to reload after an edit. */
export function useSnippets() {
  const [snippets, setSnippets] = useState<CRMSnippet[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmSnippets()
      .then((r) => !cancelled && setSnippets(r.snippets))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { snippets, reload: () => setTick((t) => t + 1) };
}

export function SnippetsDialog({
  snippets,
  onClose,
  onChanged,
}: {
  snippets: CRMSnippet[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { notify } = useToast();
  const [editing, setEditing] = useState<CRMSnippet | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start(s: CRMSnippet | null) {
    setEditing(s);
    setTitle(s?.title ?? "");
    setBody(s?.body ?? "");
    setError(null);
  }

  async function save() {
    setBusy(true);
    try {
      if (editing?.id)
        await engageApi.updateCrmSnippet(editing.id, { title, body });
      else await engageApi.createCrmSnippet({ title, body });
      notify("Quick reply saved.", "ok");
      start(null);
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not save that.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(s: CRMSnippet) {
    try {
      await engageApi.deleteCrmSnippet(s.id);
      if (editing?.id === s.id) start(null);
      onChanged();
    } catch (e) {
      notify(
        e instanceof ApiError ? e.message : "Could not delete that.",
        "error",
      );
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Quick replies"
      description="Your own words, one tap away above the reply box. Only sent while the 24-hour window is open."
      footer={
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="grid gap-4">
        {snippets.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {snippets.map((s) => (
              <li key={s.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium text-ink">
                    {s.title}
                  </div>
                  <div className="line-clamp-2 text-[12px] text-ink-2">
                    {s.body}
                  </div>
                </div>
                <button
                  type="button"
                  className="text-[12px] font-medium text-brand hover:underline"
                  onClick={() => start(s)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-[12px] text-ink-3 hover:text-live"
                  onClick={() => void remove(s)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 rounded-lg border border-line bg-surface-2 p-3">
          <span className="text-[12.5px] font-semibold text-ink">
            {editing?.id ? "Edit quick reply" : "New quick reply"}
          </span>
          {error && <Alert tone="error">{error}</Alert>}
          <input
            className="field"
            placeholder="Name on the chip, e.g. Replay link"
            maxLength={40}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Quick reply name"
          />
          <textarea
            className="field min-h-20 py-2"
            placeholder="Here's the replay: …"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            aria-label="Quick reply message"
          />
          <div className="flex justify-end gap-2">
            {editing?.id && (
              <Button variant="ghost" size="sm" onClick={() => start(null)}>
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              onClick={save}
              disabled={busy || !title.trim() || !body.trim()}
            >
              {busy && <Spinner className="size-3.5" />}
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** The choices a snooze offers, resolved against now. */
function snoozeChoices(now: Date): { label: string; at: Date }[] {
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const monday = at((8 - now.getDay()) % 7 || 7, 9);
  return [
    { label: "In 3 hours", at: new Date(now.getTime() + 3 * 3_600_000) },
    { label: "This evening, 6 PM", at: at(0, 18) },
    { label: "Tomorrow, 9 AM", at: at(1, 9) },
    { label: "Monday, 9 AM", at: monday },
  ].filter((c) => c.at.getTime() > now.getTime() + 10 * 60_000);
}

/** "Snooze" in the chat header: a small menu of times, or "Wake now" while snoozed. */
export function SnoozeButton({
  snoozedUntil,
  onSnooze,
}: {
  snoozedUntil?: string;
  onSnooze: (untilISO: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<{ label: string; at: Date }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (snoozedUntil) {
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onSnooze("")}
        title={`Snoozed until ${new Date(snoozedUntil).toLocaleString()}`}
      >
        Wake now
      </Button>
    );
  }
  return (
    <div ref={ref} className="relative">
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setChoices(snoozeChoices(new Date()));
          setOpen((v) => !v);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Snooze (S)"
      >
        Snooze
      </Button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg border border-line bg-surface py-1 shadow-lg"
        >
          {choices.map((c) => (
            <button
              key={c.label}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-[12.5px] text-ink hover:bg-surface-2"
              onClick={() => {
                setOpen(false);
                onSnooze(c.at.toISOString());
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* The inbox keyboard: J/K next and previous, E done, S snooze (tomorrow 9 AM), R reply,
 * ? help. Ignored while typing, and with a modifier held, so ⌘K and friends still work. */
export function useInboxKeys(handlers: {
  next: () => void;
  prev: () => void;
  done: () => void;
  snooze: () => void;
  reply: () => void;
  help: () => void;
}) {
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
      )
        return;
      if (document.querySelector("[role=dialog]")) return;
      const h = ref.current;
      const map: Record<string, () => void> = {
        j: h.next,
        k: h.prev,
        e: h.done,
        s: h.snooze,
        r: h.reply,
        "?": h.help,
      };
      const fn =
        map[e.key.toLowerCase()] ?? (e.key === "?" ? h.help : undefined);
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function KeysHelp({ onClose }: { onClose: () => void }) {
  const rows = [
    ["J / K", "Next / previous conversation"],
    ["R", "Reply"],
    ["⌘ ↵", "Send"],
    ["E", "Mark done (or reopen)"],
    ["S", "Snooze until tomorrow 9 AM"],
    ["?", "This list"],
  ];
  return (
    <Modal open onClose={onClose} size="sm" title="Keyboard shortcuts">
      <dl className="grid grid-cols-[5rem_1fr] gap-y-2 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <kbd className="rounded border border-line-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[11.5px]">
                {k}
              </kbd>
            </dt>
            <dd className="text-ink-2">{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

/** Tomorrow at 9 AM local, the S key's snooze. */
export function tomorrowNineISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}
