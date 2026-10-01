"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useSession } from "@/components/providers";

/* A signed-in visit to /login must not paint the form.
 *
 * Middleware already redirects when the session cookie checks out, which is
 * the path that used to render the account bar around this card. This covers
 * the other one: the cookie was present but the lookup did not finish in
 * time, so the page was allowed through, and the client session then resolves
 * to an account. Redirect before that frame can sit on screen. */
export function LoginSessionGate({ children }: { children: ReactNode }) {
  const { status } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (status === "signed-in") router.replace("/host");
  }, [status, router]);

  if (status === "signed-in") return null;
  return children;
}
