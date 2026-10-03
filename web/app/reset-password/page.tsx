import type { Metadata } from "next";
import { Suspense } from "react";
import { ResetPasswordForm } from "@/components/auth-form";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";

/* The token is in this page's address, and it is a credential until it is used. No
 * referrer, so no request this page makes can carry the address anywhere else. */
export const metadata: Metadata = {
  referrer: "no-referrer",
};

/* The link in the reset mail. No session: whoever opens it cannot sign in yet. */
export default function ResetPasswordPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense
          fallback={
            <Card className="h-72 w-full max-w-sm animate-pulse">
              <span className="sr-only">Loading…</span>
            </Card>
          }
        >
          <ResetPasswordForm />
        </Suspense>
      </main>
    </>
  );
}
