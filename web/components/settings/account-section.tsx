"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Modal } from "../controls";
import { HostRequest } from "../host-request";
import { BillingCard } from "./billing-card";
import { useSession } from "../providers";
import { Badge, Button, Card } from "../ui";
import { api } from "@/lib/api";
import type { Account } from "@/lib/api-types";

/** The account itself: the address you sign in with, and whether an
 *  administrator has granted hosting. A non-host can ask from here; the
 *  request does not turn hosting on. */
export function AccountSection({ account }: { account: Account }) {
  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Account</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">Sign-in and hosting.</p>
      <Card className="mt-4 grid max-w-lg gap-3 p-5">
        <div>
          <div className="text-[12px] text-ink-3">Email</div>
          <div className="mt-0.5 text-[14px]">{account.email}</div>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Hosting access</div>
            <div className="mt-1.5">
              {account.canHost ? (
                <div className="text-[12px] leading-relaxed text-ink-2">
                  You can schedule and run webinars.
                </div>
              ) : (
                <HostRequest account={account} placement="settings" />
              )}
            </div>
          </div>
          <Badge
            tone={
              account.canHost ? "ok" : account.hostRequestedAt ? "warn" : undefined
            }
          >
            {account.canHost
              ? "Granted"
              : account.hostRequestedAt
                ? "Requested"
                : "Not granted"}
          </Badge>
        </div>
      </Card>
      <BillingCard />
      <DeleteAccount account={account} />
    </section>
  );
}

/** Erasing the account. Confirmed with the password, or the email for an account
 *  that signs in with Google only. */
function DeleteAccount({ account }: { account: Account }) {
  const router = useRouter();
  const { signOut } = useSession();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setOpen(false);
    setSecret("");
    setError(null);
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(
        account.hasPassword ? { password: secret } : { email: secret },
      );
      await signOut().catch(() => {});
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4 grid max-w-lg gap-3 border-live/30 p-5">
      <div>
        <div className="text-[13px] font-medium text-live">Delete account</div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
          Permanently deletes your account, your webinars and their recordings, and your
          contacts and messages. Payment records are kept, as tax law requires.
        </p>
      </div>
      <div>
        <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
          Delete account…
        </Button>
      </div>
      <Modal
        open={open}
        onClose={close}
        size="sm"
        title="Delete your account?"
        description="This can't be undone."
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void confirm()}
              disabled={busy || secret.trim() === ""}
            >
              {busy ? "Deleting…" : "Delete account"}
            </Button>
          </>
        }
      >
        <div className="grid gap-2">
          <p className="text-[12.5px] leading-relaxed text-ink-2">
            Your webinars, recordings, contacts and messages are deleted. Payment records
            are kept, as tax law requires.
          </p>
          <label className="label" htmlFor="delete-confirm">
            {account.hasPassword ? "Your password" : `Type ${account.email} to confirm`}
          </label>
          <input
            id="delete-confirm"
            className="field"
            type={account.hasPassword ? "password" : "email"}
            autoComplete={account.hasPassword ? "current-password" : "off"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          {error && <p className="text-[12px] font-medium text-live">{error}</p>}
        </div>
      </Modal>
    </Card>
  );
}
