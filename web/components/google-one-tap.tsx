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
          }) => void;
          prompt: (
            momentListener?: (notification: {
              isNotDisplayed: () => boolean;
              isSkippedMoment: () => boolean;
              getNotDisplayedReason: () => string;
              getSkippedReason: () => string;
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
      existing.addEventListener("load", () => resolve(), { once: true });
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
    el.onload = () => resolve();
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

      // Desktop One Tap renders top-right by default (Canva-style corner prompt).
      window.google.accounts.id.initialize({
        client_id: clientId!,
        auto_select: false,
        cancel_on_tap_outside: true,
        use_fedcm_for_prompt: true,
        context: "signin",
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
      try {
        window.google?.accounts?.id?.cancel();
      } catch {
        // GIS may be unavailable; ignore.
      }
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
