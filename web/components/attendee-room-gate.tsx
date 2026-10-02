"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useJoinKeyFor, useJoinKeys, useLinkJoinKey, useRegistrations } from "./registrations";
import { WebinarRoom } from "./room/webinar-room";
import { LeftSession } from "./survey/session-survey";
import { Spinner } from "./controls";
import { useSession } from "./providers";
import { Button, ButtonLink, Card } from "./ui";
import { ApiError, api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { isAwaitingEmail, joinProvesKey } from "@/lib/guest-registration";

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
}: {
  slug: string;
  topic: string;
  /** The webinar's own cover image, shown on the "waiting for the host"
   *  screen in place of the generic placeholder — see stage.tsx's
   *  WaitingForStage. Undefined when the host never uploaded one. */
  imageUrl?: string;
}) {
  const router = useRouter();
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
  // Pressing Leave (or "Back to webinars") lands on the way-out screen, which offers the
  // post-event survey when there is one to answer and otherwise goes straight on.
  const [left, setLeft] = useState(false);
  const goOn = useCallback(() => router.push(`/webinars/${slug}`), [router, slug]);

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
    if (status === "loading") return;

    // directKey is the key this browser stored when it registered. When it is
    // present — the normal case — the join request goes out now rather than after
    // /registrations/lookup returns, taking a whole round trip off the front of
    // every attendee's connection.
    const key = directKey ?? reg?.joinKey;
    const bySession = status === "signed-in" && account !== null;

    // Nothing to try with yet. Keep waiting if the lookup is still running; the
    // render decides what to say once it has finished.
    if (!key && !bySession) return;

    const fingerprint = `${key ?? account?.id ?? "?"}#${attempt}`;
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
      .join(slug, key)
      .then((res) => {
        if (!current()) return;
        keepIfProven({ joined: true });
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
        setError(
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "unknown", message: "Could not join the webinar." },
        );
      });
  }, [registrations, reg, directKey, linkKey, keepKey, slug, attempt, status, account]);

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
      />
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
          <>
            <h1 className="text-[17px] font-semibold">{errorTitle(error.code)}</h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
              {error.message}
            </p>
            <div className="mt-5 grid gap-2">
              {error.code === "not_registered" ||
              error.code === "registration_required" ||
              error.code === "no_join_key" ||
              error.code === "invalid_join_key" ? (
                <ButtonLink href={`/webinars/${slug}`}>Register now</ButtonLink>
              ) : (
                <Button
                  onClick={() => {
                    setError(null);
                    setAttempt((n) => n + 1);
                  }}
                >
                  Try again
                </Button>
              )}
              <Link
                href={`/webinars/${slug}`}
                className="text-[12.5px] text-brand hover:underline"
              >
                Back to the webinar
              </Link>
            </div>
          </>
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

function errorTitle(code: string): string {
  switch (code) {
    case "not_approved":
      return "Waiting for approval";
    case "locked":
      return "The webinar is locked";
    case "room_full":
      return "The webinar is full";
    case "not_joinable":
      return "This webinar isn't running";
    case "zoom_link_missing":
      return "Your Zoom link isn't ready";
    case "not_registered":
    case "registration_required":
    case "no_join_key":
      return "You're not registered yet";
    case "invalid_join_key":
      return "This join link isn't valid";
    default:
      return "Can't join yet";
  }
}
