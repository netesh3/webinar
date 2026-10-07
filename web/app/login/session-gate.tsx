"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useSession } from "@/components/providers";
import { ApiError, api } from "@/lib/api";
import { appHome, landingAfterSignIn } from "@/lib/access";
import { loginRedirectBlocked, noteLoginRedirect, publishSignOut } from "@/lib/login-redirect";

/* A signed-in visit to /login must not paint the form — once the cookie
 * agrees.
 *
 * Middleware already redirects when the session cookie checks out. This
 * covers the visit that was allowed through before that lookup finished.
 * The in-memory session is not that cookie: it is set once, and it stays
 * set after the cookie is gone. Sending that memory on with router.replace
 * is a client navigation, so the browser never stops it, and the tab loops
 * /host → /host/login → /login. Ask /api/auth/me again before leaving. A
 * 401 means the memory is stale: drop it and show the form. The hop counter
 * is the backstop for the next time memory and the cookie disagree.
 */
export function LoginSessionGate({ children }: { children: ReactNode }) {
  const { account, status, clearSession } = useSession();
  const router = useRouter();
  const [stay, setStay] = useState(false);

  useEffect(() => {
    if (stay) return;
    if (status !== "signed-in" || !account) return;
    let active = true;
    const next = new URLSearchParams(window.location.search).get("next");
    const safe =
      next && next.startsWith("/") && !next.startsWith("//") ? next : appHome(account.canHost);
    const target = landingAfterSignIn(account.canHost, safe);

    api
      .me(true)
      .then(() => {
        if (!active) return;
        if (loginRedirectBlocked(target, Date.now(), window.sessionStorage)) {
          setStay(true);
          return;
        }
        noteLoginRedirect(target, Date.now(), window.sessionStorage);
        router.replace(target);
      })
      .catch((err: unknown) => {
        if (!active) return;
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          publishSignOut();
          return;
        }
        setStay(true);
      });
    return () => {
      active = false;
    };
  }, [status, account, router, clearSession, stay]);

  if (status === "signed-in" && !stay) return null;
  return children;
}
