"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { HostWebinarTabs } from "./host-webinar-tabs";
import { ConfirmModal, Menu, Spinner } from "./controls";
import { StepBar } from "./webinar-steps";
import { ArrowLeftIcon } from "./icons";
import { useShareOrigin, useToast } from "./providers";
import { Badge, Button, ButtonLink, Card, kindLabel } from "./ui";
import { ApiError, api } from "@/lib/api";
import {
  formatDay,
  formatDuration,
  formatTimeRange,
  tzLabel,
} from "@/lib/format";
import type { Recording, RegistrantRow, Webinar } from "@/lib/api-types";
import type { RosterCounts } from "./host-webinar-tabs";
import { bypassWebinar, DEV_BYPASS_REGISTRANTS } from "@/lib/dev-bypass";
import {
  isDevAuthBypassActive,
  useDevAuthBypassActive,
} from "@/lib/dev-bypass-session";
import { canGoLive, goLiveWaitReason } from "@/lib/go-live";
import { useNow } from "@/lib/clock";
import { openPendingRoomTab, openRoomTab } from "@/lib/open-room";
import { shareAttendeeLink } from "@/lib/share-attendee-link";
import { deleteTitle, deleteWarning } from "@/lib/webinar-delete";
import { beginWebinarWhatsAppMetrics } from "@/engage";

const NONE: RegistrantRow[] = [];
const NO_RECORDINGS: Recording[] = [];

function countsOf(rows: RegistrantRow[]): RosterCounts {
  return {
    total: rows.length,
    approved: rows.filter((r) => r.state === "approved").length,
    declined: rows.filter((r) => r.state === "declined").length,
    pending: rows.filter((r) => r.state === "pending").length,
    guests: rows.filter((r) => r.isGuest).length,
  };
}

/** Manage one webinar: Host it, admit people, see who registered / attended. */
export function HostWebinarScreen({ slug }: { slug: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const { notify } = useToast();
  const origin = useShareOrigin();
  const bypass = isDevAuthBypassActive();

  const [fetchedWebinar, setWebinar] = useState<Webinar | null>(null);
  const [fetchedCounts, setCounts] = useState<RosterCounts | null>(null);
  const [fetchedPending, setPendingRows] = useState<RegistrantRow[]>([]);
  const [rosterToken, setRosterToken] = useState(0);
  const [fetchedRecordings, setRecordings] = useState<Recording[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [fetchError, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const now = useNow(15_000);
  const waitReasonId = useId();

  // Local preview reads fixtures, derived here rather than copied into state by
  // the load effect. The hook is false on the server and while hydrating, the
  // same moment that effect first ran, so the first paint still matches.
  const showPreview = useDevAuthBypassActive();
  const preview = showPreview ? bypassWebinar(slug) : undefined;
  const webinar = showPreview ? (preview ?? null) : fetchedWebinar;
  const previewRows =
    showPreview && preview && preview.status !== "draft"
      ? DEV_BYPASS_REGISTRANTS
      : NONE;
  const counts: RosterCounts | null = showPreview
    ? countsOf(previewRows)
    : fetchedCounts;
  const pending = showPreview
    ? previewRows.filter((r) => r.state === "pending")
    : fetchedPending;
  const recordings = showPreview ? NO_RECORDINGS : fetchedRecordings;
  const error = showPreview
    ? preview
      ? null
      : "Unknown preview webinar."
    : fetchError;

  const load = useCallback(() => {
    if (bypass) return Promise.resolve();

    beginWebinarWhatsAppMetrics(slug);
    return Promise.all([
      api.hostWebinar(slug),
      api.recordings(slug).catch(() => [] as Recording[]),
      // Counts only need the slug in the address. They ride with the webinar
      // read; a draft has no roster, so that answer is dropped below.
      api.hostRegistrants(slug, { limit: 1 }).catch(() => null),
    ])
      .then(([w, recs, roster]) => {
        setWebinar(w);
        setRecordings(recs);
        setError(null);
        setRosterToken((n) => n + 1);
        if (w.status === "draft" || !roster) {
          setCounts(null);
          setPendingRows([]);
          if (w.status === "draft") return;
        } else {
          setCounts({
            total: roster.total,
            approved: roster.approved,
            declined: roster.declined,
            pending: roster.pending,
            guests: roster.guests,
          });
        }
        if (w.approval === "manual") {
          void api
            .pendingApprovals(slug)
            .then(setPendingRows)
            .catch(() => setPendingRows([]));
        } else {
          setPendingRows([]);
        }
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setNeedsLogin(true);
        else if (e instanceof ApiError && e.code === "not_a_host")
          setNeedsLogin(true);
        else
          setError(
            e instanceof Error ? e.message : "Could not load this webinar.",
          );
      });
  }, [slug, bypass]);

  useEffect(() => {
    void load();
  }, [load]);

  async function start() {
    if (bypass) {
      openRoomTab("/preview/room");
      return;
    }
    /* Opened NOW, synchronously, before the await below. Opening it afterwards
     * is what made "Host webinar" intermittently do nothing but refresh into a
     * "Rejoin room" button: by then the click no longer counts as the gesture
     * that opened the tab, and the popup blocker drops it without an error for
     * this code to catch. See openPendingRoomTab. */
    const pendingTab = openPendingRoomTab();
    setBusy(true);
    try {
      await api.startWebinar(slug);
      pendingTab.open(`/host/${slug}/room`);
      await load();
    } catch (e) {
      pendingTab.cancel();
      notify(
        e instanceof Error ? e.message : "Could not start the webinar.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function end() {
    if (bypass) {
      notify("End is mocked in local preview.", "info");
      setConfirmEnd(false);
      return;
    }
    setBusy(true);
    try {
      await api.endWebinar(slug);
      notify("Webinar ended.", "ok");
      setConfirmEnd(false);
      await load();
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "Could not end the webinar.",
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (bypass) {
      notify("Delete is mocked in local preview.", "info");
      setConfirmDelete(false);
      router.push("/host");
      return;
    }
    setBusy(true);
    try {
      await api.deleteWebinar(slug);
      notify(
        "Webinar deleted, along with its registrations, chat and recordings.",
        "ok",
      );
      router.push("/host");
    } catch (e) {
      notify(
        e instanceof Error ? e.message : "Could not delete the webinar.",
        "error",
      );
      setConfirmDelete(false);
      setBusy(false);
    }
  }

  if (needsLogin) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">
          Sign in to manage this webinar
        </h1>
        <ButtonLink href={`/login?next=/host/${slug}`} className="mt-5">
          Sign in
        </ButtonLink>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[17px] font-semibold">Couldn&apos;t load that</h1>
        <p className="mt-2 text-[13.5px] text-ink-2">{error}</p>
        <ButtonLink href="/host" variant="secondary" className="mt-5">
          Back to Hosting
        </ButtonLink>
      </Card>
    );
  }

  if (!webinar) {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  const kind = kindLabel(webinar);
  const isLive = webinar.status === "live";
  const isEnded = webinar.status === "ended";
  const isDraft = webinar.status === "draft";
  const waiting = pending.length;
  const initialTab = search.get("tab");

  return (
    <>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        <ArrowLeftIcon className="size-3.5" />
        Your webinars
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={kind.tone} dot={isLive}>
              {kind.text}
            </Badge>
            {webinar.approval === "manual" && !isEnded && (
              <Badge tone="warn">
                {waiting > 0 ? `${waiting} waiting to admit` : "Manual admit"}
              </Badge>
            )}
          </div>
          <h1 className="text-[20px] leading-snug font-semibold tracking-[-0.02em] sm:text-[22px]">
            {webinar.topic}
          </h1>
          <p className="mt-2 text-[13px] text-ink-2">
            {formatDay(webinar.startsAt, webinar.timeZone)} ·{" "}
            {formatTimeRange(
              webinar.startsAt,
              webinar.durationMin,
              webinar.timeZone,
            )}{" "}
            {tzLabel(webinar.startsAt, webinar.timeZone)} ·{" "}
            {formatDuration(webinar.durationMin)}
          </p>
          <p className="mt-1 text-[12px] text-ink-3">
            ID <span className="tabular-nums">{webinar.webinarId}</span>
            {webinar.passcode && <> · Passcode {webinar.passcode}</>}
            {!isDraft && (
              <>
                {" "}
                · {webinar.registrantCount} registered
                {isEnded && webinar.report
                  ? ` · ${webinar.report.attended} attended`
                  : ""}
              </>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Menu
            label="More actions"
            trigger={
              <span className="grid size-9 place-items-center rounded-lg text-[18px] text-ink-2 hover:bg-surface-2">
                ⋯
              </span>
            }
            items={[
              ...(!isDraft && !isEnded
                ? [
                    {
                      kind: "action" as const,
                      label: "Edit webinar",
                      onSelect: () => router.push(`/host/${slug}/edit`),
                    },
                    {
                      kind: "action" as const,
                      label: "Share link",
                      onSelect: () =>
                        void shareAttendeeLink({
                          url: `${origin}/webinars/${slug}`,
                          topic: webinar.topic,
                          notify,
                        }),
                    },
                  ]
                : []),
              ...(isLive
                ? [
                    {
                      kind: "action" as const,
                      label: "End for everyone",
                      danger: true,
                      onSelect: () => setConfirmEnd(true),
                    },
                  ]
                : []),
              { kind: "separator" as const },
              {
                kind: "action" as const,
                label: "Delete webinar",
                danger: true,
                onSelect: () => setConfirmDelete(true),
              },
            ]}
          />
          {isDraft ? (
            <ButtonLink href={`/host/${slug}/edit`}>Finish setup</ButtonLink>
          ) : isEnded ? null : isLive ? (
            <ButtonLink
              href={bypass ? "/preview/room" : `/host/${slug}/room`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Rejoin room
            </ButtonLink>
          ) : (
            <GoLiveButton
              busy={busy}
              open={canGoLive(webinar.startsAt, now)}
              reason={goLiveWaitReason(webinar.startsAt, webinar.timeZone)}
              reasonId={waitReasonId}
              showReason={now != null && !canGoLive(webinar.startsAt, now)}
              onStart={() => void start()}
            />
          )}
        </div>
      </div>

      <StepBar webinar={webinar} registrants={webinar.registrantCount} />

      <HostWebinarTabs
        webinar={webinar}
        counts={counts}
        pending={pending}
        rosterToken={rosterToken}
        recordings={recordings}
        onChanged={load}
        initialTab={initialTab}
      />

      <ConfirmModal
        open={confirmEnd}
        busy={busy}
        onClose={() => setConfirmEnd(false)}
        onConfirm={() => void end()}
        title="End this webinar for everyone?"
        body="Everyone is disconnected and the webinar is marked as ended. Registrations are kept as the attendance record, but nobody can rejoin."
        confirmLabel="End for everyone"
      />

      <ConfirmModal
        open={confirmDelete}
        busy={busy}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
        title={deleteTitle(webinar)}
        body={deleteWarning(webinar)}
        confirmLabel="Delete this webinar"
      />
    </>
  );
}

function GoLiveButton({
  busy,
  open,
  reason,
  reasonId,
  showReason,
  onStart,
}: {
  busy: boolean;
  open: boolean;
  reason: string;
  reasonId: string;
  showReason: boolean;
  onStart: () => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        onClick={onStart}
        disabled={busy || !open}
        aria-describedby={showReason ? reasonId : undefined}
      >
        {busy && <Spinner className="size-4" />}▶ Go live
      </Button>
      {showReason && (
        <p id={reasonId} className="max-w-56 text-right text-[12px] leading-snug text-ink-3">
          {reason}
        </p>
      )}
    </div>
  );
}
