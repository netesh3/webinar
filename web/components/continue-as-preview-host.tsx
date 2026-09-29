"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import { isDevAuthBypass } from "@/lib/dev-bypass-flag";
import {
  continueAsPreviewHost,
  isDevBypassOptedOut,
} from "@/lib/dev-bypass-session";

/* Shown when NEXT_PUBLIC_DEV_BYPASS_AUTH=1 but this tab signed out of the
 * fake host session. One click clears webcast.devBypassOff and re-enters preview. */

/* sessionStorage has no change event within a tab, and the only way the opt-out
 * is cleared from here is a hard navigation, so there is nothing to subscribe to.
 * The server snapshot keeps the first client render matching the server's. */
const subscribeNothing = () => () => {};
const readShow = () => isDevAuthBypass() && isDevBypassOptedOut();
const readShowOnServer = () => false;

export function ContinueAsPreviewHost({
  className,
  dest = "/host",
}: {
  className?: string;
  dest?: string;
}) {
  const show = useSyncExternalStore(subscribeNothing, readShow, readShowOnServer);

  if (!show) return null;

  return (
    <div className={className}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => continueAsPreviewHost(dest)}
      >
        Continue as Preview Host
      </Button>
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
        Local bypass is on — you signed out of the fake session. Or open{" "}
        <a className="underline hover:text-ink" href="/preview">
          /preview
        </a>{" "}
        or{" "}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a full page load is the point: middleware clears the opt-out cookie on ?bypass=1, and the session provider only re-reads the bypass on mount. */}
        <a className="underline hover:text-ink" href="/?bypass=1">
          /?bypass=1
        </a>
        .
      </p>
    </div>
  );
}
