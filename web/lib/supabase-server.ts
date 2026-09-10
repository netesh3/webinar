import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server Supabase client that shares the same cookie jar as
 * `createSupabaseBrowser` (PKCE verifier + short-lived auth cookies).
 *
 * Prefer this for Route Handlers / Server Components that exchange an OAuth
 * `code`. The Google callback page today still runs in the browser (config is
 * loaded from `/api/config`, not Next env), but both clients must use cookies
 * so start and finish stay in one storage context.
 */
export async function createSupabaseServer(
  url: string,
  anonKey: string,
): Promise<SupabaseClient> {
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component where cookies are read-only.
          // Middleware / Route Handlers can write; ignore here.
        }
      },
    },
    cookieOptions: {
      path: "/",
      sameSite: "lax",
    },
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
