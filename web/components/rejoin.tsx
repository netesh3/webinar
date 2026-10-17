"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useJoinKeyFor, useLinkJoinKey } from "./registrations";
import { useAppConfig } from "./providers";
import { Spinner } from "./controls";
import { Button } from "./ui";
import { api } from "@/lib/api";
import { useHydrated } from "@/lib/clock";
import { readPresence, setRejoinIntent, shouldAutoRejoin } from "@/lib/rejoin";
import { trackEvent } from "@/lib/telemetry";

/* The two doors back into a running session that are not the room page itself.
 * The rules are in lib/rejoin.ts and api/internal/api/rejoin.go. */

/** On the webinar's landing page: if this browser was in the room a few minutes ago and the
 *  server agrees the person may go back (live, still approved, not removed — or on the stage),
 *  go straight to the room instead of showing the page. Renders nothing otherwise. */
export function AutoRejoin({ slug }: { slug: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const storedKey = useJoinKeyFor(slug);
  const linkKey = useLinkJoinKey();
  const { telemetryEnabled } = useAppConfig();
  const [going, setGoing] = useState(false);
  const asked = useRef(false);

  useEffect(() => {
    // After hydration, so the stored key has been read rather than reported as missing.
    if (!hydrated || asked.current) return;
    if (!shouldAutoRejoin(readPresence(slug), slug, Date.now())) return;
    asked.current = true;
    api
      .rejoinCheck(slug, linkKey ?? storedKey ?? undefined)
      .then((res) => {
        if (telemetryEnabled) {
          trackEvent("rejoin_check", { userId: "", roomName: slug }, {
            rejoin: res.rejoin,
            reason: res.reason ?? "",
            stage: Boolean(res.stage),
          });
        }
        if (!res.rejoin) return;
        setGoing(true);
        setRejoinIntent(slug);
        router.replace(res.stage ? `/host/${slug}/room` : `/webinars/${slug}/room`);
      })
      // A failed check is a page shown as normal, which is what it would have been anyway.
      .catch(() => {});
  }, [hydrated, slug, linkKey, storedKey, router, telemetryEnabled]);

  if (!going) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-4 z-50 mx-auto flex w-fit items-center gap-2 rounded-full bg-stage px-4 py-2 text-[13px] text-white shadow-lg"
    >
      <Spinner className="size-4" />
      Taking you back to the webinar…
    </div>
  );
}

/** On the host's page for a live webinar they were on the stage of a few minutes ago: a
 *  prominent way back with the mic and camera as they were. Never a forced redirect — the
 *  dashboard is also where a host goes to look at things during their own session. */
export function HostRejoinBanner({ slug, live }: { slug: string; live: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  // Read once on mount; the banner does not need to chase the clock.
  const [recent] = useState(() =>
    typeof window === "undefined"
      ? false
      : shouldAutoRejoin(readPresence(slug), slug, Date.now()),
  );
  if (!hydrated || !live || !recent) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/30 bg-brand/10 px-4 py-3">
      <p className="text-[13.5px] text-ink">
        <span className="font-semibold">You&apos;re live.</span> Go back on stage with your
        microphone and camera as you left them.
      </p>
      <Button
        onClick={() => {
          setRejoinIntent(slug);
          router.push(`/host/${slug}/room`);
        }}
      >
        Rejoin
      </Button>
    </div>
  );
}
