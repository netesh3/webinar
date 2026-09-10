"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmModal, Spinner, Tabs } from "./controls";
import { useToast } from "./providers";
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
import { deleteTitle, deleteWarning } from "@/lib/webinar-delete";

/** Zoom's host portal splits webinars across these tabs. */
const TABS = ["Upcoming", "Previous", "Drafts"] as const;
type TabId = (typeof TABS)[number];

function inTab(w: Webinar, tab: TabId): boolean {
  if (tab === "Drafts") return w.status === "draft";
  if (tab === "Previous") return w.status === "ended";
  return w.status === "scheduled" || w.status === "live";
}

export function HostWebinarList({
  webinars,
  readOnly = false,
}: {
  webinars: Webinar[];
  /** Panelist rows: someone else owns these, so no start or delete. */
  readOnly?: boolean;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [tab, setTab] = useState<TabId>("Upcoming");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Webinar | null>(null);

  // Panelist rows are somebody else's webinars: there is no draft to finish and
  // no report to own, so the tab strip would offer two empty tabs and one real
  // one. They get a plain list of what they are booked to appear on.
  const rows = readOnly
    ? webinars.filter((w) => w.status !== "ended")
    : webinars.filter((w) => inTab(w, tab));

  const counts = Object.fromEntries(
    TABS.map((t) => [t, webinars.filter((w) => inTab(w, t)).length]),
  ) as Record<TabId, number>;

  /** Start moves the webinar live and creates the SFU room, then opens it.
   *  Doing it in that order means the first attendee never races room creation. */
  async function start(w: Webinar) {
    setBusy(w.id);
    try {
      if (w.status !== "live") await api.startWebinar(w.id);
      router.push(`/host/${w.id}/room`);
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not start the webinar.", "error");
      setBusy(null);
    }
  }

  async function remove(w: Webinar) {
    setBusy(w.id);
    try {
      await api.deleteWebinar(w.id);
      notify(`Deleted “${w.topic}”.`, "ok");
      setConfirmDelete(null);
      router.refresh();
      // The list is client-fetched, so a refresh of the Server Component tree is
      // not enough on its own.
      location.reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete that.", "error");
      setBusy(null);
    }
  }

  return (
    <>
      {!readOnly && (
        <div className="mb-4">
          <Tabs tabs={TABS} value={tab} onChange={setTab} counts={counts} />
        </div>
      )}

      {rows.length === 0 ? (
        <Empty
          title={
            readOnly
              ? "Nothing coming up"
              : tab === "Drafts"
                ? "No drafts"
                : tab === "Previous"
                  ? "No previous webinars"
                  : "Nothing scheduled"
          }
          hint={
            tab === "Upcoming" && !readOnly
              ? "Schedule your first webinar and share the registration page."
              : undefined
          }
          action={
            tab === "Upcoming" && !readOnly ? (
              <ButtonLink href="/host/new">Schedule a webinar</ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Card className="divide-y divide-line">
          {rows.map((w) => (
            <HostRow
              key={w.id}
              webinar={w}
              readOnly={readOnly}
              busy={busy === w.id}
              onStart={() => void start(w)}
              onDelete={() => setConfirmDelete(w)}
            />
          ))}
        </Card>
      )}

      <ConfirmModal
        open={confirmDelete !== null}
        busy={busy !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title={confirmDelete ? deleteTitle(confirmDelete) : "Delete this webinar?"}
        body={confirmDelete ? deleteWarning(confirmDelete) : ""}
        confirmLabel="Delete everything"
      />
    </>
  );
}

function HostRow({
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
  const fill = Math.min(100, (w.registrantCount / Math.max(1, w.attendeeLimit)) * 100);

  return (
    <div className="flex flex-col gap-4 p-4 lg:flex-row lg:items-center">
      {/* when */}
      <div className="shrink-0 lg:w-[132px]">
        <div className="text-[13px] font-medium">
          {formatDayShort(w.startsAt, w.timeZone)}
        </div>
        <div className="mt-0.5 text-[12px] text-ink-2">
          {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}
        </div>
        <div className="text-[11px] text-ink-3">
          {tzLabel(w.startsAt, w.timeZone)} · {formatDuration(w.durationMin)}
        </div>
      </div>

      {/* topic */}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge tone={kind.tone} dot={isLive}>
            {kind.text}
          </Badge>
          {w.approval === "manual" && <Badge tone="warn">Manual approval</Badge>}
          {w.priceUsd && <Badge tone="brand">${w.priceUsd}</Badge>}
          {w.controls.hideAttendees && !isEnded && <Badge>Audience private</Badge>}
        </div>
        <h3 className="truncate text-[14.5px] font-medium">
          {/* A panelist does not own this webinar, so the manage page would answer
              404. The public page is the one they can actually read. */}
          <Link
            href={readOnly ? `/webinars/${w.id}` : `/host/${w.id}`}
            className="hover:text-brand"
          >
            {w.topic}
          </Link>
        </h3>
        <p className="mt-1 text-[12px] text-ink-3">
          Webinar ID <span className="tabular-nums">{w.webinarId}</span>
          {w.passcode && <> · Passcode {w.passcode}</>}
        </p>
      </div>

      {/* registrants */}
      <div className="shrink-0 lg:w-[132px]">
        {isDraft ? (
          <span className="text-[12.5px] text-ink-3">Not published</span>
        ) : isEnded ? (
          <>
            <div className="text-[13px] font-medium tabular-nums">
              {formatCount(w.registrantCount)} registered
            </div>
            <div className="mt-0.5 text-[11.5px] text-ink-3">
              {w.report ? `${formatCount(w.report.attended)} attended` : "Ended"}
            </div>
          </>
        ) : (
          <>
            <div className="text-[13px] font-medium tabular-nums">
              {formatCount(w.registrantCount)} registered
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-brand" style={{ width: `${fill}%` }} />
            </div>
            <div className="mt-1 text-[11px] text-ink-3">
              {formatCount(w.attendeeLimit)} seat limit
            </div>
          </>
        )}
      </div>

      {/* actions */}
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {readOnly ? (
          <ButtonLink href={`/host/${w.id}/room`} size="sm" variant="secondary">
            Join the stage
          </ButtonLink>
        ) : (
          <>
            {isDraft ? (
              <ButtonLink href={`/host/${w.id}/edit`} size="sm">
                Finish setup
              </ButtonLink>
            ) : isEnded ? (
              <ButtonLink href={`/host/${w.id}`} variant="secondary" size="sm">
                View report
              </ButtonLink>
            ) : (
              <>
                <Button size="sm" onClick={onStart} disabled={busy}>
                  {busy ? <Spinner className="size-3.5" /> : isLive ? "Rejoin" : "Start"}
                </Button>
                <ButtonLink href={`/host/${w.id}`} variant="secondary" size="sm">
                  Manage
                </ButtonLink>
              </>
            )}
            {/* Delete on every row the host owns, not only on drafts.
                It used to be draft-only, and the API refused anything that had run — so a
                scheduled webinar could be deleted from nowhere and an ended one could not be
                deleted at all. A host who wants their data gone had no way to say so. The
                warning is in the dialog and it is specific per status; see lib/webinar-delete.ts. */}
            <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy}>
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
