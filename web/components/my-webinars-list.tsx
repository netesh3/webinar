"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRegistrations } from "./registrations";
import { Alert } from "./controls";
import { CalendarIcon } from "./icons";
import { useSession, useShareOrigin } from "./providers";
import { Badge, Button, ButtonLink, Card, Empty, TopicStripe } from "./ui";
import { formatDay, formatDuration, formatRelative, formatTimeRange, tzLabel } from "@/lib/format";
import { downloadIcs, googleCalendarUrl } from "@/lib/calendar";
import { useNow } from "@/lib/clock";
import type { Registration, Webinar } from "@/lib/api-types";

/* Everything this person is signed up for.
 *
 * This page used to be handed the whole catalogue by the server and filter it down to the
 * caller's registrations in the browser. It worked, and it meant every scheduled webinar
 * on the server — including other hosts' — travelled in the page payload to render a list
 * of one person's own. The rows never showed; the data was there.
 *
 * Both sources now carry their own webinar, so there is nothing to filter and nothing
 * extra to send. useRegistrations collects them as the responses arrive:
 *
 *   join keys        POST /api/registrations/lookup  — guests, no account needed
 *   an account       GET  /api/me/registrations      — follows the person across browsers
 *
 * Which also fixed a quieter bug. The catalogue only ever contained webinars open for
 * registration, so an ENDED session a guest had attended could not be resolved and simply
 * vanished from their list. The lookup has no such filter.
 */

export function MyWebinarsList() {
  const { registrations, webinarFor, forget, error, retry } = useRegistrations();
  // Still needed for the "saved in this browser" nudge; the registration fetching it
  // used to do is now useRegistrations' job.
  const { account } = useSession();

  const rows = useMemo(() => {
    if (registrations === null) return null;

    return registrations
      .map((reg) => ({ reg, webinar: webinarFor(reg.webinarId) }))
      .filter((x): x is { reg: Registration; webinar: Webinar } => !!x.webinar)
      .sort((a, b) => +new Date(a.webinar.startsAt) - +new Date(b.webinar.startsAt));
  }, [registrations, webinarFor]);

  if (rows === null && error) {
    return (
      <Empty
        title="Couldn't load your webinars"
        hint={`${error} Your registrations are safe — this is a problem reaching the server.`}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  }

  if (rows === null) {
    return (
      <div className="grid gap-3">
        <div className="h-32 animate-pulse rounded-xl bg-surface-2" />
        <div className="h-32 animate-pulse rounded-xl bg-surface-2" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <>
        {error && (
          <div className="mb-4">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        <Empty
          title="You haven't registered for anything yet"
          hint="Open an invitation link to register for a session. Your personal join link will show up here."
          action={<ButtonLink href="/browse">Browse webinars</ButtonLink>}
        />
      </>
    );
  }

  // Split on the webinar's own status rather than the wall clock: reading the
  // clock during render is impure, and the backend is the authority on whether a
  // session has finished.
  const upcoming = rows.filter((x) => x.webinar.status !== "ended");
  const past = rows.filter((x) => x.webinar.status === "ended");

  return (
    <div className="grid gap-6">
      {error && <Alert tone="error">{error}</Alert>}

      {!account && (
        <div className="rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-ink-2">
          These registrations are saved in this browser.{" "}
          <Link href="/signup" className="font-medium text-brand hover:underline">
            Create an account
          </Link>{" "}
          to keep them if you clear your cache or switch device.
        </div>
      )}

      {upcoming.length > 0 && (
        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-ink-2">
            Upcoming · {upcoming.length}
          </h2>
          <div className="grid gap-3">
            {upcoming.map(({ reg, webinar }) => (
              <RegisteredCard
                key={webinar.id}
                webinar={webinar}
                registration={reg}
                onForget={() => forget(reg)}
              />
            ))}
          </div>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="mb-3 text-[13px] font-semibold text-ink-2">
            Past · {past.length}
          </h2>
          <div className="grid gap-3">
            {past.map(({ reg, webinar }) => (
              <RegisteredCard
                key={webinar.id}
                webinar={webinar}
                registration={reg}
                past
                onForget={() => forget(reg)}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RegisteredCard({
  webinar: w,
  registration: r,
  past = false,
  onForget,
}: {
  webinar: Webinar;
  registration: Registration;
  past?: boolean;
  onForget: () => void;
}) {
  const origin = useShareOrigin();
  // null until after hydration, so the server and the browser render the same
  // thing and the relative time still updates while the page is open.
  const now = useNow();
  const pending = r.state === "pending";
  const declined = r.state === "declined";
  const live = w.status === "live";
  // Joinable whenever the session exists and the registration is approved. There
  // is no artificial waiting room: an attendee who arrives early sees "waiting
  // for the host", which is more informative than a disabled button.
  const joinable = !past && !pending && !declined;

  const event = {
    title: w.topic,
    description: w.summary || w.description,
    startsAt: w.startsAt,
    durationMin: w.durationMin,
    url: `${origin}/webinars/${w.id}/room`,
  };

  return (
    <Card className="overflow-hidden">
      <TopicStripe webinar={w} />
      <div className="flex flex-col gap-4 p-4 sm:flex-row">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {live ? (
              <Badge tone="live" dot>
                Live now
              </Badge>
            ) : declined ? (
              <Badge tone="live">Declined</Badge>
            ) : pending ? (
              <Badge tone="warn">Awaiting approval</Badge>
            ) : past ? (
              <Badge>Ended</Badge>
            ) : (
              <Badge tone="ok" dot>
                Registered
              </Badge>
            )}
            {w.track && <Badge>{w.track}</Badge>}
            {w.kind === "simulive" && <Badge tone="brand">Simulive</Badge>}
          </div>

          <h3 className="text-[15px] leading-snug font-semibold">
            <Link href={`/webinars/${w.id}`} className="hover:text-brand">
              {w.topic}
            </Link>
          </h3>

          <p className="mt-1.5 text-[13px] text-ink-2">
            {formatDay(w.startsAt, w.timeZone)} ·{" "}
            {formatTimeRange(w.startsAt, w.durationMin, w.timeZone)}{" "}
            {tzLabel(w.startsAt, w.timeZone)} · {formatDuration(w.durationMin)}
          </p>

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
            <span>
              Webinar ID <span className="tabular-nums">{w.webinarId}</span>
            </span>
            {!pending && !declined && (
              <span>
                Join key <span className="font-mono text-ink-2">{r.joinKey}</span>
              </span>
            )}
            <span>Hosted by {w.host.name}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col justify-center gap-2 sm:w-[180px]">
          {joinable && (
            <ButtonLink
              href={`/webinars/${w.id}/room`}
              size="sm"
              target="_blank"
              rel="noopener noreferrer"
            >
              {live ? "Join now" : "Join the webinar"}
            </ButtonLink>
          )}

          {pending && (
            <div className="flex h-9 items-center justify-center rounded-lg bg-warn-soft text-[12.5px] font-medium text-warn">
              Pending approval
            </div>
          )}

          {declined && (
            <div className="flex h-9 items-center justify-center rounded-lg bg-live-soft text-[12.5px] font-medium text-live">
              Not approved
            </div>
          )}

          {joinable && (
            <div className="grid grid-cols-2 gap-1.5">
              <ButtonLink
                href={googleCalendarUrl(event)}
                target="_blank"
                rel="noopener noreferrer"
                variant="secondary"
                size="sm"
                className="px-2"
              >
                <CalendarIcon className="size-3.5" />
                Google
              </ButtonLink>
              <Button
                variant="secondary"
                size="sm"
                className="px-2"
                onClick={() => downloadIcs(event, `${w.id}-${r.joinKey}`, `${w.id}.ics`)}
              >
                .ics
              </Button>
            </div>
          )}

          {!past && !live && now !== null && (
            <p className="text-center text-[11px] text-ink-3">
              Starts {formatRelative(w.startsAt, new Date(now))}
            </p>
          )}

          <button
            onClick={onForget}
            className="text-[11.5px] text-ink-3 hover:text-live hover:underline"
          >
            Forget on this device
          </button>
        </div>
      </div>
    </Card>
  );
}
