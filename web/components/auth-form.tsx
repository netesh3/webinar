"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Alert, Spinner } from "./controls";
import { AuthDivider, GoogleContinueButton } from "./google-continue";
import { ContinueAsPreviewHost } from "./continue-as-preview-host";
import { useAppConfig, useSession, useToast } from "./providers";
import { Button, ButtonLink, Card } from "./ui";
import { ApiError, api } from "@/lib/api";
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
  const [unverified, setUnverified] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUnverified(false);
    try {
      await signIn(email, password);
      router.push(next);
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === "email_unverified") {
        setUnverified(true);
      }
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not sign in. Check your connection and try again.",
      );
      setBusy(false);
    }
  }

  if (unverified) {
    return <VerifyEmailNotice email={email} message={error ?? "Verify your email to continue."} />;
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
          aside={
            /* Carries the address already typed, so it is not asked for twice. */
            <Link
              href={
                email.trim()
                  ? `/forgot-password?email=${encodeURIComponent(email.trim())}`
                  : "/forgot-password"
              }
              className="text-[12.5px] font-medium text-brand hover:underline"
            >
              Forgot password?
            </Link>
          }
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
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
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
      const pending = await signUp({ name, email, password, phone });
      setPendingEmail(pending.email);
      setBusy(false);
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

  if (pendingEmail) {
    return (
      <VerifyEmailNotice
        email={pendingEmail}
        message="Verify your email to continue."
      />
    );
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

/* Forgot password: asks for the link that sets a new one.
 *
 * The API answers the same whether or not an account uses the address, so this never
 * says which it was — "sent" reads as "if there is one". Each new link replaces the last,
 * which is why a second send says to use the newest mail. */
export function ForgotPasswordForm() {
  const params = useSearchParams();
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sends, setSends] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(address: string) {
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(address);
      setSentTo(address);
      setSends((n) => n + 1);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Could not send the link. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (sentTo !== null) {
    return (
      <Card className="mx-auto w-full max-w-sm p-6">
        <h1 className="text-[18px] font-semibold">Check your email</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
          If an account uses <span className="font-medium text-ink">{sentTo}</span>, we
          sent it a link to choose a new password. It works once and expires in 1 hour.
        </p>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          Nothing after a few minutes? Check your spam folder, or send another.
        </p>
        {sends > 1 && !error && (
          <div className="mt-3">
            <Alert tone="ok">Sent again. Use the newest email — it replaces the earlier link.</Alert>
          </div>
        )}
        {error && (
          <div className="mt-3">
            <Alert tone="error">{error}</Alert>
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          className="mt-4 w-full"
          onClick={() => void send(sentTo)}
        >
          {busy && <Spinner className="size-4" />}
          {busy ? "Sending…" : "Send another link"}
        </Button>
        <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
          <Link href="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Reset your password</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        Enter the email you sign in with, and we&apos;ll send you a link to choose a new
        password.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(email.trim());
        }}
        className="mt-5 grid gap-3"
      >
        <Field
          id="email"
          label="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={setEmail}
          required
        />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
          {busy && <Spinner className="size-4" />}
          {busy ? "Sending…" : "Send reset link"}
        </Button>
      </form>
      <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
        Remembered it?{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}

/* The link in the reset mail. Nothing happens until the form is sent, so a mail scanner
 * that opens the link cannot spend it. Saving signs in here and signs out every other
 * browser on the account. */
export function ResetPasswordForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const router = useRouter();
  const { refresh } = useSession();
  const { notify } = useToast();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [deadLink, setDeadLink] = useState(token === "");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFields({});
    // Typed blind, so a slip here is a password nobody knows. Checked before the link
    // is spent, rather than after.
    if (password !== confirm) {
      setFields({ confirm: "Those passwords don't match." });
      return;
    }
    setBusy(true);
    try {
      await api.resetPassword(token, password);
      await refresh();
      notify("Password changed. You're signed in.", "ok");
      router.push("/");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFields(err.fields);
      } else if (err instanceof ApiError) {
        setError(err.message);
        setDeadLink(err.code === "invalid_token" || err.code === "expired_token");
      } else {
        setError("Could not save the new password. Check your connection and try again.");
      }
      setBusy(false);
    }
  }

  if (deadLink) {
    return (
      <Card className="mx-auto w-full max-w-sm p-6">
        <h1 className="text-[18px] font-semibold">Ask for a new link</h1>
        <div className="mt-3">
          <Alert tone="error">
            {error ??
              "That link is missing its token. Open the link from the email, or ask for a new one."}
          </Alert>
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
          Reset links work once and expire after an hour. Asking again sends a fresh one.
        </p>
        <ButtonLink href="/forgot-password" className="mt-4 w-full">
          Send me a new link
        </ButtonLink>
        <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
          <Link href="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Choose a new password</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">
        You&apos;ll be signed in once it&apos;s saved, and signed out on every other device.
      </p>
      <form onSubmit={submit} className="mt-5 grid gap-3">
        <Field
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={fields.password}
          required
        />
        <Field
          id="confirm"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          error={fields.confirm}
          required
        />
        {error && <Alert tone="error">{error}</Alert>}
        <Button type="submit" disabled={busy} size="lg" className="mt-1 w-full">
          {busy && <Spinner className="size-4" />}
          {busy ? "Saving…" : "Save new password"}
        </Button>
      </form>
      <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
        <Link href="/login" className="font-medium text-brand hover:underline">
          Back to sign in
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
  aside,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  error?: string;
  /** Beside the label, right-aligned — the "Forgot password?" link. */
  aside?: React.ReactNode;
}) {
  return (
    <div>
      {aside ? (
        <div className="flex items-baseline justify-between gap-3">
          <label className="label" htmlFor={id}>
            {label}
          </label>
          {aside}
        </div>
      ) : (
        <label className="label" htmlFor={id}>
          {label}
        </label>
      )}
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

/* Shown after password signup, and when sign-in is refused because the address
 * is still unconfirmed. There is no session either way, so resend is the way
 * to get another link. */
function VerifyEmailNotice({ email, message }: { email: string; message: string }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resend() {
    setBusy(true);
    setError(null);
    try {
      await api.resendVerification(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not send another link.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Verify your email</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{message}</p>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
        We sent a link to <span className="font-medium text-ink">{email}</span>. It
        works once and expires in 24 hours.
      </p>
      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {sent && (
        <div className="mt-3">
          <Alert tone="ok">Sent. Check your inbox for the new link.</Alert>
        </div>
      )}
      <Button type="button" disabled={busy} className="mt-4 w-full" onClick={() => void resend()}>
        {busy && <Spinner className="size-4" />}
        {busy ? "Sending…" : "Resend link"}
      </Button>
      <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
        Already verified?{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
