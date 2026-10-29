"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Alert, Spinner } from "@/components/controls";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";
import { safeNextPath } from "@/lib/app-auth";
import { connectErrorMessage, providerLabel } from "@/lib/app-connect";
import type { AppConnectCompleteResponse } from "@/lib/api-types";

/**
 * Inside the desktop or mobile app: the end of a Connect Zoom / Connect YouTube that ran in
 * the system browser (29 Oct 2026; lib/app-connect.ts). The app opened this page from
 * `webinarliv://connect/complete?code=…`. It hands the code to the API, which connects the
 * provider for this webview's own account only, then goes back to where the connect started.
 */
export default function AppConnectCompletePage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense fallback={<Finishing provider="" />}>
          <Complete />
        </Suspense>
      </main>
    </>
  );
}

function Finishing({ provider }: { provider: string }) {
  return (
    <Card className="mx-auto w-full max-w-sm p-6 text-center">
      <Spinner className="mx-auto size-5" />
      <p className="mt-3 text-[13px] text-ink-2">
        {provider ? `Connecting ${providerLabel(provider)}…` : "Finishing…"}
      </p>
    </Card>
  );
}

function Complete() {
  const params = useSearchParams();
  const code = params.get("code") ?? "";
  const provider = params.get("provider") ?? "";
  const failed = params.get("error") ?? "";
  const [error, setError] = useState<string | null>(null);
  // The code is good for one try: never send it twice (Strict Mode runs effects twice).
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (failed || !code) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the one result of a one-shot check
      setError(connectErrorMessage(provider, failed || "invalid"));
      return;
    }
    void (async () => {
      try {
        const res = await fetch(`${window.location.origin}/api/host/integrations/app/complete`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const body = (await res.json().catch(() => null)) as
          | (AppConnectCompleteResponse & { message?: string })
          | null;
        if (res.status === 401) {
          setError("Sign in to the Webinar Liv app first, then connect again.");
          return;
        }
        if (!res.ok || !body) {
          setError(body?.message || connectErrorMessage(provider, "provider"));
          return;
        }
        // A full load, so the integrations list and the session pick up the connection.
        window.location.replace(safeNextPath(body.next, "/settings#integrations"));
      } catch {
        setError("Couldn't reach Webinar Liv. Check your connection and try again.");
      }
    })();
  }, [code, failed, provider]);

  if (!error) return <Finishing provider={provider} />;
  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">{providerLabel(provider)} didn&rsquo;t connect</h1>
      <div className="mt-3">
        <Alert tone="error">{error}</Alert>
      </div>
      <a
        href="/settings#integrations"
        className="mt-4 inline-block text-[13px] font-medium text-brand hover:underline"
      >
        Back to Integrations
      </a>
    </Card>
  );
}
