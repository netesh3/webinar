import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Browser Supabase client for Google OAuth only. Session cookie comes from the API. */
export function createSupabaseBrowser(
  url: string,
  anonKey: string,
): SupabaseClient {
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}

/** Same-origin relative paths only — used for ?next= after OAuth. */
export function safeAuthNext(raw: string | null, fallback = "/"): string {
  if (!raw) return fallback;
  return raw.startsWith("/") && !raw.startsWith("//") ? raw : fallback;
}
