"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { SpamFlag, SpamFlagsResponse, SpamSettingsPatch } from "@/lib/api-types";
import { useCoalescingReader } from "@/lib/polls";
import {
  actionsFor,
  alertText,
  categoryLabel,
  confidenceLabel,
  flagKey,
  flagsFor,
  isWaiting,
  newFlags,
  statusLabel,
  whyLabel,
  type SpamAction,
  type SpamKind,
} from "@/lib/spam";
import { MaterialIcon } from "../icons";
import { useToast } from "../providers";
import { useRoomUI } from "./context";

/* Spam detection's pieces of the host team's chat and Q&A panels: the in-room alert when
 * something is flagged, the "Flagged" filter, and the one-click actions. Host and co-hosts
 * only; the audience never sees a flag. The server does the flagging — free rules on every
 * attendee message and a batched AI pass (api/internal/api/spam.go); nothing is deleted
 * unless a host does it, or turns on Auto-hide. */

// How often the room re-reads the flags. The read is also what lets a due AI pass run (the
// server's batching window is 30 s, so a pass is never more than one poll late).
const SPAM_POLL_MS = 15_000;

export type SpamApi = {
  data: SpamFlagsResponse | null;
  act: (flag: SpamFlag, action: SpamAction) => Promise<void>;
  setSettings: (patch: SpamSettingsPatch) => Promise<void>;
};

/** The flags, read on mount, on the room's spam-flags nudge, and every 15 s, with a toast for
 *  each newly flagged message. Null while `on` is false (everyone but the host team). */
export function useSpamFlags(slug: string, revision: number, on: boolean): SpamApi | null {
  const { notify } = useToast();
  const [data, setData] = useState<SpamFlagsResponse | null>(null);
  // What has been alerted already. The first read only fills it: flags from before this tab
  // opened are in the Flagged filter, not a burst of toasts.
  const seen = useRef<Set<string> | null>(null);

  const read = useCallback(async () => {
    try {
      const next = await api.spamFlags(slug);
      setData(next);
      if (seen.current === null) {
        seen.current = new Set(next.flags.map(flagKey));
        return;
      }
      const fresh = newFlags(seen.current, next.flags);
      for (const f of fresh) seen.current.add(flagKey(f));
      const text = alertText(fresh);
      if (text) notify(text, "info");
    } catch {
      /* the next read tries again */
    }
  }, [slug, notify]);
  const request = useCoalescingReader(read);

  useEffect(() => {
    if (on) request();
  }, [on, request, revision]);

  useEffect(() => {
    if (!on) return;
    const timer = setInterval(request, SPAM_POLL_MS);
    return () => clearInterval(timer);
  }, [on, request]);

  const act = useCallback(
    async (flag: SpamFlag, action: SpamAction) => {
      try {
        await api.spamAction(slug, flag.kind as SpamKind, flag.id, action);
      } catch (e) {
        notify(e instanceof ApiError ? e.message : "That didn't work. Try again.", "error");
      }
      request();
    },
    [slug, notify, request],
  );

  const setSettings = useCallback(
    async (patch: SpamSettingsPatch) => {
      try {
        const settings = await api.spamSettings(slug, patch);
        setData((d) => (d ? { ...d, settings } : d));
      } catch (e) {
        notify(e instanceof ApiError ? e.message : "Couldn't save that setting.", "error");
      }
    },
    [slug, notify],
  );

  return useMemo(() => (on ? { data, act, setSettings } : null), [on, data, act, setSettings]);
}

/** "All · Flagged (n)" above a panel's list. Drawn only for the host team. */
export function FlaggedFilter({ flagged, count, onChange }: {
  flagged: boolean;
  count: number;
  onChange: (flagged: boolean) => void;
}) {
  const tab = (on: boolean, label: string) => (
    <button
      type="button"
      onClick={() => onChange(on)}
      aria-pressed={flagged === on}
      className={`rounded-full px-2.5 py-0.5 text-[11.5px] font-medium transition-colors ${
        flagged === on ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1 border-b border-line px-3 py-1.5" role="group" aria-label="Filter">
      {tab(false, "All")}
      {tab(true, count > 0 ? `Flagged (${count})` : "Flagged")}
    </div>
  );
}

/** The Flagged view of one panel: the flags of its kind, waiting first, each with its
 *  one-click actions, and the session's spam settings at the foot. */
export function FlaggedList({ kind }: { kind: SpamKind }) {
  const { spam } = useRoomUI();
  const [busy, setBusy] = useState<string | null>(null);
  const data = spam?.data;
  if (!spam || !data) {
    return <p className="py-8 text-center text-[12.5px] text-ink-3">Loading…</p>;
  }
  const flags = flagsFor(data.flags, kind);
  const muted = new Set(data.muted);
  const where = kind === "chat" ? "chat" : "Q&A";

  async function run(f: SpamFlag, action: SpamAction) {
    if (!spam) return;
    setBusy(flagKey(f));
    await spam.act(f, action);
    setBusy(null);
  }

  return (
    <div className="space-y-2">
      {data.limited && (
        <p className="text-[11px] text-ink-3">AI limit reached. Only the free rules are checking {where} for now.</p>
      )}
      {!data.ai && (
        <p className="text-[11px] text-ink-3">AI is off for this session, so only the free rules are checking {where}.</p>
      )}
      {flags.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] leading-relaxed text-ink-3">
          Nothing flagged in {where}.
          <br />
          Possible spam from attendees shows up here. Only you and your co-hosts see it.
        </p>
      ) : (
        <ul className="space-y-2">
          {flags.map((f) => {
            const done = statusLabel(f.status);
            return (
              <li
                key={flagKey(f)}
                className={`rounded-xl border px-3 py-2 ${isWaiting(f) ? "border-warn/40 bg-warn-soft/40" : "border-line opacity-80"}`}
              >
                <div className="flex items-center gap-1.5 text-[11px] text-ink-3">
                  <MaterialIcon name="flag" className="!text-[13px] text-warn" />
                  <span className="truncate font-semibold text-ink-2">{f.name || "Attendee"}</span>
                  <span>·</span>
                  <span>{categoryLabel(f.category)}</span>
                  <span className="tabular-nums">{confidenceLabel(f.confidence)}</span>
                  <span className="truncate">· {whyLabel(f)}</span>
                  {done && <span className="ml-auto shrink-0 rounded-full bg-surface-2 px-1.5 text-[10.5px]">{done}</span>}
                </div>
                <p className="mt-1 text-[12.5px] leading-snug break-words text-ink wrap-anywhere">{f.text}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {actionsFor(f, muted.has(f.identity)).map((a) => (
                    <button
                      key={a.action}
                      type="button"
                      disabled={busy === flagKey(f)}
                      onClick={() => void run(f, a.action)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50 ${
                        a.action === "delete" || a.action === "hide" || a.action === "remove"
                          ? "border-live/40 text-live hover:bg-live-soft"
                          : "border-line text-ink-2 hover:bg-surface-2"
                      }`}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <SpamSettingsBox />
    </div>
  );
}

function SpamSettingsBox() {
  const { spam } = useRoomUI();
  const settings = spam?.data?.settings;
  if (!spam || !settings) return null;
  const row = (label: string, hint: string, checked: boolean, patch: SpamSettingsPatch) => (
    <label className="flex cursor-pointer items-start gap-2 py-1">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={() => void spam.setSettings(patch)}
      />
      <span className="min-w-0">
        <span className="block text-[12px] text-ink">{label}</span>
        <span className="block text-[10.5px] text-ink-3">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="mt-3 border-t border-line pt-2">
      {row(
        "Auto-hide high-confidence spam (≥0.9)",
        "Hides it from the audience straight away. Off: nothing is hidden until you decide.",
        settings.autoHide,
        { autoHide: !settings.autoHide },
      )}
      {row(
        "Allow links from attendees",
        "Off: a link from an attendee counts toward spam. Group invites always do.",
        settings.allowLinks,
        { allowLinks: !settings.allowLinks },
      )}
    </div>
  );
}
