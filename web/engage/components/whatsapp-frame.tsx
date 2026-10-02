"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/providers";
import { engageApi } from "../api";
import { ENGAGE_HOME, MESSAGES_HREF } from "../hrefs";
import { useReplies } from "./replies";

/* The WhatsApp page chrome: title, the connected number, and the tabs.
 * Each tab keeps the screen that already existed. This only places them.
 * Broadcasts used to be a separate page behind a back link; it is a tab now,
 * and ?view=broadcasts is that tab's address. */

export type WhatsAppTab =
  | "metrics"
  | "chats"
  | "templates"
  | "automations"
  | "broadcasts";

const TABS: { id: WhatsAppTab; label: string; href: string }[] = [
  { id: "metrics", label: "Metrics", href: ENGAGE_HOME },
  { id: "chats", label: "Chats", href: MESSAGES_HREF },
  { id: "templates", label: "Templates", href: `${ENGAGE_HOME}?view=templates` },
  {
    id: "automations",
    label: "Automations",
    href: `${ENGAGE_HOME}?view=automations`,
  },
  {
    id: "broadcasts",
    label: "Broadcasts",
    href: `${ENGAGE_HOME}?view=broadcasts`,
  },
];

export function WhatsAppFrame({
  tab,
  templateCount,
  broadcastCount,
  actions,
  children,
}: {
  tab: WhatsAppTab | null;
  templateCount?: number | null;
  /** When the Broadcasts tab already has the list, its length wins over the
   *  count this frame reads for the other tabs. */
  broadcastCount?: number | null;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { account } = useSession();
  const replies = useReplies();
  const link = account?.whatsapp;
  const connected = Boolean(link?.connected);
  const chats = replies?.needsReply ?? 0;
  const [fetchedBroadcasts, setFetchedBroadcasts] = useState<number | null>(null);

  /* The badge has to be there on Metrics and on Chats too, which is a different
   * route. One read of the list; a failure hides the badge rather than showing 0. */
  useEffect(() => {
    let cancelled = false;
    engageApi
      .crmBroadcasts()
      .then((res) => {
        if (!cancelled) setFetchedBroadcasts(res.broadcasts.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const broadcasts = broadcastCount ?? fetchedBroadcasts;

  return (
    <div className="grid gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">WhatsApp</h1>
        {actions}
      </header>

      <div className="flex min-w-0 flex-wrap items-center gap-2 text-[13px] text-ink-2">
        {connected ? (
          <>
            <span className="size-2 shrink-0 rounded-full bg-ok ring-[3px] ring-ok/15" />
            <b className="font-semibold text-ink">Connected</b>
            <span className="truncate">
              {link?.displayPhone || "your number"}
              {link?.verifiedName ? ` (${link.verifiedName})` : ""}
            </span>
            <Link
              href="/settings#integrations"
              className="text-[12.5px] font-medium text-brand hover:underline"
            >
              Settings
            </Link>
          </>
        ) : (
          <>
            <span className="size-2 shrink-0 rounded-full bg-ink-3" />
            <b className="font-semibold text-ink">Not connected</b>
            <Link
              href={`${ENGAGE_HOME}?view=setup`}
              className="text-[12.5px] font-medium text-brand hover:underline"
            >
              Connect
            </Link>
          </>
        )}
      </div>

      <nav className="flex gap-1 border-b border-line" aria-label="WhatsApp">
        {TABS.map((item) => {
          const on = item.id === tab;
          const count =
            item.id === "chats" && chats > 0
              ? chats
              : item.id === "templates" && templateCount != null
                ? templateCount
                : item.id === "broadcasts" && broadcasts != null && broadcasts > 0
                  ? broadcasts
                  : null;
          return (
            <Link
              key={item.id}
              href={item.href}
              data-tour={`whatsapp-${item.id}`}
              aria-current={on ? "page" : undefined}
              className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-medium ${
                on
                  ? "border-brand text-brand"
                  : "border-transparent text-ink-2 hover:text-ink"
              }`}
            >
              {item.label}
              {count != null && (
                <span
                  className={`inline-grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[11px] font-semibold ${
                    on ? "bg-brand-soft text-brand" : "bg-surface-2 text-ink-2"
                  }`}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}
