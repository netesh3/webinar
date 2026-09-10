import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client for Google OAuth only.
 *
 * Uses `@supabase/ssr` so the PKCE code verifier is stored in cookies (not
 * memory/localStorage). That is required for the round-trip: signInWithOAuth →
 * Google → `/auth/callback` → exchangeCodeForSession. The previous
 * `persistSession: false` client dropped the verifier on navigation and caused
 * "PKCE code verifier not found in storage".
 *
 * After exchange, the callback posts the access token to the API which sets
 * `webcast_session`; the short-lived Supabase cookies are then cleared locally.
 */
export function createSupabaseBrowser(
  url: string,
  anonKey: string,
): SupabaseClient {
  return createBrowserClient(url, anonKey, {
    auth: {
      flowType: "pkce",
      // Manual exchange on /auth/callback — avoid a second auto-detect race.
      detectSessionInUrl: false,
      // App session is webcast_session; no need to refresh Supabase tokens.
      autoRefreshToken: false,
    },
    cookieOptions: {
      path: "/",
      sameSite: "lax",
    },
  });
}

/** Same-origin relative paths only — used for ?next= after OAuth. */
export function safeAuthNext(raw: string | null, fallback = "/"): string {
  if (!raw) return fallback;
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}
