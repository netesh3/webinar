"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, Spinner } from "@/components/controls";
import { TopNav } from "@/components/top-nav";
import { Button, Card } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

/* The link in the verification mail. No session: confirming the address is
 * what makes sign-in possible, so this page cannot require one. */
export default function VerifyEmailPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense
          fallback={
            <Card className="mx-auto w-full max-w-sm p-6 text-center">
              <Spinner className="mx-auto size-5" />
              <p className="mt-3 text-[13px] text-ink-2">Checking that link…</p>
            </Card>
          }
        >
          <VerifyEmailInner />
        </Suspense>
      </main>
    </>
  );
}

function VerifyEmailInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "done" | "failed">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function confirm() {
    setState("working");
    setMessage(null);
    try {
      await api.verifyEmail(token);
      setState("done");
    } catch (err) {
      setState("failed");
      setMessage(
        err instanceof ApiError ? err.message : "Could not verify that link. Try again.",
      );
    }
  }

  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">Verify your email</h1>
      {token === "" ? (
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
          That link is missing its token. Open the link from the email, or sign in and
          ask for another.
        </p>
      ) : state === "done" ? (
        <>
          <div className="mt-3">
            <Alert tone="ok">Your email is verified.</Alert>
          </div>
          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            If you registered for a webinar, your join link is on its way to this
            inbox. Otherwise, sign in to continue.
          </p>
        </>
      ) : (
        <>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
            Confirm this address to finish creating your account.
          </p>
          {message && (
            <div className="mt-3">
              <Alert tone="error">{message}</Alert>
            </div>
          )}
          <Button
            type="button"
            disabled={state === "working"}
            className="mt-4 w-full"
            onClick={() => void confirm()}
          >
            {state === "working" && <Spinner className="size-4" />}
            {state === "working" ? "Confirming…" : "Confirm email"}
          </Button>
        </>
      )}
      <p className="mt-4 border-t border-line pt-3 text-center text-[12.5px] text-ink-2">
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
