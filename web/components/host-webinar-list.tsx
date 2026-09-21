"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmModal, Spinner } from "./controls";
import { useShareOrigin, useToast } from "./providers";
import { Badge, Button, ButtonLink, Card, Empty, kindLabel } from "./ui";
import {
  formatCount,
  formatDayShort,
  formatDuration,
  formatTimeRange,
  tzLabel,
} from "@/lib/format";
import { api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { openPendingRoomTab, openRoomTab } from "@/lib/open-room";
import { shareAttendeeLink } from "@/lib/share-attendee-link";
import { deleteTitle, deleteWarning } from "@/lib/webinar-delete";

/* Rows, and the two things a host can do to one from the list — start it, or
 * delete it.
 *
 * Tabs, search, date range and paging used to live here as well, filtering a
 * complete list held in the browser. They moved to host-webinar-browser.tsx
 * when that list became one server-side page at a time, because a component
 * cannot count tabs it no longer holds every row for. What is left is what both
 * lists share: the host's own paged one, and the panelist list below it.
 */
export function HostWebinarRows({
  webinars,
  readOnly = false,
}: {
  webinars: Webinar[];
  /** Panelist rows: someone else owns these, so no start or delete. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Webinar | null>(null);
  const bypass = isDevAuthBypassActive();

  async function start(w: Webinar) {
    if (bypass) {
      openRoomTab("/preview/room");
      return;
    }
    // A webinar that is already live has nothing to await, so opening it
    // stays inside the click's own call stack and a plain openRoomTab is
    // never at risk of the popup blocker. One that still needs starting
    // does have an await in front of it — see openPendingRoomTab's doc
    // comment for why that turns a same-tick window.open() into one Safari
    // silently blocks.
    if (w.status === "live") {
      openRoomTab(`/host/${w.id}/room`);
      router.refresh();
      return;
    }
    const pendingTab = openPendingRoomTab();
    setBusy(w.id);
    try {
      await api.startWebinar(w.id);
      pendingTab.open(`/host/${w.id}/room`);
      /* router.refresh(), not location.reload(): the tab opened a line above is
       * still an about:blank whose navigation was started by THIS document, and
       * tearing this document down in the same tick cancels it — the room tab
       * stays blank and the only visible effect of pressing Host is the
       * dashboard reloading. Refreshing re-renders the list in place instead,
       * which is all the reload was ever for. */
      router.refresh();
      setBusy(null);
    } catch (err) {
      pendingTab.cancel();
      notify(err instanceof Error ? err.message : "Could not start the webinar.", "error");
      setBusy(null);
    }
  }

  async function remove(w: Webinar) {
    if (bypass) {
      notify("Delete is mocked in local preview.", "info");
      setConfirmDelete(null);
      return;
    }
    setBusy(w.id);
    try {
      await api.deleteWebinar(w.id);
      notify(`Deleted “${w.topic}”.`, "ok");
      setConfirmDelete(null);
      router.refresh();
      location.reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete that.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="grid gap-3">
        {webinars.map((w) => (
          <HostCard
            key={w.id}
            webinar={w}
            readOnly={readOnly}
            busy={busy === w.id}
            onStart={() => void start(w)}
            onDelete={() => setConfirmDelete(w)}
          />
        ))}
      </div>

      <ConfirmModal
        open={confirmDelete !== null}
        busy={busy !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title={confirmDelete ? deleteTitle(confirmDelete) : "Delete this webinar?"}
        body={confirmDelete ? deleteWarning(confirmDelete) : ""}
        confirmLabel="Delete this webinar"
      />
    </>
  );
}

/* The panelist list: sessions somebody else owns and invited this account onto.
 *
 * Whole, unpaged and untabbed on purpose. A host is invited onto a handful of
 * these rather than hundreds, and the only split that would matter — has it
 * happened yet — is already made by dropping the ended ones: there is nothing
 * to join in a session that is over.
 */
export function HostWebinarList({ webinars }: { webinars: Webinar[] }) {
  const rows = webinars.filter((w) => w.status !== "ended");

  if (rows.length === 0) return <Empty title="Nothing coming up" />;
  return <HostWebinarRows webinars={rows} readOnly />;
}

function HostCard({
  webinar: w,
  readOnly,
  busy,
  onStart,
  onDelete,
}: {
  webinar: Webinar;
  readOnly: boolean;
  busy: boolean;
  onStart: () => void;
  onDelete: () => void;
}) {
  const kind = kindLabel(w);
  const isDraft = w.status === "draft";
  const isEnded = w.status === "ended";
  const isLive = w.status === "live";
  const needsAdmit = w.approval === "manual" && !isEnded && !isDraft;
  const bypass = isDevAuthBypassActive();
  const origin = useShareOrigin();
  const { notify } = useToast();
  const roomHref = bypass ? "/preview/room" : `/host/${w.id}/room`;
  const registerUrl = `${origin}/webinars/${w.id}`;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={kind.tone} dot={isLive}>
              {kind.text}
            </Badge>
            {needsAdmit && <Badge tone="warn">Admit required</Badge>}
            {w.priceUsd ? <Badge tone="brand">${w.priceUsd}</Badge> : null}
          </div>

          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
            <Link
              href={readOnly ? `/webinars/${w.id}` : `/host/${w.id}`}
              className="hover:text-brand"
            >
              {w.topic}
            </Link>
          </h3>

          <p className="mt-1.5 text-[13px] text-ink-2">
            {formatDayShort(w.startsAt, w.timeZone)} ·{" "}
            {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
            {tzLabel(w.startsAt, w.timeZone)} · {formatDuration(w.durationMin)}
          </p>

          <p className="mt-1 text-[12px] text-ink-3">
            {isDraft ? (
              "Draft — not published yet"
            ) : isEnded ? (
              <>
                {formatCount(w.registrantCount)} registered
                {w.report ? ` · ${formatCount(w.report.attended)} attended` : ""}
              </>
            ) : (
              <>
                {formatCount(w.registrantCount)} registered
                {w.attendeeLimit > 0
                  ? ` · ${formatCount(w.attendeeLimit)} seat limit`
                  : ""}
              </>
            )}
          </p>
        </div>

        {/* Primary actions — Host / Share / Manage / Attendees (or Admit). */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {readOnly ? (
            <ButtonLink
              href={roomHref}
              size="sm"
              target="_blank"
              rel="noopener noreferrer"
            >
              Join stage
            </ButtonLink>
          ) : isDraft ? (
            <ButtonLink href={`/host/${w.id}/edit`} size="sm">
              Finish setup
            </ButtonLink>
          ) : isEnded ? (
            <>
              <ButtonLink href={`/host/${w.id}?tab=attendees`} size="sm">
                View attendance
              </ButtonLink>
              <ButtonLink href={`/host/${w.id}`} variant="secondary" size="sm">
                Manage
              </ButtonLink>
            </>
          ) : (
            <>
              {isLive ? (
                <ButtonLink
                  href={roomHref}
                  size="sm"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Rejoin
                </ButtonLink>
              ) : (
                <Button size="sm" onClick={onStart} disabled={busy}>
                  {busy ? <Spinner className="size-3.5" /> : "Host"}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void shareAttendeeLink({
                    url: registerUrl,
                    topic: w.topic,
                    notify,
                  })
                }
              >
                Share
              </Button>
              {needsAdmit ? (
                <ButtonLink
                  href={`/host/${w.id}?tab=admit`}
                  variant="secondary"
                  size="sm"
                >
                  Admit
                </ButtonLink>
              ) : (
                <ButtonLink
                  href={`/host/${w.id}?tab=attendees`}
                  variant="secondary"
                  size="sm"
                >
                  Attendees
                </ButtonLink>
              )}
              <ButtonLink href={`/host/${w.id}`} variant="ghost" size="sm">
                Manage
              </ButtonLink>
            </>
          )}
          {!readOnly && (
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
              Delete
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
