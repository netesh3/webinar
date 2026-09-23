"use client";

import { useCallback, useEffect, useState } from "react";
import { HostWebinarList } from "./host-webinar-list";
import { Alert, Spinner } from "./controls";
import { CalendarIcon, ChevronDownIcon, PlayIcon } from "./icons";
import { DEFAULT_ATTENDEE_LIMIT } from "./schedule-form";
import { useAppConfig, useSession, useShareOrigin, useToast } from "./providers";
import { ButtonLink, Card, Empty } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Webinar, WebinarInput } from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";
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
      // Off: it spends the host's own WhatsApp balance. See WebinarOptions.
      whatsappReminders: false,
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
 *  One primary nav area (top: Host Webinar) + in-page segments (Upcoming /
 *  Past / Drafts). No competing sidebar — two action tiles up top (Instant /
 *  Schedule) instead of a pair of same-weight buttons, so which one to click
 *  is obvious without reading closely. */
export function HostWebinarsScreen() {
  const { account, status } = useSession();
  const { maxAttendees } = useAppConfig();
  const { notify } = useToast();
  const origin = useShareOrigin();
  const [mine, setMine] = useState<Webinar[] | null>(null);
  const [onStage, setOnStage] = useState<Webinar[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [startingInstant, setStartingInstant] = useState(false);
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
      load();
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

  const load = useCallback(() => {
    if (bypass) {
      setMine(DEV_BYPASS_WEBINARS);
      setOnStage([]);
      setError(null);
      return;
    }

    api
      .stageWebinars()
      .then(setOnStage)
      .catch(() => setOnStage([]));

    if (!canHost) return;
    api
      .hostWebinars()
      .then((owned) => {
        setMine(owned);
        setError(null);
      })
      .catch((e: unknown) => {
        setMine([]);
        if (e instanceof ApiError && e.code === "not_a_host") return;
        setError(
          e instanceof Error ? e.message : "Could not load your webinars.",
        );
      });
  }, [canHost, bypass]);

  useEffect(() => {
    if (status === "signed-in") load();
  }, [status, load]);

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
            <HostWebinarList webinars={onStage} readOnly />
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
              My Webinar
            </ButtonLink>
            <ButtonLink href="/account" variant="ghost" size="sm">
              Account settings
            </ButtonLink>
          </div>
        </Card>
      </>
    );
  }

  const upcoming =
    mine?.filter((w) => w.status === "scheduled" || w.status === "live")
      .length ?? 0;

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

      <div className="mb-6">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
          Host Webinar
        </h1>
        <p className="mt-1.5 max-w-lg text-[13.5px] leading-relaxed text-ink-2">
          Start a webinar right now, or schedule one for later
          {upcoming > 0 ? ` · ${upcoming} upcoming` : ""}.
        </p>
      </div>

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

      {error && (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {mine === null ? (
        <div className="grid gap-3">
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
          <div className="h-24 animate-pulse rounded-xl bg-surface-2" />
        </div>
      ) : mine.length === 0 && !error ? (
        // No action button here on purpose — the two rows above already are
        // the actions, and repeating "Create webinar" a third time (nav
        // label, tile, empty-state button) says nothing new.
        <Empty
          title="No webinars yet"
          hint="Start one instantly, or schedule one above — then share the link."
        />
      ) : (
        <HostWebinarList webinars={mine} />
      )}

      {onStage.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-1 text-[15px] font-semibold">On stage as panelist</h2>
          <p className="mb-3 text-[13px] text-ink-2">
            Sessions you were invited to present on — join when the host starts.
          </p>
          <HostWebinarList webinars={onStage} readOnly />
        </section>
      )}
    </>
  );
}
