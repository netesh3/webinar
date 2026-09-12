import { AdminScreen } from "@/components/admin-screen";
import { TopNav } from "@/components/top-nav";

/* The admin area.
 *
 * Client-rendered like the host portal, for the same reason: the session is an httpOnly cookie
 * scoped to the API origin and the browser is what holds it.
 *
 * Access is decided in three places and only the last is authoritative — lib/access.ts keeps a
 * non-admin from rendering this at all, the API's requireAdmin refuses every request behind it,
 * and the database column is the fact both consult. A page guard alone would be decoration.
 */
export default function AdminPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-8">
        <h1 className="mb-1 text-[26px] font-semibold tracking-[-0.02em]">
          Administration
        </h1>
        <p className="mb-6 text-[14px] text-ink-2">
          Who can host webinars, every webinar on this instance, and
          accounts.
        </p>
        <AdminScreen />
      </main>
    </>
  );
}
