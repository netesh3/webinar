"use client";

import { useCallback, useEffect, useState } from "react";
import { HostWebinarBrowser } from "./host-webinar-browser";
import { HostWebinarList } from "./host-webinar-list";
import { Alert, Spinner } from "./controls";
import { CalendarIcon, ChevronDownIcon, PlayIcon } from "./icons";
import { DEFAULT_ATTENDEE_LIMIT } from "./schedule-form";
import { useAppConfig, useSession, useShareOrigin, useToast } from "./providers";
import { ButtonLink, Card } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Webinar, WebinarInput } from "@/lib/api-types";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { localTimeZone } from "@/lib/format";
import { openPendingRoomTab, openRoomTab } from "@/lib/open-room";

/* An instant webinar is the same request a normal Create submits, just with
 * the form skipped: a topic that says what it is, starting now, and every
 * other field set to the same defaults schedule-form.tsx's blank form would
 * have sent. It is not a different kind of webinar — a host can rename it or
 * change its settings afterwards exactly like any other. */
function instantWebinarInput(maxAttendees: number): WebinarInput {
  return {
    topic: "Instant webinar",
    summary: "",
    description: "",
    track: "",
    /* NOT literally now: the server rejects a create whose startsAt is
     * already in the past (host.go, isCreate + status "scheduled"), with no
     * grace period — and "now" computed here is, by the time this request
     * reaches the server, already a little in the past. A few minutes of
     * slack clears that race with room to spare. The exact value barely
     * matters anyway: startWebinar (called right after this resolves) has no
     * precondition on startsAt at all, so the room goes live immediately
     * regardless of what this says. */
    startsAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    durationMin: 60,
    timeZone: localTimeZone(),
    kind: "live",
    status: "scheduled",
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

/** Host Webinar home: create, run upcoming sessions, review past attendance.
 *
 *  No top nav entry of its own any more — the logo is this page for a host,
 *  see homeHrefFor in top-nav.tsx — and no page heading either: the two
 *  action tiles below say what this screen is for more directly than a title
 *  repeating them would. In-page segments (Upcoming / Past / Drafts) instead
 *  of a competing sidebar, and two action tiles up top (Instant / Schedule)
 *  instead of a pair of same-weight buttons, so which one to click is obvious
 *  without reading closely. */
export function HostWebinarsScreen() {
  const { account, status } = useSession();
  const { maxAttendees } = useAppConfig();
  const { notify } = useToast();
  const origin = useShareOrigin();
  const [onStage, setOnStage] = useState<Webinar[]>([]);
  const [startingInstant, setStartingInstant] = useState(false);
  /* The host's own list is paged server-side, so this screen no longer holds
   * it: HostWebinarBrowser fetches it. Bumping reloadToken is how a webinar
   * created here gets into a list this component cannot reach into. */
  const [reloadToken, setReloadToken] = useState(0);
  const bypass = isDevAuthBypassActive();

  const canHost = account?.canHost ?? false;

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
      const created = await api.createWebinar(instantWebinarInput(maxAttendees));
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
      const message =
        err instanceof ApiError
          ? (Object.values(err.fields ?? {})[0] ?? err.message)
          : err instanceof Error
            ? err.message
            : "Could not start the webinar.";
      notify(message || "Could not start the webinar.", "error");
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
      .then(setOnStage)
      .catch(() => setOnStage([]));
  }, [bypass]);

  useEffect(() => {
    if (status === "signed-in") loadStage();
  }, [status, loadStage]);

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
            <ButtonLink href="/account" variant="ghost" size="sm">
              Account settings
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

      {/* Two distinct rows rather than two same-weight buttons: which one to
          click should be obvious without reading closely, the way Zoom's own
          "New Meeting" vs "Schedule" tiles are. Compact and horizontal, not a
          tall card — the whole row is one action, so there is nothing to say
          twice (a title plus a "Do the thing →" link under it repeats
          itself). */}
      <div className="mb-8 grid gap-2.5 sm:grid-cols-2">
        <button
          type="button"
          onClick={startInstantWebinar}
          disabled={startingInstant}
          className="group flex items-center gap-3 rounded-xl border border-line bg-surface p-3.5 text-left transition-colors hover:border-brand-line hover:bg-surface-2 disabled:opacity-60"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            {startingInstant ? <Spinner className="size-4.5" /> : <PlayIcon className="size-4.5" />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">
              {startingInstant ? "Starting…" : "Instant webinar"}
            </span>
            <span className="block truncate text-[12px] text-ink-2">
              Go live immediately, no form
            </span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 -rotate-90 text-ink-3 transition-transform group-hover:translate-x-0.5" />
        </button>

        <ButtonLink
          href="/host/new"
          variant="secondary"
          className="group h-auto items-center gap-3 whitespace-normal rounded-xl border-line p-3.5 text-left font-normal hover:border-brand-line"
        >
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">
            <CalendarIcon className="size-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">
              Schedule a webinar
            </span>
            <span className="block truncate text-[12px] text-ink-2">
              Pick a date and invite people
            </span>
          </span>
          <ChevronDownIcon className="size-4 shrink-0 -rotate-90 text-ink-3 transition-transform group-hover:translate-x-0.5" />
        </ButtonLink>
      </div>

      <HostWebinarBrowser reloadToken={reloadToken} />

      {onStage.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-1 text-[15px] font-semibold">On stage as panelist</h2>
          <p className="mb-3 text-[13px] text-ink-2">
            Sessions you were invited to present on — join when the host starts.
          </p>
          <HostWebinarList webinars={onStage} />
        </section>
      )}
    </>
  );
}
