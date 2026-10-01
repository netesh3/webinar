import { AdminScreen } from "@/components/admin-screen";
import { HostPortalFrame } from "@/components/host-portal-frame";

/* The admin area, in the same shell as the host pages.
 *
 * Client-rendered like the host portal, for the same reason: the session is an httpOnly cookie
 * scoped to the API origin and the browser is what holds it.
 *
 * Access is decided in three places and only the last is authoritative — lib/access.ts keeps a
 * non-admin from rendering this at all, the API's requireAdmin refuses every request behind it,
 * and the database column is the fact both consult. A page guard alone would be decoration.
 *
 * Dashboard, Accounts and Webinars stay tabs on this page. The sidebar Admin
 * item is the way in; it is not a second navigation column.
 */
export default function AdminPage() {
  return (
    <HostPortalFrame>
      <h1 className="mb-1 text-[26px] font-semibold tracking-[-0.02em]">
        Administration
      </h1>
      <p className="mb-6 text-[14px] text-ink-2">
        What&apos;s happening on this instance, then the accounts and webinars
        behind it.
      </p>
      <AdminScreen />
    </HostPortalFrame>
  );
}
