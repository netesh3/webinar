"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/controls";
import { useSession } from "@/components/providers";
import { TopNav } from "@/components/top-nav";
import { ButtonLink, Card } from "@/components/ui";
import { ApiError, api } from "@/lib/api";
import type { KeepRecordingLinkResponse } from "@/lib/api-types";

/* The "Keep 3 more months" link in a recording expiry email.
 *
 * One click: once the host is signed in, the page sends the signed link and says what
 * happened. Signed in as somebody else (or not at all) it does nothing but ask them to sign
 * in as the host — the signature is for one account, and the server checks it against the
 * session. A second visit keeps nothing more (the link names the expiry it was about). */
export default function KeepRecordingPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense fallback={<Working />}>
          <KeepRecordingInner />
        </Suspense>
      </main>
    </>
  );
}

function Working() {
  return (
    <Card className="mx-auto w-full max-w-sm p-6 text-center">
      <Spinner className="mx-auto size-5" />
      <p className="mt-3 text-[13px] text-ink-2">Keeping your recording…</p>
    </Card>
  );
}

function KeepRecordingInner() {
  const params = useSearchParams();
  const { status } = useSession();
  const recording = params.get("r") ?? "";
  const expires = Number(params.get("e") ?? "");
  const sig = params.get("s") ?? "";
  const valid = recording !== "" && sig !== "" && Number.isFinite(expires) && expires > 0;
  const [result, setResult] = useState<KeepRecordingLinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sent = useRef(false);

  useEffect(() => {
    if (status !== "signed-in" || !valid || sent.current) return;
    sent.current = true;
    api
      .keepRecordingLink({ recording, expires, sig })
      .then(setResult)
      .catch((err: unknown) =>
        setError(err instanceof ApiError ? err.message : "Couldn't keep that recording just now. Try again."),
      );
  }, [status, valid, recording, expires, sig]);

  const here = `/recordings/keep?${params.toString()}`;

  if (!valid) {
    return (
      <Message title="This link is incomplete">
        Open the link from the email again, or keep the recording from its Recording tab.
      </Message>
    );
  }
  if (status === "loading") return <Working />;
  if (status === "anonymous") {
    return (
      <Message title="Sign in to keep your recording">
        <p>Sign in as the host the email was sent to, and the recording is kept straight away.</p>
        <ButtonLink href={`/login?next=${encodeURIComponent(here)}`} variant="primary" className="mt-4">
          Sign in
        </ButtonLink>
      </Message>
    );
  }
  if (error) {
    return (
      <Message title="Not kept">
        <p>{error}</p>
        <Link href="/host?tab=past&recording=with" className="mt-3 inline-block text-[13px] font-medium text-brand hover:underline">
          See your recordings
        </Link>
      </Message>
    );
  }
  if (!result) return <Working />;
  const until = result.expiresAt
    ? new Date(result.expiresAt).toLocaleDateString(undefined, { dateStyle: "long" })
    : "";
  return (
    <Message title={result.status === "kept" ? "Recording kept" : "Already kept"}>
      <p>
        {result.status === "kept" ? "" : "This link was used already. "}
        &ldquo;{result.topic}&rdquo; is kept{until ? ` until ${until}` : ""}.
      </p>
      <ButtonLink href={`/host/${encodeURIComponent(result.webinar)}?tab=recording`} variant="secondary" className="mt-4">
        Open the recording
      </ButtonLink>
    </Message>
  );
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card className="mx-auto w-full max-w-sm p-6">
      <h1 className="text-[18px] font-semibold">{title}</h1>
      <div className="mt-2 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </Card>
  );
}
