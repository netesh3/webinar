"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Alert, Spinner } from "@/components/controls";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";
import { safeAuthNext } from "@/lib/supabase";

/**
 * Legacy OAuth return path. Sign-in now finishes on
 * `/api/auth/google/callback` (session cookie set, then redirect). This page
 * only exists so an old bookmark or a leftover Google error query still has
 * somewhere polite to land.
 */
export default function AuthCallbackPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense
          fallback={
            <Card className="mx-auto w-full max-w-sm p-6 text-center">
              <Spinner className="mx-auto size-5" />
              <p className="mt-3 text-[13px] text-ink-2">Finishing sign-in…</p>
            </Card>
          }
        >
          <AuthCallbackInner />
        </Suspense>
      </main>
    </>
  );
}

function AuthCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeAuthNext(params.get("next"), "/");
  const oauthError = params.get("error_description") || params.get("error");

  useEffect(() => {
    if (oauthError) return;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [oauthError, next, router]);

  if (oauthError) {
    return (
      <Card className="mx-auto w-full max-w-sm p-6">
        <h1 className="text-[18px] font-semibold">Sign-in failed</h1>
        <div className="mt-3">
          <Alert tone="error">{oauthError}</Alert>
        </div>
        <a
          href={`/login?next=${encodeURIComponent(next)}`}
          className="mt-4 inline-block text-[13px] font-medium text-brand hover:underline"
        >
          Back to sign in
        </a>
      </Card>
    );
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6 text-center">
      <Spinner className="mx-auto size-5" />
      <p className="mt-3 text-[13px] text-ink-2">Finishing sign-in…</p>
    </Card>
  );
}
