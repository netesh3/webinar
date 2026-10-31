"use client";

import { useRef, useState, type FormEvent } from "react";
import { Alert, Spinner } from "./controls";
import { useAppConfig } from "./providers";
import { Button } from "./ui";
import { pastedAppCode, startAppGoogleSignIn } from "@/lib/app-auth";
import { safeAuthNext } from "@/lib/supabase";
import { googleLoginHint } from "@/lib/webinar-register";

/* Starts first-party Google OAuth on this origin.
 *
 * The browser goes to `/api/auth/google/start` (Worker/Next proxy → Cloud Run),
 * then accounts.google.com, then `/api/auth/google/callback`. It never hits
 * `*.supabase.co`. `next` is a same-origin path round-tripped in signed state
 * so a webinar registration comes back to that webinar.
 *
 * Inside the desktop or mobile app (29 Oct 2026) the same start URL opens in the system
 * browser instead, and the sign-in comes back to the app through webinarliv:// (lib/app-auth.ts).
 * That resolves "external": this page stays where it is.
 */
export async function startGoogleOAuth(opts: {
  next: string;
  loginHint?: string;
}): Promise<"navigating" | "external"> {
  const params = new URLSearchParams();
  params.set("next", safeAuthNext(opts.next));
  const hint = googleLoginHint(opts.loginHint ?? "");
  if (hint) params.set("login_hint", hint);
  if (await startAppGoogleSignIn({ next: params.get("next") ?? "/", loginHint: hint || undefined })) {
    return "external";
  }
  // Full navigation to the API proxy (Worker / Cloud Run), not a Next.js page.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(
    `${window.location.origin}/api/auth/google/start?${params.toString()}`,
  );
  return "navigating";
}

/** Starts first-party Google OAuth; Cloud Run sets webcast_session on callback. */
export function GoogleContinueButton({
  next,
  loginHint,
  label = "Continue with Google",
}: {
  next: string;
  loginHint?: string;
  label?: string;
}) {
  const { googleAuth } = useAppConfig();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [external, setExternal] = useState(false);
  // A second click before the first has re-rendered the button disabled (31 Oct 2026).
  const starting = useRef(false);

  if (!googleAuth) {
    return null;
  }

  async function start() {
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    try {
      if ((await startGoogleOAuth({ next, loginHint })) === "external") {
        // The app opened the browser; the sign-in comes back here by itself.
        setExternal(true);
        setBusy(false);
      }
      // Otherwise the browser navigates away to Google.
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not start Google sign-in. Check your connection.",
      );
      setBusy(false);
    } finally {
      starting.current = false;
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
      {external && !error && (
        <>
          <p className="text-center text-[12.5px] text-ink-2">
            Finish signing in with Google in your browser. You&rsquo;ll come straight back here.
          </p>
          <PasteAppCode />
        </>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}

/* When webinarliv:// does not reach this copy of the app (31 Oct 2026: macOS can keep the
 * scheme on an older or deleted copy after an update), /auth/app-return shows the code to
 * copy. Pasted here it goes through /auth/complete as the link would. The code alone is
 * useless without the verifier this app kept, so showing it in the browser is safe. */
function PasteAppCode() {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const code = pastedAppCode(value);
    if (!code) {
      setInvalid(true);
      return;
    }
    // A full load, as the webinarliv:// link gives the page.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign(`/auth/complete?code=${encodeURIComponent(code)}`);
  }

  return (
    <details className="text-[12.5px] text-ink-2">
      <summary className="cursor-pointer text-center">
        Signed in in the browser but nothing happened? Paste the code
      </summary>
      <form onSubmit={submit} className="mt-2 flex gap-2">
        <input
          aria-label="Sign-in code from the browser"
          className={`field min-w-0 flex-1 font-mono ${invalid ? "border-live" : ""}`}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setInvalid(false);
          }}
        />
        <Button type="submit" variant="secondary">
          Continue
        </Button>
      </form>
      {invalid && <p className="mt-1 text-live">That doesn&rsquo;t look like a sign-in code.</p>}
    </details>
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
