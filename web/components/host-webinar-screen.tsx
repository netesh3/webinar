"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { HostWebinarTabs } from "./host-webinar-tabs";
import { Alert, ConfirmModal, Spinner } from "./controls";
import { ArrowLeftIcon } from "./icons";
import { useToast } from "./providers";
import { Badge, Button, ButtonLink, Card, kindLabel } from "./ui";
import { ApiError, api } from "@/lib/api";
import { formatDay, formatDuration, formatTimeRange, tzLabel } from "@/lib/format";
import type { Recording, RegistrantRow, Webinar } from "@/lib/api-types";
import { deleteTitle, deleteWarning } from "@/lib/webinar-delete";

/** Manage one webinar: its registrants, its share links, and the start/end
 *  controls. The room itself lives at /host/[id]/room. */
export function HostWebinarScreen({ slug }: { slug: string }) {
  const router = useRouter();
  const { notify } = useToast();

  const [webinar, setWebinar] = useState<Webinar | null>(null);
  const [registrants, setRegistrants] = useState<RegistrantRow[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Promise callbacks rather than an awaited call: every setState lands in a
  // .then/.catch, so nothing runs synchronously inside the effect body.
  const load = useCallback(
    () =>
      // Recordings are loaded here rather than inside their own tab, so the tab
      // can carry a count: a tab that looks identical whether or not there is a
      // recording behind it is a recording nobody finds. Its failure is tolerated
      // — recording can be switched off for an instance, and that must not blank
      // the page the host came for.
      Promise.all([
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
        }),
    [slug],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function start() {
    setBusy(true);
    try {
      await api.startWebinar(slug);
      router.push(`/host/${slug}/room`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not start the webinar.", "error");
      setBusy(false);
    }
  }

  async function end() {
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

  /* Delete, then leave — in that order, and without reloading this page.
   *
   * `load()` on a webinar that no longer exists would set the error state and leave the host
   * looking at "Couldn't load that" as the result of a successful action. The list is where
   * they came from and where the outcome is visible, so the navigation IS the confirmation.
   */
  async function remove() {
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
          Back to webinars
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

  return (
    <>
      <Link
        href="/host"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-brand"
      >
        <ArrowLeftIcon className="size-3.5" />
        Webinars
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Badge tone={kind.tone} dot={isLive}>
              {kind.text}
            </Badge>
            {webinar.track && <Badge>{webinar.track}</Badge>}
            {webinar.approval === "manual" && <Badge tone="warn">Manual approval</Badge>}
            {webinar.controls.hideAttendees && <Badge>Audience private</Badge>}
            {webinar.controls.locked && <Badge tone="warn">Locked</Badge>}
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
            Webinar ID <span className="tabular-nums">{webinar.webinarId}</span>
            {webinar.passcode && <> · Passcode {webinar.passcode}</>}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {isDraft ? (
            <ButtonLink href={`/host/${slug}/edit`}>Finish setup</ButtonLink>
          ) : isEnded ? (
            <ButtonLink href={`/host/${slug}/edit`} variant="secondary">
              Edit and reschedule
            </ButtonLink>
          ) : (
            <>
              <Button onClick={() => void start()} disabled={busy}>
                {busy && <Spinner className="size-4" />}
                {isLive ? "Rejoin the room" : "Start webinar"}
              </Button>
              {isLive && (
                <Button variant="danger" onClick={() => setConfirmEnd(true)} disabled={busy}>
                  End for everyone
                </Button>
              )}
              <ButtonLink href={`/host/${slug}/edit`} variant="secondary">
                Edit
              </ButtonLink>
            </>
          )}
          {/* Delete, on every status. Ghost rather than danger: it sits next to the primary
              action a host actually came here for, and a red button beside "Start webinar" is
              a mis-click waiting to happen. The dialog carries the weight instead, and it
              names what goes — see lib/webinar-delete.ts. */}
          <Button variant="ghost" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete
          </Button>
        </div>
      </div>

      {isDraft && (
        <div className="mb-4">
          <Alert tone="warn" title="This is a draft">
            It has no public registration page yet. Finish setup and save it as
            scheduled to open registration.
          </Alert>
        </div>
      )}

      <HostWebinarTabs
        webinar={webinar}
        registrants={registrants}
        recordings={recordings}
        onChanged={load}
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
        confirmLabel="Delete everything"
      />
    </>
  );
}
