"use client";

import { Badge, Card } from "../ui";
import type { Account } from "@/lib/api-types";

/** The account itself: the address you sign in with, and whether an
 *  administrator has granted hosting. Neither is edited here. */
export function AccountSection({ account }: { account: Account }) {
  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Account</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Sign-in and hosting. An administrator changes hosting; you don&apos;t.
      </p>
      <Card className="mt-4 grid max-w-lg gap-3 p-5">
        <div>
          <div className="text-[12px] text-ink-3">Email</div>
          <div className="mt-0.5 text-[14px]">{account.email}</div>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Hosting access</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
              {account.canHost
                ? "You can schedule and run webinars."
                : "Only an administrator can grant this. Ask whoever runs this instance."}
            </div>
          </div>
          <Badge tone={account.canHost ? "ok" : undefined}>
            {account.canHost ? "Granted" : "Not granted"}
          </Badge>
        </div>
      </Card>
    </section>
  );
}
