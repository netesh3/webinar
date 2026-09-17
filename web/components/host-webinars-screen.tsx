"use client";

import { useCallback, useEffect, useState } from "react";
import { HostWebinarList } from "./host-webinar-list";
import { Alert, Spinner } from "./controls";
import { DEFAULT_ATTENDEE_LIMIT } from "./schedule-form";
import { useAppConfig, useSession, useToast } from "./providers";
import { Button, ButtonLink, Card, Empty } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { Webinar, WebinarInput } from "@/lib/api-types";
import { DEV_BYPASS_WEBINARS } from "@/lib/dev-bypass";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { localTimeZone } from "@/lib/format";
import { openRoomTab } from "@/lib/open-room";

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
    startsAt: new Date().toISOString(),
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
      locked: false,
    },
  };
}

/** Hosting home: create, run upcoming sessions, review past attendance.
 *
 *  One primary nav area (top: Hosting) + in-page segments (Upcoming / Past /
 *  Drafts). No competing sidebar. */
export function HostWebinarsScreen() {
  const { account, status } = useSession();
  const { maxAttendees } = useAppConfig();
  const { notify } = useToast();
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
    setStartingInstant(true);
    try {
      const created = await api.createWebinar(instantWebinarInput(maxAttendees));
      await api.startWebinar(created.id);
      openRoomTab(`/host/${created.id}/room`);
      load();
    } catch (err) {
      notify(
        err instanceof Error ? err.message : "Could not start the webinar.",
        "error",
      );
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

      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold tracking-[-0.02em]">
            Host Webinar
          </h1>
          <p className="mt-1.5 max-w-lg text-[13.5px] leading-relaxed text-ink-2">
            Create a session, start it when you&apos;re ready, admit people who
            need approval, then review who attended
            {upcoming > 0 ? ` · ${upcoming} upcoming` : ""}.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            onClick={startInstantWebinar}
            disabled={startingInstant}
          >
            {startingInstant && <Spinner className="size-4" />}
            Instant webinar
          </Button>
          <ButtonLink href="/host/new">Create webinar</ButtonLink>
        </div>
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
        <Empty
          title="No webinars yet"
          hint="Create one, share the link, then Host when it's time."
          action={<ButtonLink href="/host/new">Create webinar</ButtonLink>}
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
