"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Alert, Spinner } from "@/components/controls";
import { useAppConfig, useSession } from "@/components/providers";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import { createSupabaseBrowser, safeAuthNext } from "@/lib/supabase";

/**
 * OAuth return path. Supabase redirects here with a ?code=; we exchange it for
 * a Supabase session, then POST the access token to the API which sets
 * webcast_session (first-party via the Worker /api proxy).
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
  const { refresh } = useSession();
  const { googleAuth, supabaseUrl, supabaseAnonKey } = useAppConfig();
  const next = safeAuthNext(params.get("next"), "/");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function finish() {
      const oauthError = params.get("error_description") || params.get("error");
      if (oauthError) {
        setError(oauthError);
        return;
      }

      try {
        // Prefer live /api/config so a cold callback is not stuck on the fallback
        // AppConfig (which has googleAuth off until the first fetch lands).
        let url = supabaseUrl;
        let anon = supabaseAnonKey;
        let enabled = googleAuth;
        if (!enabled || !url || !anon) {
          const cfg = await api.config();
          url = cfg.supabaseUrl;
          anon = cfg.supabaseAnonKey;
          enabled = cfg.googleAuth;
        }
        if (!enabled || !url || !anon) {
          setError("Google sign-in is not configured on this instance.");
          return;
        }

        const supabase = createSupabaseBrowser(url, anon);
        const code = params.get("code");
        let accessToken: string | undefined;

        if (code) {
          const { data, error: exchangeError } =
            await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) {
            throw new Error(exchangeError.message);
          }
          accessToken = data.session?.access_token;
        } else {
          const { data, error: sessionError } = await supabase.auth.getSession();
          if (sessionError) {
            throw new Error(sessionError.message);
          }
          accessToken = data.session?.access_token;
        }

        if (!accessToken) {
          throw new Error("No session returned from Google. Try again.");
        }

        const account = await api.supabaseAuth(accessToken);
        // Drop the short-lived Supabase session; the app cookie is authoritative.
        await supabase.auth.signOut({ scope: "local" }).catch(() => {});

        if (cancelled) return;
        await refresh();
        router.replace(account.canHost && next === "/" ? "/host" : next);
        router.refresh();
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Could not finish Google sign-in.",
        );
      }
    }

    void finish();
    return () => {
      cancelled = true;
    };
  }, [
    googleAuth,
    supabaseUrl,
    supabaseAnonKey,
    params,
    next,
    refresh,
    router,
  ]);

  if (error) {
    return (
      <Card className="mx-auto w-full max-w-sm p-6">
        <h1 className="text-[18px] font-semibold">Sign-in failed</h1>
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
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
