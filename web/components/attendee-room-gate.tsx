"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useJoinKeyFor, useJoinKeys, useLinkJoinKey, useRegistrations } from "./registrations";
import { WebinarRoom } from "./room/webinar-room";
import { LeftSession } from "./survey/session-survey";
import { Spinner } from "./controls";
import { useAppConfig, useSession } from "./providers";
import { Button, ButtonLink, Card } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { detectArrival, hasRejoinIntent, type Arrival } from "@/lib/rejoin";
import { trackEvent } from "@/lib/telemetry";
import { reportEvent } from "@/lib/observability";
import { usePrimeMediaOnGesture } from "@/lib/media-unlock";
import { isAwaitingEmail, joinProvesKey } from "@/lib/guest-registration";
import { attendeeJoinRefusal } from "@/lib/join-refusal";
import { serverRetryDelayMs, serverWaitOf } from "@/lib/video-server";
import { MEETING_POLL_MS, lobbyScreen, type LobbyScreen } from "@/lib/meeting-lobby";
import { LobbyStatus, MeetingKnockForm } from "./meeting-door";
import { PushOptIn } from "./pwa";

/** Exchanges the caller's credential for a LiveKit token, then hands off to the
 *  room.
 *
 *  Two credentials work here: a join key held in this browser, or the session
 *  cookie of an account that registered. Every authorization decision is the
 *  server's — this component only reports what it was told. */
export function AttendeeRoomGate({
  slug,
  topic,
  imageUrl,
  meeting = false,
  upcoming = false,
}: {
  slug: string;
  topic: string;
  /** The webinar's own cover image, shown on the "waiting for the host"
   *  screen in place of the generic placeholder — see stage.tsx's
   *  WaitingForStage. Undefined when the host never uploaded one. */
  imageUrl?: string;
  /** A meeting (Webinar.kind "meeting"): this gate is also its lobby. POST /join answers
   *  409 waiting_for_host until the host admits the key, so that answer is polled here
   *  on MEETING_POLL_MS rather than shown as a refusal, and a browser with no key is given
   *  the name field to knock with instead of "you're not registered". See
   *  components/meeting-door.tsx and lib/meeting-lobby.ts. */
  meeting?: boolean;
  /** Not started yet when the page loaded (status "scheduled"). A meeting's waiting screen
   *  then offers "Get notified when it starts" (components/pwa.tsx PushOptIn). */
  upcoming?: boolean;
}) {
  const router = useRouter();
  // Any tap on the way in ("Join again", "Try again") unlocks a <video> for Safari's sake.
  usePrimeMediaOnGesture();
  const {
    registrations,
    registrationFor,
    error: lookupError,
    retry,
  } = useRegistrations();
  const { account, status } = useSession();
  const [join, setJoin] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [openingZoom, setOpeningZoom] = useState(false);
  const [attempt, setAttempt] = useState(0);
  /* The webinar's video server is started on demand (lib/video-server.ts): while it starts,
   * or after it failed and is being retried, ask again on a timer instead of waiting for a
   * "Try again" click, and go in by itself when it answers. Edge viewers join the same way. */
  // A meeting polls its own way (below), sfu_starting and sfu_failed included.
  const serverWait = meeting ? null : serverWaitOf(error?.code);
  useEffect(() => {
    if (!serverWait) return;
    const t = setTimeout(() => {
      setError(null);
      setAttempt((n) => n + 1);
    }, serverRetryDelayMs(serverWait));
    return () => clearTimeout(t);
  }, [serverWait]);

  /* The meeting lobby: what the last answer means, and whether to ask again by itself.
   *
   * The error is NOT cleared before the next poll, unlike the retry above. Clearing it
   * would flash "Connecting…" between every two "Waiting for the host" screens; leaving it
   * means the waiting screen stays put until an answer that is different arrives — a token
   * (the room), or a refusal that replaces it. Each answer is a new object, so this effect
   * schedules the next poll from the one before. */
  const lobby = meeting && error ? lobbyScreen(error.code, error.message) : null;
  // The guest asked for a fresh knock (after a removal), so the held key is not sent.
  const [knockFresh, setKnockFresh] = useState(false);
  // A knock from the name field that was refused outright (denied, locked, ended).
  const [knockRefusal, setKnockRefusal] = useState<LobbyScreen | null>(null);
  const lobbyPolls = lobby?.poll ?? false;
  useEffect(() => {
    if (!lobbyPolls) return;
    const t = setTimeout(() => setAttempt((n) => n + 1), MEETING_POLL_MS);
    return () => clearTimeout(t);
  }, [lobbyPolls, error]);
  // Pressing Leave (or "Back to webinars") lands on the way-out screen, which offers the
  // post-event survey when there is one to answer and otherwise goes straight on.
  const [left, setLeft] = useState(false);
  const goOn = useCallback(() => router.push(`/webinars/${slug}`), [router, slug]);
  const { telemetryEnabled } = useAppConfig();

  /* How this page was reached (lib/rejoin.ts). A refresh, or the landing page sending a
   * recent visitor back, is "rejoin": the join is marked automatic, so the server refuses it
   * for somebody the host removed. A refresh after pressing Leave is "left": they meant to go,
   * so nothing joins until they say so. Read on the client only — the server has no storage
   * — and not used until hydration, so both renders agree. */
  const hydrated = useHydrated();
  const [arrival, setArrival] = useState<Arrival>(() => detectArrival(slug));

  // A ref, not state: guards against the double-invoke of effects in dev
  // StrictMode without triggering a synchronous setState inside the effect.
  const requested = useRef<string | null>(null);

  const reg = registrationFor(slug);
  // The key this browser already holds for this webinar. Available before the
  // lookup returns, which is the whole point — see the effect below.
  const storedKey = useJoinKeyFor(slug);
  // The key in the link that opened this page (?k=). It wins over a stored one: it is
  // the credential the person just used, and since a registration only gets its key
  // once the email is confirmed, it is the only key a guest on any device has.
  const linkKey = useLinkJoinKey();
  const directKey = linkKey ?? storedKey;
  const { add: keepKey } = useJoinKeys();
  // Registered but still waiting for the email: no key yet, and the server would refuse
  // it anyway, so it is nothing to try. Trying it would sit on "Connecting…" forever.
  const awaitingEmail = reg !== undefined && isAwaitingEmail(reg);
  // A signed-in account can join without holding a key at all — the server finds
  // the registration from the session.
  const canTry =
    directKey !== null ||
    (reg !== undefined && !awaitingEmail) ||
    (status === "signed-in" && account !== null);

  useEffect(() => {
    if (status === "loading" || !hydrated || arrival === "left") return;

    // directKey is the key this browser stored when it registered. When it is
    // present — the normal case — the join request goes out now rather than after
    // /registrations/lookup returns, taking a whole round trip off the front of
    // every attendee's connection.
    const key = directKey ?? reg?.joinKey;
    const bySession = status === "signed-in" && account !== null;

    // Nothing to try with yet. Keep waiting if the lookup is still running; the
    // render decides what to say once it has finished.
    if (!key && !bySession) return;

    const fingerprint = `${key ?? account?.id ?? "?"}#${attempt}#${arrival}`;
    const rejoin = arrival === "rejoin";
    if (requested.current === fingerprint) return;
    requested.current = fingerprint;

    // The fingerprint is the only guard, deliberately. The obvious alternative — a
    // per-run `active` flag cleared in the effect's cleanup — deadlocks here, and did:
    //
    //   1. mount with a stored join key, so the request goes out immediately while
    //      the registration lookup is still in flight
    //   2. the lookup resolves, `registrations` changes, dependencies change,
    //      cleanup sets active = false
    //   3. the effect re-runs, sees the same fingerprint, and returns early — so no
    //      replacement request is made
    //   4. the original response lands and is discarded because active is false
    //
    // The attendee sits on "Connecting to the webinar…" forever and a reload fixes
    // it, which is exactly what was reported. Comparing the fingerprint when the
    // response arrives instead means a re-render cannot throw away a good response,
    // while a genuinely different attempt still supersedes an older one.
    const current = () => requested.current === fingerprint;
    // Keep a link's key in this browser once the server has shown it belongs to a real
    // registration, so the webinar page, and a later visit without the link, still know
    // this person. A refused key or a network failure proves nothing and is not kept.
    const keepIfProven = (outcome: { joined: true } | { code: string }) => {
      if (key && key === linkKey && joinProvesKey(outcome)) keepKey(key, slug);
    };
    api
      .join(slug, key, { rejoin })
      .then((res) => {
        if (!current()) return;
        keepIfProven({ joined: true });
        if (rejoin && telemetryEnabled) {
          trackEvent("rejoin", { userId: res.identity, roomName: slug }, {
            door: "attendee",
            via: hasRejoinIntent(slug, Date.now()) ? "link" : "refresh",
            publisher: res.canPublish,
          });
        }
        if (res.zoomJoinUrl) {
          setOpeningZoom(true);
          window.location.assign(res.zoomJoinUrl);
          return;
        }
        setJoin(res);
      })
      .catch((e: unknown) => {
        if (!current()) return;
        if (e instanceof ApiError) keepIfProven({ code: e.code });
        // Grafana Faro: why an attendee could not get in (a code, nothing personal). Not the
        // video server still starting, which is retried every few seconds and is not a refusal.
        if (!(e instanceof ApiError && serverWaitOf(e.code))) {
          reportEvent("room_join_refused", { door: "attendee", code: e instanceof ApiError ? e.code : "unknown" });
        }
        setError(
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "unknown", message: "Could not join the webinar." },
        );
      });
  }, [
    registrations,
    reg,
    directKey,
    linkKey,
    keepKey,
    slug,
    attempt,
    status,
    account,
    hydrated,
    arrival,
    telemetryEnabled,
  ]);

  if (join && left) {
    return (
      <LeftSession
        slug={slug}
        joinKey={directKey ?? reg?.joinKey}
        topic={join.topic || topic}
        onContinue={goOn}
      />
    );
  }

  if (join) {
    return (
      <WebinarRoom
        join={join}
        slug={slug}
        topic={join.topic || topic}
        imageUrl={imageUrl}
        // The credential the room needs to send chat: an attendee publishes nothing
        // on the data channel, so every message they send is a request to our API.
        // Undefined for somebody who joined on their session alone, which the API
        // accepts too.
        joinKey={directKey ?? reg?.joinKey}
        onLeave={() => setLeft(true)}
        door="attendee"
        rejoined={arrival === "rejoin"}
      />
    );
  }

  if (hydrated && arrival === "left") {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <Card className="w-full max-w-md p-6 text-center">
          <h1 className="text-[17px] font-semibold">
            You left this {meeting ? "meeting" : "webinar"}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            It&apos;s still running. Join again whenever you&apos;re ready.
          </p>
          <div className="mt-5 grid gap-2">
            <Button onClick={() => setArrival("normal")}>Join again</Button>
            <Link
              href={`/webinars/${slug}`}
              className="text-[12.5px] text-brand hover:underline"
            >
              Back to the {meeting ? "meeting" : "webinar"}
            </Link>
          </div>
        </Card>
      </main>
    );
  }

  /* A meeting's door, in place of everything below: no registration lookup to wait for or
   * report on (a meeting's key is always in this browser's slug index once it has knocked),
   * and no "register" anywhere. The order is the lobby's: no key yet → the name field; an
   * answer from /join → its screen; otherwise the request is out. */
  if (meeting) {
    const signedIn = status === "signed-in" && account !== null;
    const needsKnock =
      knockFresh ||
      lobby?.phase === "knock" ||
      (hydrated && status !== "loading" && directKey === null && !signedIn);
    const waitingKey = directKey ?? reg?.joinKey;
    const afterKnock = () => {
      setKnockFresh(false);
      setKnockRefusal(null);
      setError(null);
      setAttempt((n) => n + 1);
    };
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <Card className="w-full max-w-md p-6 text-center">
          {knockRefusal ? (
            <LobbyStatus
              screen={knockRefusal}
              onRetry={() => setKnockRefusal(null)}
              backHref={`/webinars/${slug}`}
            />
          ) : needsKnock ? (
            <MeetingKnockForm
              slug={slug}
              heading={topic ? `Ask to join “${topic}”` : "Ask to join"}
              onKnocked={afterKnock}
              onRefused={setKnockRefusal}
            />
          ) : lobby ? (
            <LobbyStatus
              screen={lobby}
              onRetry={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
              onKnockAgain={() => setKnockFresh(true)}
              backHref={lobby.poll ? undefined : `/webinars/${slug}`}
            />
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Spinner className="size-5 text-ink-3" />
              <p className="text-[13.5px] text-ink-2">Connecting to the meeting…</p>
            </div>
          )}
          {/* Knocked on a meeting that has not started (31 Oct 2026): the host may be a
              while, so offer the "it started" push to the knock's key instead of asking the
              guest to keep the tab open. Not once it is live: they go in in seconds. */}
          {upcoming && waitingKey && error?.code === "waiting_for_host" && !needsKnock && !knockRefusal ? (
            <PushOptIn slug={slug} joinKey={waitingKey} meeting />
          ) : null}
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <Card className="w-full max-w-md p-6 text-center">
        {/* A failed lookup must never render as "you're not registered". Telling
            somebody they never signed up, at the moment they are trying to get
            into the webinar, is the worst possible way to report a 429. */}
        {registrations === null && lookupError ? (
          <>
            <h1 className="text-[17px] font-semibold">
              Couldn&apos;t check your registration
            </h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
              {lookupError} Your registration is safe — this is a problem reaching
              the server.
            </p>
            <div className="mt-5 grid gap-2">
              <Button onClick={retry}>Try again</Button>
              <Link
                href={`/webinars/${slug}`}
                className="text-[12.5px] text-brand hover:underline"
              >
                Back to the webinar
              </Link>
            </div>
          </>
        ) : registrations === null || status === "loading" ? (
          <div className="flex flex-col items-center gap-3">
            <Spinner className="size-5 text-ink-3" />
            <p className="text-[13.5px] text-ink-2">Checking your registration…</p>
          </div>
        ) : !canTry && awaitingEmail ? (
          <>
            <h1 className="text-[17px] font-semibold">Confirm your email first</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
              Open the link we sent to {reg?.email || "your inbox"}. Your join link arrives
              as soon as you do.
            </p>
            <ButtonLink href={`/webinars/${slug}`} className="mt-5 w-full">
              Back to the webinar
            </ButtonLink>
          </>
        ) : !canTry ? (
          <>
            <h1 className="text-[17px] font-semibold">You&apos;re not registered</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
              This webinar needs a registration before you can join. It only takes a
              few seconds.
            </p>
            <ButtonLink href={`/webinars/${slug}`} className="mt-5 w-full">
              Register for this webinar
            </ButtonLink>
          </>
        ) : error ? (
          <JoinRefusal
            slug={slug}
            code={error.code}
            message={error.message}
            onRetry={() => {
              setError(null);
              setAttempt((n) => n + 1);
            }}
          />
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Spinner className="size-5 text-ink-3" />
            <p className="text-[13.5px] text-ink-2">
              {openingZoom ? "Opening Zoom…" : "Connecting to the webinar…"}
            </p>
          </div>
        )}
      </Card>
    </main>
  );
}

function JoinRefusal({
  slug,
  code,
  message,
  onRetry,
}: {
  slug: string;
  code: string;
  message: string;
  onRetry: () => void;
}) {
  const refusal = attendeeJoinRefusal(code, message);
  return (
    <>
      <h1 className="text-[17px] font-semibold">{refusal.title}</h1>
      {refusal.body ? (
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{refusal.body}</p>
      ) : null}
      <div className="mt-5 grid gap-2">
        {refusal.action === "register" ? (
          <ButtonLink href={`/webinars/${slug}`}>Register now</ButtonLink>
        ) : refusal.action === "retry" ? (
          <Button onClick={onRetry}>Try again</Button>
        ) : null}
        <Link
          href={`/webinars/${slug}`}
          className="text-[12.5px] text-brand hover:underline"
        >
          Back to the webinar
        </Link>
      </div>
    </>
  );
}
