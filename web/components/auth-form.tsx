"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert, Spinner } from "./controls";
import { AuthDivider, GoogleContinueButton } from "./google-continue";
import { ContinueAsPreviewHost } from "./continue-as-preview-host";
import { useAppConfig, useSession } from "./providers";
import { Button, Card } from "./ui";
import { ApiError } from "@/lib/api";
import { DIAL_CODES, dialOptions } from "@/lib/dial-codes";

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
      <p className="mt-3 text-center text-[11.5px] text-ink-3">
        <Link href="/privacy" className="hover:underline">
          Privacy
        </Link>
        {" · "}
        <Link href="/terms" className="hover:underline">
          Terms
        </Link>
      </p>
      <ContinueAsPreviewHost className="mt-4 border-t border-line pt-4 text-center" />
    </Card>
  );
}

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { signUp } = useSession();
  const { appName, signupOpen, googleAuth } = useAppConfig();
  const next = safeNext(params.get("next"), "/");

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [dialIso, setDialIso] = useState("IN");
  const [phoneNumber, setPhoneNumber] = useState("");
  const dials = useMemo(() => dialOptions(), []);
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!signupOpen) {
    return (
      <Card className="mx-auto w-full max-w-sm p-6 text-center">
        <h1 className="text-[18px] font-semibold">Sign-ups are closed</h1>
        {/* No link onward. Browse needs a session to list anything, and this
            card is read by the one visitor who cannot get one — pointing them
            at "Sign in to see your sessions" would be a circle. An invitation
            link is what still works without an account, and that is what this
            says. */}
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          This {appName} instance isn&apos;t accepting new accounts. You can
          still register for a webinar without one — open the invitation link
          you were sent.
        </p>
      </Card>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    const digits = phoneNumber.replace(/\D/g, "");
    if (digits && digits.length !== 10) {
      setBusy(false);
      setFields({ phone: "Enter a 10-digit mobile number." });
      return;
    }
    try {
      const phone = digits ? `+${DIAL_CODES[dialIso] ?? ""}${digits}` : "";
      const account = await signUp({ name, email, password, phone });
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

        <div>
          <label className="label" htmlFor="phone">
            Mobile number <span className="text-ink-3">(optional)</span>
          </label>
          <div className="flex gap-2">
            <select
              aria-label="Country calling code"
              className="field w-32 shrink-0"
              value={dialIso}
              onChange={(e) => setDialIso(e.target.value)}
            >
              {dials.map((d) => (
                <option key={d.iso} value={d.iso}>
                  {d.label}
                </option>
              ))}
            </select>
            <input
              id="phone"
              className={`field min-w-0 flex-1 ${fields.phone ? "border-live" : ""}`}
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              placeholder="98765 43210"
              maxLength={10}
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value.replace(/\D/g, "").slice(0, 10))}
              aria-invalid={Boolean(fields.phone)}
            />
          </div>
          {fields.phone && (
            <p className="mt-1 text-[12px] font-medium text-live">{fields.phone}</p>
          )}
        </div>

        <Field
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          required
        />

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
      <p className="mt-3 text-center text-[11.5px] text-ink-3">
        <Link href="/privacy" className="hover:underline">
          Privacy
        </Link>
        {" · "}
        <Link href="/terms" className="hover:underline">
          Terms
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
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  error?: string;
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-help` : undefined}
      />
      {error && (
        <p id={`${id}-help`} className="mt-1 text-[12px] font-medium text-live">
          {error}
        </p>
      )}
    </div>
  );
}
