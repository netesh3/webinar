"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { HostWebinarTabs } from "./host-webinar-tabs";
import { Alert, ConfirmModal, Spinner } from "./controls";
import { ArrowLeftIcon } from "./icons";
import { useShareOrigin, useToast } from "./providers";
import { Badge, Button, ButtonLink, Card, kindLabel } from "./ui";
import { ApiError, api } from "@/lib/api";
import { formatDay, formatDuration, formatTimeRange, tzLabel } from "@/lib/format";
import type { Recording, RegistrantRow, Webinar } from "@/lib/api-types";
import {
  bypassWebinar,
  DEV_BYPASS_REGISTRANTS,
} from "@/lib/dev-bypass";
import { isDevAuthBypassActive, useDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { openPendingRoomTab, openRoomTab } from "@/lib/open-room";
import { shareAttendeeLink } from "@/lib/share-attendee-link";
import { deleteTitle, deleteWarning } from "@/lib/webinar-delete";

const NONE: RegistrantRow[] = [];
const NO_RECORDINGS: Recording[] = [];

/** Manage one webinar: Host it, admit people, see who registered / attended. */
export function HostWebinarScreen({ slug }: { slug: string }) {
  const router = useRouter();
  const search = useSearchParams();
  const { notify } = useToast();
  const origin = useShareOrigin();
  const bypass = isDevAuthBypassActive();

  const [fetchedWebinar, setWebinar] = useState<Webinar | null>(null);
  const [fetchedRegistrants, setRegistrants] = useState<RegistrantRow[]>([]);
  const [fetchedRecordings, setRecordings] = useState<Recording[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [fetchError, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Local preview reads fixtures, derived here rather than copied into state by
  // the load effect. The hook is false on the server and while hydrating, the
  // same moment that effect first ran, so the first paint still matches.
  const showPreview = useDevAuthBypassActive();
  const preview = showPreview ? bypassWebinar(slug) : undefined;
  const webinar = showPreview ? (preview ?? null) : fetchedWebinar;
  const registrants = showPreview
    ? preview && preview.status !== "draft"
      ? DEV_BYPASS_REGISTRANTS
      : NONE
    : fetchedRegistrants;
  const recordings = showPreview ? NO_RECORDINGS : fetchedRecordings;
  const error = showPreview
    ? preview
      ? null
      : "Unknown preview webinar."
    : fetchError;

  const load = useCallback(() => {
    if (bypass) return Promise.resolve();

    return Promise.all([
      api.hostWebinar(slug),
      api.hostRegistrants(slug),
      api.recordings(slug).catch(() => [] as Recording[]),
    ])
      .then(([w, rows, recs]) => {
        setWebinar(w);
        setRegistrants(rows);
        setRecordings(recs);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setNeedsLogin(true);
        else if (e instanceof ApiError && e.code === "not_a_host") setNeedsLogin(true);
        else setError(e instanceof Error ? e.message : "Could not load this webinar.");
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
      notify(e instanceof Error ? e.message : "Could not start the webinar.", "error");
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
      notify(e instanceof Error ? e.message : "Could not end the webinar.", "error");
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
      notify("Webinar deleted, along with its registrations, chat and recordings.", "ok");
      router.push("/host");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not delete the webinar.", "error");
      setConfirmDelete(false);
      setBusy(false);
    }
  }

  if (needsLogin) {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">Sign in to manage this webinar</h1>
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
  const pending = registrants.filter((r) => r.state === "pending").length;
  const initialTab = search.get("tab");

  return (
    <>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        <ArrowLeftIcon className="size-3.5" />
        Hosting
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={kind.tone} dot={isLive}>
              {kind.text}
            </Badge>
            {webinar.approval === "manual" && !isEnded && (
              <Badge tone="warn">
                {pending > 0 ? `${pending} waiting to admit` : "Manual admit"}
              </Badge>
            )}
          </div>
          <h1 className="text-[20px] leading-snug font-semibold tracking-[-0.02em] sm:text-[22px]">
            {webinar.topic}
          </h1>
          <p className="mt-2 text-[13px] text-ink-2">
            {formatDay(webinar.startsAt, webinar.timeZone)} ·{" "}
            {formatTimeRange(webinar.startsAt, webinar.durationMin, webinar.timeZone)}{" "}
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

        <div className="flex shrink-0 flex-wrap gap-2">
          {isDraft ? (
            <ButtonLink href={`/host/${slug}/edit`}>Finish setup</ButtonLink>
          ) : isEnded ? (
            <ButtonLink
              href={`/host/${slug}?tab=${recordings.length > 0 ? "recordings" : "attendees"}`}
            >
              {recordings.length > 0 ? "Watch the recording" : "View attendance"}
            </ButtonLink>
          ) : (
            <>
              {isLive ? (
                <ButtonLink
                  href={bypass ? "/preview/room" : `/host/${slug}/room`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Rejoin room
                </ButtonLink>
              ) : (
                <Button onClick={() => void start()} disabled={busy}>
                  {busy && <Spinner className="size-4" />}
                  Host webinar
                </Button>
              )}
              {pending > 0 && (
                <ButtonLink href={`/host/${slug}?tab=admit`} variant="secondary">
                  Admit ({pending})
                </ButtonLink>
              )}
              {isLive && (
                <Button variant="danger" onClick={() => setConfirmEnd(true)} disabled={busy}>
                  End for everyone
                </Button>
              )}
            </>
          )}
          {/* The registration link only means something while somebody can still
              join. After the webinar it leads to a page that cannot be attended;
              sharing the recording is a different link, offered on its own row. */}
          {!isDraft && !isEnded && (
            <Button
              variant="secondary"
              onClick={() =>
                void shareAttendeeLink({
                  url: `${origin}/webinars/${slug}`,
                  topic: webinar.topic,
                  notify,
                })
              }
            >
              Share
            </Button>
          )}
          {!isDraft && !isEnded && (
            <ButtonLink href={`/host/${slug}/edit`} variant="ghost">
              Edit
            </ButtonLink>
          )}
          <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete
          </Button>
        </div>
      </div>

      {isDraft && (
        <div className="mb-4">
          <Alert tone="warn" title="This is a draft">
            Finish setup and save as scheduled to open registration.
          </Alert>
        </div>
      )}

      <HostWebinarTabs
        webinar={webinar}
        registrants={registrants}
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
