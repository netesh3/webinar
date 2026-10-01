"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { engageApi } from "../api";
import { useSession } from "@/components/providers";
import type { CRMRepliesResponse } from "@/lib/api-types";
import { formatRelative } from "@/lib/format";
import { messagesHref } from "../hrefs";
import { applyThreadRead } from "../unread";
import { PersonAvatar } from "./wa-kit";

/* WhatsApp replies waiting on the host, for the top bar's bell.
 *
 * One bell, not two: the webinar app's bell adds this count to its badge and renders
 * ReplyAlerts at the top of its panel. It polls slowly while the tab is visible; the
 * reply email (sent after a quiet spell) covers the host who is not in the app at all.
 */

const POLL_MS = 60_000;

/* One poll for every caller (the bell, the messages icon). A second mount joins
 * the same interval instead of starting another. */
let replySnap: CRMRepliesResponse | null = null;
const replyListeners = new Set<() => void>();
let pollers = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/* Bumped when a read lands, so a poll that started before the read cannot
 * paint the old count back over the optimistic one. */
let replyGen = 0;
const readOnce = new Set<string>();

function emitReplies() {
  replyListeners.forEach((cb) => cb());
}

function loadReplies() {
  const gen = ++replyGen;
  engageApi
    .crmReplies()
    .then((res) => {
      if (gen !== replyGen) return;
      replySnap = res;
      readOnce.clear();
      emitReplies();
    })
    .catch(() => {});
}

/** Drop one opened thread from the chat badge immediately. A later poll replaces
 *  this with the server's count. Calling it again for the same thread does not
 *  drop the number a second time. */
export function noteThreadRead(contactId: string) {
  replyGen += 1;
  if (!replySnap) {
    readOnce.add(contactId);
    return;
  }
  const next = applyThreadRead(replySnap, contactId, readOnce);
  if (next === replySnap) return;
  replySnap = next;
  emitReplies();
}

/** Ask for the badge again. Used after a read has been saved. */
export function refreshReplies() {
  loadReplies();
}

/** Save a read, then refresh the badge. `wasUnread` also drops the number now. */
export function markThreadRead(contactId: string, wasUnread = false): void {
  void engageApi
    .markCrmRead(contactId)
    .then(() => {
      if (wasUnread) noteThreadRead(contactId);
      else replyGen += 1;
      loadReplies();
    })
    .catch(() => {
      replyGen += 1;
      loadReplies();
    });
}

function startReplyPoll() {
  if (pollTimer) return;
  loadReplies();
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") loadReplies();
  }, POLL_MS);
}

function stopReplyPoll() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

const subscribeReplies = (cb: () => void) => {
  replyListeners.add(cb);
  return () => {
    replyListeners.delete(cb);
  };
};

export function useReplies(): CRMRepliesResponse | null {
  const { account } = useSession();
  const enabled = Boolean(account?.canHost && account?.whatsapp);
  const data = useSyncExternalStore(subscribeReplies, () => replySnap, () => null);

  useEffect(() => {
    if (!enabled) return;
    pollers += 1;
    startReplyPoll();
    return () => {
      pollers -= 1;
      if (pollers === 0) stopReplyPoll();
    };
  }, [enabled]);

  return enabled ? data : null;
}

/** The bell panel's WhatsApp section: chats not opened yet, newest first. Rendered by the
 *  webinar app's bell (components/host-alerts), which adds `unread` to its badge. */
export function ReplyAlerts({
  data,
  onNavigate,
}: {
  data: CRMRepliesResponse | null;
  onNavigate: () => void;
}) {
  if (!data || data.unread === 0) return null;
  return (
    <div className="border-b border-line">
      <Link
        href={messagesHref()}
        onClick={onNavigate}
        className="flex items-center justify-between px-3 py-2 text-[12px] font-semibold text-ok hover:bg-surface-2"
      >
        <span>
          {data.unread} WhatsApp {data.unread === 1 ? "reply" : "replies"} to answer
        </span>
        <span className="font-medium text-brand">Open Messages</span>
      </Link>
      <ul className="divide-y divide-line/60">
        {data.recent.slice(0, 4).map((r) => (
          <li key={r.contactId}>
            <Link
              href={messagesHref(r.contactId)}
              onClick={() => {
                onNavigate();
                noteThreadRead(r.contactId);
              }}
              className="flex gap-2.5 bg-ok/5 px-3 py-2 hover:bg-surface-2"
            >
              <PersonAvatar name={r.name} seed={r.contactId} size={28} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-[12.5px]">
                  <span className="truncate font-medium">{r.name}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-ink-3">
                    {formatRelative(r.at, new Date())}
                  </span>
                </span>
                <span className="block truncate text-[11.5px] text-ink-2">
                  {r.preview ? `“${r.preview}”` : r.webinar || "Replied on WhatsApp"}
                </span>
              </span>
              <span className="self-center text-[11px] font-semibold text-brand">Reply</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
