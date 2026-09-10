import { Suspense } from "react";
import { SignupForm } from "@/components/auth-form";
import { TopNav } from "@/components/top-nav";
import { Card } from "@/components/ui";

export default function SignupPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto flex w-full max-w-6xl flex-1 items-start justify-center px-4 py-10 sm:px-5">
        <Suspense
          fallback={
            <Card className="h-[28rem] w-full max-w-sm animate-pulse">
              <span className="sr-only">Loading sign up…</span>
            </Card>
          }
        >
          <SignupForm />
        </Suspense>
      </main>
    </>
  );
}
