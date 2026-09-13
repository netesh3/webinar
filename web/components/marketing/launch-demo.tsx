"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAppConfig } from "@/components/providers";
import { Alert, Modal, Spinner } from "@/components/controls";
import { Button } from "@/components/ui";

/* "Launch a webinar": the zero-friction door.
 *
 * Everywhere else on this site, hosting means an account with hosting rights
 * an admin granted. This is the one exception, and it is deliberately narrow:
 * a name and an email start a real webinar, already live, that quietly ends
 * itself two hours later — see the API's handleLaunchDemo. Rendered only when
 * the operator has turned DemoMode on; there is no button to hide otherwise,
 * because a visible button for a door that 404s is worse than no button.
 */

export function LaunchDemoButton({ className }: { className?: string }) {
  const { demoMode } = useAppConfig();
  const [open, setOpen] = useState(false);

  if (!demoMode) return null;

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M13 2 3 14h7l-1 8 11-14h-7l1-6z" />
        </svg>
        Launch a webinar
      </button>
      <LaunchDemoModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function LaunchDemoModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const wb = await api.launchDemo({ name, email });
      // A hard navigation, not router.push: the launch just set a session
      // cookie, and the room needs a fresh load to pick it up rather than
      // carrying over whatever the client-side router cached as "signed out".
      window.location.href = `/host/${wb.id}/room`;
    } catch (err) {
      if (err instanceof ApiError && err.fields) {
        setFields(err.fields);
      } else {
        setError(
          err instanceof ApiError
            ? err.message
            : "Could not launch a webinar. Check your connection and try again.",
        );
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Launch a webinar"
      description="No signup. This starts a real webinar you can share right away — it closes itself after 2 hours."
    >
      <form onSubmit={submit} className="grid gap-3.5">
        {error && <Alert tone="error">{error}</Alert>}
        <label className="grid gap-1 text-[13px] font-medium text-ink">
          Your name
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            autoFocus
            required
          />
          {fields.name && <span className="text-[12px] font-normal text-live">{fields.name}</span>}
        </label>
        <label className="grid gap-1 text-[13px] font-medium text-ink">
          Email
          <input
            className="field"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ada@example.com"
            required
          />
          {fields.email && <span className="text-[12px] font-normal text-live">{fields.email}</span>}
        </label>
        <Button type="submit" size="lg" disabled={busy} className="mt-1">
          {busy && <Spinner className="size-4" />}
          {busy ? "Launching…" : "Launch it"}
        </Button>
      </form>
    </Modal>
  );
}
