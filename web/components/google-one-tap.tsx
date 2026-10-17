"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAppConfig, useSession } from "@/components/providers";
import { api } from "@/lib/api";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { landingAfterSignIn } from "@/lib/access";
import { safeAuthNext } from "@/lib/supabase";

/**
 * Google One Tap: sign in or sign up from Google's corner prompt, through
 * POST /api/auth/google. One Tap never yields a phone number; the app asks for
 * it straight after (PhonePrompt, or the register page's own popup).
 */

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
            auto_select?: boolean;
            cancel_on_tap_outside?: boolean;
            use_fedcm_for_prompt?: boolean;
            context?: string;
            nonce?: string;
            itp_support?: boolean;
          }) => void;
          prompt: (
            momentListener?: (notification: {
              isNotDisplayed: () => boolean;
              isSkippedMoment: () => boolean;
              isDismissedMoment?: () => boolean;
              getNotDisplayedReason: () => string;
              getSkippedReason: () => string;
              getDismissedReason?: () => string;
            }) => void,
          ) => void;
          cancel: () => void;
        };
      };
    };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";
let gsiLoad: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.accounts?.id) return Promise.resolve();
  if (gsiLoad) return gsiLoad;
  gsiLoad = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GSI_SRC}"]`,
    );
    if (existing) {
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }
      // A script tag left over from a previous load may already be complete, in
      // which case `load` will never fire again and waiting for it hangs forever.
      if (existing.getAttribute("data-gsi-ready") === "1") {
        resolve();
        return;
      }
      // `load` already fired before we attached a listener (HMR, a previous
      // mount that created the tag). readyState is complete in that case.
      const readyState = (existing as HTMLScriptElement & { readyState?: string })
        .readyState;
      if (readyState === "complete" || readyState === "loaded") {
        existing.setAttribute("data-gsi-ready", "1");
        resolve();
        return;
      }
      existing.addEventListener(
        "load",
        () => {
          existing.setAttribute("data-gsi-ready", "1");
          resolve();
        },
        { once: true },
      );
      existing.addEventListener(
        "error",
        () => reject(new Error("GIS script failed")),
        { once: true },
      );
      return;
    }
    const el = document.createElement("script");
    el.src = GSI_SRC;
    el.async = true;
    el.onload = () => {
      el.setAttribute("data-gsi-ready", "1");
      resolve();
    };
    el.onerror = () => reject(new Error("GIS script failed"));
    document.head.appendChild(el);
  }).catch((err) => {
    gsiLoad = null;
    throw err;
  });
  return gsiLoad;
}

function resolveGoogleClientId(fromConfig?: string): string | undefined {
  const fromEnv = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim();
  if (fromEnv) return fromEnv;
  const fromApi = fromConfig?.trim();
  return fromApi || undefined;
}

/** Nonce pair for Google One Tap.
 *
 *  GIS is given the SHA-256 hex and puts that value in the ID token. The API
 *  checks the same hex. Skipping this is why One Tap often "works" (prompt
 *  shows) then fails at session creation with a nonce error. */
async function googleIdNonce(): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const raw = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function GoogleOneTap({
  next = "/browse",
  stay = false,
}: {
  /** Where to land after a successful One Tap sign-in (hosts may still go to /host). */
  next?: string;
  /** Stay on this page and only refresh the session (the webinar register page). */
  stay?: boolean;
}) {
  const router = useRouter();
  const { refresh, status } = useSession();
  const { googleAuth, googleClientId } = useAppConfig();
  const busy = useRef(false);

  useEffect(() => {
    if (isDevAuthBypassActive()) return;
    if (status !== "anonymous") return;
    if (!googleAuth) return;

    const clientId = resolveGoogleClientId(googleClientId);
    if (!clientId) return;

    let cancelled = false;

    async function run() {
      try {
        await loadGsi();
      } catch {
        return;
      }
      if (cancelled || !window.google?.accounts?.id) return;

      const destination = safeAuthNext(next, "/browse");
      const hashedNonce = await googleIdNonce();
      if (cancelled) return;

      // Desktop One Tap renders top-right by default (Canva-style corner prompt).
      window.google.accounts.id.initialize({
        client_id: clientId!,
        nonce: hashedNonce,
        auto_select: false,
        // Outside clicks must not count as a dismiss: GIS then suppresses the
        // prompt for a cooling-off period, which looks like "One Tap is broken".
        cancel_on_tap_outside: false,
        // FedCM is required in Chrome once third-party cookies are gone. It is
        // also a no-op on browsers that do not implement it (Safari, Firefox),
        // where forcing it skips the prompt entirely. Detect rather than assume.
        use_fedcm_for_prompt: "IdentityCredential" in window,
        context: "signin",
        itp_support: true,
        callback: (response) => {
          const credential = response.credential;
          if (!credential || busy.current) return;
          busy.current = true;
          void (async () => {
            try {
              const account = await api.googleAuth(credential, hashedNonce);
              await refresh();
              if (!stay) {
                router.replace(landingAfterSignIn(account.canHost, destination));
              }
              router.refresh();
            } catch (err) {
              console.warn("Google One Tap sign-in failed", err);
              busy.current = false;
            }
          })();
        },
      });

      window.google.accounts.id.prompt((notification) => {
        if (notification.isNotDisplayed()) {
          console.info(
            "Google One Tap not displayed:",
            notification.getNotDisplayedReason(),
          );
        } else if (notification.isSkippedMoment()) {
          console.info(
            "Google One Tap skipped:",
            notification.getSkippedReason(),
          );
        }
      });
    }

    void run();

    return () => {
      cancelled = true;
      // Do not call google.accounts.id.cancel() here. React Strict Mode (and a
      // config refresh) remounts this effect; cancel() is treated as a user
      // dismiss and GIS then hides One Tap for hours. The prompt tears down
      // with the page on its own.
    };
  }, [
    status,
    googleAuth,
    googleClientId,
    next,
    stay,
    refresh,
    router,
  ]);

  return null;
}
