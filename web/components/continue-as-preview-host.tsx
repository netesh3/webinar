"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { isDevAuthBypass } from "@/lib/dev-bypass-flag";
import {
  continueAsPreviewHost,
  isDevBypassOptedOut,
} from "@/lib/dev-bypass-session";

/* Shown when NEXT_PUBLIC_DEV_BYPASS_AUTH=1 but this tab signed out of the
 * fake host session. One click clears webcast.devBypassOff and re-enters preview. */

export function ContinueAsPreviewHost({
  className,
  dest = "/host",
}: {
  className?: string;
  dest?: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(isDevAuthBypass() && isDevBypassOptedOut());
  }, []);

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
        <a className="underline hover:text-ink" href="/?bypass=1">
          /?bypass=1
        </a>
        .
      </p>
    </div>
  );
}
