"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { WebinarRoom } from "./room/webinar-room";
import { Spinner } from "./controls";
import { Button, ButtonLink, Card } from "./ui";
import { useAppConfig } from "./providers";
import { ApiError, api } from "@/lib/api";
import type { JoinResponse } from "@/lib/api-types";
import { useHydrated } from "@/lib/clock";
import { detectArrival, hasRejoinIntent, type Arrival } from "@/lib/rejoin";
import { trackEvent } from "@/lib/telemetry";

/** Starts the stage for a host or panelist. Requires the session cookie; the API
 *  refuses to mint a publishing token for anyone else. */
export function HostRoomGate({ slug }: { slug: string }) {
  const router = useRouter();
  const [join, setJoin] = useState<JoinResponse | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [openingZoom, setOpeningZoom] = useState(false);
  const { telemetryEnabled } = useAppConfig();
  /* A refresh of the stage, or the dashboard's Rejoin, inside the window: straight back on
   * stage with the microphone and camera as they were, no device check (lib/rejoin.ts). Any
   * other arrival — including a refresh after pressing Leave — is the ordinary pre-join. */
  const hydrated = useHydrated();
  const [arrival] = useState<Arrival>(() => detectArrival(slug));
  const rejoin = arrival === "rejoin";
  /* A video server stopped to save money answers sfu_starting while it boots (about a
   * minute): wait on it and ask again, rather than show "Can't start". */
  const [serverStarting, setServerStarting] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    api
      .hostJoin(slug, { rejoin })
      .then((res) => {
        if (!active) return;
        if (rejoin && telemetryEnabled) {
          trackEvent("rejoin", { userId: res.identity, roomName: slug }, {
            door: "stage",
            via: hasRejoinIntent(slug, Date.now()) ? "link" : "refresh",
            publisher: res.canPublish,
          });
        }
        if (res.zoomStartUrl) {
          setOpeningZoom(true);
          window.location.assign(res.zoomStartUrl);
          return;
        }
        setServerStarting(false);
        setJoin(res);
      })
      .catch((e: unknown) => {
        if (!active) return;
        if (e instanceof ApiError && e.code === "sfu_starting") {
          setServerStarting(true);
          retry = setTimeout(() => setAttempt((n) => n + 1), 5000);
          return;
        }
        setServerStarting(false);
        if (e instanceof ApiError) setError({ code: e.code, message: e.message });
        else setError({ code: "unknown", message: "Could not start the webinar." });
      });

    return () => {
      active = false;
      clearTimeout(retry);
    };
  }, [slug, hydrated, rejoin, telemetryEnabled, attempt]);

  /* Being on this stage is a fact about the webinar, not something a retry can change —
   * offering "Try again" would just repeat the same 403. */
  const notInvited = error?.code === "forbidden";

  /* Somebody who is not on this stage is sent to the public page for the same webinar.
   *
   * This is the panelist link's half of the access rule. Middleware lets any signed-in account
   * ASK for /host/<slug>/room, because whether they are a panelist on this particular webinar
   * is not something a session cookie knows — only the API can answer, and it just did. A
   * participant who was forwarded the panelist link therefore lands here, and the right place
   * for them is the registration page, not a dashboard link.
   *
   * Replace, not push: leaving the refused URL in history means Back walks straight into it
   * again. */
  useEffect(() => {
    if (notInvited) router.replace(`/webinars/${slug}`);
  }, [notInvited, router, slug]);


  if (join) {
    return (
      <WebinarRoom
        join={join}
        slug={slug}
        // The topic comes back with the token, so the room needs no second
        // request before it can render its own header.
        topic={join.topic}
        onLeave={() => router.push(`/host/${slug}`)}
        door="stage"
        rejoined={rejoin}
      />
    );
  }

  const signInNeeded = error?.code === "unauthenticated";

  if (serverStarting && !error) {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <Card className="w-full max-w-md p-6 text-center">
          <div role="status" aria-live="polite">
          <span
            aria-hidden="true"
            className="mx-auto mb-3 block size-6 animate-spin rounded-full border-2 border-brand/30 border-t-brand"
          />
          <h1 className="text-[17px] font-semibold">Getting the video server ready…</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
            It was paused while no webinars were running. This takes about a minute, and you&apos;ll
            go straight into your room when it&apos;s up.
          </p>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <Card className="w-full max-w-md p-6 text-center">
        {error ? (
          <>
            <h1 className="text-[17px] font-semibold">
              {signInNeeded
                ? "Please sign in"
                : notInvited
                  ? "You're not on this stage"
                  : error.code === "runs_in_zoom"
                    ? "This session runs in Zoom"
                    : error.code === "removed"
                      ? "You were removed from this session"
                    : "Can't start"}
            </h1>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
              {error.message}
            </p>
            <div className="mt-5 grid gap-2">
              {signInNeeded ? (
                <ButtonLink href={`/login?next=/host/${slug}/room`}>Sign in</ButtonLink>
              ) : notInvited || error.code === "removed" ? null : (
                <Button onClick={() => location.reload()}>Try again</Button>
              )}
              {/* Not offered when the answer was "you are not on this stage": that person is
                  being redirected to the public page, and a host-dashboard link is the last
                  thing to show them on the way. */}
              {!notInvited && (
                <Link href="/host" className="text-[12.5px] text-brand hover:underline">
                  Back to webinars
                </Link>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <Spinner className="size-5 text-ink-3" />
            <p className="text-[13.5px] text-ink-2">
              {openingZoom ? "Opening Zoom…" : "Setting up the room…"}
            </p>
          </div>
        )}
      </Card>
    </main>
  );
}
