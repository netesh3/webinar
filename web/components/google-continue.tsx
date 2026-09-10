"use client";

import { useState } from "react";
import { Alert, Spinner } from "./controls";
import { useAppConfig } from "./providers";
import { Button } from "./ui";
import { createSupabaseBrowser, safeAuthNext } from "@/lib/supabase";

/** Starts Supabase Google OAuth; the callback page exchanges for webcast_session. */
export function GoogleContinueButton({
  next,
  label = "Continue with Google",
}: {
  next: string;
  label?: string;
}) {
  const { googleAuth, supabaseUrl, supabaseAnonKey } = useAppConfig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!googleAuth || !supabaseUrl || !supabaseAnonKey) {
    return null;
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const supabase = createSupabaseBrowser(supabaseUrl!, supabaseAnonKey!);
      const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(safeAuthNext(next))}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo,
          queryParams: { prompt: "select_account" },
        },
      });
      if (oauthError) {
        setError(oauthError.message || "Could not start Google sign-in.");
        setBusy(false);
      }
      // On success the browser navigates away to Google.
    } catch {
      setError("Could not start Google sign-in. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2">
      <Button
        type="button"
        variant="secondary"
        size="lg"
        className="w-full"
        disabled={busy}
        onClick={start}
      >
        {busy ? (
          <Spinner className="size-4" />
        ) : (
          <GoogleGlyph className="size-4" />
        )}
        {busy ? "Redirecting…" : label}
      </Button>
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

export function AuthDivider() {
  return (
    <div className="flex items-center gap-3 text-[11.5px] text-ink-3">
      <span className="h-px flex-1 bg-line" aria-hidden />
      <span>or</span>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  );
}

function GoogleGlyph({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}
