"use client";

import { usePathname, useRouter } from "next/navigation";
import { needsManualPhone } from "@/lib/account-phone";
import { phonePromptAllowed } from "@/lib/phone-prompt";
import { AccountPhoneForm } from "./account-phone-form";
import { Modal } from "./controls";
import { useSession } from "./providers";
import { Button } from "./ui";

/** Every signed-in account needs a typed mobile number, Google accounts included.
 *
 * Asked here, once, as a step that cannot be skipped, on every page except the
 * ones phonePromptAllowed leaves alone (the webinar register page asks together with
 * WhatsApp consent for that coach). No WhatsApp question here: that consent is per
 * coach and is only asked when registering for one of their webinars. Signing out
 * is the way to leave without a number. */
export function PhonePrompt() {
  const { account, status, signOut } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  if (status !== "signed-in" || !needsManualPhone(account) || !phonePromptAllowed(pathname)) {
    return null;
  }

  return (
    <Modal
      open
      dismissible={false}
      onClose={() => {}}
      size="sm"
      title="Add your mobile number"
      description="Hosts use it to send you join links and reminders. You only need to do this once."
      footer={
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await signOut();
            router.push("/");
          }}
        >
          Sign out
        </Button>
      }
    >
      <AccountPhoneForm
        initialPhone=""
        googlePhone={account?.googlePhone}
        required
        submitLabel="Continue"
      />
    </Modal>
  );
}
