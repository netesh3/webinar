"use client";

import { usePathname } from "next/navigation";
import { needsManualPhone } from "@/lib/account-phone";
import { AccountPhoneForm } from "./account-phone-form";
import { useSession } from "./providers";
import { Card } from "./ui";

/** Signed-in accounts whose typed phone is empty.
 *
 * Google's People number does not count. Hidden on Settings, where the
 * same field lives on the profile form. */
export function PhoneNeededBanner() {
  const { account, status } = useSession();
  const pathname = usePathname();
  if (status !== "signed-in" || !needsManualPhone(account)) return null;
  if (pathname === "/settings") return null;

  return (
    <Card className="mx-4 mb-4 mt-3 grid gap-2 p-3.5 sm:mx-6">
      <p className="text-[13.5px] font-semibold tracking-[-0.01em]">
        Add a mobile number
      </p>
      <p className="text-[12.5px] leading-relaxed text-ink-2">
        Hosts use it for WhatsApp updates and join reminders. Google sign-in
        cannot collect this for you.
      </p>
      <AccountPhoneForm
        initialPhone=""
        googlePhone={account?.googlePhone}
        required
        submitLabel="Save number"
      />
    </Card>
  );
}
