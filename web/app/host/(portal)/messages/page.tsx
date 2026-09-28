import { Suspense } from "react";
import { Spinner } from "@/components/controls";
import { HostMessagesInbox } from "@/engage";

/* WhatsApp Messages, its own route. The chat icon in the top bar opens it;
 * ?tab=messages on Your webinars redirects here so older links still land. */

export default function HostMessagesPage() {
  return (
    <Suspense
      fallback={
        <div className="grid flex-1 place-items-center">
          <Spinner className="size-6 text-ink-3" />
        </div>
      }
    >
      <HostMessagesInbox />
    </Suspense>
  );
}
