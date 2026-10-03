import { Suspense } from "react";
import { ForgotPasswordForm } from "@/components/auth-form";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";

/* "Forgot password?" from the sign-in card. No session, and none needed: this is the page
 * for somebody who cannot sign in. */
export default function ForgotPasswordPage() {
  // The form reads ?email= with useSearchParams, which needs a Suspense boundary or the
  // production prerender fails — the same reason the sign-in page has one.
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense
          fallback={
            <Card className="h-64 w-full max-w-sm animate-pulse">
              <span className="sr-only">Loading…</span>
            </Card>
          }
        >
          <ForgotPasswordForm />
        </Suspense>
      </main>
    </>
  );
}
