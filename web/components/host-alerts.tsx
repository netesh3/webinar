"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import type { HostAlert } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { useNow } from "@/lib/clock";
import { formatRelative } from "@/lib/format";
import { Button } from "./ui";
import { ReplyAlerts, useReplies } from "@/engage";

/* The host's notification bell.
 *
 * The gap this fills: on a manual-approval webinar somebody registers, lands in PENDING, and
 * waits. Nothing told the host. They had to think to open the webinar and check the registrants
 * tab — so the realistic failure was a registrant sitting unapproved until the session started,
 * which is exactly when the host has least capacity to deal with it.
 *
 * POLLED, not pushed, and that is a considered choice rather than laziness. The app already has
 * a realtime channel, but it is the SFU's data channel and it only exists INSIDE a room — a host
 * on their dashboard is not connected to anything. Adding a second transport (a WebSocket, or
 * SSE) to carry a number that changes a few times an hour would be a new always-on connection
 * per host, a reconnect ladder and a server-side fan-out, to replace one cheap indexed COUNT.
 *
 * Sixty seconds, and only while the tab is visible. A background tab polling forever is how a
 * laptop battery disappears, and a host who returns to the tab gets a fresh count immediately
 * from the visibility handler.
 */

const POLL_MS = 60_000;

export function HostAlerts({ placement = "bar" }: { placement?: "bar" | "side" }) {
  const [alerts, setAlerts] = useState<HostAlert[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const now = useNow();
  // WhatsApp replies waiting — owned by Engage, shown in this one bell.
  const replies = useReplies();
  const badge = unread + (replies?.unread ?? 0);

  /* Not an async function, and the state is written inside .then().
   *
   * The obvious `async () => { const out = await api...; setAlerts(out) }` is rejected by
   * react-hooks/set-state-in-effect when called from an effect body — the rule sees a call
   * that reaches setState and cannot tell that everything after the first await is already a
   * later tick. Putting the writes in a promise callback says the same thing in a shape the
   * rule accepts, and matches how useDevices in lib/media.ts solves the identical problem.
   */
  const load = useCallback(() => {
    if (isDevAuthBypassActive()) return;
    api
      .hostAlerts()
      .then((out) => {
        setAlerts(out.alerts);
        setUnread(out.unread);
      })
      .catch(() => {
        /* Silent. This is an ambient count, not something the host asked for, and an error
         * banner over a dashboard because a background poll failed is worse than a stale
         * number — especially since the next tick fixes it. */
      });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    // Coming back to the tab is the moment the count is most likely to be stale and most
    // likely to be looked at.
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  /* Opening the panel does NOT mark everything read.
   *
   * Glancing at a bell is not the same as dealing with what is behind it, and clearing the
   * badge on open means a host who opens it in passing loses the only signal that somebody is
   * still waiting. Marking read is an explicit action.
   */
  /* Clicking one notification is reading it. The number drops now; the request
   * persists that, and a failure asks for the list again so a still-unread row
   * comes back. */
  function openAlert(a: HostAlert) {
    setOpen(false);
    if (!a.unread) return;
    setAlerts((prev) => prev.map((row) => (row.id === a.id ? { ...row, unread: false } : row)));
    setUnread((n) => Math.max(0, n - 1));
    void api.readHostAlerts([a.id]).catch(() => load());
  }

  async function markAllRead() {
    try {
      await api.readHostAlerts();
      setUnread(0);
      setAlerts((prev) => prev.map((a) => ({ ...a, unread: false })));
    } catch {
      // Leave the badge alone; it is still true.
    }
  }

  /* Close on Escape or a press outside the bell and its panel. A document
   * listener rather than a fixed click-catcher: the header's backdrop-filter
   * makes `position: fixed` relative to the header, so a catcher only covered
   * the header strip and clicks on the page never closed the panel. Checking
   * `root.contains` keeps the button's own click from closing and reopening. */
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [beside, setBeside] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (root.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggle() {
    if (!open && placement === "side" && root.current) {
      const rect = root.current.getBoundingClientRect();
      setBeside({ left: rect.right + 8, bottom: window.innerHeight - rect.bottom });
    }
    setOpen((v) => !v);
  }

  const body = (
    <div className="w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <span className="text-[12.5px] font-semibold">Notifications</span>
              {unread > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void markAllRead()}
                >
                  Mark all read
                </Button>
              )}
            </div>

            <ReplyAlerts data={replies} onNavigate={() => setOpen(false)} />

            {alerts.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">
                Nothing yet. Registrations that need your approval show up here.
              </p>
            ) : (
              <ul className="max-h-[24rem] divide-y divide-line/60 overflow-y-auto">
                {alerts.map((a) => (
                  <li key={a.id} className={a.unread ? "bg-brand/5" : ""}>
                    {/* Straight to the tab that can act on it. A notification that tells you
                        something needs doing and then makes you navigate to find it is half a
                        feature. */}
                    <Link
                      href={
                        a.webinarId
                          ? `/host/${a.webinarId}?tab=registrants`
                          : "/host"
                      }
                      onClick={() => openAlert(a)}
                      className="block px-3 py-2.5 hover:bg-surface-2"
                    >
                      <div className="text-[12.5px] leading-snug font-medium">
                        {a.subject}
                      </div>
                      {a.topic && (
                        <div className="mt-0.5 truncate text-[11.5px] text-ink-3">
                          {a.topic}
                        </div>
                      )}
                      <div className="mt-0.5 text-[11px] text-ink-3">
                        {now ? formatRelative(a.createdAt, new Date(now)) : ""}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
    </div>
  );

  return (
    <div className={placement === "side" ? "sb-alerts" : "relative"} ref={root}>
      <button
        type="button"
        onClick={toggle}
        className={
          placement === "side"
            ? "text-ink-2"
            : "relative grid size-9 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
        }
        aria-label={
          badge > 0 ? `Notifications (${badge} unread)` : "Notifications"
        }
        aria-expanded={open}
      >
        <BellIcon />
        {placement === "side" && <span className="sb-lbl">Notifications</span>}
        {badge > 0 && (
          <span
            className={
              placement === "side"
                ? "sb-badge"
                : "absolute top-1 right-1 grid min-w-4 place-items-center rounded-full bg-brand px-1 text-[10px] leading-4 font-semibold text-white"
            }
            // The count is already in the button's aria-label, so the badge itself is
            // decorative — announcing it twice makes a screen reader read the number and
            // then read it again.
            aria-hidden
          >
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </button>
      {placement === "side" && <span className="sb-fly">Notifications</span>}

      {open && placement === "side" && beside
        ? createPortal(
            <div
              ref={panel}
              className="fixed z-50"
              style={{ left: beside.left, bottom: beside.bottom }}
            >
              {body}
            </div>,
            document.body,
          )
        : open && (
            <div ref={panel} className="absolute right-0 z-50 mt-1">
              {body}
            </div>
          )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden
    >
      <path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13.7 21a2 2 0 0 1-3.4 0"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
