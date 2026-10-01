"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HostWebinarBrowser } from "./host-webinar-browser";
import { HostWebinarList } from "./host-webinar-list";
import { Alert, Spinner } from "./controls";
import { CalendarIcon, ChevronRightIcon, PlayIcon } from "./icons";
import { DEFAULT_ATTENDEE_LIMIT, SCHEDULE_LEAD_ERROR } from "./schedule/form-state";
import {
  useAppConfig,
  useSession,
  useShareOrigin,
  useToast,
} from "./providers";
import { ButtonLink, Card } from "./ui";
import { ApiError, api, type HostWebinarTab } from "@/lib/api";
import { dropCache } from "@/lib/http";
import { FOLLOW_UP_FETCH_LIMIT, followUpListCacheKey } from "@/lib/follow-up-nudge";
import {
  HOST_LIST_PREFIX,
  HOST_WEBINAR_PAGE_SIZE,
  hostListFilterKey,
  hostListPageKey,
} from "@/lib/host-list-cache";
import {
  FeatureInstantWebinar,
  type Webinar,
  type WebinarInput,
} from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { localTimeZone } from "@/lib/format";
import { openPendingRoomTab, openRoomTab } from "@/lib/open-room";

/* An instant webinar is the same request a normal Create submits, just with
 * the form skipped: a topic that says what it is, starting now, and every
 * other field set to the same defaults the schedule form's blank form would
 * have sent. It is not a different kind of webinar — a host can rename it or
 * change its settings afterwards exactly like any other. */
function instantWebinarInput(maxAttendees: number): WebinarInput {
  return {
    topic: "Instant webinar",
    summary: "",
    description: "",
    track: "",
    /* The server stamps an instant create to its own clock and skips the
     * schedule form's hour lead. This value is only here because the field
     * is required on the type; it is not a time the host picked. */
    startsAt: new Date().toISOString(),
    durationMin: 60,
    timeZone: localTimeZone(),
    kind: "live",
    status: "scheduled",
    instant: true,
    registrationRequired: true,
    approval: "automatic",
    attendeeLimit:
      maxAttendees > 0
        ? Math.min(DEFAULT_ATTENDEE_LIMIT, maxAttendees)
        : DEFAULT_ATTENDEE_LIMIT,
    passcode: "",
    agenda: [],
    takeaways: [],
    customQuestions: [],
    panelistEmails: [],
    options: {
      practiceSession: true,
      autoRecord: false,
      qAndA: true,
      attendeeChat: true,
      raiseHand: true,
      captions: false,
      multistream: false,
      postWebinarSurvey: false,
      emailReminders: true,
      // Off: it spends the host's own WhatsApp balance. See WebinarOptions.
      whatsappReminders: false,
      reminders: [1440, 60],
    },
    controls: {
      hideAttendees: true,
      muteOnEntry: true,
      allowUnmute: true,
      chatEnabled: true,
      chatDestination: "everyone",
      pollsEnabled: true,
      qaEnabled: true,
      raiseHandEnabled: true,
      reactionsEnabled: true,
      captionsEnabled: false,
      locked: false,
    },
  };
}

/* The hour-ahead sentence is a schedule-form field error. This button has no
 * time to change, so that text is never what a failed instant start says. */
function instantStartError(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return err instanceof Error && err.message
      ? err.message
      : "Could not start the webinar.";
  }
  const fields = { ...(err.fields ?? {}) };
  if (fields.startsAt === SCHEDULE_LEAD_ERROR) delete fields.startsAt;
  const fieldMsg = Object.values(fields).find((message) => message);
  return fieldMsg || err.message || "Could not start the webinar.";
}

const actionCardClass =
  "group flex w-full items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3.5 text-left " +
  "shadow-[0_1px_2px_rgba(19,22,25,0.04)] transition-[border-color,box-shadow] " +
  "hover:border-line-2 hover:shadow-[0_2px_8px_rgba(19,22,25,0.08)] " +
  "outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-1 " +
  "disabled:cursor-progress disabled:opacity-70";

function ActionCardBody({
  icon,
  title,
  subtitle,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-ink">{title}</span>
        <span className="mt-0.5 block text-[12.5px] text-ink-2">{subtitle}</span>
      </span>
      <ChevronRightIcon className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
    </>
  );
}

/** Host Webinar home: create, run upcoming sessions, review past attendance.
 *
 *  No top nav entry of its own any more — the logo is this page for a host,
 *  see homeHrefFor in top-nav.tsx. The page opens on two action cards, Instant
 *  webinar (go live now, no form) and Schedule a webinar (/host/new). */
/** The list tab this visit will paint, when the address names one. Anything else
 *  (an old Audience or Messages link, Attending) still opens on Upcoming until
 *  that link is redirected. */
function listTabFromQuery(raw: string): HostWebinarTab {
  if (raw === "past" || raw === "drafts" || raw === "upcoming") return raw;
  return "upcoming";
}

export function HostWebinarsScreen() {
  const { account, status } = useSession();
  const { maxAttendees } = useAppConfig();
  const { notify } = useToast();
  const origin = useShareOrigin();
  const search = useSearchParams();
  const listTab = listTabFromQuery(search.get("tab") ?? "");
  const [onStage, setOnStage] = useState<Webinar[]>([]);
  const [startingInstant, setStartingInstant] = useState(false);
  /* The host's own list is paged server-side, so this screen no longer holds
   * it: HostWebinarBrowser fetches it. Bumping reloadToken is how a webinar
   * created here gets into a list this component cannot reach into. */
  const [reloadToken, setReloadToken] = useState(0);
  const bypass = isDevAuthBypassActive();

  const canHost = account?.canHost ?? false;
  const instantAllowed = (account?.features ?? []).includes(
    FeatureInstantWebinar,
  );
  /* Read during the prefetch's callback. The prefetch itself must not restart when
   * the session resolves, or it would drop the list it just fetched. */
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  /* The login check (GET /api/auth/me) is already in flight from the app shell.
   * These start with it, not after it. The screen below still waits for the
   * session before it draws anything: a 401 throws the list away, and a signed-in
   * host finds the page already in memory. */
  useEffect(() => {
    if (bypass) return;
    let live = true;
    const key = hostListPageKey(hostListFilterKey(listTab, "", "", ""), 0);
    api
      .hostWebinars({ tab: listTab, limit: HOST_WEBINAR_PAGE_SIZE })
      .then(() => {
        if (statusRef.current === "anonymous") dropCache(key);
      })
      .catch(() => {
        dropCache(key);
      });
    api
      .stageWebinars()
      .then((rows) => {
        if (!live || statusRef.current === "anonymous") return;
        setOnStage(rows);
      })
      .catch(() => {
        if (live && statusRef.current !== "anonymous") setOnStage([]);
      });
    api.myRegistrations().catch(() => {
      dropCache("/api/me/registrations");
    });
    /* The follow-up column asks for the three most recent past rows. It only
     * mounts once the session is allowed to draw, so start it here or those
     * cards wait again. */
    const pastKey = followUpListCacheKey(HOST_LIST_PREFIX);
    api
      .hostWebinars({ tab: "past", limit: FOLLOW_UP_FETCH_LIMIT })
      .then(() => {
        if (statusRef.current === "anonymous") dropCache(pastKey);
      })
      .catch(() => {
        dropCache(pastKey);
      });
    return () => {
      live = false;
    };
  }, [bypass, listTab]);

  useEffect(() => {
    if (status !== "anonymous") return;
    dropCache(hostListPageKey(hostListFilterKey(listTab, "", "", ""), 0));
    dropCache(followUpListCacheKey(HOST_LIST_PREFIX));
    dropCache("/api/me/registrations");
    /* After the effect, so this is not a setState in the effect body. The
     * signed-out screen does not render these rows either way. */
    const clear = () => setOnStage([]);
    queueMicrotask(clear);
  }, [status, listTab]);

  async function startInstantWebinar() {
    if (bypass) {
      openRoomTab("/preview/room");
      return;
    }
    // Opened NOW, synchronously, before the awaits below — see
    // openPendingRoomTab's own doc comment for why that order is load-
    // bearing and not just tidiness.
    const pendingTab = openPendingRoomTab();
    setStartingInstant(true);
    try {
      const created = await api.createWebinar(
        instantWebinarInput(maxAttendees),
      );
      await api.startWebinar(created.id);
      pendingTab.open(`/host/${created.id}/room`);
      // The whole point of "instant" is joining people who aren't in this
      // browser tab — so the join link goes straight to the clipboard rather
      // than making the host hunt for Share after the fact.
      try {
        await navigator.clipboard.writeText(`${origin}/webinars/${created.id}`);
        notify("Instant webinar started — join link copied to share.", "ok");
      } catch {
        notify(
          "Instant webinar started. Open Share from the room to copy the join link.",
          "info",
        );
      }
      refresh();
    } catch (err) {
      pendingTab.cancel();
      notify(instantStartError(err), "error");
    } finally {
      setStartingInstant(false);
    }
  }

  /* Panelist sessions only, and not async so the state write lands inside
   * .then() — react-hooks/set-state-in-effect rejects an async function called
   * from an effect body. A failure here is swallowed on purpose: not being able
   * to list somebody else's sessions is not a reason to put an error banner
   * over the host's own. */
  const loadStage = useCallback(() => {
    if (bypass) return;
    api
      .stageWebinars()
      .then((rows) => {
        if (statusRef.current === "anonymous") return;
        setOnStage(rows);
      })
      .catch(() => setOnStage([]));
  }, [bypass]);

  /** After starting an instant webinar: the host's own list lives inside
   *  HostWebinarBrowser and fetches itself, so it gets nudged rather than
   *  handed new rows. */
  function refresh() {
    setReloadToken((n) => n + 1);
    loadStage();
  }

  if (status === "loading") {
    return (
      <div className="grid place-items-center py-20">
        <Spinner className="size-6 text-ink-3" />
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <Card className="p-8 text-center">
        <h1 className="text-[18px] font-semibold">Sign in to host</h1>
        <p className="mx-auto mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-2">
          Hosting needs an account <em>and</em> access granted by an
          administrator. Attendees need neither — their registration link is all
          they need.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <ButtonLink href="/login?next=/host">Sign in</ButtonLink>
          <ButtonLink href="/signup?host=1" variant="secondary">
            Create an account
          </ButtonLink>
        </div>
      </Card>
    );
  }

  if (!canHost) {
    return (
      <>
        {onStage.length > 0 && (
          <section className="mb-8">
            <h1 className="mb-1.5 text-[24px] font-semibold tracking-[-0.02em]">
              You&apos;re a panelist on
            </h1>
            <p className="mb-3 text-[13.5px] text-ink-2">
              Join the stage when the host starts. Hosting your own sessions is
              separate — ask an admin to enable it on your account.
            </p>
            <HostWebinarList webinars={onStage} />
          </section>
        )}
        <Card className="p-8 text-center">
          <h1 className="text-[18px] font-semibold">
            Hosting isn&apos;t enabled for this account
          </h1>
          <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-ink-2">
            Only an administrator can turn it on. You can still register for and
            attend any session you have a link to.
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <ButtonLink href="/my-webinars" variant="secondary" size="sm">
              WatchList
            </ButtonLink>
            <ButtonLink href="/settings#account" variant="ghost" size="sm">
              Settings
            </ButtonLink>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      {bypass && (
        <div className="mb-4">
          <Alert tone="info" title="Local UI preview">
            Auth bypass is on — fixture webinars below. Room media is mocked at{" "}
            <a
              className="underline"
              href="/preview/room"
              target="_blank"
              rel="noopener noreferrer"
            >
              /preview/room
            </a>
            .
          </Alert>
        </div>
      )}

      {/* The visible heading gave way to the action cards; the page keeps its
       * h1 for screen readers and the document outline. */}
      <h1 className="sr-only">Your webinars</h1>
      <div
        className={
          instantAllowed
            ? "mb-6 grid gap-3 sm:grid-cols-2"
            : "mb-6 grid gap-3"
        }
      >
        {instantAllowed && (
          <button
            type="button"
            onClick={startInstantWebinar}
            disabled={startingInstant}
            aria-busy={startingInstant}
            className={actionCardClass}
          >
            <ActionCardBody
              icon={
                startingInstant ? (
                  <Spinner className="size-4" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )
              }
              title={startingInstant ? "Starting…" : "Instant webinar"}
              subtitle="Go live immediately, no form"
            />
          </button>
        )}
        <Link href="/host/new" className={actionCardClass}>
          <ActionCardBody
            icon={<CalendarIcon className="size-4" />}
            title="Schedule a webinar"
            subtitle="Pick a date and invite people"
          />
        </Link>
      </div>

      <HostWebinarBrowser reloadToken={reloadToken} />

      {onStage.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-1 text-[15px] font-semibold">
            On stage as panelist
          </h2>
          <p className="mb-3 text-[13px] text-ink-2">
            Sessions you were invited to present on — join when the host starts.
          </p>
          <HostWebinarList webinars={onStage} />
        </section>
      )}
    </>
  );
}
