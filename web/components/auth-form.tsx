"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Alert, Spinner, Toggle } from "./controls";
import { AuthDivider, GoogleContinueButton } from "./google-continue";
import { ContinueAsPreviewHost } from "./continue-as-preview-host";
import { useAppConfig, useSession } from "./providers";
import { Button, Card } from "./ui";
import { ApiError } from "@/lib/api";

/* Sign in and sign up.
 *
 * One account type. Hosting is a capability on it rather than a separate kind of
 * login, because the same person registers for other people's webinars and runs
 * their own — and a product with two front doors makes them pick the wrong one.
 */

/** Only same-origin relative paths, so ?next= cannot be used as an open redirect
 *  to an attacker's site. */
function safeNext(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn } = useSession();
  const { appName, googleAuth } = useAppConfig();
  const next = safeNext(params.get("next"), "/");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not sign in. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Sign in</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        Welcome back to {appName}.
      </p>

      {googleAuth && (
        <div className="mt-5 grid gap-3">
          <GoogleContinueButton next={next} />
          <AuthDivider />
        </div>
      )}

      <form onSubmit={submit} className={`grid gap-3 ${googleAuth ? "mt-3" : "mt-5"}`}>
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={setPassword}
          required
        />

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
          {busy && <Spinner className="size-4" />}
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
        No account?{" "}
        <Link
          href={`/signup?next=${encodeURIComponent(next)}`}
          className="font-medium text-brand hover:underline"
        >
          Create one
        </Link>
      </p>
      <p className="mt-2 text-center text-[11.5px] leading-relaxed text-ink-3">
        You don&apos;t need an account to attend — registering for a webinar
        sends you a personal join link.
      </p>
      <ContinueAsPreviewHost className="mt-4 border-t border-line pt-4 text-center" />
    </Card>
  );
}

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { signUp } = useSession();
  // The password rule comes from the server, so this form cannot promise a length
  // the API does not enforce — and a relaxed floor for local testing shows up here
  // without a second value to change.
  const {
    appName,
    signupOpen,
    minPasswordLength: minPassword,
    googleAuth,
  } = useAppConfig();
  const next = safeNext(params.get("next"), "/");

  /* ?host=1 pre-ticks the "I'd like to host" box for somebody who arrived by asking.
   *
   * The box no longer GRANTS anything — the server ignores wantsHost and only an admin can
   * write can_host. It is kept as a request, and the copy below says so, because the signal
   * is useful: it is logged at signup, so whoever administers the instance has a reason to
   * look. Silently dropping the intent would leave an admin with no way to know anybody is
   * waiting to be granted access. */
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [org, setOrg] = useState("");
  const [wantsHost, setWantsHost] = useState(params.get("host") === "1");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!signupOpen) {
    return (
      <Card className="mx-auto w-full max-w-sm p-6 text-center">
        <h1 className="text-[18px] font-semibold">Sign-ups are closed</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          This {appName} instance isn&apos;t accepting new accounts. You can
          still register for a webinar without one.
        </p>
        <Link
          href="/browse"
          className="mt-4 inline-block text-[13px] font-medium text-brand hover:underline"
        >
          Browse webinars
        </Link>
      </Card>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const account = await signUp({ name, email, password, org, wantsHost });
      router.push(account.canHost ? "/host" : next);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) setFields(err.fields);
        else setError(err.message);
      } else {
        setError("Could not create the account. Check your connection.");
      }
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Create an account</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        One account to attend webinars and to run them.
      </p>

      {googleAuth && (
        <div className="mt-5 grid gap-3">
          <GoogleContinueButton next={next} label="Sign up with Google" />
          <AuthDivider />
        </div>
      )}

      <form onSubmit={submit} className={`grid gap-3 ${googleAuth ? "mt-3" : "mt-5"}`}>
        <Field
          id="name"
          label="Full name"
          autoComplete="name"
          value={name}
          onChange={setName}
          error={fields.name}
          required
        />
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          error={fields.email}
          required
        />
        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          hint={`At least ${minPassword} characters. Length beats punctuation.`}
          minLength={minPassword}
          required
        />
        <Field
          id="org"
          label="Organisation (optional)"
          autoComplete="organization"
          value={org}
          onChange={setOrg}
        />

        <div className="rounded-lg border border-line p-1.5">
          <Toggle
            checked={wantsHost}
            onChange={setWantsHost}
            label="I'd like to host webinars"
            description="This asks an administrator for access — it isn't granted automatically. You can still register for and attend any session in the meantime."
          />
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
          {busy && <Spinner className="size-4" />}
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>

      <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
        Already have one?{" "}
        <Link
          href={`/login?next=${encodeURIComponent(next)}`}
          className="font-medium text-brand hover:underline"
        >
          Sign in
        </Link>
      </p>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  autoComplete,
  required,
  error,
  hint,
  minLength,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  /** Mirrors the server's rule so the browser can catch a short password before a
   *  round trip. The server is still the one that decides. */
  minLength?: number;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        className={`field ${error ? "border-live" : ""}`}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-help` : undefined}
      />
      {error ? (
        <p id={`${id}-help`} className="mt-1 text-[12px] font-medium text-live">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-help`} className="mt-1 text-[11.5px] text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
