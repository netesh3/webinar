"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { ConfirmModal, Menu, Modal } from "./controls";
import { useShareOrigin, useToast } from "./providers";
import { Badge, Button, ButtonLink, Card, Empty, kindLabel } from "./ui";
import { WebinarListCard } from "./webinar-list-card";
import {
  formatCount,
  formatDayShort,
  formatDuration,
  formatRelative,
  formatTimeRange,
  tzLabel,
} from "@/lib/format";
import { api } from "@/lib/api";
import type { Webinar } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { canGoLive, goLiveWaitReason } from "@/lib/go-live";
import { useNow } from "@/lib/clock";
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
  const now = useNow(15_000);
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
    const isZoom = w.venue === "zoom_meeting" || w.venue === "zoom_webinar";
    if (w.status === "live" && !isZoom) {
      openRoomTab(`/host/${w.id}/room`);
      router.refresh();
      return;
    }
    const pendingTab = openPendingRoomTab();
    setBusy(w.id);
    try {
      const started = await api.startWebinar(w.id);
      pendingTab.open(started.zoomStartUrl || `/host/${w.id}/room`);
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

  async function remove(w: Webinar, scope?: "this" | "following") {
    if (bypass) {
      notify("Delete is mocked in local preview.", "info");
      setConfirmDelete(null);
      return;
    }
    setBusy(w.id);
    try {
      await api.deleteWebinar(w.id, w.seriesId ? scope ?? "this" : undefined);
      notify(
        scope === "following"
          ? "Deleted this session and the later ones that had not started."
          : `Deleted “${w.topic}”.`,
        "ok",
      );
      setConfirmDelete(null);
      router.refresh();
      location.reload();
    } catch (err) {
      notify(err instanceof Error ? err.message : "Could not delete that.", "error");
    } finally {
      setBusy(null);
    }
  }

  function card(w: Webinar) {
    return (w.status === "ended" || w.didntGoLive) && !readOnly ? (
      <CompletedCard key={w.id} webinar={w} />
    ) : (
      <HostCard
        key={w.id}
        webinar={w}
        readOnly={readOnly}
        busy={busy === w.id}
        now={now}
        onStart={() => void start(w)}
        onDelete={() => setConfirmDelete(w)}
      />
    );
  }

  return (
    <>
      <div className="grid gap-3">
        {groupHostRows(webinars).map((chunk) =>
          chunk.kind === "one" ? (
            card(chunk.webinar)
          ) : (
            <SeriesGroup
              key={`${chunk.id}-${chunk.webinars[0]?.id}`}
              webinars={chunk.webinars}
              card={card}
            />
          ),
        )}
      </div>

      <ConfirmModal
        open={confirmDelete !== null && !confirmDelete.seriesId}
        busy={busy !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void remove(confirmDelete)}
        title={confirmDelete ? deleteTitle(confirmDelete) : "Delete this webinar?"}
        body={confirmDelete ? deleteWarning(confirmDelete) : ""}
        confirmLabel="Delete this webinar"
      />

      <Modal
        open={confirmDelete?.seriesId != null}
        onClose={() => busy === null && setConfirmDelete(null)}
        title="Delete sessions in this series?"
        description="Past sessions, and any session that has gone live or has people in the room, stay."
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy !== null}
              onClick={() => setConfirmDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy !== null || confirmDelete === null}
              onClick={() => confirmDelete && void remove(confirmDelete, "this")}
            >
              This session only
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy !== null || confirmDelete === null}
              onClick={() => confirmDelete && void remove(confirmDelete, "following")}
            >
              This and following
            </Button>
          </div>
        }
      >
        <p className="text-[13.5px] leading-relaxed text-ink-2">
          {confirmDelete
            ? `“${confirmDelete.topic}” is one session in a series. Delete only that upcoming session, or that session and every later one that has not started.`
            : ""}
        </p>
      </Modal>
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
type HostChunk =
  | { kind: "one"; webinar: Webinar }
  | { kind: "series"; id: string; webinars: Webinar[] };

/** Consecutive sessions of the same series become one group, so a page of
 *  ten is not ten unrelated copies of the same title. */
function groupHostRows(webinars: Webinar[]): HostChunk[] {
  const out: HostChunk[] = [];
  for (const w of webinars) {
    const last = out[out.length - 1];
    if (w.seriesId && last?.kind === "series" && last.id === w.seriesId) {
      last.webinars.push(w);
      continue;
    }
    if (w.seriesId) out.push({ kind: "series", id: w.seriesId, webinars: [w] });
    else out.push({ kind: "one", webinar: w });
  }
  return out;
}

function SeriesGroup({
  webinars,
  card,
}: {
  webinars: Webinar[];
  card: (w: Webinar) => ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const head = webinars[0];
  const total = head?.series?.occurrenceCount ?? webinars.length;
  const shown =
    total > webinars.length
      ? `${webinars.length} of ${total} sessions on this page`
      : `${webinars.length} session${webinars.length === 1 ? "" : "s"}`;
  return (
    <div className="rounded-xl border border-line bg-surface">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Badge tone="brand">Series</Badge>
        <span className="text-[14px] font-semibold text-ink">{head?.topic}</span>
        <span className="text-[12.5px] text-ink-3">{head?.series?.summary}</span>
        <span className="ml-auto text-[12px] text-ink-3">
          {open ? "Hide" : "Show"} {shown}
        </span>
      </button>
      {open && (
        <div className="grid gap-3 border-t border-line p-3">
          {webinars.map((w) => card(w))}
        </div>
      )}
    </div>
  );
}

export function HostWebinarList({ webinars }: { webinars: Webinar[] }) {
  const rows = webinars.filter((w) => w.status !== "ended");

  if (rows.length === 0) return <Empty title="Nothing coming up" />;
  return <HostWebinarRows webinars={rows} readOnly />;
}

function HostCard({
  webinar: w,
  readOnly,
  busy,
  now,
  onStart,
  onDelete,
}: {
  webinar: Webinar;
  readOnly: boolean;
  busy: boolean;
  now: number | null;
  onStart: () => void;
  onDelete: () => void;
}) {
  const kind = kindLabel(w);
  const isDraft = w.status === "draft";
  const isEnded = w.status === "ended";
  const isLive = w.status === "live";
  const upcoming = !isDraft && !isEnded && !isLive;
  const whenLabel = upcoming
    ? formatRelative(w.startsAt, new Date()).replace(/^./, (c) => c.toUpperCase())
    : null;
  const emailOn = w.options?.emailReminders;
  const whatsAppOn = w.options?.whatsappReminders;
  const reminders =
    emailOn && whatsAppOn
      ? "reminders on (email + WhatsApp)"
      : emailOn
        ? "reminders on"
        : whatsAppOn
          ? "reminders on (WhatsApp)"
          : null;
  const needsAdmit = w.approval === "manual" && !isEnded && !isDraft;
  const bypass = isDevAuthBypassActive();
  const origin = useShareOrigin();
  const { notify } = useToast();
  const router = useRouter();
  const waitReasonId = useId();
  const roomHref = bypass ? "/preview/room" : `/host/${w.id}/room`;
  const registerUrl = `${origin}/webinars/${w.id}`;
  /* Upcoming (including a live session) opens the schedule. A draft opens setup,
   * the same place as Finish setup. Panelist rows stay a title link only. */
  const rowHref = readOnly
    ? `/webinars/${w.id}`
    : isDraft
      ? `/host/${w.id}/edit`
      : `/host/${w.id}`;
  const scheduled = !isDraft && !isEnded && !isLive;
  const liveOpen = isLive || (scheduled && canGoLive(w.startsAt, now, w.durationMin));
  const showWait = !readOnly && scheduled && now != null && !canGoLive(w.startsAt, now, w.durationMin);
  const waitReason = goLiveWaitReason(w.startsAt, w.timeZone);

  return (
    /* The action column is z-10 so its buttons sit above the stretched link.
     * That z-10 is its own stacking context, so the menu's z-50 cannot climb
     * out of it: the next card's action column is also z-10 and later in the
     * tree, and paints over this open menu (and the same would happen over
     * the pager and the follow-up banner if those ever stacked too). While
     * the menu is open, lift the whole card above those siblings. */
    <Card
      className={
        readOnly
          ? "p-4 sm:p-5"
          : "group relative cursor-pointer p-4 transition-colors hover:border-line-2 hover:bg-surface-2/40 sm:p-5 [&:has([aria-expanded=true])]:z-20"
      }
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {whenLabel ? (
              <Badge tone="brand" dot>
                {whenLabel}
              </Badge>
            ) : (
              <Badge tone={kind.tone} dot={isLive}>
                {kind.text}
              </Badge>
            )}
            {upcoming && (
              <span className="text-[12px] text-ink-3">
                {formatDayShort(w.startsAt, w.timeZone)} ·{" "}
                {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
                {tzLabel(w.startsAt, w.timeZone)} · {formatDuration(w.durationMin)}
              </span>
            )}
            {needsAdmit && <Badge tone="warn">Admit required</Badge>}
            {w.priceUsd ? <Badge tone="brand">${w.priceUsd}</Badge> : null}
          </div>

          {w.series && (
            <p className="mb-1 text-[12px] text-ink-3">
              {w.occurrenceIndex ? `Session ${w.occurrenceIndex}` : "Session"}
              {w.series.occurrenceCount ? ` of ${w.series.occurrenceCount}` : ""}
              {w.seriesException ? " · changed on its own" : ""}
            </p>
          )}

          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">
            {/* Stretched over the card so anywhere on it opens the row. Buttons
                sit above it (z-10) and keep their own clicks. */}
            <Link
              href={rowHref}
              data-tour="webinar-title"
              className={
                readOnly
                  ? "hover:text-brand"
                  : "outline-none after:absolute after:inset-0 after:rounded-xl after:content-[''] group-hover:text-brand focus-visible:after:ring-2 focus-visible:after:ring-brand/40"
              }
            >
              {w.topic}
            </Link>
          </h3>

          {!upcoming && (
            <p className="mt-1.5 text-[13px] text-ink-2">
              {formatDayShort(w.startsAt, w.timeZone)} ·{" "}
              {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
              {tzLabel(w.startsAt, w.timeZone)} · {formatDuration(w.durationMin)}
            </p>
          )}

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
                {reminders ? ` · ${reminders}` : ""}
              </>
            )}
          </p>
        </div>

        {/* Primary actions — Go live / Share. Manage is the row itself. */}
        <div
          className={`flex shrink-0 flex-col items-end gap-1.5 ${
            readOnly ? "" : "pointer-events-none relative z-10"
          }`}
        >
          <div className="flex flex-wrap items-center justify-end gap-2">
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
            <ButtonLink href={`/host/${w.id}/edit`} size="sm" className="pointer-events-auto">
              Finish setup
            </ButtonLink>
          ) : (
            <>
              <Button
                variant="secondary"
                size="sm"
                className="pointer-events-auto"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(registerUrl)
                    .then(() => notify("Link copied — share it anywhere.", "ok"))
                    .catch(() => void shareAttendeeLink({ url: registerUrl, topic: w.topic, notify }))
                }
              >
                Copy link
              </Button>
              {scheduled && (
                <Button
                  size="sm"
                  className="pointer-events-auto"
                  onClick={onStart}
                  disabled={busy || !liveOpen}
                  aria-describedby={showWait ? waitReasonId : undefined}
                >
                  {busy ? "Starting…" : "Go live"}
                </Button>
              )}
              {isLive && (
                <ButtonLink
                  href={roomHref}
                  size="sm"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pointer-events-auto"
                >
                  Rejoin
                </ButtonLink>
              )}
            </>
          )}
          {!readOnly && (
            <div className="pointer-events-auto">
              <Menu
                label={`More for ${w.topic}`}
                trigger={
                  <span className="grid size-8 place-items-center rounded-lg text-[17px] text-ink-2 hover:bg-surface-2">
                    ⋯
                  </span>
                }
                items={[
                  ...(!isDraft
                    ? [
                        ...(isLive
                          ? [{ kind: "action" as const, label: "Manage", onSelect: () => router.push(`/host/${w.id}`) }]
                          : []),
                        ...(needsAdmit
                          ? [{ kind: "action" as const, label: "Admit people", onSelect: () => router.push(`/host/${w.id}?tab=people`) }]
                          : []),
                        { kind: "action" as const, label: "Edit", onSelect: () => router.push(`/host/${w.id}/edit`) },
                        { kind: "separator" as const },
                      ]
                    : []),
                  { kind: "action" as const, label: "Delete", danger: true, onSelect: onDelete },
                ]}
              />
            </div>
          )}
          </div>
          {showWait && (
            <p id={waitReasonId} className="max-w-56 text-right text-[11.5px] leading-snug text-ink-3">
              {waitReason}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

/* A session that is over, as a coach or teacher looks for it afterwards.
 *
 * It used to offer "View attendance" and "Manage" side by side, and both went to the
 * same page — one to its Attendees tab, the other to Engagement — so the choice asked
 * a host to know the page's tabs before seeing it. Now the card answers the first
 * question itself (did people come, and did they stay?) and has one way in: the card,
 * or See results. Attendees, recording, survey and Delete are all on that page, so the
 * list does not repeat them. */
function CompletedCard({ webinar: w }: { webinar: Webinar }) {
  const href = `/host/${w.id}`;
  const r = w.report;
  const registered = w.registrantCount;
  // Walk-ins on an open link can outnumber registrations; a turnout over 100% reads as a bug.
  const turnout =
    r && registered > 0 ? Math.min(100, Math.round((r.attended / registered) * 100)) : null;

  return (
    <WebinarListCard
      href={href}
      title={w.topic}
      titleDataTour
      badge={
        w.didntGoLive ? <Badge tone="neutral">Didn&apos;t go live</Badge> : undefined
      }
      when={`${formatDayShort(w.startsAt, w.timeZone)} · ${formatTimeRange(w.startsAt, w.durationMin, w.timeZone)} ${tzLabel(w.startsAt, w.timeZone)}${w.series ? ` · Session ${w.occurrenceIndex || ""} of a series` : ""}`}
      meta={
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <Figure
            label="Attended"
            value={r ? formatCount(r.attended) : "—"}
            note={`of ${formatCount(registered)} registered`}
          />
          {turnout !== null && (
            <Figure
              label="Turnout"
              value={`${turnout}%`}
              tone={turnout >= 50 ? "ok" : turnout >= 25 ? "neutral" : "warn"}
            />
          )}
          {r && r.attended > 0 && (
            <Figure
              label="Avg. time watched"
              value={formatDuration(r.avgWatchMin)}
              note={`of ${formatDuration(w.durationMin)}`}
            />
          )}
          {r && r.questions > 0 && (
            <Figure label="Questions" value={formatCount(r.questions)} />
          )}
        </dl>
      }
      action={
        <ButtonLink href={href} size="sm">
          See results
        </ButtonLink>
      }
    />
  );
}

function Figure({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: string;
  note?: string;
  tone?: "neutral" | "ok" | "warn";
}) {
  const valueTone = { neutral: "text-ink", ok: "text-ok", warn: "text-warn" }[tone];
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1.5">
        <span className={`text-[16px] font-semibold tracking-[-0.01em] tabular-nums ${valueTone}`}>
          {value}
        </span>
        {note && <span className="text-[12px] text-ink-3">{note}</span>}
      </dd>
    </div>
  );
}
