"use client";

import { useEffect, useState } from "react";
import { Spinner } from "@/components/controls";
import { Card } from "@/components/ui";
import { connectCompleteLink, parseConnectFragment, providerLabel } from "@/lib/app-connect";

/**
 * The system browser's last stop in an app's Connect Zoom / Connect YouTube (29 Oct 2026;
 * lib/app-connect.ts). Like /auth/app-return for sign-in.
 *
 * The provider's callback parked its code and sent this browser here with `#code=…` (or
 * `#error=…`). The page opens `webinarliv://connect/complete?code=…`, which the app catches
 * and finishes in its own window, for its own signed-in account. The code is in the fragment
 * so no server logs it, and it leaves this tab's history as soon as it is read.
 */
export default function ConnectAppReturnPage() {
  const [link, setLink] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [app, setApp] = useState("");
  const [provider, setProvider] = useState("");

  useEffect(() => {
    const got = parseConnectFragment(window.location.hash);
    window.history.replaceState(null, "", window.location.pathname);
    if (!got.code && !got.error) return;
    const next = connectCompleteLink(got);
    /* Read from the URL once, on mount: nothing else to render from. */
    /* eslint-disable react-hooks/set-state-in-effect */
    setLink(next);
    setFailed(!got.code);
    setApp(got.app);
    setProvider(got.provider);
    /* eslint-enable react-hooks/set-state-in-effect */
    window.location.href = next;
  }, []);

  const mobile = app === "ios" || app === "android";
  const name = providerLabel(provider);
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-16 sm:px-5">
      <Card className="mx-auto w-full max-w-sm p-6 text-center">
        {link ? (
          <>
            <h1 className="text-[18px] font-semibold">
              {failed ? `${name} didn’t connect` : `Almost done with ${name}`}
            </h1>
            <p className="mt-2 text-[13px] text-ink-2">
              {failed
                ? "Go back to the Webinar Liv app to try again."
                : "Returning you to the Webinar Liv app to finish…"}
            </p>
            <a
              href={link}
              className="mt-4 inline-flex h-10 items-center justify-center rounded-lg bg-brand px-4 text-[14px] font-medium text-white"
            >
              Open Webinar Liv
            </a>
            {!mobile && (
              <p className="mt-4 text-[12px] text-ink-3">
                Once the app has opened, you can close this tab.
              </p>
            )}
          </>
        ) : (
          <>
            <Spinner className="mx-auto size-5" />
            <p className="mt-3 text-[13px] text-ink-2">
              Nothing to hand back here. Start connecting from the Webinar Liv app.
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
