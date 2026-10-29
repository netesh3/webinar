"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Alert, Spinner } from "@/components/controls";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";
import { safeNextPath, takeVerifier } from "@/lib/app-auth";
import type { AppAuthExchangeResponse } from "@/lib/api-types";

/**
 * Inside the desktop or mobile app: the end of a Google sign-in that ran in the system
 * browser (29 Oct 2026; lib/app-auth.ts). The app opened this page from
 * `webinarliv://auth/complete?code=…`. It trades the code, with the verifier this webview
 * kept, for the session cookie, then goes where the sign-in was headed.
 */
export default function AppAuthCompletePage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense fallback={<Finishing />}>
          <Complete />
        </Suspense>
      </main>
    </>
  );
}

function Finishing() {
  return (
    <Card className="mx-auto w-full max-w-sm p-6 text-center">
      <Spinner className="mx-auto size-5" />
      <p className="mt-3 text-[13px] text-ink-2">Finishing sign-in…</p>
    </Card>
  );
}

function Complete() {
  const params = useSearchParams();
  const code = params.get("code") ?? "";
  const googleError = params.get("error") ?? "";
  const [error, setError] = useState<string | null>(null);
  // The code and the verifier are good for one try: never send them twice (Strict Mode
  // runs effects twice in development).
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (googleError || !code) {
      // The login page already knows how to explain each reason (?google=denied, …).
      window.location.replace(`/login?google=${encodeURIComponent(googleError || "state")}`);
      return;
    }
    const verifier = takeVerifier();
    if (!verifier) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the one result of a one-shot check
      setError("This sign-in was started somewhere else, or too long ago. Start again from the app.");
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${window.location.origin}/api/auth/app/exchange`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, verifier }),
        });
        const body = (await res.json().catch(() => null)) as
          | (AppAuthExchangeResponse & { message?: string })
          | null;
        if (!res.ok || !body) {
          setError(body?.message || "That sign-in could not be finished. Start again from the app.");
          return;
        }
        // A full load, so every part of the page picks up the new session.
        window.location.replace(safeNextPath(body.next, "/host"));
      } catch {
        setError("Couldn't reach Webinar Liv. Check your connection and sign in again.");
      }
    })();
  }, [code, googleError]);

  if (!error) return <Finishing />;
  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Sign-in didn&rsquo;t finish</h1>
      <div className="mt-3">
        <Alert tone="error">{error}</Alert>
      </div>
      <a href="/login" className="mt-4 inline-block text-[13px] font-medium text-brand hover:underline">
        Back to sign in
      </a>
    </Card>
  );
}
