"use client";

import { useAppConfig } from "../providers";
import { Card } from "../ui";

/** What this product already tells a host. There is no per-message switch:
 *  approval alerts and the WhatsApp reply digest are how the product works,
 *  not preferences someone can turn off from here. */
export function NotificationsSection() {
  const { emailConfigured } = useAppConfig();
  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Notifications</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        How you hear about registrations and replies. These are on for every host.
      </p>
      <div className="mt-4 grid gap-3">
        <Card className="px-4 py-3">
          <p className="text-[13.5px] font-medium">Registration alerts</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
            When someone registers and needs a decision, it shows on the bell.
            {emailConfigured
              ? " You also get the email."
              : " Email is not set up on this instance, so the bell is the whole of it."}
          </p>
        </Card>
        <Card className="px-4 py-3">
          <p className="text-[13.5px] font-medium">WhatsApp replies</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
            When people answer a confirmation, reminder or follow-up, a digest
            email lists who is waiting. The replies themselves stay in Messages.
          </p>
        </Card>
      </div>
    </section>
  );
}
