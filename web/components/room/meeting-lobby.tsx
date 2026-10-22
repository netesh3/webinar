"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { LobbyEntry } from "@/lib/api-types";
import {
  admitAllMessage,
  lobbyArrivals,
  lobbyLabel,
  lobbyToastText,
  meetingFullMessage,
  sortLobby,
} from "@/lib/meeting-room";
import { useToast } from "../providers";
import { Spinner } from "../controls";
import { CloseIcon, UsersIcon } from "../icons";
import { SenderAvatar } from "../sender-avatar";

/* A meeting's lobby, as the host and co-hosts run it from inside the room.
 *
 * The people waiting are GET /lobby, polled every five seconds while this person can act on
 * it, and read again the moment the server's {kind:"lobby"} packet says the count moved
 * (lib/realtime.ts LobbyMessage). Both, for the same reason the roster does both: the packet
 * is best-effort and the poll is the floor. A knock while the host is mid-sentence shows up
 * within a second; a lost packet, within five.
 *
 * Room-level rather than panel-level, so the header's "Waiting (N)" and the toast are right
 * whether or not Participants is open — the person at the door is the one thing in a meeting
 * that cannot wait for the host to go looking.
 */

const LOBBY_POLL_MS = 5_000;
const LOBBY_RETRY_MS = 8_000;
// A knock and its announce arrive together; one read covers a burst of them.
const LOBBY_DEBOUNCE_MS = 250;

export type MeetingLobbyApi = {
  /** Oldest first. Null until the first read lands. */
  entries: LobbyEntry[] | null;
  waiting: number;
  error: boolean;
  /** The id being admitted or denied, "all" for Admit all, or null. */
  busy: string | null;
  /** The server said the count changed: read now. */
  signal: () => void;
  admit: (entry: LobbyEntry) => Promise<void>;
  deny: (entry: LobbyEntry) => Promise<void>;
  admitAll: () => Promise<void>;
};

/** Why an admit failed, said the way a host can act on. 409 meeting_full is the one that
 *  matters: the host is looking at the button and should hear the cap, not "conflict". */
function lobbyError(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code === "meeting_full") return meetingFullMessage(err.message);
  if (err instanceof ApiError && err.status === 404) return "They aren't waiting any more.";
  return err instanceof Error && err.message ? err.message : fallback;
}

export function useMeetingLobby(slug: string, enabled: boolean): MeetingLobbyApi {
  const { notify } = useToast();
  const [entries, setEntries] = useState<LobbyEntry[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // How the packet (and an action's own follow-up) reaches the poller below.
  const soonRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(read, ms);
    };
    const read = () => {
      if (inFlight) {
        schedule(LOBBY_DEBOUNCE_MS);
        return;
      }
      inFlight = true;
      api
        .meetingLobby(slug)
        .then((list) => {
          if (!active) return;
          setEntries(sortLobby(list ?? []));
          setError(false);
          schedule(LOBBY_POLL_MS);
        })
        .catch(() => {
          if (!active) return;
          setError(true);
          schedule(LOBBY_RETRY_MS);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    soonRef.current = () => schedule(LOBBY_DEBOUNCE_MS);
    read();
    return () => {
      active = false;
      clearTimeout(timer);
      soonRef.current = () => {};
    };
  }, [slug, enabled]);

  const signal = useCallback(() => soonRef.current(), []);

  const decide = useCallback(
    async (entry: LobbyEntry, admit: boolean) => {
      setBusy(entry.id);
      try {
        if (admit) await api.admitLobby(slug, entry.id);
        else await api.denyLobby(slug, entry.id);
        // Out of the list at once rather than on the next read: the host has moved on.
        setEntries((list) => list?.filter((e) => e.id !== entry.id) ?? list);
        notify(admit ? `Let ${entry.name} in.` : `${entry.name} wasn't let in.`, "ok");
      } catch (err) {
        notify(lobbyError(err, admit ? "Couldn't let them in." : "Couldn't turn them away."), "error");
      } finally {
        setBusy(null);
        soonRef.current();
      }
    },
    [slug, notify],
  );

  const admitAll = useCallback(async () => {
    setBusy("all");
    try {
      const res = await api.admitAllLobby(slug);
      notify(admitAllMessage(res), res.left > 0 ? "info" : "ok");
    } catch (err) {
      notify(lobbyError(err, "Couldn't let everyone in."), "error");
    } finally {
      setBusy(null);
      soonRef.current();
    }
  }, [slug, notify]);

  return useMemo(
    () => ({
      entries: enabled ? entries : null,
      waiting: enabled ? (entries?.length ?? 0) : 0,
      error,
      busy,
      signal,
      admit: (e: LobbyEntry) => decide(e, true),
      deny: (e: LobbyEntry) => decide(e, false),
      admitAll,
    }),
    [enabled, entries, error, busy, signal, decide, admitAll],
  );
}

/* "Asha is waiting to join", with Admit and Deny, once per new knock.
 *
 * One keyed toast for the whole queue, updated in place, rather than one per person: five
 * people arriving for a 10 o'clock meeting is one card saying so, not five stacked over the
 * stage. Only arrivals put it up — the poll bringing back the same queue does not — and it
 * goes the moment the lobby empties or Participants is in front of the host, where the same
 * buttons already are. The host clicking it away keeps it away until somebody new knocks.
 */
export function useLobbyToasts(
  lobby: MeetingLobbyApi | null,
  panelVisible: boolean,
  openParticipants: () => void,
) {
  const { upsert, dismissKey } = useToast();
  const [showing, setShowing] = useState(false);
  const entries = lobby?.entries ?? null;

  /* Who has been announced, adjusted during render when a new list arrives rather than in
   * an effect after it. The first read is the baseline: a host who opens the room to a queue
   * gets one card for it, not a burst of "is waiting" for people who have been. */
  const [seen, setSeen] = useState<{ list: LobbyEntry[] | null; known: Set<string> | null }>({
    list: null,
    known: null,
  });
  if (entries !== seen.list) {
    const known = entries ? new Set(entries.map((e) => e.id)) : seen.known;
    const arrived = entries
      ? seen.known === null
        ? entries.length > 0
        : lobbyArrivals(seen.known, entries).length > 0
      : false;
    setSeen({ list: entries, known });
    if (arrived && !panelVisible) setShowing(true);
  }

  const visible = showing && !panelVisible && (entries?.length ?? 0) > 0;
  const latest = useRef({ lobby, openParticipants });
  useEffect(() => {
    latest.current = { lobby, openParticipants };
  });

  useEffect(() => {
    if (!visible || !entries) {
      dismissKey("meeting-lobby");
      return;
    }
    upsert("meeting-lobby", {
      message: lobbyToastText(entries),
      tone: "info",
      interactive: true,
      node: (
        <LobbyToastCard
          entries={entries}
          busy={lobby?.busy ?? null}
          onAdmit={(e) => void latest.current.lobby?.admit(e)}
          onDeny={(e) => void latest.current.lobby?.deny(e)}
          onAdmitAll={() => void latest.current.lobby?.admitAll()}
          onView={() => {
            latest.current.openParticipants();
            setShowing(false);
          }}
          onHide={() => setShowing(false)}
        />
      ),
      onDismiss: () => setShowing(false),
    });
  }, [visible, entries, lobby?.busy, upsert, dismissKey]);

  useEffect(() => () => dismissKey("meeting-lobby"), [dismissKey]);
}

const toastButton =
  "inline-flex min-h-11 items-center rounded-lg px-3 text-[12.5px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50 md:min-h-7";

function LobbyToastCard({
  entries,
  busy,
  onAdmit,
  onDeny,
  onAdmitAll,
  onView,
  onHide,
}: {
  entries: LobbyEntry[];
  busy: string | null;
  onAdmit: (e: LobbyEntry) => void;
  onDeny: (e: LobbyEntry) => void;
  onAdmitAll: () => void;
  onView: () => void;
  onHide: () => void;
}) {
  const one = entries.length === 1 ? entries[0] : null;
  return (
    <div className="join-card room-dark relative flex w-full items-start gap-3 rounded-xl border border-brand-line bg-surface/95 py-2.5 pr-3 pl-3 text-left shadow-xl backdrop-blur sm:w-[22rem]">
      {one ? (
        <SenderAvatar name={one.name} identity={one.id} size="md" />
      ) : (
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand">
          <UsersIcon className="size-4" />
        </span>
      )}
      <div className="min-w-0 flex-1 pr-7">
        <p className="text-[13px] font-semibold text-ink">{lobbyToastText(entries)}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {one ? (
            <>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onAdmit(one)}
                className={`${toastButton} bg-brand text-stage hover:bg-brand-hover`}
              >
                {busy === one.id ? <Spinner className="size-3.5" /> : "Admit"}
              </button>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => onDeny(one)}
                className={`${toastButton} border border-line-2 text-ink hover:bg-surface-2`}
              >
                Deny
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy !== null}
              onClick={onAdmitAll}
              className={`${toastButton} bg-brand text-stage hover:bg-brand-hover`}
            >
              {busy === "all" ? <Spinner className="size-3.5" /> : "Admit all"}
            </button>
          )}
          <button
            type="button"
            onClick={onView}
            className={`${toastButton} text-brand hover:bg-surface-2`}
          >
            View
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={onHide}
        aria-label="Hide notification"
        title="Hide — they stay in Participants"
        className="absolute top-1.5 right-1.5 grid size-7 place-items-center rounded-md text-ink-3 transition-colors outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        <CloseIcon className="size-3.5" />
      </button>
    </div>
  );
}

/** The header's "Waiting (N)": present only while somebody is at the door, and one click
 *  from the list that lets them in. */
export function LobbyChip({ waiting, onOpen }: { waiting: number; onOpen: () => void }) {
  if (waiting <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-brand/90 px-2.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-brand outline-none focus-visible:ring-2 focus-visible:ring-white/50"
    >
      <UsersIcon className="size-3.5" />
      {lobbyLabel(waiting)}
    </button>
  );
}

/* The lobby, at the top of the host's Participants panel: who is waiting, oldest first, each
 * with Admit and Deny, and Admit all once there is more than one. Nothing at all when nobody
 * is waiting — an empty "Waiting (0)" heading in every meeting is noise. */
export function LobbySection({ lobby }: { lobby: MeetingLobbyApi }) {
  const entries = lobby.entries ?? [];
  if (entries.length === 0) return null;
  const busy = lobby.busy;
  return (
    <div className="border-b border-line">
      <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur">
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
          Waiting to join
          <span className="rounded-full bg-brand-soft px-1.5 text-[10px] leading-4 tracking-normal text-brand tabular-nums">
            {entries.length}
          </span>
        </p>
        {entries.length > 1 && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void lobby.admitAll()}
            aria-busy={busy === "all"}
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-0 md:py-0.5"
          >
            {busy === "all" && <Spinner className="size-3" />}
            Admit all
          </button>
        )}
      </div>
      <ul className="divide-y divide-line">
        {entries.map((e) => (
          <li key={e.id} className="flex min-h-12 items-center gap-2.5 bg-brand/[0.04] px-3 py-2">
            <SenderAvatar name={e.name} identity={e.id} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{e.name}</span>
            {busy === e.id ? (
              <Spinner className="size-4 text-ink-3" />
            ) : (
              <span className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void lobby.deny(e)}
                  className="inline-flex min-h-11 items-center rounded-lg border border-line-2 px-2.5 text-[12px] font-medium text-ink transition-colors hover:bg-surface-2 disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7"
                >
                  Deny
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void lobby.admit(e)}
                  className="inline-flex min-h-11 items-center rounded-lg bg-brand px-2.5 text-[12px] font-medium text-stage transition-colors hover:bg-brand-hover disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-brand/40 md:min-h-7"
                >
                  Admit
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {lobby.error && (
        <p className="px-3 py-1.5 text-[11.5px] text-live">Couldn&apos;t refresh who is waiting. Retrying…</p>
      )}
    </div>
  );
}
