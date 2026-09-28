"use client";

import { useState } from "react";
import { Alert, Spinner } from "../controls";
import { useSession } from "../providers";
import { Button, Card } from "../ui";
import { ApiError } from "@/lib/api";
import type { Account } from "@/lib/api-types";

/** Name, job title, organisation. Hosting and the connected apps live in the
 *  other sections. */
export function ProfileSection({ account }: { account: Account }) {
  const { updateProfile } = useSession();
  const [name, setName] = useState(account.name);
  const [title, setTitle] = useState(account.title);
  const [org, setOrg] = useState(account.org);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <section>
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Profile</h2>
      <p className="mt-1 text-[12.5px] text-ink-3">
        Shown to everyone in a webinar you present on.
      </p>
      <Card className="mt-4 p-5">
        <form onSubmit={save} className="grid max-w-lg gap-3.5">
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
