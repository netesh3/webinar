import { Suspense } from "react";
import { Spinner } from "@/components/controls";
import { CRMScreen } from "@/engage";

/* Contacts + Inbox, inside the host portal chrome.
 *
 * Client-rendered like the rest of the portal: the session is an httpOnly cookie
 * scoped to the API origin, and the browser is what holds it. A contact list is
 * also the last thing that should be rendered on a server and cached anywhere.
 *
 * A static segment beside /host/[id], so it shadows a webinar whose slug is
 * literally "crm" — the same trade /host/new and /host/login already make.
 *
 * The Suspense boundary is what ?webinar= costs: the screen reads it with
 * useSearchParams, which cannot be resolved while the shell is prerendered. Same
 * shape as /host/[id], which reads ?tab= the same way. */
export default function HostCRMPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-20">
          <Spinner className="size-6 text-ink-3" />
        </div>
      }
    >
      <CRMScreen />
    </Suspense>
  );
}
