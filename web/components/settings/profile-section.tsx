"use client";

import { useRef, useState } from "react";
import { AccountAvatar } from "../account-avatar";
import { Alert, Spinner } from "../controls";
import { useSession } from "../providers";
import { Button, Card } from "../ui";
import { api, ApiError } from "@/lib/api";
import type { Account } from "@/lib/api-types";
import { prepareProfilePhoto, ProfilePhotoError } from "@/lib/profile-photo";

/** True when the photo on the account is one we stored, not Google's URL. */
function isUploadedPhoto(url: string | undefined): boolean {
  return !!url && url.startsWith("/api/auth/avatar");
}

/** Name, job title, organisation, and the photo shown with them. Hosting and
 *  the connected apps live in the other sections. The photo uploads on its
 *  own: an upload replaces the Google photo, and removing it falls back. */
export function ProfileSection({ account }: { account: Account }) {
  const { updateProfile, refresh } = useSession();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState(account.name);
  const [title, setTitle] = useState(account.title);
  const [org, setOrg] = useState(account.org);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const uploaded = isUploadedPhoto(account.avatarUrl);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await updateProfile({ name, title, org });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your changes.");
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      const prepared = await prepareProfilePhoto(file);
      await api.uploadAvatar(prepared.blob, prepared.mime);
      await refresh();
    } catch (err) {
      setPhotoError(
        err instanceof ProfilePhotoError || err instanceof ApiError
          ? err.message
          : "Couldn't upload that photo.",
      );
    } finally {
      setPhotoBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    setPhotoError(null);
    setPhotoBusy(true);
    try {
      await api.deleteAvatar();
      await refresh();
    } catch (err) {
      setPhotoError(err instanceof ApiError ? err.message : "Couldn't remove that photo.");
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Profile</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Shown to everyone in a webinar you present on.
      </p>
      <Card className="mt-4 grid max-w-lg gap-4 p-5">
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
                disabled={photoBusy}
                onChange={(e) => void onFile(e.target.files?.[0])}
                className="block max-w-full text-[12.5px] text-ink-2 file:mr-3 file:rounded-lg file:border file:border-line-2 file:bg-surface file:px-3 file:py-1.5 file:text-[12.5px] file:font-medium file:text-ink"
              />
              {uploaded && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={photoBusy}
                  onClick={() => void remove()}
                >
                  Remove photo
                </Button>
              )}
              {photoBusy && <Spinner className="size-4 text-ink-3" />}
            </div>
            {photoError && (
              <div className="mt-2">
                <Alert tone="error">{photoError}</Alert>
              </div>
            )}
          </div>
        </div>
        <form onSubmit={save} className="grid gap-3.5 border-t border-line pt-4">
          <div>
            <label className="label" htmlFor="name">
              Full name
            </label>
            <input
              id="name"
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="label" htmlFor="title">
              Job title
            </label>
            <input
              id="title"
              className="field"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="org">
              Organisation
            </label>
            <input
              id="org"
              className="field"
              value={org}
              onChange={(e) => setOrg(e.target.value)}
            />
          </div>
          {error && <Alert tone="error">{error}</Alert>}
          {saved && <Alert tone="ok">Saved.</Alert>}
          <div>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner className="size-4" />}
              Save changes
            </Button>
          </div>
        </form>
      </Card>
    </section>
  );
}
