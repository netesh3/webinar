"use client";

import { useRef, useState } from "react";
import { AccountAvatar } from "../account-avatar";
import { Alert, Spinner } from "../controls";
import { useSession } from "../providers";
import { Badge, Button, Card } from "../ui";
import { api, ApiError } from "@/lib/api";
import { prepareProfilePhoto, ProfilePhotoError } from "@/lib/profile-photo";
import type { Account } from "@/lib/api-types";

/** True when the photo on the account is one we stored, not Google's URL. */
function isUploadedPhoto(url: string | undefined): boolean {
  return !!url && url.startsWith("/api/auth/avatar");
}

/** The account itself: the address you sign in with, and whether an
 *  administrator has granted hosting. Neither is edited here. The profile
 *  photo is: an upload replaces the Google photo, and removing it falls back. */
export function AccountSection({ account }: { account: Account }) {
  const { refresh } = useSession();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploaded = isUploadedPhoto(account.avatarUrl);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const prepared = await prepareProfilePhoto(file);
      await api.uploadAvatar(prepared.blob, prepared.mime);
      await refresh();
    } catch (err) {
      setError(
        err instanceof ProfilePhotoError || err instanceof ApiError
          ? err.message
          : "Couldn't upload that photo.",
      );
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await api.deleteAvatar();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't remove that photo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Account</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Sign-in and hosting. An administrator changes hosting; you don&apos;t.
      </p>
      <Card className="mt-4 grid max-w-lg gap-3 p-5">
        <div className="flex items-center gap-4">
          <AccountAvatar
            initials={account.initials}
            hue={account.hue}
            photo={account.avatarUrl}
            size={56}
          />
          <div className="min-w-0 flex-1">
            <label className="text-[12px] text-ink-3" htmlFor="profile-photo">
              Profile photo
            </label>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-2">
              {uploaded
                ? "This upload is shown everywhere your avatar is. Remove it to use your Google photo again."
                : account.avatarUrl
                  ? "Using your Google photo. An upload replaces it."
                  : "JPEG, PNG or WebP. Shown in place of your initials."}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                ref={inputRef}
                id="profile-photo"
                type="file"
                accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                aria-label="Upload profile picture"
                disabled={busy}
                onChange={(e) => void onFile(e.target.files?.[0])}
                className="block max-w-full text-[12.5px] text-ink-2 file:mr-3 file:rounded-lg file:border file:border-line-2 file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:font-medium file:text-ink"
              />
              {uploaded && (
                <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void remove()}>
                  Remove photo
                </Button>
              )}
              {busy && <Spinner className="size-4 text-ink-3" />}
            </div>
            {error && (
              <div className="mt-2">
                <Alert tone="error">{error}</Alert>
              </div>
            )}
          </div>
        </div>
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
