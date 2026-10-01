import { Suspense } from "react";
import { LoginForm } from "@/components/auth-form";
import { LoginGoogleOneTap } from "@/components/login-google-one-tap";
import { Card } from "@/components/ui";
import { LoginSessionGate } from "./session-gate";

export default function LoginPage() {
  // LoginForm reads ?next= with useSearchParams, which forces a client bailout.
  // Without a Suspense boundary the production prerender fails outright — a
  // failure `next dev` never surfaces.
  //
  // No top bar. Email, the bell, the account name and the avatar are the host
  // shell, and this page is only the sign-in card. A session that middleware
  // already confirmed never reaches here; the gate covers one that resolves
  // in the browser after the first paint.
  return (
    <LoginSessionGate>
      <Suspense fallback={null}>
        <LoginGoogleOneTap />
      </Suspense>
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
    </LoginSessionGate>
  );
}
