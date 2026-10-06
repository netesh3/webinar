import { HostPortalFrame } from "@/components/host-portal-frame";
import { WatchListScreen } from "@/components/watch-list-screen";

/* No data fetched here on purpose.
 *
 * This page used to call api.listWebinars() server-side and hand the whole catalogue to
 * the list, which filtered it down to the caller's registrations in the browser. The list
 * now resolves each registration together with its webinar — from the join-key lookup for
 * guests, from /api/me/registrations for accounts — so there is nothing for the server to
 * fetch and nothing extra to put in the payload.
 *
 * Both of those need the browser: one reads join keys out of localStorage, the other needs
 * the session cookie. So the page is a shell and the client does the asking.
 *
 * The shell is the side panel. A host is redirected to the Attending tab before this
 * renders (lib/access.ts); what is left is an account that cannot host yet.
 */
export default function MyWebinarsPage() {
  return (
    <HostPortalFrame>
      <WatchListScreen />
    </HostPortalFrame>
  );
}
