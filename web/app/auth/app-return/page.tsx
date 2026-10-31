"use client";

import { useEffect, useState } from "react";
import { CopyField, Spinner } from "@/components/controls";
import { Card } from "@/components/ui";
import { appCompleteLink, parseReturnFragment } from "@/lib/app-auth";

/**
 * The system browser's last stop in an app's Google sign-in (29 Oct 2026; lib/app-auth.ts).
 *
 * /api/auth/google/callback lands here with `#code=…` (or `#error=…`) instead of setting a
 * session in this browser. The page opens `webinarliv://auth/complete?code=…`, which the
 * desktop or mobile app catches and finishes in its own window. The code is in the fragment
 * so no server logs it, and it is wiped from this tab's history as soon as it is read. Alone
 * it is worthless: redeeming it takes the verifier only the app holds.
 *
 * Browsers ask before opening an app, and some only from a click, so the button stays.
 *
 * And the code is shown, with Copy (31 Oct 2026): after an update macOS can keep webinarliv://
 * pointed at an older or deleted copy of the app, so the link opens nothing. The desktop app's
 * sign-in page takes the code pasted by hand (components/google-continue.tsx). Shown, it is
 * still useless without the verifier the app kept.
 */
export default function AppReturnPage() {
  const [link, setLink] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [failed, setFailed] = useState(false);
  const [app, setApp] = useState("");

  useEffect(() => {
    const fromHash = parseReturnFragment(window.location.hash);
    const fromQuery = parseReturnFragment(window.location.search);
    const got = fromHash.code || fromHash.error ? fromHash : fromQuery;
    // Out of the address bar and the history: the link below carries it now.
    window.history.replaceState(null, "", window.location.pathname);
    if (!got.code && !got.error) return;
    const next = appCompleteLink(got);
    /* Read from the URL once, on mount. This page has nothing else to render from, so the
     * state has to be set here. */
    /* eslint-disable react-hooks/set-state-in-effect */
    setLink(next);
    setCode(got.code);
    setFailed(!got.code);
    setApp(got.app);
    /* eslint-enable react-hooks/set-state-in-effect */
    window.location.href = next;
  }, []);

  const mobile = app === "ios" || app === "android";
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-16 sm:px-5">
      <Card className="mx-auto w-full max-w-sm p-6 text-center">
        {link ? (
          <>
            <h1 className="text-[18px] font-semibold">
              {failed ? "Sign-in didn’t finish" : "Signed in with Google"}
            </h1>
            <p className="mt-2 text-[13px] text-ink-2">
              {failed
                ? "Go back to the Webinar Liv app to try again."
                : "Returning you to the Webinar Liv app…"}
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
            {code && (
              <div className="mt-5 border-t border-line pt-4 text-left">
                <p className="mb-2 text-[12px] text-ink-2">
                  Didn&rsquo;t open? Copy the code, then in the app choose &ldquo;Paste the
                  code&rdquo; under Continue with Google.
                </p>
                <CopyField value={code} />
              </div>
            )}
          </>
        ) : (
          <>
            <Spinner className="mx-auto size-5" />
            <p className="mt-3 text-[13px] text-ink-2">
              Nothing to hand back here. Start signing in from the Webinar Liv app.
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
