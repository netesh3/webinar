import { CRMScreen } from "@/components/crm-screen";

/* Contacts + Inbox, inside the host portal chrome.
 *
 * Client-rendered like the rest of the portal: the session is an httpOnly cookie
 * scoped to the API origin, and the browser is what holds it. A contact list is
 * also the last thing that should be rendered on a server and cached anywhere.
 *
 * A static segment beside /host/[id], so it shadows a webinar whose slug is
 * literally "crm" — the same trade /host/new and /host/login already make. */
export default function HostCRMPage() {
  return <CRMScreen />;
}
