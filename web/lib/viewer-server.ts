/* Who is asking, for a server component that changes what it renders for an admin
 * (app/download/page.tsx). The session cookie is handed to the API, the only thing that can
 * verify it, as middleware.ts does. No cookie means no request. Any failure reads as
 * signed out: the caller then shows what everyone else sees. */

import { cookies } from "next/headers";
import { baseFor } from "./http";

const SESSION_COOKIE = "webcast_session";
const TIMEOUT_MS = 3000;

export async function viewerIsAdmin(): Promise<boolean> {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)?.value) return false;
  try {
    const res = await fetch(`${baseFor()}/api/auth/me`, {
      headers: { cookie: jar.toString() },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const me = (await res.json()) as { isAdmin?: boolean };
    return me.isAdmin === true;
  } catch {
    return false;
  }
}
