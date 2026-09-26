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
 *
 * The width matches the host portal (max-w-6xl, and px-4 until sm) rather than the narrower
 * column this page used when it was only two lists. A dashboard of figures needs the room,
 * and the same 767px line the rest of the app treats as a phone still stacks it.
 */
export default function AdminPage() {
  return (
    <>
      <TopNav />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-5">
        <h1 className="mb-1 text-[26px] font-semibold tracking-[-0.02em]">
          Administration
        </h1>
        <p className="mb-6 text-[14px] text-ink-2">
          What&apos;s happening on this instance, then the accounts and
          webinars behind it.
        </p>
        <AdminScreen />
      </main>
    </>
  );
}
