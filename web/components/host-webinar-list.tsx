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
import { isDevAuthBypass } from "@/lib/dev-bypass";
import { deleteTitle, deleteWarning } from "@/lib/webinar-delete";

/** Zoom / Livestorm-style host list: Upcoming vs Past vs Drafts. */
const TABS = ["Upcoming", "Past", "Drafts"] as const;
type TabId = (typeof TABS)[number];

function inTab(w: Webinar, tab: TabId): boolean {
  if (tab === "Drafts") return w.status === "draft";
  if (tab === "Past") return w.status === "ended";
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
  const bypass = isDevAuthBypass();

  const rows = readOnly
    ? webinars.filter((w) => w.status !== "ended")
    : webinars.filter((w) => inTab(w, tab));

  const counts = Object.fromEntries(
    TABS.map((t) => [t, webinars.filter((w) => inTab(w, t)).length]),
  ) as Record<TabId, number>;

  async function start(w: Webinar) {
    if (bypass) {
      router.push("/preview/room");
      return;
    }
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
                : tab === "Past"
                  ? "No past webinars"
                  : "Nothing upcoming"
          }
          hint={
            tab === "Upcoming" && !readOnly
              ? "Create a webinar, then Host it from this list when it's time."
              : undefined
          }
          action={
            tab === "Upcoming" && !readOnly ? (
              <ButtonLink href="/host/new">Create webinar</ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-3">
          {rows.map((w) => (
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

        {/* Primary actions — Host / Manage / Attendees (or Admit). */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {readOnly ? (
            <ButtonLink href={`/host/${w.id}/room`} size="sm">
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
              <Button size="sm" onClick={onStart} disabled={busy}>
                {busy ? <Spinner className="size-3.5" /> : isLive ? "Rejoin" : "Host"}
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
