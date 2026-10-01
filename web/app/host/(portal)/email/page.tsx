import { Suspense } from "react";
import { Spinner } from "@/components/controls";
import { EmailScreen } from "@/components/email/email-screen";

/* Host email: inbox and templates. Not a webinar stage tab. */

function Loading() {
  return (
    <div className="grid place-items-center py-20">
      <Spinner className="size-6 text-ink-3" />
    </div>
  );
}

export default function HostEmailPage() {
  return (
    <Suspense fallback={<Loading />}>
      <EmailScreen />
    </Suspense>
  );
}
