import { Suspense } from "react";
import { Spinner } from "@/components/controls";
import { HostMessagesInbox, WhatsAppFrame } from "@/engage";

/* WhatsApp Chats. The inbox itself is unchanged; the WhatsApp tabs sit above it.
 * ?tab=messages on Your webinars redirects here so older links still land. */

export default function HostMessagesPage() {
  return (
    <Suspense
      fallback={
        <div className="grid place-items-center py-20">
          <Spinner className="size-6 text-ink-3" />
        </div>
      }
    >
      <WhatsAppFrame tab="chats">
        <HostMessagesInbox />
      </WhatsAppFrame>
    </Suspense>
  );
}
