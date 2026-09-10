import { Suspense } from "react";
import { LoginForm } from "@/components/auth-form";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";

export default function LoginPage() {
  // LoginForm reads ?next= with useSearchParams, which forces a client bailout.
  // Without a Suspense boundary the production prerender fails outright — a
  // failure `next dev` never surfaces.
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense
          fallback={
            <Card className="h-80 w-full max-w-sm animate-pulse">
              <span className="sr-only">Loading sign in…</span>
            </Card>
          }
        >
          <LoginForm />
        </Suspense>
      </main>
    </>
  );
}
