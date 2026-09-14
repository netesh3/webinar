"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useAppConfig, useSession } from "@/components/providers";
import { api } from "@/lib/api";
import { isDevAuthBypassActive } from "@/lib/dev-bypass-session";
import { createSupabaseBrowser, safeAuthNext } from "@/lib/supabase";

/**
 * Google One Tap / FedCM prompt for logged-out visitors on public pages.
 *
 * Uses Identity Services (accounts.google.com/gsi/client). On success the
 * credential JWT goes through Supabase `signInWithIdToken`, then the same
 * `POST /api/auth/supabase` path as "Continue with Google".
 *
 * No-ops when Google auth is off, the client ID is missing, GIS is blocked,
 * or the visitor is already signed in. Never mounts inside the room.
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

/** Nonce pair Google One Tap + Supabase `signInWithIdToken` both require.
 *
 *  GIS gets the SHA-256 hex; Supabase gets the raw value and checks it against
 *  the JWT. Skipping this is why One Tap often "works" (prompt shows) then
 *  fails at session creation with a nonce error. */
async function googleIdNonce(): Promise<{ raw: string; hashed: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const raw = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { raw, hashed };
}

export function GoogleOneTap({
  next = "/browse",
}: {
  /** Where to land after a successful One Tap sign-in (hosts may still go to /host). */
  next?: string;
}) {
  const router = useRouter();
  const { refresh, status } = useSession();
  const { googleAuth, googleClientId, supabaseUrl, supabaseAnonKey } =
    useAppConfig();
  const busy = useRef(false);

  useEffect(() => {
    if (isDevAuthBypassActive()) return;
    if (status !== "anonymous") return;
    if (!googleAuth || !supabaseUrl || !supabaseAnonKey) return;

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
      const { raw: nonce, hashed: hashedNonce } = await googleIdNonce();
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
              const supabase = createSupabaseBrowser(
                supabaseUrl!,
                supabaseAnonKey!,
              );
              const { data, error } = await supabase.auth.signInWithIdToken({
                provider: "google",
                token: credential,
                nonce,
              });
              if (error) throw error;
              const accessToken = data.session?.access_token;
              if (!accessToken) {
                throw new Error("No session from Google One Tap.");
              }
              const account = await api.supabaseAuth(accessToken);
              await supabase.auth.signOut({ scope: "local" }).catch(() => {});
              await refresh();
              router.replace(
                account.canHost &&
                  (destination === "/" || destination === "/browse")
                  ? "/host"
                  : destination,
              );
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
    supabaseUrl,
    supabaseAnonKey,
    next,
    refresh,
    router,
  ]);

  return null;
}
